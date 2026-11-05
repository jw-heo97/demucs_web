"""곡 하나에 악보 여러 개 — 올린 악보들 중 하나를 골라 쓴다.

고른(활성) 악보는 예전 자리 그대로 곡 폴더에 둔다 (score.pdf, _score.json, _score/, _score_ink.json) —
악보를 읽는 다른 코드는 바뀌지 않는다. 고르지 않은 악보는 _scores/<id>/ 에 같은 이름으로 넣어 둔다.
고르기는 둘을 서로 옮겨 바꾸는 것이라 다시 분석하지 않는다 (쪽 그림·필기도 악보마다 따로 남는다).

목록은 _scores.json: {"active": id, "items": [{"id", "name", "at"}]}
예전 곡(목록 없이 score.pdf 만 있는 곡)은 처음 볼 때 '악보 1' 로 올린다.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import scores

INDEX = "_scores.json"
LIB_DIR = "_scores"
INK = "_score_ink.json"
# 악보 하나에 딸린 파일·폴더 (활성일 때는 곡 폴더에, 아니면 _scores/<id>/ 에)
PARTS = (scores.SCORE_PDF, scores.SCORE_JSON, INK, scores.SCORE_DIR)

_lock = threading.RLock()


class LibraryError(ValueError):
    pass


def _read(song: Path) -> dict:
    try:
        data = json.loads((song / INDEX).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data
    except (OSError, ValueError):
        pass
    return {"active": None, "items": []}


def _write(song: Path, data: dict) -> None:
    tmp = song / (INDEX + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, song / INDEX)


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def load(song: Path) -> dict:
    """목록. 예전 곡은 지금 악보를 '악보 1' 로 올린다."""
    with _lock:
        data = _read(song)
        if not data["items"] and (song / scores.SCORE_PDF).exists():
            sid = _new_id()
            data = {"active": sid, "items": [{"id": sid, "name": "악보 1", "at": time.time()}]}
            _write(song, data)
        return data


def _park(song: Path, sid: str) -> None:
    """곡 폴더의 활성 악보 파일을 _scores/<sid>/ 로."""
    dst = song / LIB_DIR / sid
    dst.mkdir(parents=True, exist_ok=True)
    for name in PARTS:
        src = song / name
        if src.exists():
            target = dst / name
            if target.exists():
                shutil.rmtree(target) if target.is_dir() else target.unlink()
            os.replace(src, target)


def _unpark(song: Path, sid: str) -> None:
    """_scores/<sid>/ 의 악보 파일을 곡 폴더로."""
    src_dir = song / LIB_DIR / sid
    for name in PARTS:
        dst = song / name
        if dst.exists():
            shutil.rmtree(dst) if dst.is_dir() else dst.unlink()
        src = src_dir / name
        if src.exists():
            os.replace(src, dst)
    shutil.rmtree(src_dir, ignore_errors=True)


def add(song: Path, name: Optional[str]) -> str:
    """새 악보 자리를 만들고 활성으로 한다 (지금 악보는 보관). 부른 쪽이 곡 폴더에 score.pdf 를 쓰고 분석한다."""
    with _lock:
        data = load(song)
        if data["active"]:
            _park(song, data["active"])
        sid = _new_id()
        used = {it["name"] for it in data["items"]}
        name = (name or "").strip()[:60]
        if not name:
            k = len(data["items"]) + 1
            while f"악보 {k}" in used:
                k += 1
            name = f"악보 {k}"
        data["items"].append({"id": sid, "name": name, "at": time.time()})
        data["active"] = sid
        _write(song, data)
        return sid


def activate(song: Path, sid: str) -> None:
    with _lock:
        data = load(song)
        if not any(it["id"] == sid for it in data["items"]):
            raise LibraryError("그 악보가 없습니다.")
        if data["active"] == sid:
            return
        if data["active"]:
            _park(song, data["active"])
        _unpark(song, sid)
        data["active"] = sid
        _write(song, data)


def rename(song: Path, sid: str, name: str) -> None:
    with _lock:
        data = load(song)
        name = (name or "").strip()[:60]
        if not name:
            raise LibraryError("이름을 넣어 주세요.")
        for it in data["items"]:
            if it["id"] == sid:
                it["name"] = name
                _write(song, data)
                return
        raise LibraryError("그 악보가 없습니다.")


def remove(song: Path, sid: str) -> None:
    """악보 하나를 지운다. 활성 악보면 남은 것 중 가장 최근 것을 고른다 (없으면 악보 없음)."""
    with _lock:
        data = load(song)
        if not any(it["id"] == sid for it in data["items"]):
            raise LibraryError("그 악보가 없습니다.")
        data["items"] = [it for it in data["items"] if it["id"] != sid]
        if data["active"] == sid:
            scores.remove(song)
            (song / INK).unlink(missing_ok=True)
            data["active"] = None
            if data["items"]:
                nxt = max(data["items"], key=lambda it: it.get("at", 0))["id"]
                _unpark(song, nxt)
                data["active"] = nxt
        else:
            shutil.rmtree(song / LIB_DIR / sid, ignore_errors=True)
        _write(song, data)


def view(song: Path) -> dict:
    """화면용 목록: 이름·쪽 수·마디 수·활성."""
    data = load(song)
    out = []
    for it in data["items"]:
        d = song if it["id"] == data["active"] else song / LIB_DIR / it["id"]
        sc = scores.load(d) or {}
        out.append({"id": it["id"], "name": it["name"], "at": it.get("at"),
                    "pages": len(sc.get("pages", [])), "measures": len(sc.get("measures", [])),
                    "active": it["id"] == data["active"]})
    return {"active": data["active"], "items": out}
