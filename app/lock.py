"""곡별 잠금과 PIN.

곡마다 '만든 사람'(분리를 등록한 기기·계정)이 주인이다. 주인은 곡을 잠그고 PIN 을 정한다.
  - 잠긴 곡: 구성표 저장·버전·악보·트랙·삭제 같은 바꾸는 요청을 서버가 423 으로 거절한다.
    듣기·구간 반복·속도·믹스 받기는 그대로.
  - 잠금: 주인(또는 관리자)이면 바로. PIN 없이.
  - 해제: 그 곡에 PIN 이 있으면 누구든(주인·관리자 포함) PIN 을 쳐야 한다 — 손이 미끄러져
    풀리는 것을 막는 게 목적이라 주인도 예외가 아니다. PIN 이 없으면 주인·관리자만 풀 수 있다.
  - PIN 정하기·바꾸기: 주인(또는 관리자). 이미 PIN 이 있으면 기존 PIN 이 맞아야 바꾼다.
    관리자는 잊어버린 PIN 을 초기화(지우기)할 수 있다 — 서버 파일을 직접 만질 수 있는 사람이라.

PIN 은 scrypt 해시로 메타에 저장한다. 틀린 시도는 곡·요청자별로 세어 5번이면 5분 막는다.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Optional

MAX_FAILS = 5
LOCK_SEC = 300
# scrypt: OpenSSL 기본 메모리 상한이 32MB 라 n=2^15 는 걸린다 (README). n=2^14 + maxmem 명시.
_N, _R, _P, _MAXMEM = 2 ** 14, 8, 1, 64 * 1024 * 1024

_fails: dict[tuple[str, str], list[float]] = {}


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pin.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, maxmem=_MAXMEM)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_pin(stored: Optional[str], pin: str) -> bool:
    if not stored or not pin:
        return False
    try:
        _, salt_hex, h_hex = stored.split("$", 2)
        h = hashlib.scrypt(pin.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=_N, r=_R, p=_P, maxmem=_MAXMEM)
        return hmac.compare_digest(h.hex(), h_hex)
    except (ValueError, TypeError):
        return False


def normalize_pin(pin: object) -> str:
    """4~12자. 공백은 버린다."""
    s = str(pin or "").strip()
    if not (4 <= len(s) <= 12):
        raise ValueError("PIN 은 4~12자여야 합니다.")
    return s


def locked_out(job_id: str, who_key: str, max_fails: int = MAX_FAILS) -> Optional[int]:
    """막혀 있으면 남은 초, 아니면 None."""
    now = time.time()
    hits = [t for t in _fails.get((job_id, who_key), []) if now - t < LOCK_SEC]
    _fails[(job_id, who_key)] = hits
    if len(hits) >= max_fails:
        return int(LOCK_SEC - (now - hits[0])) + 1
    return None


def record_fail(job_id: str, who_key: str, max_fails: int = MAX_FAILS) -> int:
    """틀린 시도를 적고 남은 기회를 돌려준다."""
    hits = _fails.setdefault((job_id, who_key), [])
    hits.append(time.time())
    return max(0, max_fails - len(hits))


def clear_fails(job_id: str, who_key: str) -> None:
    _fails.pop((job_id, who_key), None)
