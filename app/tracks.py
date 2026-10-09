"""사용자 트랙 — 곡에 내 녹음·반주 같은 오디오를 올려 믹서에서 스템과 함께 튼다 (MTR 용도).

파일은 `{곡}/tracks/{id}.mp3` 로 두고(올린 것이 무엇이든 ffmpeg 로 mp3 변환 — 브라우저 녹음은
webm/m4a, 업로드는 wav 일 수 있다), 목록은 `{곡}/_tracks.json` 에 둔다.

offset_ms: 트랙의 0초가 곡의 몇 ms 에 해당하는지. 녹음은 곡이 시작되기 전부터 돌아가므로
음수일 수 있다. 브라우저가 재생할 때 곡 위치 - offset 으로 맞춘다.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import audio_io

TRACKS_FILE = "_tracks.json"
TRACKS_DIR = "tracks"
MAX_TRACKS = 16
MAX_NAME = 40

_lock = threading.Lock()


def _path(out_dir: Path) -> Path:
    return out_dir / TRACKS_FILE


def load(out_dir: Optional[Path]) -> list[dict]:
    """목록을 읽는다. 파일이 없는 트랙은 뺀다 (탐색기에서 지운 경우)."""
    if not out_dir:
        return []
    try:
        d = json.loads(_path(out_dir).read_text(encoding="utf-8"))
        items = d.get("tracks") if isinstance(d, dict) else None
    except (OSError, ValueError):
        return []
    out = []
    for t in items or []:
        if isinstance(t, dict) and t.get("file") and (out_dir / t["file"]).exists():
            out.append(t)
    return out


def _save(out_dir: Path, items: list[dict]) -> None:
    p = _path(out_dir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"tracks": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _clean_name(v: Any, default: str) -> str:
    return (str(v or "").strip() or default)[:MAX_NAME]


def _offset(v: Any, default: int = 0) -> int:
    try:
        x = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return max(-600_000, min(600_000, x))   # ±10분


def add(out_dir: Path, data: bytes, ext: str, name: str, offset_ms: Any) -> dict:
    """올린 오디오를 mp3 로 변환해 넣는다. 변환에 실패하면 오디오가 아닌 것."""
    with _lock:
        items = load(out_dir)
        if len(items) >= MAX_TRACKS:
            raise ValueError(f"트랙은 곡당 {MAX_TRACKS}개까지입니다.")
    tid = uuid.uuid4().hex[:8]
    tdir = out_dir / TRACKS_DIR
    tdir.mkdir(parents=True, exist_ok=True)
    src = tdir / f"{tid}.upload{ext}"
    dst = tdir / f"{tid}.mp3"
    src.write_bytes(data)
    try:
        audio_io.transcode_mp3(src, dst)
    except Exception as e:
        src.unlink(missing_ok=True)
        raise ValueError(f"오디오로 읽지 못했습니다: {e}") from e
    src.unlink(missing_ok=True)
    try:
        duration = float(audio_io.probe(dst).get("duration") or 0)
    except Exception:
        duration = 0.0
    item = {"id": tid, "name": _clean_name(name, f"트랙 {len(load(out_dir)) + 1}"),
            "file": f"{TRACKS_DIR}/{tid}.mp3", "offset_ms": _offset(offset_ms),
            "duration": round(duration, 3), "created": round(time.time(), 3)}
    with _lock:
        items = load(out_dir)
        items.append(item)
        _save(out_dir, items)
    return item


def update(out_dir: Path, tid: str, name: Any = None, offset_ms: Any = None) -> dict:
    with _lock:
        items = load(out_dir)
        for t in items:
            if t["id"] == tid:
                if name is not None:
                    t["name"] = _clean_name(name, t["name"])
                if offset_ms is not None:
                    t["offset_ms"] = _offset(offset_ms, t.get("offset_ms", 0))
                _save(out_dir, items)
                return t
    raise KeyError(tid)


def remove(out_dir: Path, tid: str) -> None:
    with _lock:
        items = load(out_dir)
        t = next((x for x in items if x["id"] == tid), None)
        if t is None:
            raise KeyError(tid)
        items.remove(t)
        _save(out_dir, items)
    try:
        (out_dir / t["file"]).unlink(missing_ok=True)
    except OSError:
        pass
