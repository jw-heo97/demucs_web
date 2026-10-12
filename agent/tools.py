"""에이전트 도구 (MCP, 프로세스 안). 무거운 일은 scorevid·scorebuild 가 하고, 에이전트는 눈으로 보고 판단한다.

도구는 한 번의 실행(Run)에 묶여 있다 — 곡 하나 + 악보 영상 하나.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import shutil
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from PIL import Image, ImageDraw

import scorebuild as sb
import scores
import scorevid as sv
from claude_agent_sdk import create_sdk_mcp_server, tool

API = "http://api:8000"
OUTPUT = Path("/data/output")
WORK = Path("/work")


class Run:
    def __init__(self, job_id: str, score_url: str, overwrite: bool = False, dry_run: bool = False):
        self.job_id = job_id
        self.score_url = score_url
        self.overwrite = overwrite
        self.dry_run = dry_run
        self.dir = WORK / job_id
        self.strip_dir = self.dir / "strips"
        self.video: Optional[Path] = None
        self.job: dict = {}
        self.proj: dict = {"version": 1, "source": score_url, "tempo": None, "strips": []}
        self.built: Optional[dict] = None
        self.saved: Optional[dict] = None
        self.reported: Optional[dict] = None
        self.log_lines: list[dict] = []
        self.state = "대기"
        self.align: Optional[dict] = None

    def log(self, msg: str, kind: str = "info") -> None:
        self.log_lines.append({"t": round(time.time(), 1), "kind": kind, "msg": msg})
        self.log_lines[:] = self.log_lines[-300:]

    @property
    def song_dir(self) -> Path:
        return OUTPUT / (self.job.get("folder") or "_none_")

    def file_of(self, key: str) -> Optional[Path]:
        """곡 폴더의 트랙 파일 (mp3 우선)."""
        folder = self.job.get("folder") or ""
        for ext in ("mp3", "wav"):
            p = self.song_dir / ext / f"{folder}_{key}.{ext}"
            if p.exists():
                return p
        return None


# ---------------------------------------------------------------- 도우미

def S(required: list[str] | None = None, **props: str) -> dict:
    """JSON 스키마. props 값: number | integer | string | boolean | array | object"""
    return {"type": "object", "properties": {k: {"type": v} for k, v in props.items()},
            "required": required or []}

def _img(im: Image.Image, max_w: int = 1400) -> dict:
    if im.size[0] > max_w:
        im = im.resize((max_w, int(im.size[1] * max_w / im.size[0])))
    buf = io.BytesIO()
    # JPEG: PNG 보다 4~6배 작다 (토큰·전송). 악보 선은 품질 85 면 충분히 읽힌다
    im.convert("RGB").save(buf, "JPEG", quality=85)
    return {"type": "image", "data": base64.b64encode(buf.getvalue()).decode(), "mimeType": "image/jpeg"}


def _text(s: str) -> dict:
    return {"type": "text", "text": s}


def _ok(*parts: Any) -> dict:
    return {"content": [p if isinstance(p, dict) else _text(str(p)) for p in parts]}


def _err(msg: str) -> dict:
    return {"content": [_text(msg)], "is_error": True}


def _strip_table(run: Run, bpm: Optional[float] = None, beats: float = 4.0) -> str:
    rows = []
    n = 1
    for i, s in enumerate(run.proj["strips"]):
        m = sb.measures_of(s)
        rep = max(1, s.get("repeat", 1))
        hold = s["t1"] - s["t0"]
        line = f"#{i:02d} {s['t0']:7.2f}~{s['t1']:7.2f}s ({hold:5.2f}s) 마디 {m}"
        if rep > 1:
            line += f" ×{rep}"
        if s.get("skip"):
            line += " [빼기]"
        else:
            line += f"  → {n}~{n + m * rep - 1}마디"
            n += m * rep
        if bpm:
            exp = hold / (beats * 60 / bpm)
            flag = "" if abs(exp - m * rep) < 0.6 else f"   ⚠ 시간상 {exp:.1f}마디"
            line += f"  (시간 기준 {exp:.2f}마디){flag}"
        marks = ", ".join(f"{mk['measure']}:{mk['text']}" for mk in s.get("marks", []))
        if marks:
            line += f"  [구간 {marks}]"
        rows.append(line)
    return "\n".join(rows) + f"\n합계 {sb.total_measures(run.proj)}마디"


async def _api(method: str, path: str, **kw) -> Any:
    async with httpx.AsyncClient(base_url=API, timeout=120) as c:
        r = await c.request(method, path, **kw)
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text[:300]
            raise RuntimeError(f"{method} {path} → {r.status_code}: {detail}")
        return r.json() if r.content else None


# ---------------------------------------------------------------- 도구

def build_server(run: Run):
    @tool("get_job", "작업 중인 곡 정보: 제목·길이·검출 BPM·트랙·지금 송 맵·이미 악보가 있는지.", S())
    async def get_job(args):
        run.job = await _api("GET", f"/api/jobs/{run.job_id}")
        m = await _api("GET", f"/api/jobs/{run.job_id}/map")
        has_score = any(f["rel"] == "score.pdf" for f in run.job.get("files", []))
        info = {
            "title": run.job.get("folder"), "duration": run.job.get("duration"), "bpm_detected": run.job.get("bpm"),
            "tracks": sorted({f["rel"].split("/")[-1] for f in run.job.get("files", []) if f["rel"].endswith(".mp3")})[:20],
            "has_score": has_score, "overwrite_score": run.overwrite, "dry_run": run.dry_run,
            "active_map": m.get("map"), "bars": len(m.get("bars", [])),
            "versions": [v["name"] for v in m.get("versions", [])],
            "score_video": run.score_url,
        }
        return _ok(json.dumps(info, ensure_ascii=False, indent=1))

    @tool("download_video", "악보 영상을 받고, 15장 정도의 축소 장면(시각 표시)을 보여준다. 화면 구성(악보 띠 위치·자막·커서)을 여기서 파악한다.", S())
    async def download_video(args):
        run.dir.mkdir(parents=True, exist_ok=True)
        try:
            run.video = await asyncio.to_thread(sv.download, run.score_url, run.dir / "video", run.log)
        except Exception as e:  # noqa: BLE001
            return _err(str(e))
        p = sv.probe(run.video)
        times = [round(p["duration"] * k / 16, 1) for k in range(1, 16)]
        sheet = await asyncio.to_thread(sv.contact_sheet, run.video, times, 5, 384)
        return _ok(json.dumps(p), _img(sheet, 1600))

    @tool("look", "영상의 한 장면을 본다. box=[x0,y0,x1,y1] 로 잘라 볼 수 있다 (원본 픽셀 좌표).",
          S(["t"], t="number", box="array"))
    async def look(args):
        if not run.video:
            return _err("먼저 download_video")
        box = args.get("box") or None
        im = await asyncio.to_thread(sv.frame, run.video, float(args["t"]), box)
        return _ok(f"{im.size[0]}x{im.size[1]}", _img(im, 1600))

    @tool("find_score_band", "악보 띠가 있는 가로 영역 후보를 찾고, 첫 후보를 장면 위에 표시해 보여준다.", S())
    async def find_score_band(args):
        if not run.video:
            return _err("먼저 download_video")
        bands = await asyncio.to_thread(sv.suggest_bands, run.video)
        if not bands:
            return _err("보표를 찾지 못했습니다. look 으로 악보 위치를 보고 extract_strips 에 box 를 직접 주세요.")
        p = sv.probe(run.video)
        im = await asyncio.to_thread(sv.frame, run.video, p["duration"] * 0.4)
        d = ImageDraw.Draw(im)
        for i, b in enumerate(bands[:3]):
            d.rectangle(b["box"], outline=[(255, 0, 0), (0, 200, 0), (0, 0, 255)][i], width=5)
        return _ok(json.dumps(bands[:3]), _img(im, 1400))

    @tool("extract_strips",
          "box 영역에서 악보가 바뀔 때마다 띠 하나씩 뽑고, 마디선을 찾는다. 결과 표와 처음 6개 띠(빨강=찾은 마디선)를 보여준다. "
          "bpm 을 주면 띠가 화면에 있던 시간으로 마디 수를 검산해 ⚠ 를 붙인다.",
          S(["box"], box="array", bpm="number"))
    async def extract_strips(args):
        if not run.video:
            return _err("먼저 download_video")
        box = [int(v) for v in args["box"]]
        strips = await asyncio.to_thread(sv.extract_strips, run.video, box, run.strip_dir, 4.0, 0.4, 0.6, run.log)
        run.proj["strips"] = strips
        run.proj["box"] = box
        run.built = None
        sheet = await asyncio.to_thread(sv.strips_sheet, run.strip_dir, strips, 0, 6)
        return _ok(_strip_table(run, args.get("bpm")), _img(sheet, 1400))

    @tool("show_strips", "띠들을 확인용 그림으로 본다 (빨강 = 마디선, 숫자 = 마디 번호).", S([], start="integer", count="integer"))
    async def show_strips(args):
        st = run.proj["strips"]
        if not st:
            return _err("띠가 없습니다")
        start = max(0, int(args.get("start", 0)))
        count = max(1, min(8, int(args.get("count", 6))))
        sheet = await asyncio.to_thread(sv.strips_sheet, run.strip_dir, st, start, count)
        return _ok(f"#{start}~#{min(len(st), start + count) - 1} / 전체 {len(st)}개", _img(sheet, 1400))

    @tool("strip_table", "띠 목록 표. bpm·beats(마디당 박 수)를 주면 시간으로 마디 수를 검산한다.",
          S([], bpm="number", beats="number"))
    async def strip_table(args):
        return _ok(_strip_table(run, args.get("bpm"), float(args.get("beats") or 4)))

    @tool("edit_strip",
          "띠 하나를 고친다. 필요한 것만 준다: add_bar(x) / remove_bar(x, 가장 가까운 것) / bars([x…] 통째로) — "
          "staff 는 띠 안 보표 번호(보통 0). repeat(같은 띠가 연달아 n번), skip(true=악보가 아닌 장면이라 뺀다), "
          "marks([{measure: 띠 안 마디 번호(0부터), text}]) = 구간 이름.",
          S(["index"], index="integer", staff="integer", add_bar="integer", remove_bar="integer", bars="array",
            repeat="integer", skip="boolean", marks="array"))
    async def edit_strip(args):
        st = run.proj["strips"]
        i = int(args["index"])
        if not 0 <= i < len(st):
            return _err(f"index 는 0~{len(st) - 1}")
        s = st[i]
        k = int(args.get("staff") or 0)
        if s["staves"] and any(x in args for x in ("add_bar", "remove_bar", "bars")):
            staff = s["staves"][min(k, len(s["staves"]) - 1)]
            bars = list(staff["bars"])
            if args.get("bars") is not None:
                bars = sorted(int(x) for x in args["bars"])
            if args.get("add_bar") is not None:
                bars = sorted(set(bars + [int(args["add_bar"])]))
            if args.get("remove_bar") is not None and bars:
                x = int(args["remove_bar"])
                bars.remove(min(bars, key=lambda b: abs(b - x)))
            staff["bars"] = bars
        if args.get("repeat") is not None:
            s["repeat"] = max(1, int(args["repeat"]))
        if args.get("skip") is not None:
            s["skip"] = bool(args["skip"])
        if args.get("marks") is not None:
            s["marks"] = [{"measure": int(m["measure"]), "text": str(m["text"])[:40]}
                          for m in args["marks"] if str(m.get("text", "")).strip()]
        run.built = None
        sheet = await asyncio.to_thread(sv.strips_sheet, run.strip_dir, st, i, 1)
        return _ok(f"#{i} 고침 — 마디 {sb.measures_of(s)}개, 합계 {sb.total_measures(run.proj)}마디", _img(sheet, 1400))

    @tool("align_audio",
          "영상 소리와 곡 소리를 맞대 시차를 구하고(offset), 곡 드럼으로 박 간격·위상을 맞춘 뒤, 띠가 나타난 시각으로 "
          "1마디 1박(anchor)을 역산한다. bpm 은 악보 템포(또는 추정). beats 는 마디별 박 수 예외 {마디번호: 박수} (예: {\"1\": 2}).",
          S(["bpm"], bpm="number", beats="object"))
    async def align_audio(args):
        if not run.video:
            return _err("먼저 download_video")
        if not run.job:
            run.job = await _api("GET", f"/api/jobs/{run.job_id}")
        song = run.file_of("original")
        if not song:
            stems = [p for p in (run.file_of(k) for k in ("drums", "bass", "other", "vocals")) if p]
            if not stems:
                return _err("곡 트랙 파일을 찾지 못했습니다")
            song = await asyncio.to_thread(sv.mix_tracks, stems, run.dir / "song_mix.wav")
        drums = run.file_of("drums") or song
        try:
            off = await asyncio.to_thread(sv.audio_offset, run.video, song)
        except ValueError as e:
            return _err(str(e))
        grid = await asyncio.to_thread(sv.fit_grid, drums, float(args["bpm"]), 2.0)
        total = sb.total_measures(run.proj)
        ov = {int(k): float(v) for k, v in (args.get("beats") or {}).items()}
        bpm_list = [ov.get(m + 1, 4.0) for m in range(total)]
        strips = [s for s in run.proj["strips"] if not s.get("skip")]
        anc = sv.estimate_anchor(strips, off["offset"], grid, bpm_list) if strips else {}
        run.align = {"offset": off, "grid": grid, "anchor": anc}
        note = ("offset: 곡 시각 = 영상 시각 − offset. z 가 8 미만이거나 ratio 가 1.15 미만이면 영상 소리가 원곡과 "
                "다를 수 있다(라이브·편곡) — 이때는 첫 타격(first_hit)과 악보의 첫 음으로 판단. strip_lead_sec 는 띠가 "
                "마디보다 얼마나 먼저(음수) 바뀌는지 — 고르게 작아야(±0.3초) 정상이다. 어느 띠부터 한 마디 길이만큼 "
                "통째로 벌어지면 그 사이 띠의 마디 수(또는 repeat)가 틀렸다는 뜻이다.")
        return _ok(json.dumps(run.align, ensure_ascii=False), note)

    @tool("build_score",
          "띠들로 PDF 를 만들고 앱의 악보 분석기로 다시 읽어 검산한다(마디 수·구간·템포). 첫 쪽 그림을 돌려준다.",
          S([], tempo="number"))
    async def build_score(args):
        if not run.proj["strips"]:
            return _err("띠가 없습니다")
        run.proj["tempo"] = float(args.get("tempo") or 0) or None
        pdf = run.dir / "score.pdf"
        title = run.job.get("folder") or ""
        try:
            res = await asyncio.to_thread(sb.build_pdf, run.strip_dir, run.proj, pdf, title)
            ana_dir = run.dir / "analysis"
            data = await asyncio.to_thread(scores.analyze, pdf, ana_dir)
        except Exception as e:  # noqa: BLE001
            return _err(f"PDF 를 만들지 못했습니다: {e}")
        expect = sb.total_measures(run.proj)
        run.built = {"pdf": str(pdf), "measures": len(data["measures"]), "expect": expect,
                     "marks": data["marks"], "tempo": data["tempo"], "warnings": data["warnings"], "pages": res["pages"]}
        page1 = Image.open(ana_dir / "_score" / "page-1.png")
        return _ok(json.dumps(run.built, ensure_ascii=False), _img(page1, 1200))

    @tool("save_result",
          "결과를 곡에 저장한다: 악보 PDF(score.pdf)와 송 맵 새 버전. anchor·bpm 은 align_audio 결과로, "
          "beats 는 박 수 예외 {마디: 박수}, names 는 구간 이름 {마디: 이름} (생략하면 띠의 구간 표시를 쓴다).",
          S(["anchor", "bpm"], anchor="number", bpm="number", beats="object", names="object", version_name="string"))
    async def save_result(args):
        if not run.built:
            return _err("먼저 build_score 로 PDF 를 만들고 검산하세요")
        total = run.built["measures"]
        names: dict[int, str] = {}
        if args.get("names"):
            names = {int(k): str(v) for k, v in args["names"].items()}
        else:
            n = 1
            for s in sb.expanded(run.proj):
                for mk in s.get("marks", []):
                    names.setdefault(n + int(mk["measure"]), mk["text"])
                n += sb.measures_of(s)
        beats = {int(k): float(v) for k, v in (args.get("beats") or {}).items()}
        ranges = []
        prev_b, prev_n = None, None
        for m in range(1, total + 1):
            b = beats.get(m, 4.0)
            nm = names.get(m)
            if m == 1 or b != prev_b or nm:
                bpb, unit = (int(b), 4) if float(b).is_integer() else (int(round(b * 2)), 8)
                ranges.append({"from_bar": m, "name": nm or ("" if m > 1 else ""), "beats_per_bar": bpb,
                               "beat_unit": unit, "bpm": None, "click_beats": None})
            prev_b, prev_n = b, nm or prev_n
        songmap = {"anchor": float(args["anchor"]), "bpm": float(args["bpm"]), "ranges": ranges}
        vname = (args.get("version_name") or "AI 악보").strip()
        if run.dry_run:
            out = run.dir / "result.json"
            out.write_text(json.dumps({"map": songmap, "built": run.built}, ensure_ascii=False, indent=1), encoding="utf-8")
            run.saved = {"dry_run": True, "map": songmap}
            return _ok(f"(시험 실행) 저장하지 않고 {out} 에 남겼습니다.\n" + json.dumps(songmap, ensure_ascii=False))
        has_score = any(f["rel"] == "score.pdf" for f in (await _api("GET", f"/api/jobs/{run.job_id}")).get("files", []))
        if has_score and not run.overwrite:
            return _err("이 곡에는 이미 악보가 있습니다. 덮어쓰기가 허락되지 않았으니 report 로 결과만 알리세요.")
        try:
            pdf_bytes = Path(run.built["pdf"]).read_bytes()
            await _api("PUT", f"/api/jobs/{run.job_id}/score", content=pdf_bytes,
                       headers={"Content-Type": "application/pdf"})
            names_now = {v["name"] for v in (await _api("GET", f"/api/jobs/{run.job_id}/map")).get("versions", [])}
            base, k = vname, 2
            while vname in names_now:
                vname = f"{base} {k}"
                k += 1
            await _api("POST", f"/api/jobs/{run.job_id}/map/versions", json={"name": vname, "map": songmap})
        except RuntimeError as e:
            return _err(str(e))
        # 악보 편집(송 맵)용 원본: 띠 그림 + 프로젝트
        dst = run.song_dir / sb.SRC_DIR
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(run.strip_dir, dst)
        sb.save_project(run.song_dir, run.proj)
        run.saved = {"version": vname, "map": songmap}
        return _ok(f"저장했습니다 — 악보 {total}마디, 송 맵 버전 '{vname}' (활성)")

    @tool("report", "끝내기 전에 반드시 부른다. status: done | failed. summary: 사용자에게 보일 한국어 요약 (무엇을 했고, 무엇이 불확실한지).",
          S(["status", "summary"], status="string", summary="string"))
    async def report(args):
        run.reported = {"status": args["status"], "summary": args["summary"]}
        return _ok("기록했습니다. 이제 끝내도 됩니다.")

    tools = [get_job, download_video, look, find_score_band, extract_strips, show_strips, strip_table,
             edit_strip, align_audio, build_score, save_result, report]
    run.tools = {t.name: t for t in tools}   # 시험용: 에이전트 없이 바로 부를 수 있게
    return create_sdk_mcp_server("score", "1.0.0", tools), [f"mcp__score__{t.name}" for t in tools]
