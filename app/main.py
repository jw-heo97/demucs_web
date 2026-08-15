"""FastAPI 서버.

이 컨테이너는 포트를 직접 노출하지 않는다. compose 에서 Caddy 뒤에만 붙이고,
IP 화이트리스트는 Caddy 가 처리한다. (main.py 에 IP 필터를 두면 프록시 헤더를
믿어야 해서 위조가 가능해진다.)
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import auth
import downloader
import separator
from config import (
    BEATS_PER_BAR,
    CORS_ORIGINS,
    MAX_DURATION_SEC,
    METRONOME_DEFAULT,
    OUTPUT_DIR,
    REQUIRE_ROLE,
    SESSION_DAYS,
    WORK_DIR,
)
from downloader import DownloadError
from jobs import FORMATS, MAX_TITLE_LEN, STEMS, store

STATIC_DIR = Path(__file__).parent / "static"
COOKIE_NAME = "demucs_session"

# 인증 없이 접근 가능한 경로. 그 외는 전부 토큰이 필요하다.
PUBLIC_PATHS = {"/healthz", "/api/auth/login", "/favicon.ico"}
# React 앱은 로그인 화면도 같은 번들이라 /ui 정적 자산은 열어두고,
# 실제 데이터는 전부 /api 에서 막는다.
PUBLIC_PREFIXES = ("/ui/assets/", "/ui/login")

# 접속 기록을 남길 요청. 1초마다 도는 폴링(GET /api/jobs)까지 남기면
# 로그가 순식간에 쓸모없어지므로, 상태를 바꾸거나 파일을 가져가는 요청만 남긴다.
def _should_log(method: str, path: str) -> bool:
    if method != "GET":
        return True
    return "/files/" in path


@asynccontextmanager
async def lifespan(app: FastAPI):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    auth.store.load()
    generated = auth.store.bootstrap()
    if generated:
        print("=" * 64, flush=True)
        print(f"  관리자 계정이 생성되었습니다.", flush=True)
        print(f"    아이디   : {auth.ADMIN_USER}", flush=True)
        print(f"    비밀번호 : {generated}", flush=True)
        print(f"  이 비밀번호는 다시 표시되지 않습니다. 로그인 후 변경하세요.", flush=True)
        print("=" * 64, flush=True)

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
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(COOKIE_NAME, "")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
        return await call_next(request)

    ip = auth.client_ip(request)
    ua = request.headers.get("user-agent", "")
    identity = auth.store.verify_token(_bearer(request), ip=ip, ua=ua)

    if not identity:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "인증이 필요합니다."}, status_code=401)
        return RedirectResponse("/ui/login", status_code=303)

    # 역할 게이트 — 기본값 REQUIRE_ROLE=admin 이면 관리자 계정만 화면을 볼 수 있다.
    if not auth.role_allowed(identity.get("role", "user")):
        auth.store.log_event("forbidden", user=identity["user"], ip=ip, path=path)
        if path.startswith("/api/"):
            return JSONResponse(
                {"detail": f"이 계정에는 접근 권한이 없습니다 (필요 역할: {REQUIRE_ROLE})."},
                status_code=403)
        return JSONResponse({"detail": "접근 권한이 없습니다."}, status_code=403)

    request.state.identity = identity
    request.state.client_ip = ip
    response = await call_next(request)

    if _should_log(request.method, path):
        auth.store.log_event(
            "access", user=identity["user"], ip=ip,
            method=request.method, path=path,
            status=response.status_code, token=identity["label"], ua=ua[:160],
        )
    return response


@app.get("/healthz")
def healthz():
    return {"ok": True, "queue": store.queue_depth()}


# --------------------------------------------------------------------------
# 인증
# --------------------------------------------------------------------------
@app.post("/api/auth/login")
def login(request: Request, response: Response, payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    ip = auth.client_ip(request)
    ua = request.headers.get("user-agent", "")

    locked = auth.store.locked_for(username)
    if locked:
        auth.store.log_event("login_locked", user=username, ip=ip, ua=ua[:160])
        raise HTTPException(429, f"로그인 시도가 많아 잠겼습니다. {locked}초 후 다시 시도하세요.")

    if not auth.store.authenticate(username, password):
        auth.store.log_event("login_fail", user=username, ip=ip, ua=ua[:160])
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")

    role = auth.store.role_of(username)
    if not auth.role_allowed(role):
        auth.store.log_event("login_forbidden", user=username, ip=ip, detail=role)
        raise HTTPException(403, f"이 계정에는 접근 권한이 없습니다 (필요 역할: {REQUIRE_ROLE}).")

    token, tid = auth.store.create_token(username, kind="session", ua=ua, ip=ip)
    auth.store.log_event("login_ok", user=username, ip=ip, ua=ua[:160], token=tid)

    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,          # JS 에서 못 읽으므로 XSS 로 토큰이 새지 않는다
        samesite="lax",
        path="/",
    )
    # 앱(Capacitor/Tauri)은 쿠키를 못 쓰는 경우가 있어 토큰 원문도 함께 준다.
    return {"username": username, "token_id": tid, "role": role, "token": token}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    ident = request.state.identity
    auth.store.revoke_token(ident["user"], ident["token_id"])
    auth.store.log_event("logout", user=ident["user"], ip=request.state.client_ip)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    ident = request.state.identity
    return {
        "username": ident["user"],
        "token_id": ident["token_id"],
        "role": ident.get("role", "user"),
        "is_admin": ident.get("role") == "admin",
        "kind": ident["kind"],
        "client_ip": request.state.client_ip,
        "ip_trustworthy": auth.ip_is_meaningful(),
    }


@app.post("/api/auth/password")
def change_password(request: Request, payload: dict = Body(...)):
    ident = request.state.identity
    try:
        auth.store.change_password(ident["user"],
                                   payload.get("old") or "", payload.get("new") or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "note": "비밀번호가 변경되어 모든 세션이 해제되었습니다. 다시 로그인하세요."}


def _require_admin(request: Request) -> dict:
    ident = request.state.identity
    if ident.get("role") != "admin":
        raise HTTPException(403, "관리자만 할 수 있습니다.")
    return ident


@app.get("/api/auth/tokens")
def list_tokens(request: Request):
    ident = request.state.identity
    return {"current": ident["token_id"], "tokens": auth.store.list_tokens(ident["user"])}


@app.post("/api/auth/tokens")
def create_token(request: Request, payload: dict = Body(default={})):
    """API 토큰 발급. 원문은 이 응답에서 한 번만 볼 수 있다."""
    ident = request.state.identity
    label = (payload.get("label") or "").strip()[:60] or "API 토큰"
    days = int(payload.get("days") or 0)
    token, tid = auth.store.create_token(
        ident["user"], kind="api", label=label, days=days,
        ip=request.state.client_ip, ua=request.headers.get("user-agent", ""))
    auth.store.log_event("token_create", user=ident["user"],
                         ip=request.state.client_ip, token=tid, detail=label)
    return {"token": token, "id": tid, "label": label}


@app.delete("/api/auth/tokens/{tid}")
def revoke_token(request: Request, tid: str):
    ident = request.state.identity
    if not auth.store.revoke_token(ident["user"], tid):
        raise HTTPException(404, "토큰을 찾을 수 없습니다.")
    auth.store.log_event("token_revoke", user=ident["user"],
                         ip=request.state.client_ip, token=tid)
    return {"ok": True}


@app.get("/api/auth/log")
def access_log(request: Request, limit: int = 200):
    # 다른 사용자의 접속까지 보이므로 관리자만
    _require_admin(request)
    return {
        "entries": auth.store.read_log(max(1, min(limit, 1000))),
        "ip_trustworthy": auth.ip_is_meaningful(),
    }


# --------------------------------------------------------------------------
# 계정 관리 (관리자 전용)
# --------------------------------------------------------------------------
@app.get("/api/auth/users")
def list_users(request: Request):
    _require_admin(request)
    return {"users": auth.store.list_users(), "require_role": REQUIRE_ROLE}


@app.post("/api/auth/users")
def create_user(request: Request, payload: dict = Body(...)):
    _require_admin(request)
    try:
        u = auth.store.create_user(payload.get("username") or "",
                                   payload.get("password") or "",
                                   payload.get("role") or "user")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return u


@app.patch("/api/auth/users/{username}")
def update_user(request: Request, username: str, payload: dict = Body(...)):
    _require_admin(request)
    try:
        if payload.get("role"):
            auth.store.set_role(username, payload["role"])
        if payload.get("password"):
            auth.store.reset_password(username, payload["password"])
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "username": username, "role": auth.store.role_of(username)}


@app.delete("/api/auth/users/{username}")
def delete_user(request: Request, username: str):
    ident = _require_admin(request)
    if username == ident["user"]:
        raise HTTPException(400, "자기 계정은 삭제할 수 없습니다.")
    try:
        auth.store.delete_user(username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


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

    try:
        result = store.mixdown(job, stems, fmt=payload.get("format", "mp3"),
                               gains=gains, count_in=count_in)
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
    return JSONResponse({"deleted": job_id})


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
