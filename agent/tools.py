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

import notation as nota
import scorebuild as sb
import scores
import scorevid as sv
from claude_agent_sdk import create_sdk_mcp_server, tool

API = "http://api:8000"
OUTPUT = Path("/data/output")
WORK = Path("/work")


class Run:
    def __init__(self, job_id: str, score_url: str, overwrite: bool = False, dry_run: bool = False,
                 mode: str = "video"):
        self.job_id = job_id
        # video: 연주 영상의 악보 띠에서 / pdf: 곡에 이미 있는 악보 PDF 에서 (PDF 는 그대로 두고 음표·송 맵만)
        self.mode = mode
        self.pdf: Optional[dict] = None          # _score.json (scores.py 분석 결과)
        self.sections: dict[int, str] = {}      # 에이전트가 읽은 구간 이름 {음원 마디: 이름}
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
        # 받아 적은 음표: 마디 번호(1부터) → 마디 (app/notation.py 형식)
        self.notes: dict[int, dict] = {}
        self.timing: Optional[dict] = None     # 소리 대조에 쓰는 anchor·bpm·beats
        self._onsets: Optional[dict] = None
        self.refined: Optional[dict] = None

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


def _pdf_order(run: Run) -> list[int]:
    """음원 마디 n → 악보 마디 번호(1부터). 반복 기호가 있으면 펼친 순서."""
    sc = run.pdf or {}
    n = len(sc.get("measures", []))
    order = sc.get("order")
    return [k for k in order if 1 <= k <= n] if order else list(range(1, n + 1))


def _measure_index(run: Run) -> list:
    """연주 순서 마디마다 (띠, 띠 번호, 보표 번호, 보표 안 마디 번호). pdf 방식이면 악보 마디 번호."""
    if run.mode == "pdf":
        return _pdf_order(run)
    out = []
    for si, s in enumerate(run.proj["strips"]):
        if s.get("skip"):
            continue
        for _ in range(max(1, s.get("repeat", 1))):
            for k, st in enumerate(s.get("staves", [])):
                for j in range(len(st.get("bars", []))):
                    out.append((s, si, k, j))
    return out


def _pdf_measure_crop(run: Run, n: int) -> Optional[Image.Image]:
    """악보 PDF 에서 음원 n 번째 마디를 잘라 선명하게(200dpi) 그린다. 줄 첫 마디면 음자리표까지."""
    import pymupdf
    order = _pdf_order(run)
    if not 1 <= n <= len(order):
        return None
    m = run.pdf["measures"][order[n - 1] - 1]
    doc = pymupdf.open(run.song_dir / "score.pdf")
    try:
        page = doc[m["page"]]
        g = (m["bot"] - m["top"]) / 4
        x0 = m["sys_x0"] - 8 if abs(m["x0"] - m["sys_x0"]) < 1 else m["x0"] - 1.5 * g
        clip = pymupdf.Rect(max(0, x0), max(0, m["y0"]), min(page.rect.width, m["x1"] + 1.5 * g),
                            min(page.rect.height, m["y1"]))
        pix = page.get_pixmap(dpi=200, clip=clip)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    finally:
        doc.close()


def _measure_crop(run: Run, n: int) -> Optional[Image.Image]:
    if run.mode == "pdf":
        return _pdf_measure_crop(run, n)
    idx = _measure_index(run)
    if not 1 <= n <= len(idx):
        return None
    s, si, k, j = idx[n - 1]
    st = s["staves"][k]
    im = Image.open(run.strip_dir / s["img"]).convert("RGB")
    left = st["bars"][j - 1] if j > 0 else max(0, st["x0"] - 10)
    right = st["bars"][j]
    g = st["gap"]
    # 위아래로 넉넉히 (구간 상자·위 음표·발 음표), 양옆은 조금 겹쳐 이음매가 보이게
    box = (max(0, int(left - 1.5 * g)), max(0, int(st["top"] - 7 * g)), min(im.size[0], int(right + 1.5 * g)),
           min(im.size[1], int(st["bot"] + 6 * g)))
    return im.crop(box)


def _onsets(run: Run) -> dict:
    if run._onsets is None:
        drums = run.file_of("drums")
        if not drums:
            raise RuntimeError("드럼 트랙이 없습니다")
        run._onsets = sv.drum_onsets(drums)
    return run._onsets


def _bar_times(run: Run, total: int) -> list[tuple[float, float, float]]:
    """마디마다 (시작, 끝, ♩ 길이)."""
    tm = run.timing or {}
    q = 60 / tm["bpm"]
    t = tm["anchor"]
    out = []
    for m in range(1, total + 1):
        nb = tm["beats"].get(m, 4.0)
        out.append((t, t + nb * q, q))
        t += nb * q
    return out


def _check(run: Run, a: int, b: int) -> str:
    if not run.timing:
        return "(소리 대조는 set_timing 뒤에 됩니다)"
    total = max(len(_measure_index(run)), max(run.notes) if run.notes else 0)
    times = _bar_times(run, total)
    on = _onsets(run)
    def stat(n: int) -> Optional[dict]:
        m = run.notes.get(n)
        if not m or n > len(times):
            return None
        start, end, q = times[n - 1]
        # 틱(♩=48) → 초. 박자표 분모와 상관없이 ♩ 기준이다
        hits = [(start + tick / nota.TPQ * q, lane) for tick, lane, c in nota.hits(m) if c != "g"]
        return sv.check_measure(hits, start, end, on)

    # '소리에만 있는 타격'은 탐·필인·스템 번짐으로 늘 조금 있다 — 곡 전체의 보통 수준보다 많을 때만 본다
    allst = {n: stat(n) for n in run.notes}
    extras = sorted(r["bd"]["extra"] + r["sn"]["extra"] for r in allst.values() if r)
    med = extras[len(extras) // 2] if extras else 0
    rows, bad = [], []
    for n in range(a, b + 1):
        r = allst.get(n)
        if not r:
            continue
        bd, sn = r["bd"], r["sn"]
        miss = (bd["score"] - bd["hit"]) + (sn["score"] - sn["hit"])
        extra = bd["extra"] + sn["extra"]
        why = []
        if miss >= 2 or (miss == 1 and bd["score"] + sn["score"] <= 4):
            why.append(f"악보 타격 {miss}개가 소리에 없음")
        if extra > med + 3:
            why.append(f"소리에만 있는 타격 {extra}개 (보통 {med})")
        if why:
            bad.append(n)
        rows.append(f"{n:4d}: 킥 {bd['hit']}/{bd['score']}  스네어 {sn['hit']}/{sn['score']}  (+{extra})"
                    + (f"  ⚠ {', '.join(why)}" if why else ""))
    head = ("마디: 킥 맞음/악보, 스네어 맞음/악보, (+소리에만 있는 타격) — 곡의 드럼(원곡 연주)과 대조. 커버 악보가 원곡을 "
            "단순화했으면 전체적으로 낮게 나온다 — ⚠ 마디만 다시 본다.")
    return head + "\n" + "\n".join(rows) + (f"\n다시 볼 마디: {bad}" if bad else "\n⚠ 없음")


def _match_rate(run: Run, anchor: float, bpm: float, beats: dict[int, float]) -> float:
    """받아 적은 킥·스네어 중 곡 드럼 소리와 ±45ms 안에 맞는 비율."""
    import numpy as np
    on = _onsets(run)
    q = 60 / bpm
    t, tot, hit = anchor, 0, 0
    for n in range(1, max(run.notes) + 1):
        m = run.notes.get(n)
        if m:
            for tick, lane, c in nota.hits(m):
                if lane in ("bd", "sn") and c != "g":
                    tt = t + tick / nota.TPQ * q
                    tot += 1
                    g = on[lane]
                    i = int(np.searchsorted(g, tt))
                    if any(abs(g[j] - tt) <= 0.045 for j in (i - 1, i) if 0 <= j < len(g)):
                        hit += 1
        t += beats.get(n, 4.0) * q
    return hit / max(tot, 1)


def refine_anchor(run: Run, anchor: float, bpm: float, beats: dict[int, float]) -> dict:
    """1마디 1박을 박 단위(±4박)·10ms 단위로 밀어 보며 받아 적은 음표가 소리와 가장 잘 맞는 자리를 찾는다.
    띠가 넘어가는 시각만으로는 한 박쯤 틀릴 수 있다 (라시사: -0.26초 → 맞는 자리 0.104초, 일치 53% → 90%)."""
    import numpy as np
    q = 60 / bpm
    rows = []
    for k in range(-4, 5):
        best = max((_match_rate(run, anchor + k * q + d, bpm, beats), anchor + k * q + d)
                   for d in np.arange(-0.06, 0.0601, 0.01))
        rows.append({"shift_beats": k, "anchor": round(best[1], 4), "match": round(best[0], 3)})
    top = max(rows, key=lambda r: r["match"])
    now = next(r for r in rows if r["shift_beats"] == 0)
    return {"now": now, "best": top, "table": rows}


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
            "mode": run.mode,
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
        count = max(1, min(6, int(args.get("count", 6))))
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

    @tool("add_strip",
          "띠 뽑기가 놓친 장면을 띠로 끼워 넣는다: 영상 시각 t 의 악보 띠(extract_strips 에 쓴 box)를 잡아 마디선을 찾고, "
          "시각 순서 자리에 넣는다. 띠가 화면에 있던 끝 시각 t1 을 주면 그 시간으로 마디 수를 검산할 수 있다.",
          S(["t"], t="number", t1="number"))
    async def add_strip(args):
        if not run.video or not run.proj.get("box"):
            return _err("먼저 extract_strips")
        t = float(args["t"])
        im = await asyncio.to_thread(sv.frame, run.video, t, run.proj["box"])
        import numpy as np
        rgb = np.asarray(im)
        info = sb.analyze_strip(rgb)
        if not info["staves"]:
            return _err(f"{t}초 장면에서 보표를 찾지 못했습니다. look 으로 확인하세요.")
        st = run.proj["strips"]
        i = sum(1 for s in st if s["t0"] <= t)
        name = f"strip-add-{int(t * 100):06d}.png"
        im.save(run.strip_dir / name)
        t1 = float(args.get("t1") or (st[i]["t0"] if i < len(st) else t + 4))
        if i > 0 and st[i - 1]["t1"] > t:
            st[i - 1]["t1"] = t
        st.insert(i, {"t0": round(t, 2), "t1": round(t1, 2), "img": name, "marks": [], "repeat": 1, **info})
        run.built = None
        sheet = await asyncio.to_thread(sv.strips_sheet, run.strip_dir, st, i, 1)
        return _ok(f"#{i} 에 넣었습니다 — 마디 {sb.measures_of(st[i])}개, 합계 {sb.total_measures(run.proj)}마디", _img(sheet, 1400))

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

    @tool("refine_timing",
          "음표를 다 받아 적은 뒤: 1마디 1박을 한 박씩(±4박) 밀어 보며 킥·스네어가 곡 드럼 소리와 가장 잘 맞는 자리를 찾는다.",
          S(["anchor", "bpm"], anchor="number", bpm="number", beats="object"))
    async def refine_timing(args):
        if not run.notes:
            return _err("먼저 write_measures 로 음표를 적으세요")
        beats = {int(k): float(v) for k, v in (args.get("beats") or {}).items()}
        try:
            r = await asyncio.to_thread(refine_anchor, run, float(args["anchor"]), float(args["bpm"]), beats)
        except RuntimeError as e:
            return _err(str(e))
        run.refined = r
        msg = (f"지금 anchor {r['now']['anchor']} 일치 {r['now']['match']*100:.1f}% / "
               f"가장 잘 맞는 자리 {r['best']['anchor']} ({r['best']['shift_beats']:+d}박) 일치 {r['best']['match']*100:.1f}%\n")
        msg += "\n".join(f"{x['shift_beats']:+d}박 {x['anchor']:.3f}s {x['match']*100:.1f}%" for x in r["table"])
        if r["best"]["shift_beats"] != 0 and r["best"]["match"] - r["now"]["match"] >= 0.1:
            msg += "\n→ 가장 잘 맞는 자리를 1마디 1박으로 쓰세요 (save_result 의 anchor)."
        return _ok(msg)

    @tool("save_result",
          "결과를 곡에 저장한다: 악보 PDF(score.pdf)와 송 맵 새 버전. anchor·bpm 은 align_audio 결과로, "
          "beats 는 박 수 예외 {마디: 박수}, names 는 구간 이름 {마디: 이름} (생략하면 띠의 구간 표시를 쓴다).",
          S(["anchor", "bpm"], anchor="number", bpm="number", beats="object", names="object", version_name="string"))
    async def save_result(args):
        if not run.built:
            return _err("먼저 build_score 로 PDF 를 만들고 검산하세요" if run.mode == "video" else "먼저 pdf_overview")
        total = run.built["measures"]
        names: dict[int, str] = {}
        if args.get("names"):
            names = {int(k): str(v) for k, v in args["names"].items()}
        elif run.mode == "pdf":
            names = dict(run.sections)
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
        # 음표가 있으면 1마디 1박을 소리로 검산한다 — 한 박 넘게 틀린 자리로 저장하지 않게
        if run.notes and len(run.notes) >= max(4, total // 2):
            try:
                r = await asyncio.to_thread(refine_anchor, run, float(args["anchor"]), float(args["bpm"]), beats)
            except RuntimeError:
                r = None
            far = r and abs(r["best"]["anchor"] - float(args["anchor"])) > 0.5 * 60 / float(args["bpm"])
            if far and r["best"]["match"] - r["now"]["match"] >= 0.1:
                return _err(f"1마디 1박 {args['anchor']} 에서는 받아 적은 킥·스네어가 소리와 {r['now']['match']*100:.0f}% 맞고, "
                            f"{r['best']['anchor']} ({r['best']['shift_beats']:+d}박) 에서는 {r['best']['match']*100:.0f}% 맞습니다. "
                            "anchor 를 고쳐 다시 save_result 하세요 (refine_timing 표 참고).")
        songmap = {"anchor": float(args["anchor"]), "bpm": float(args["bpm"]), "ranges": ranges}
        vname = (args.get("version_name") or "AI 악보").strip()
        run.timing = run.timing or {"anchor": songmap["anchor"], "bpm": songmap["bpm"], "beats": beats}
        if run.dry_run:
            out = run.dir / "result.json"
            out.write_text(json.dumps({"map": songmap, "built": run.built,
                                       "notes": {str(k): v for k, v in sorted(run.notes.items())}},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
            run.saved = {"dry_run": True, "map": songmap}
            return _ok(f"(시험 실행) 저장하지 않고 {out} 에 남겼습니다.\n" + json.dumps(songmap, ensure_ascii=False))
        has_score = any(f["rel"] == "score.pdf" for f in (await _api("GET", f"/api/jobs/{run.job_id}")).get("files", []))
        if run.mode == "video" and has_score and not run.overwrite:
            return _err("이 곡에는 이미 악보가 있습니다. 덮어쓰기가 허락되지 않았으니 report 로 결과만 알리세요.")
        try:
            if run.mode == "video":
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
        # 받아 적은 음표 악보 (전부 적었을 때만 — 일부만 있으면 편집 화면에 빈 마디가 섞여 헷갈린다)
        nt_note = ""
        if run.notes:
            ms = [run.notes.get(n) for n in range(1, total + 1)]
            if all(ms):
                doc = {"version": 1, "tempo": float(args["bpm"]), "source": run.score_url,
                       "measures": [{**m, **({"section": names[i + 1]} if names.get(i + 1) else {})}
                                    for i, m in enumerate(ms)]}
                try:
                    await _api("PUT", f"/api/jobs/{run.job_id}/notation", json={"notation": doc, "note": "AI 악보"})
                    nt_note = f", 음표 악보 {total}마디"
                except RuntimeError as e:
                    nt_note = f", 음표 악보 저장 실패: {e}"
            else:
                nt_note = f", 음표 악보는 {sum(1 for m in ms if m)}/{total}마디뿐이라 저장 안 함"
        # 악보 편집(송 맵)용 원본: 띠 그림 + 프로젝트 (영상 방식만)
        # 송 맵·음표 악보는 이미 저장됐으니 여기서 실패해도 저장 실패로 치지 않는다
        if run.mode == "video":
            dst = run.song_dir / sb.SRC_DIR
            try:
                if dst.exists():
                    shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(run.strip_dir, dst)
                sb.save_project(run.song_dir, run.proj)
            except OSError as e:
                nt_note += f", 악보 원본 그림(_score_src) 복사 실패: {e}"
        run.saved = {"version": vname, "map": songmap}
        return _ok(f"저장했습니다 — 악보 {total}마디, 송 맵 버전 '{vname}' (활성){nt_note}")

    @tool("measure_images",
          "받아 적기용: 마디들을 하나씩 잘라 확대해 보여준다 (연주 순서 마디 번호, 한 번에 최대 6마디).",
          S(["from"], **{"from": "integer", "to": "integer"}))
    async def measure_images(args):
        a = int(args["from"])
        b = min(int(args.get("to") or a), a + 5)
        ims = []
        for n in range(a, b + 1):
            im = await asyncio.to_thread(_measure_crop, run, n)
            if im is None:
                continue
            im = im.resize((int(im.size[0] * 1.6), int(im.size[1] * 1.6)))
            d = ImageDraw.Draw(im)
            d.rectangle([0, 0, 120, 30], fill="black")
            d.text((4, 3), f"#{n}", fill="yellow", font=sv._font(22))   # 그림 글꼴에 한글이 없다
            ims.append(im)
        if not ims:
            return _err("그 마디가 없습니다")
        W = max(i.size[0] for i in ims)
        sheet = Image.new("RGB", (W, sum(i.size[1] + 8 for i in ims)), (90, 90, 90))
        y = 0
        for im in ims:
            sheet.paste(im, (0, y))
            y += im.size[1] + 8
        return _ok(f"{a}~{b}마디", _img(sheet, 1500))

    @tool("write_measures",
          "받아 적은 마디들을 기록한다. measures=[{m: 마디 번호, beats, unit, steps, lanes: {악기: 칸 문자열}, "
          "simile?: true(악보에 %), section?: 구간 이름}]. 악기: cr cr2 spl chn rd rb hh t1 t2 sn rim ft cb bd hhp. "
          "칸: '-' 없음 x 침 > 악센트 g 고스트 f 플램 o 열린 하이햇. 소리 대조 결과를 함께 돌려준다.",
          S(["measures"], measures="array"))
    async def write_measures(args):
        done, errs = [], []
        for m in args["measures"]:
            try:
                n = int(m["m"])
                one = nota.normalize({"measures": [{k: v for k, v in m.items() if k != "m"}]})["measures"][0]
            except (nota.NotationError, KeyError, ValueError, TypeError) as e:
                errs.append(f"{m.get('m')}마디: {e}")
                continue
            run.notes[n] = one
            done.append(n)
            if run.mode == "pdf":
                order = _pdf_order(run)
                if 1 <= n <= len(order):
                    for j, k in enumerate(order, 1):
                        if k == order[n - 1] and j not in run.notes:
                            run.notes[j] = dict(one)       # 반복으로 다시 나오는 같은 악보 마디
        if errs:
            errs.append('형식 예: {"m": 5, "beats": 4, "unit": 4, "steps": 16, "lanes": {"hh": "x-x-x-x-x-x-x-x-", '
                        '"sn": "----x-------x---", "bd": "x-------x-x-----"}} — 자세한 것은 스킬의 transcribe.md')
        total = len(_measure_index(run))
        left = [n for n in range(1, total + 1) if n not in run.notes]
        msg = f"기록 {len(done)}마디. 남은 마디 {len(left)}개" + (f" (처음 {left[:10]})" if left else "")
        if errs:
            msg += "\n틀린 것: " + "; ".join(errs)
        if done:
            try:
                msg += "\n" + await asyncio.to_thread(_check, run, min(done), max(done))
            except RuntimeError as e:
                msg += f"\n(소리 대조 안 됨: {e})"
        return {"content": [_text(msg)], "is_error": bool(errs) and not done}

    @tool("set_timing", "소리 대조에 쓸 1마디 1박·BPM·박 수 예외(align_audio 결과). 받아 적기 전에 한 번.",
          S(["anchor", "bpm"], anchor="number", bpm="number", beats="object"))
    async def set_timing(args):
        run.timing = {"anchor": float(args["anchor"]), "bpm": float(args["bpm"]),
                      "beats": {int(k): float(v) for k, v in (args.get("beats") or {}).items()}}
        return _ok("기록했습니다. 이제 write_measures 가 소리 대조 결과를 함께 보여줍니다.")

    @tool("check_measures", "받아 적은 마디들을 곡의 드럼 소리와 다시 대조한다.",
          S(["from", "to"], **{"from": "integer", "to": "integer"}))
    async def check_measures(args):
        try:
            return _ok(await asyncio.to_thread(_check, run, int(args["from"]), int(args["to"])))
        except RuntimeError as e:
            return _err(str(e))

    @tool("pdf_overview",
          "pdf 방식: 곡에 있는 악보 PDF 의 쪽 그림에 앱이 찾은 마디(빨간 상자, 음원 마디 번호)를 그려 보여주고, "
          "마디 수·반복 순서·구간 표시·템포를 알려 준다. page 를 주면 그 쪽만 (1부터).",
          S([], page="integer"))
    async def pdf_overview(args):
        import pymupdf
        if not run.job:
            run.job = await _api("GET", f"/api/jobs/{run.job_id}")
        sc = await _api("GET", f"/api/jobs/{run.job_id}/score")
        run.pdf = sc
        order = _pdf_order(run)
        if not order:
            return _err("악보 PDF 에서 마디를 찾지 못했습니다 (스캔본?). 이 방식으로는 만들 수 없습니다.")
        run.built = {"measures": len(order), "expect": len(order), "marks": sc.get("marks", []),
                     "tempo": sc.get("tempo"), "warnings": sc.get("warnings", []), "pages": len(sc.get("pages", []))}
        first_bar: dict[int, int] = {}
        for n, k in enumerate(order, 1):
            first_bar.setdefault(k, n)
        doc = pymupdf.open(run.song_dir / "score.pdf")
        pages = [int(args["page"]) - 1] if args.get("page") else list(range(min(2, doc.page_count)))
        ims = []
        try:
            for pi in pages:
                if not 0 <= pi < doc.page_count:
                    continue
                pix = doc[pi].get_pixmap(dpi=100)
                im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                d = ImageDraw.Draw(im)
                z = 100 / 72
                for k, m in enumerate(sc["measures"], 1):
                    if m["page"] != pi:
                        continue
                    d.rectangle([m["x0"] * z, m["top"] * z - 6, m["x1"] * z, m["bot"] * z + 6], outline=(230, 30, 30), width=2)
                    d.text((m["x0"] * z + 3, m["bot"] * z + 8), str(first_bar.get(k, f"({k})")), fill=(230, 30, 30),
                           font=sv._font(14))
                ims.append(im)
        finally:
            doc.close()
        marks = ", ".join(f"{first_bar.get(mk['measure'], mk['measure'])}:{mk['text']}" for mk in sc.get("marks", []))
        info = (f"쪽 {len(sc.get('pages', []))} · 악보 마디 {len(sc['measures'])} · 연주 순서 마디 {len(order)}"
                f"{' (반복 펼침)' if sc.get('order') else ''} · 템포 {sc.get('tempo')}\n"
                f"구간 표시(음원 마디:이름 — '구간N' 은 글자가 그림이라 못 읽은 것): {marks or '없음'}\n"
                f"경고: {sc.get('warnings') or '없음'}")
        return _ok(info, *[_img(im, 1300) for im in ims])

    @tool("set_sections",
          "구간 이름을 정한다 {음원 마디: 이름}. 악보의 네모 상자 글자를 읽어서 (pdf 방식에서 '구간N' 으로 나온 것을 바로잡을 때).",
          S(["names"], names="object"))
    async def set_sections(args):
        run.sections = {int(k): str(v)[:40] for k, v in args["names"].items() if str(v).strip()}
        return _ok(f"구간 {len(run.sections)}개: " + ", ".join(f"{k}:{v}" for k, v in sorted(run.sections.items())))

    @tool("audio_grid",
          "pdf 방식: 곡 드럼에서 BPM·박 위상·첫 타격을 잰다. bpm 은 악보 템포(모르면 곡 검출 BPM). "
          "1마디 1박 첫 후보 = first_beat_at_hit (못갖춘마디면 그만큼 앞으로). 받아 적은 뒤 refine_timing 으로 한 박 단위 검산.",
          S(["bpm"], bpm="number"))
    async def audio_grid(args):
        if not run.job:
            run.job = await _api("GET", f"/api/jobs/{run.job_id}")
        drums = run.file_of("drums")
        if not drums:
            return _err("드럼 트랙이 없습니다")
        grid = await asyncio.to_thread(sv.fit_grid, drums, float(args["bpm"]), 2.0)
        m = await _api("GET", f"/api/jobs/{run.job_id}/map")
        now = m.get("map") or {}
        run.align = {"grid": grid}
        return _ok(json.dumps({"grid": grid, "current_map": {"anchor": now.get("anchor"), "bpm": now.get("bpm")}},
                              ensure_ascii=False),
                   "current_map 은 사용자가 지금 쓰는 송 맵 — 손으로 맞춘 값일 수 있으니 1마디 1박 후보로 함께 본다.")

    @tool("report", "끝내기 전에 반드시 부른다. status: done | failed. summary: 사용자에게 보일 한국어 요약 (무엇을 했고, 무엇이 불확실한지).",
          S(["status", "summary"], status="string", summary="string"))
    async def report(args):
        st = str(args["status"]).strip().lower()
        # 'ok'·'success' 처럼 적어도 성공으로 본다
        st = "done" if st in ("done", "ok", "success", "succeeded", "완료") else "failed"
        run.reported = {"status": st, "summary": args["summary"]}
        return _ok("기록했습니다. 이제 끝내도 됩니다.")

    if run.mode == "pdf":
        tools = [get_job, pdf_overview, set_sections, audio_grid, set_timing, measure_images, write_measures,
                 check_measures, refine_timing, save_result, report]
    else:
        tools = [get_job, download_video, look, find_score_band, extract_strips, show_strips, strip_table,
                 edit_strip, add_strip, align_audio, build_score, set_timing, measure_images, write_measures,
                 check_measures, refine_timing, save_result, report]
    run.tools = {t.name: t for t in tools}   # 시험용: 에이전트 없이 바로 부를 수 있게
    return create_sdk_mcp_server("score", "1.0.0", tools), [f"mcp__score__{t.name}" for t in tools]
