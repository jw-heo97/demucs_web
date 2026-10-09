"""FastAPI 서버.

인증은 없다. 이 앱은 `tailscale serve` 뒤에서만 쓰는 것을 전제로 하며, 접근 제어는
Tailscale 이 맡는다 — 내 tailnet 에 속한 기기만 접속할 수 있다. 컨테이너 포트는
127.0.0.1 에만 바인딩하므로(compose 의 WEB_BIND) LAN 이나 인터넷에서는 직접 닿지 않는다.
"""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import access
import downloader
import lock as song_lock
import scores
import separator
import together
import tracks as user_tracks
from config import TOGETHER_ENABLED, CORS_ORIGINS, MAX_DURATION_SEC, METRONOME_DEFAULT, OUTPUT_DIR, WORK_DIR
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
    # 예전 곡들의 재생용 mp3 를 뒤에서 채운다 (wav 만 있으면 기기 저장이 너무 크다)
    threading.Thread(target=store.backfill_playback_mp3, name="mp3-backfill", daemon=True).start()
    try:
        yield
    finally:
        store.stop()


app = FastAPI(title="Demucs Web", version="2.0.0", lifespan=lifespan)

# 접속자 기록 + funnel·다른 계정 차단 (app/access.py)
app.middleware("http")(access.middleware)


def _guard(job_id: str, who: dict, dv) -> bool:
    """볼 수 없는 곡의 경로(/api/jobs/{id}/…)는 미들웨어가 404 로 막는다. 없는 곡은 각 엔드포인트가 404."""
    j = store.get(job_id)
    return j is None or access.can_see(j.owner, j.owner_link, j.shared_links, who, dv)


access.job_guard = _guard

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


@app.get("/api/me")
def api_me(request: Request):
    """지금 접속한 경로와 관리 화면을 볼 수 있는지 (탭 표시용)."""
    who = getattr(request.state, "who", None) or access.classify(request)
    dv = getattr(request.state, "device", None)
    return {"via": who["via"], "login": who["login"], "admin": access.is_admin(who),
            "can_edit": access.can_edit(who, dv),
            "key": access.owner_key(who, dv), "name": access.owner_name(who, dv),
            "device": dv["name"] if dv else None,
            "link": access.link_of(dv),
            # 보관함에서 곡을 공유할 링크를 고를 때 쓴다 (관리자만)
            "links": [{"id": x["id"], "label": x["label"]} for x in access.store.links()]
            if access.is_admin(who) else []}


# --- 접속자 관리 (허용 계정의 tailnet 기기·이 PC 만 — 미들웨어가 /api/admin/* 를 막는다) ---
def _link_url(request: Request, code: str) -> str:
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    # tailnet 으로 들어왔으면 그 주소(…ts.net)가 funnel 주소와 같다. 이 PC 에서 직접이면 모른다
    # (화면이 지금 주소를 앞에 붙인다).
    if not host or host.startswith(("127.0.0.1", "localhost")):
        return f"{access.JOIN_PREFIX}{code}"
    return f"https://{host}{access.JOIN_PREFIX}{code}"


def _links(request: Request) -> list[dict]:
    jobs = store.list()
    return [{**ln, "url": _link_url(request, ln["code"]),
             "songs": sum(1 for j in jobs if ln["id"] in j["shared_links"]),
             "own_songs": sum(1 for j in jobs if j["owner_link"] == ln["id"])}
            for ln in access.store.links()]


@app.get("/api/admin/access")
def admin_access(request: Request):
    return {"devices": access.store.devices(), "links": _links(request),
            "clients": access.recent_clients(),
            "allow_users": sorted(access.TAILSCALE_ALLOW_USERS)}


@app.post("/api/admin/links")
def admin_link_create(request: Request, payload: dict = Body(default={})):
    """{label, password, role?} — 여러 사람이 같이 쓰는 접속 링크. 들어올 때 이름과 비밀번호를 넣는다."""
    try:
        ln = access.store.create_link(payload.get("label") or "", payload.get("password") or "",
                                      payload.get("role") or "view")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {**ln, "url": _link_url(request, ln["code"])}


@app.patch("/api/admin/links/{lid}")
def admin_link_update(request: Request, lid: str, payload: dict = Body(...)):
    """{label?, password?, role?}  role 은 앞으로 이 링크로 등록할 기기에만 적용된다."""
    try:
        ln = access.store.update_link(lid, payload.get("label"), payload.get("password"), payload.get("role"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError:
        raise HTTPException(404, "그 링크를 찾을 수 없습니다.")
    return {**ln, "url": _link_url(request, ln["code"])}


@app.put("/api/admin/links/{lid}/songs")
def admin_link_songs(lid: str, payload: dict = Body(...)):
    """{jobs: [id…]} — 이 링크에 공유할 곡을 통째로 정한다 (목록에 없는 곡은 공유 해제)."""
    if not any(x["id"] == lid for x in access.store.links()):
        raise HTTPException(404, "그 링크를 찾을 수 없습니다.")
    want = set(payload.get("jobs") or [])
    for j in store.all_jobs():
        has = lid in j.shared_links
        if (j.id in want) != has:
            store.set_shared(j, [x for x in j.shared_links if x != lid] + ([lid] if j.id in want else []))
    return {"ok": True, "songs": len(want)}


@app.put("/api/admin/jobs/{job_id}/share")
def admin_job_share(job_id: str, payload: dict = Body(...)):
    """{links: [id…]} — 이 곡을 볼 수 있는 접속 링크를 통째로 정한다."""
    job = _require_job(job_id)
    known = {x["id"] for x in access.store.links()}
    links = [x for x in payload.get("links") or [] if x in known]
    store.set_shared(job, links)
    return job.to_dict()


@app.delete("/api/admin/links/{lid}")
def admin_link_delete(lid: str):
    try:
        access.store.delete_link(lid)
    except KeyError:
        raise HTTPException(404, "그 링크를 찾을 수 없습니다.")
    return {"ok": True}


@app.patch("/api/admin/devices/{did}")
def admin_device_update(did: str, payload: dict = Body(...)):
    """{name?, blocked?, role?}  role: view | edit"""
    try:
        return access.store.update(did, payload.get("name"),
                                   payload.get("blocked") if "blocked" in payload else None,
                                   payload.get("role"))
    except KeyError:
        raise HTTPException(404, "그 기기를 찾을 수 없습니다.")


@app.delete("/api/admin/devices/{did}")
def admin_device_delete(did: str):
    """등록 해제 — 그 기기는 접속 링크로 다시 등록해야 들어온다."""
    try:
        access.store.delete(did)
    except KeyError:
        raise HTTPException(404, "그 기기를 찾을 수 없습니다.")
    return {"ok": True}


@app.websocket("/api/together/{job_id}")
async def together_ws(ws: WebSocket, job_id: str):
    """함께 연습 — 같은 곡을 여러 기기에서 같은 순간에 재생한다 (app/together.py).
    아직 다듬는 중이라 TOGETHER=1 일 때만 연다."""
    if not TOGETHER_ENABLED:
        await ws.close(code=4410)
        return
    if store.get(job_id) is None:
        await ws.close(code=4404)
        return
    await together.handle(ws, job_id)


@app.get("/api/info")
def api_info():
    return {
        **separator.model_info(),
        "formats": list(FORMATS),
        "stems": list(STEMS),
        "max_duration_sec": MAX_DURATION_SEC,
        "max_title_len": MAX_TITLE_LEN,
        "queue": store.queue_depth(),
        "build": _build_id(),
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
def create_job(request: Request, payload: dict = Body(...)):
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
            # 누가 만들었나 — 같은 접속 링크 사람들끼리 이 곡을 본다
            owner=access.owner_key(*_who(request)),
            owner_name=access.owner_name(*_who(request)),
            owner_link=access.link_of(_who(request)[1]),
        )
    except (DownloadError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(429, str(e)) from e
    return job.to_dict()


def _job_visible(j: dict, who: dict, dv) -> bool:
    return access.can_see(j.get("owner"), j.get("owner_link"), j.get("shared_links"), who, dv)


def _for_viewer(j: dict, who: dict) -> dict:
    # 어느 링크에 공유했는지는 관리자만 안다
    return j if access.is_admin(who) else {**j, "shared_links": []}


@app.get("/api/jobs")
def list_jobs(request: Request):
    """볼 수 있는 곡만 (access.can_see). 같은 링크 사람이 만든 곡 + 관리자가 공유한 곡."""
    who, dv = _who(request)
    jobs = [_for_viewer(j, who) for j in store.list() if _job_visible(j, who, dv)]
    return {"jobs": jobs, "queue": store.queue_depth()}


@app.get("/api/jobs/{job_id}")
def get_job(request: Request, job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return _for_viewer(job.to_dict(), _who(request)[0])


def _require_job(job_id: str, done: bool = False, unlocked: bool = False):
    """unlocked: 활성 송 맵 버전이 잠겨 있으면 423 (덮어쓰는 요청에)."""
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    if done and job.status != "done":
        raise HTTPException(409, "완료된 작업에만 가능합니다.")
    if unlocked and store._active_locked(job):
        raise HTTPException(423, "잠긴 송 맵 버전입니다. '새 버전' 으로 복사해서 편집하거나 잠금을 푸세요.")
    return job


def _who(request: Request):
    who = getattr(request.state, "who", None) or access.classify(request)
    dv = getattr(request.state, "device", None)
    return who, dv


def _version_or_404(job, vid: str) -> dict:
    v = next((x for x in job.map_versions if x["id"] == vid), None)
    if not v:
        raise HTTPException(404, "그 버전을 찾을 수 없습니다.")
    return v


def _check_pin(job_id: str, v: dict, pin: str, who_key: str) -> None:
    left = song_lock.locked_out(job_id + ":" + v["id"], who_key)
    if left:
        raise HTTPException(429, f"PIN 을 여러 번 틀렸습니다. {left}초 뒤에 다시 해 보세요.")
    if not song_lock.check_pin(v.get("pin_hash"), pin):
        n = song_lock.record_fail(job_id + ":" + v["id"], who_key)
        raise HTTPException(403, f"PIN 이 틀립니다. (남은 기회 {n}번)" if n else
                            f"PIN 을 {song_lock.MAX_FAILS}번 틀려 {song_lock.LOCK_SEC // 60}분 동안 막힙니다.")
    song_lock.clear_fails(job_id + ":" + v["id"], who_key)


# --- 송 맵 버전 잠금 · PIN (app/lock.py) ---
@app.post("/api/jobs/{job_id}/map/versions/{vid}/lock")
def lock_version(job_id: str, vid: str, request: Request, payload: dict = Body(...)):
    """{locked: true, pin?} 잠그기 — 만든 사람·관리자. pin 을 주면 풀 때 그 PIN 이 필요하다(주인도).
    {locked: false, pin?} 풀기 — PIN 이 있으면 PIN 으로 누구든(수정 가능 기기), 없으면 만든 사람·관리자만.
    풀면 PIN 도 지워진다 (다시 잠글 때 새로 정한다)."""
    job = _require_job(job_id, done=True)
    v = _version_or_404(job, vid)
    who, dv = _who(request)
    owner = access.is_owner(v.get("owner"), who, dv)
    if payload.get("locked"):
        if not owner:
            raise HTTPException(403, "이 버전을 만든 사람만 잠글 수 있습니다.")
        pin = str(payload.get("pin") or "").strip()
        if pin:
            try:
                v["pin_hash"] = song_lock.hash_pin(song_lock.normalize_pin(pin))
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
        else:
            v["pin_hash"] = None
        v["locked"] = True
    else:
        if v.get("pin_hash"):
            _check_pin(job_id, v, str(payload.get("pin") or ""), access.owner_key(who, dv))
        elif not owner:
            raise HTTPException(403, "이 버전을 만든 사람만 풀 수 있습니다 (PIN 이 없습니다).")
        v["locked"] = False
        v["pin_hash"] = None
    store._save_meta(job)
    print(f"[lock] {job.folder} / {v['name']}: {'잠금' if v['locked'] else '해제'} by {access.owner_name(who, dv)}", flush=True)
    return {"version": store.version_view(v), "job": job.to_dict()}


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
        "versions": [store.version_view(v) for v in job.map_versions],
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
    job = _require_job(job_id, done=True, unlocked=True)
    try:
        result = store.apply_map(job, payload.get("map") or payload)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {**result, "job": job.to_dict()}


@app.post("/api/jobs/{job_id}/map/detect")
def detect_map(job_id: str):
    """드럼 스템을 다시 분석해 기본 구성표를 만든다 (편집 출발점)."""
    job = _require_job(job_id, done=True, unlocked=True)
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
def create_map_version(job_id: str, request: Request, payload: dict = Body(default={})):
    """새 구성표 버전을 만들고 활성화한다. 메트로놈 파일도 버전 이름으로 함께 구워진다.
    잠긴 버전이 활성이어도 된다 — 잠긴 것을 복사해 내 버전으로 편집하는 길이다."""
    job = _require_job(job_id, done=True)
    who, dv = _who(request)
    try:
        v = store.create_version(job, payload.get("name") or "새 버전",
                                 payload.get("map"), access.owner_key(who, dv), access.owner_name(who, dv))
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
    if _version_or_404(job, vid).get("locked"):
        raise HTTPException(423, "잠긴 송 맵 버전입니다. 잠금을 풀어야 바꿀 수 있습니다.")
    try:
        v = store.rename_version(job, vid, payload.get("name"))
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"version": {"id": v["id"], "name": v["name"]}}


@app.delete("/api/jobs/{job_id}/map/versions/{vid}")
def delete_map_version(job_id: str, vid: str):
    job = _require_job(job_id, done=True)
    if _version_or_404(job, vid).get("locked"):
        raise HTTPException(423, "잠긴 송 맵 버전입니다. 잠금을 풀어야 바꿀 수 있습니다.")
    try:
        store.delete_version(job, vid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "active": job.map_active}


@app.post("/api/jobs/{job_id}/map/restore")
def restore_map(job_id: str, payload: dict = Body(...)):
    """이력에 보관된 이전 구성표로 되돌린다."""
    job = _require_job(job_id, done=True, unlocked=True)
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
def delete_job(request: Request, job_id: str):
    j = store.get(job_id)
    who, dv = _who(request)
    # 공유받은 곡(관리자·같은 링크의 다른 사람이 만든 곡)은 지울 수 없다. 주인 없는 예전 곡은 관리자 것
    if j and not access.is_admin(who) and dv is not None and j.owner != access.owner_key(who, dv):
        raise HTTPException(403, "내가 만든 곡만 지울 수 있습니다.")
    if j and any(v.get("locked") for v in j.map_versions):
        raise HTTPException(423, "잠긴 송 맵 버전이 있는 곡은 지울 수 없습니다. 먼저 잠금을 푸세요.")
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
MAX_TRACK_BYTES = 200 * 1024 * 1024

# 올린 파일의 Content-Type → 임시 확장자 (ffmpeg 가 알아서 읽지만 확장자가 있으면 더 잘 고른다)
_AUDIO_EXT = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
              "audio/wave": ".wav", "audio/webm": ".webm", "video/webm": ".webm", "audio/ogg": ".ogg",
              "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac",
              "audio/x-flac": ".flac", "video/mp4": ".mp4"}


# --- 사용자 트랙 (녹음·반주를 믹서에 올린다, MTR) ---
@app.post("/api/jobs/{job_id}/tracks", status_code=201)
async def add_track(job_id: str, request: Request, name: str = "", offset_ms: float = 0):
    """본문 = 오디오 파일 그대로. ?name= ?offset_ms= 로 이름·시작 위치. mp3 로 변환해 넣는다."""
    job = _require_job(job_id, done=True)
    if not job.out_dir or not job.out_dir.exists():
        raise HTTPException(404, "결과 폴더가 없습니다.")
    body = await request.body()
    if len(body) < 100:
        raise HTTPException(400, "오디오 파일이 비어 있습니다.")
    if len(body) > MAX_TRACK_BYTES:
        raise HTTPException(400, "파일이 너무 큽니다 (200MB 까지).")
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    ext = _AUDIO_EXT.get(ctype, "")
    try:
        item = await asyncio.to_thread(user_tracks.add, job.out_dir, body, ext, name, offset_ms)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    job.files = store._scan_files(job, job.out_dir)
    return {"track": item, "job": job.to_dict()}


@app.patch("/api/jobs/{job_id}/tracks/{tid}")
def update_track(job_id: str, tid: str, payload: dict = Body(...)):
    """{name?, offset_ms?}"""
    job = _require_job(job_id, done=True)
    try:
        item = user_tracks.update(job.out_dir, tid, payload.get("name"),
                                  payload.get("offset_ms") if "offset_ms" in payload else None)
    except KeyError:
        raise HTTPException(404, "그 트랙을 찾을 수 없습니다.")
    return {"track": item, "job": job.to_dict()}


@app.delete("/api/jobs/{job_id}/tracks/{tid}")
def delete_track(job_id: str, tid: str):
    job = _require_job(job_id, done=True)
    try:
        user_tracks.remove(job.out_dir, tid)
    except KeyError:
        raise HTTPException(404, "그 트랙을 찾을 수 없습니다.")
    job.files = store._scan_files(job, job.out_dir)
    return {"job": job.to_dict()}



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

def _visible_ids(who: dict, dv) -> set[str]:
    return {j["id"] for j in store.list() if _job_visible(j, who, dv)}


def _pl_mine(p: dict, who: dict, dv) -> bool:
    """이 플레이리스트를 바꿀 수 있는가: 관리자, 만든 사람, 같은 링크 사람."""
    if access.is_admin(who) or dv is None:
        return True
    return (bool(p.get("owner")) and p["owner"] == access.owner_key(who, dv)) \
        or (bool(access.link_of(dv)) and p.get("owner_link") == access.link_of(dv))


def _pl_view(p: dict, who: dict, dv, ids: set[str]):
    """보이는 플레이리스트면 볼 수 있는 곡만 남겨 돌려준다. 남의(관리자) 플레이리스트는
    보이는 곡이 하나라도 있을 때만 보인다."""
    items = [x for x in p.get("items", []) if x in ids]
    mine = _pl_mine(p, who, dv)
    if not mine and not items:
        return None
    return {**p, "items": items, "readonly": not mine}


@app.get("/api/playlists")
def list_playlists(request: Request):
    who, dv = _who(request)
    try:
        ids = _visible_ids(who, dv)
        return {"playlists": [v for p in playlists.list() if (v := _pl_view(p, who, dv, ids))]}
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e


def _pl_guard(pid: str, who: dict, dv, items=None):
    """바꿀 수 있는지 확인하고, 이 사람이 못 보는 곡은 목록을 바꿔도 지워지지 않게 되붙인다."""
    p = next((x for x in playlists.list() if x["id"] == pid), None)
    if p is None:
        raise HTTPException(404, "플레이리스트를 찾을 수 없습니다.")
    if not _pl_mine(p, who, dv):
        raise HTTPException(403, "다른 사람이 만든 플레이리스트는 바꿀 수 없습니다.")
    if items is None or access.is_admin(who):
        return items
    ids = _visible_ids(who, dv)
    return list(items) + [x for x in p.get("items", []) if x not in ids]


@app.post("/api/playlists", status_code=201)
def create_playlist(request: Request, payload: dict = Body(...)):
    who, dv = _who(request)
    try:
        return playlists.create(payload.get("name"), payload.get("items"),
                                owner=access.owner_key(who, dv), owner_link=access.link_of(dv))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e


@app.put("/api/playlists/{pid}")
def update_playlist(request: Request, pid: str, payload: dict = Body(...)):
    who, dv = _who(request)
    items = _pl_guard(pid, who, dv, payload.get("items"))
    try:
        p = playlists.update(pid, payload.get("name"), items)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e
    if not p:
        raise HTTPException(404, "플레이리스트를 찾을 수 없습니다.")
    return p


@app.delete("/api/playlists/{pid}")
def delete_playlist(request: Request, pid: str):
    _pl_guard(pid, *_who(request))
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


@app.get("/manifest.webmanifest")
def web_manifest(request: Request):
    """홈 화면에 추가할 때 쓰는 설정. start_url 이 기기마다 다르다 (access.start_url)."""
    dv = getattr(request.state, "device", None)
    return JSONResponse({
        "name": "Demucs Web", "short_name": "Demucs",
        "start_url": access.start_url(request, dv), "scope": "/",
        "display": "standalone", "background_color": "#12141a", "theme_color": "#12141a",
    }, media_type="application/manifest+json", headers={"Cache-Control": "no-store"})


@app.get("/")
def index():
    return RedirectResponse("/ui/")


# React 앱은 클라이언트 라우팅을 쓰므로, 정적 파일이 아니면 index.html 을 돌려준다.
#
# 캐시: index.html 은 매번 서버에 확인(no-cache) — 예전엔 캐시 지시가 없어 Safari 가
# 예전 페이지를 재사용했고, 배포해도 예전 화면 코드가 돌았다. 파일 이름에 해시가 붙은
# assets/* 는 내용이 바뀌면 이름이 바뀌므로 오래 캐시해도 된다.
class SPAStatic(StaticFiles):
    async def get_response(self, path, scope):
        try:
            resp = await super().get_response(path, scope)
        except Exception:
            resp = await super().get_response("index.html", scope)
            path = "index.html"
        if path.startswith("assets/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            resp.headers["Cache-Control"] = "no-cache"
        return resp


def _build_id() -> str:
    """지금 배포된 화면의 빌드 id (index.html 이 부르는 해시 붙은 js 이름). 화면이 자기 것과 비교해
    다르면 '새 버전이 있습니다' 를 띄운다."""
    try:
        import re as _re
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        m = _re.search(r"assets/(index-[\w-]+\.js)", html)
        return m.group(1) if m else ""
    except OSError:
        return ""


app.mount("/ui", SPAStatic(directory=STATIC_DIR, html=True), name="ui")
