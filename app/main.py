"""FastAPI 서버.

인증은 없다. 이 앱은 `tailscale serve` 뒤에서만 쓰는 것을 전제로 하며, 접근 제어는
Tailscale 이 맡는다 — 내 tailnet 에 속한 기기만 접속할 수 있다. 컨테이너 포트는
127.0.0.1 에만 바인딩하므로(compose 의 WEB_BIND) LAN 이나 인터넷에서는 직접 닿지 않는다.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import downloader
import scores
import separator
from config import CORS_ORIGINS, MAX_DURATION_SEC, METRONOME_DEFAULT, OUTPUT_DIR, WORK_DIR
from downloader import DownloadError
from jobs import FORMATS, MAX_TITLE_LEN, STEMS, store
from playlists import playlists

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    # 모델 로딩(수 초)을 첫 요청이 아니라 기동 때 끝내둔다.
    await asyncio.to_thread(separator.get_loaded_model)
    print("[startup]", separator.model_info(), flush=True)
    # 이전 결과를 디스크에서 되살린다 (재시작해도 라이브러리가 유지되도록)
    await asyncio.to_thread(store.restore_from_disk)
    store.start()
    try:
        yield
    finally:
        store.stop()


app = FastAPI(title="Demucs Web", version="2.0.0", lifespan=lifespan)

# 앱(Capacitor/Tauri)이나 개발 서버처럼 다른 오리진에서 부를 때만 쓴다.
# 비어 있으면 동일 오리진만 허용 — 웹으로만 쓸 때는 켤 필요가 없다.
if CORS_ORIGINS:
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/healthz")
def healthz():
    return {"ok": True, "queue": store.queue_depth()}


@app.get("/api/info")
def api_info():
    return {
        **separator.model_info(),
        "formats": list(FORMATS),
        "stems": list(STEMS),
        "max_duration_sec": MAX_DURATION_SEC,
        "max_title_len": MAX_TITLE_LEN,
        "queue": store.queue_depth(),
    }


@app.get("/api/search")
def api_search(q: str, limit: int = 12):
    """YouTube 검색. Data API 키 없이 yt-dlp 로 처리한다.

    sync def 라 FastAPI 가 스레드풀에서 돌려주므로 이벤트 루프를 막지 않는다.
    """
    try:
        return {"query": q, "items": downloader.search(q, limit)}
    except DownloadError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/resolve")
def api_resolve(url: str):
    """다운로드 없이 제목만 조회 — 제목 입력란 자동 채우기용."""
    try:
        return downloader.probe_metadata(url)
    except DownloadError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/jobs", status_code=202)
def create_job(payload: dict = Body(...)):
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "url 이 필요합니다.")
    try:
        job = store.submit(
            url=url,
            fmt=payload.get("format", "both"),
            target=payload.get("target", "all"),
            save_original=bool(payload.get("save_original", True)),
            # 지정하면 이게 출력 폴더 이름 + 파일 접두사가 된다
            title_override=payload.get("title"),
            metronome=bool(payload.get("metronome", METRONOME_DEFAULT)),
            # '_no_*' 제외 믹스는 믹스다운으로 언제든 만들 수 있어 기본은 끔 (용량 절약)
            minus_mixes=bool(payload.get("minus_mixes", False)),
        )
    except (DownloadError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(429, str(e)) from e
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs():
    return {"jobs": store.list(), "queue": store.queue_depth()}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job.to_dict()


def _require_job(job_id: str, done: bool = False):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if done and job.status != "done":
        raise HTTPException(409, "완료된 작업에만 가능합니다.")
    return job


@app.get("/api/jobs/{job_id}/map")
def get_map(job_id: str):
    """곡 구성표와 거기서 파생된 박자.

    박자는 곡당 수백~수천 개라 작업 목록에 실으면 1초 폴링이 무거워진다.
    그래서 송 맵/믹서를 열 때만 따로 받아간다.
    """
    job = _require_job(job_id)
    store.ensure_versions(job)
    return {
        "map": job.songmap,
        "beats": job.beats,
        "accents": job.accents,
        "sounds": job.sounds,
        "bars": job.bars,
        "versions": [{"id": v["id"], "name": v["name"], "updated": v.get("updated")}
                     for v in job.map_versions],
        "active": job.map_active,
        "history": store.map_history(job),
        "markers": store.marker_times(job),
        "bpm": job.bpm,
        "duration": job.duration,
        "raw_bpm": job.raw_bpm,
        "octave_note": job.octave_note,
    }


@app.put("/api/jobs/{job_id}/map")
def put_map(job_id: str, payload: dict = Body(...)):
    """구성표를 저장하고 메트로놈을 다시 굽는다.

    구성표가 박자·마디·메트로놈·예비박의 단일 원천이다. 검출이 틀려도
    사용자가 첫 박 위치와 BPM 을 직접 잡으면 전부 해결된다.
    """
    job = _require_job(job_id, done=True)
    try:
        result = store.apply_map(job, payload.get("map") or payload)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {**result, "job": job.to_dict()}


@app.post("/api/jobs/{job_id}/map/detect")
def detect_map(job_id: str):
    """드럼 스템을 다시 분석해 기본 구성표를 만든다 (편집 출발점)."""
    job = _require_job(job_id, done=True)
    try:
        result = store.redetect_map(job)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {**result, "job": job.to_dict()}


@app.post("/api/jobs/{job_id}/map/align")
def align_map(job_id: str, payload: dict = Body(...)):
    """{map} — 편집 중인 구성표의 1마디 1박·고정 마디를 실제 타격에 맞춘 결과 (저장 안 함)."""
    job = _require_job(job_id, done=True)
    try:
        return store.align_map(job, payload.get("map") or payload)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/jobs/{job_id}/map/versions")
def create_map_version(job_id: str, payload: dict = Body(default={})):
    """새 구성표 버전을 만들고 활성화한다. 메트로놈 파일도 버전 이름으로 함께 구워진다."""
    job = _require_job(job_id, done=True)
    try:
        v = store.create_version(job, payload.get("name") or "새 버전",
                                 payload.get("map"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"version": {"id": v["id"], "name": v["name"]}, "job": job.to_dict()}


@app.post("/api/jobs/{job_id}/map/versions/{vid}/activate")
def activate_map_version(job_id: str, vid: str):
    job = _require_job(job_id, done=True)
    try:
        v = store.activate_version(job, vid)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"version": {"id": v["id"], "name": v["name"]}, "job": job.to_dict()}


@app.patch("/api/jobs/{job_id}/map/versions/{vid}")
def rename_map_version(job_id: str, vid: str, payload: dict = Body(...)):
    job = _require_job(job_id, done=True)
    try:
        v = store.rename_version(job, vid, payload.get("name"))
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"version": {"id": v["id"], "name": v["name"]}}


@app.delete("/api/jobs/{job_id}/map/versions/{vid}")
def delete_map_version(job_id: str, vid: str):
    job = _require_job(job_id, done=True)
    try:
        store.delete_version(job, vid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "active": job.map_active}


@app.post("/api/jobs/{job_id}/map/restore")
def restore_map(job_id: str, payload: dict = Body(...)):
    """이력에 보관된 이전 구성표로 되돌린다."""
    job = _require_job(job_id, done=True)
    try:
        result = store.restore_map(job, int(payload.get("index", -1)))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e)) from e
    return result


@app.get("/api/jobs/{job_id}/peaks")
def get_peaks(job_id: str, stem: str = "drums", buckets: int = 1600):
    """파형 표시용 피크. 원본을 브라우저에서 디코딩하지 않기 위한 것."""
    job = _require_job(job_id, done=True)
    allowed = {*STEMS, "original", "click"}
    if stem not in allowed:
        raise HTTPException(400, f"stem 은 {sorted(allowed)} 중 하나여야 합니다.")
    try:
        return store.peaks(job, stem=stem, buckets=buckets)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/jobs/{job_id}/mixdown")
def mixdown(job_id: str, payload: dict = Body(...)):
    """믹서에서 들리는 트랙만 합쳐 한 파일로 만든다."""
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if job.status != "done":
        raise HTTPException(409, "완료된 작업만 믹스할 수 있습니다.")

    stems = payload.get("stems") or []
    if not isinstance(stems, list) or not all(isinstance(s, str) for s in stems):
        raise HTTPException(400, "stems 는 문자열 배열이어야 합니다.")
    # 경로 조작 방지 — 알려진 키만 받는다
    allowed = {*STEMS, "click", *(f"no_{s}" for s in STEMS)}
    bad = [s for s in stems if s not in allowed]
    if bad:
        raise HTTPException(400, f"알 수 없는 트랙: {bad}")

    gains = payload.get("gains") or {}
    if not isinstance(gains, dict):
        raise HTTPException(400, "gains 는 객체여야 합니다.")

    try:
        count_in = int(payload.get("count_in") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "count_in 은 정수여야 합니다.")
    if not (0 <= count_in <= 16):
        raise HTTPException(400, "count_in 은 0~16 사이여야 합니다.")

    subdiv = payload.get("subdiv", 1)
    if subdiv not in (1, 2):
        raise HTTPException(400, "subdiv 는 1(4비트) 또는 2(8비트)여야 합니다.")

    try:
        result = store.mixdown(job, stems, fmt=payload.get("format", "mp3"),
                               gains=gains, count_in=count_in, subdiv=subdiv)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return result


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    try:
        found = store.delete(job_id)
    except RuntimeError as e:      # 진행 중인 작업
        raise HTTPException(409, str(e)) from e
    if not found:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    playlists.remove_job(job_id)
    return JSONResponse({"deleted": job_id})


# --- 악보 ---
# 곡 폴더의 score.pdf 와 그 분석 결과(_score.json, _score/page-N.png). scores.py 참고.

MAX_SCORE_BYTES = 30 * 1024 * 1024


def _score_dir(job_id: str) -> Path:
    job = _require_job(job_id, done=True)
    if not job.out_dir or not job.out_dir.exists():
        raise HTTPException(404, "결과 폴더가 없습니다.")
    return job.out_dir


def _score_payload(job_id: str, data: dict) -> dict:
    return {**data, "page_urls": [f"/api/jobs/{job_id}/score/pages/{i + 1}"
                                  for i in range(len(data.get("pages", [])))]}


@app.get("/api/jobs/{job_id}/score")
def get_score(job_id: str):
    d = _score_dir(job_id)
    data = scores.load(d)
    if data is None and (d / scores.SCORE_PDF).exists():
        data = scores.rebuild(d)          # PDF 만 넣어둔 경우 처음 볼 때 분석한다
    if data is None:
        raise HTTPException(404, "연결된 악보가 없습니다.")
    return _score_payload(job_id, data)


@app.put("/api/jobs/{job_id}/score")
async def put_score(job_id: str, request: Request):
    """악보 PDF 를 올린다 (본문 = PDF 그대로). 곡 폴더에 score.pdf 로 저장하고 분석한다."""
    d = _score_dir(job_id)
    body = await request.body()
    if not body.startswith(b"%PDF"):
        raise HTTPException(400, "PDF 파일이 아닙니다.")
    if len(body) > MAX_SCORE_BYTES:
        raise HTTPException(400, "악보 파일이 너무 큽니다 (30MB 까지).")
    tmp = d / (scores.SCORE_PDF + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(d / scores.SCORE_PDF)
    try:
        data = await asyncio.to_thread(scores.rebuild, d)
    except Exception as e:                 # 깨진 PDF 등
        raise HTTPException(400, f"악보를 읽지 못했습니다: {e}") from e
    job = store.get(job_id)
    job.files = store._scan_files(job, d)
    return _score_payload(job_id, data)


@app.post("/api/jobs/{job_id}/score/analyze")
def analyze_score(job_id: str):
    d = _score_dir(job_id)
    if not (d / scores.SCORE_PDF).exists():
        raise HTTPException(404, "연결된 악보가 없습니다.")
    data = scores.rebuild(d)
    job = store.get(job_id)
    job.files = store._scan_files(job, d)
    return _score_payload(job_id, data)


@app.delete("/api/jobs/{job_id}/score")
def delete_score(job_id: str):
    d = _score_dir(job_id)
    scores.remove(d)
    job = store.get(job_id)
    job.files = store._scan_files(job, d)
    return {"deleted": True}


@app.get("/api/jobs/{job_id}/score/pages/{n}")
def get_score_page(job_id: str, n: int):
    d = _score_dir(job_id)
    p = d / scores.SCORE_DIR / f"page-{n}.png"
    if n < 1 or not p.is_file():
        raise HTTPException(404, "페이지가 없습니다.")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "no-cache"})


# --- 플레이리스트 ---

@app.get("/api/playlists")
def list_playlists():
    try:
        return {"playlists": playlists.list()}
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e


@app.post("/api/playlists", status_code=201)
def create_playlist(payload: dict = Body(...)):
    try:
        return playlists.create(payload.get("name"), payload.get("items"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e


@app.put("/api/playlists/{pid}")
def update_playlist(pid: str, payload: dict = Body(...)):
    try:
        p = playlists.update(pid, payload.get("name"), payload.get("items"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e
    if not p:
        raise HTTPException(404, "플레이리스트를 찾을 수 없습니다.")
    return p


@app.delete("/api/playlists/{pid}")
def delete_playlist(pid: str):
    try:
        found = playlists.delete(pid)
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e
    if not found:
        raise HTTPException(404, "플레이리스트를 찾을 수 없습니다.")
    return {"deleted": pid}


# 브라우저가 <audio> 로 바로 재생할 수 있는 타입.
# mimetypes 는 .wav 를 audio/x-wav 로 추측하는데 audio/wav 가 표준에 가깝다.
_AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac"}


@app.get("/api/jobs/{job_id}/files/{rel:path}")
def get_file(job_id: str, rel: str, download: int = 0):
    """결과 파일 서빙.

    기본은 inline — <audio src=...> 로 바로 재생된다.
    ?download=1 이면 attachment 로 내려받는다.
    Starlette 의 FileResponse 가 Range 요청(206)을 처리하므로 탐색도 동작한다.
    """
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if not job.out_dir:
        raise HTTPException(404, "결과 폴더가 아직 없습니다.")

    # 폴더명이 한글/일본어일 수 있어 URL 에는 작업 ID 를 쓰고 여기서 실제 경로로 바꾼다
    root = job.out_dir.resolve()
    try:
        target = (root / rel).resolve()
        # 경로 탈출 차단: ../ 로 /data 밖이나 다른 작업 폴더를 읽지 못하게 한다.
        target.relative_to(root)
    except (ValueError, OSError):
        raise HTTPException(400, "잘못된 경로입니다.")

    if not target.is_file():
        raise HTTPException(404, "파일이 없습니다.")

    return FileResponse(
        target,
        media_type=_AUDIO_TYPES.get(target.suffix.lower()),
        filename=target.name,
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/")
def index():
    return RedirectResponse("/ui/")


# React 앱은 클라이언트 라우팅을 쓰므로, 정적 파일이 아니면 index.html 을 돌려준다.
class SPAStatic(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except Exception:
            return await super().get_response("index.html", scope)


app.mount("/ui", SPAStatic(directory=STATIC_DIR, html=True), name="ui")
