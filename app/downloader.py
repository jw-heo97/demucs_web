"""yt-dlp 래퍼.

원본 download.py 의 정규식 r'(?:v=|\\/)([0-9A-Za-z_-]{11}).*' 은 URL 안의 다른 '/' 구간에
먼저 걸릴 수 있어서(특히 shorts/live/채널 경로) 패턴을 형태별로 분리했다.
Windows ffmpeg 절대경로 하드코딩도 전부 제거 — 컨테이너 PATH 의 ffmpeg 를 쓴다.
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import yt_dlp

from config import COOKIES_FILE, YTDLP_CLIENTS

_ID = r"[0-9A-Za-z_-]{11}"

_PATTERNS = [
    re.compile(r"youtube\.com/watch\?(?:[^#]*&)?v=(" + _ID + r")"),
    re.compile(r"youtu\.be/(" + _ID + r")"),
    re.compile(r"youtube\.com/(?:embed|shorts|live|v)/(" + _ID + r")"),
    re.compile(r"^(" + _ID + r")$"),
]


class DownloadError(RuntimeError):
    pass


def _base_opts() -> dict:
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 20}
    if COOKIES_FILE and COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    return opts


# --- 검색 결과 캐시 -------------------------------------------------------
# 같은 검색어를 반복해서 YouTube 에 던지지 않도록 짧게 캐싱한다.
# (봇 탐지에 걸릴 위험을 줄이는 목적도 있다)
_CACHE_TTL = 300.0
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (time.time() - hit[0]) < _CACHE_TTL:
            return hit[1]
        _cache.pop(key, None)
    return None


def _cache_put(key: str, value) -> None:
    with _cache_lock:
        if len(_cache) > 200:
            _cache.clear()
        _cache[key] = (time.time(), value)


def extract_video_id(url_or_id: str) -> str:
    s = (url_or_id or "").strip()
    for pat in _PATTERNS:
        m = pat.search(s)
        if m:
            return m.group(1)
    raise DownloadError(f"YouTube 영상 ID를 인식하지 못했습니다: {s[:120]!r}")


def search(query: str, limit: int = 12) -> list[dict]:
    """YouTube 검색. Data API 키가 필요 없다 — yt-dlp 의 ytsearch 를 쓴다.

    extract_flat 이라 개별 영상 페이지를 열지 않아 빠르다(결과 12개에 1초 내외).
    """
    query = (query or "").strip()
    if not query:
        raise DownloadError("검색어를 입력하세요.")
    limit = max(1, min(int(limit), 25))

    key = f"search:{limit}:{query}"
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    opts = {**_base_opts(), "extract_flat": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            res = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(f"검색 실패: {str(e)[:300]}") from e

    items = []
    for e in (res or {}).get("entries") or []:
        vid = e.get("id")
        if not vid or len(vid) != 11:
            continue
        items.append({
            "video_id": vid,
            "title": e.get("title") or vid,
            "channel": e.get("channel") or e.get("uploader"),
            "duration": float(e.get("duration") or 0),
            "view_count": e.get("view_count"),
            "live": e.get("live_status") in ("is_live", "is_upcoming"),
            # i.ytimg.com 은 안정적인 썸네일 CDN 이다 (브라우저가 직접 받는다)
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
        })

    _cache_put(key, items)
    return items


def probe_metadata(url_or_id: str) -> dict:
    """다운로드 없이 제목/길이만 조회한다. 제목 입력란 자동 채우기에 쓴다."""
    video_id = extract_video_id(url_or_id)

    key = f"meta:{video_id}"
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    opts = {**_base_opts(), "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(f"영상 정보 조회 실패: {str(e)[:300]}") from e

    data = {
        "video_id": video_id,
        "title": info.get("title") or video_id,
        "channel": info.get("channel") or info.get("uploader"),
        "duration": float(info.get("duration") or 0),
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
        # 소유자가 외부 사이트 재생을 막았는지. 미리보기 실패를 미리 알려주는 용도이며
        # 이 값이 False 여도 다운로드/분리는 정상 동작한다.
        "playable_in_embed": info.get("playable_in_embed"),
        "availability": info.get("availability"),
        # 진행 중/예정 방송. 길이가 없거나 무한이라 다운로드를 시작하면 끝나지 않는다.
        "live": bool(info.get("is_live"))
        or info.get("live_status") in ("is_live", "is_upcoming"),
    }
    _cache_put(key, data)
    return data


def download_audio(
    video_id: str,
    work_dir: Path,
    progress_cb: Optional[Callable[[float, str], None]] = None,
) -> dict:
    """bestaudio 를 원본 컨테이너 그대로 받는다.

    postprocessor(FFmpegExtractAudio) 를 쓰지 않는 이유: 어차피 audio_io.decode() 가
    ffmpeg 로 모델 샘플레이트에 맞춰 디코딩하므로 wav 로 중간 변환하면 디스크만 낭비된다.
    """
    work_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if not progress_cb:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            frac = (done / total) if total else 0.0
            progress_cb(min(frac, 1.0), "다운로드 중")
        elif d.get("status") == "finished":
            progress_cb(1.0, "다운로드 완료")

    base = {
        **_base_opts(),
        "format": "bestaudio/best",
        "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
        "noprogress": True,
        "progress_hooks": [hook],
        "retries": 3,
        "socket_timeout": 30,
    }

    url = f"https://www.youtube.com/watch?v={video_id}"

    # YouTube 는 기본(web) 클라이언트에 PO 토큰을 요구하며 403 을 주는 일이 잦다.
    # 정보 조회는 되는데 다운로드만 막히는 형태라, 클라이언트를 바꿔가며 재시도한다.
    info = None
    path = None
    last = None
    tried = []
    for client in YTDLP_CLIENTS:
        opts = dict(base)
        if client:
            opts["extractor_args"] = {"youtube": {"player_client": [client]}}
        tried.append(client or "default")
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                path = Path(ydl.prepare_filename(info))
            break
        except yt_dlp.utils.DownloadError as e:
            msg = str(e)
            last = msg
            low = msg.lower()
            if "confirm you" in low or "not a bot" in low:
                raise DownloadError(
                    "YouTube 봇 확인에 걸렸습니다. 쿠키 파일이 필요합니다 "
                    "(secrets/cookies.txt 마운트 후 COOKIES_FILE 설정)."
                ) from e
            # 403/차단 계열이면 다음 클라이언트로 넘어간다
            if any(k in low for k in ("403", "forbidden", "unable to download video data",
                                      "requested format is not available",
                                      "player response", "nsig")):
                print(f"[yt-dlp] {client or 'default'} 실패, 다음 클라이언트 시도: {msg[:120]}",
                      flush=True)
                continue
            raise DownloadError(f"다운로드 실패: {msg[:400]}") from e

    if info is None or path is None:
        raise DownloadError(
            f"다운로드 실패 (시도한 클라이언트: {', '.join(tried)}). "
            f"YouTube 변경으로 막힌 것일 수 있습니다 — yt-dlp 를 올리거나 쿠키를 설정하세요. "
            f"마지막 오류: {(last or '')[:240]}"
        )

    if not path.exists():
        # 확장자가 예상과 다르게 저장된 경우 대비
        candidates = sorted(work_dir.glob(f"{video_id}.*"))
        if not candidates:
            raise DownloadError("다운로드된 파일을 찾지 못했습니다.")
        path = candidates[0]

    return {
        "path": path,
        "title": info.get("title") or video_id,
        "duration": float(info.get("duration") or 0.0),
        "uploader": info.get("uploader"),
        "video_id": video_id,
    }
