"""플레이리스트 — 보관함 곡(작업 id)을 순서대로 묶은 목록.

data/output/_playlists.json 한 파일에 전부 둔다. 보관함과 같은 폴더라 함께 백업되고,
restore_from_disk 는 하위 '폴더'만 훑으므로 이 파일과 부딪히지 않는다.
단일 사용자·단일 프로세스(uvicorn workers=1)라 프로세스 안의 락이면 충분하다.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Optional

from config import OUTPUT_DIR

PLAYLISTS_FILE = "_playlists.json"
MAX_NAME_LEN = 60
MAX_ITEMS = 200


class PlaylistStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    @property
    def _path(self):
        return OUTPUT_DIR / PLAYLISTS_FILE

    def _load(self) -> list[dict]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as e:
            # 깨진 파일을 빈 목록으로 덮어쓰면 그대로 사라진다. 저장을 막고 알린다.
            raise RuntimeError(f"플레이리스트 파일을 읽을 수 없습니다: {e}") from e
        items = data.get("playlists") if isinstance(data, dict) else None
        return [p for p in items or [] if isinstance(p, dict) and p.get("id")]

    def _save(self, playlists: list[dict]) -> None:
        # 임시 파일에 쓰고 교체한다 — 쓰는 도중 죽어도 파일이 깨지지 않는다
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"playlists": playlists}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, self._path)

    @staticmethod
    def _name(raw: Any) -> str:
        name = str(raw or "").strip()
        if not name:
            raise ValueError("플레이리스트 이름을 입력하세요.")
        if len(name) > MAX_NAME_LEN:
            raise ValueError(f"이름은 {MAX_NAME_LEN}자 이하로 입력하세요.")
        return name

    @staticmethod
    def _items(raw: Any) -> list[str]:
        if not isinstance(raw, list) or not all(isinstance(x, str) and x for x in raw):
            raise ValueError("items 는 작업 id 문자열 목록이어야 합니다.")
        if len(raw) > MAX_ITEMS:
            raise ValueError(f"한 플레이리스트에는 {MAX_ITEMS}곡까지 넣을 수 있습니다.")
        return list(raw)

    # --- 조회 ---
    def list(self) -> list[dict]:
        with self._lock:
            return self._load()

    # --- 변경 ---
    def create(self, name: Any, items: Any = None) -> dict:
        p = {
            "id": uuid.uuid4().hex[:10],
            "name": self._name(name),
            "items": self._items(items) if items is not None else [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        with self._lock:
            playlists = self._load()
            playlists.append(p)
            self._save(playlists)
        return p

    def update(self, pid: str, name: Any = None, items: Any = None) -> Optional[dict]:
        """이름·곡 목록을 바꾼다. 곡 목록은 통째로 교체한다 (추가·삭제·순서 변경 모두)."""
        new_name = self._name(name) if name is not None else None
        new_items = self._items(items) if items is not None else None
        with self._lock:
            playlists = self._load()
            p = next((x for x in playlists if x["id"] == pid), None)
            if not p:
                return None
            if new_name is not None:
                p["name"] = new_name
            if new_items is not None:
                p["items"] = new_items
            p["updated_at"] = time.time()
            self._save(playlists)
        return p

    def delete(self, pid: str) -> bool:
        with self._lock:
            playlists = self._load()
            kept = [x for x in playlists if x["id"] != pid]
            if len(kept) == len(playlists):
                return False
            self._save(kept)
        return True

    def remove_job(self, job_id: str) -> None:
        """보관함에서 곡을 지우면 모든 플레이리스트에서도 뺀다."""
        with self._lock:
            try:
                playlists = self._load()
            except RuntimeError as e:
                print(f"[playlists] 곡 정리 건너뜀: {e}", flush=True)
                return
            changed = False
            for p in playlists:
                items = [x for x in p.get("items", []) if x != job_id]
                if len(items) != len(p.get("items", [])):
                    p["items"] = items
                    p["updated_at"] = time.time()
                    changed = True
            if changed:
                self._save(playlists)


playlists = PlaylistStore()
