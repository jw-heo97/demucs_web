"""인증(아이디/비밀번호 → 토큰)과 접속 기록.

의존성을 늘리지 않으려고 passlib/bcrypt 대신 표준 라이브러리의 hashlib.scrypt 를 쓴다.
scrypt 는 메모리 하드 함수라 GPU 무차별 대입에 강하고, Python 3.6+ 에 기본 포함이다.

저장 위치(/data/auth):
  users.json    계정 — 비밀번호는 해시만 저장
  tokens.json   발급된 토큰 — 원문이 아니라 SHA-256 만 저장(유출돼도 재사용 불가)
  access.jsonl  접속 기록 (JSON Lines, 5MB 넘으면 .1 로 회전)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Optional

from config import (
    ACCESS_LOG_MAX_MB,
    ADMIN_PASSWORD,
    ADMIN_USER,
    AUTH_DIR,
    LOGIN_LOCK_SEC,
    LOGIN_MAX_FAILS,
    PROXY_SECRET,
    REQUIRE_ROLE,
    SESSION_DAYS,
    TRUST_PROXY_HEADER,
)

USERS_FILE = AUTH_DIR / "users.json"
TOKENS_FILE = AUTH_DIR / "tokens.json"
ACCESS_LOG = AUTH_DIR / "access.jsonl"

# scrypt 파라미터. n=2^15 는 이 PC 에서 100ms 안쪽이면서 충분히 무겁다.
_SCRYPT = {"n": 1 << 15, "r": 8, "p": 1}


def _maxmem(n: int, r: int) -> int:
    """OpenSSL 은 scrypt 메모리 상한이 기본 32MB 라서 n=2^15, r=8 이면 딱 걸린다
    (필요량 128*n*r = 32MB). 여유를 둬서 명시하지 않으면
    'memory limit exceeded' 로 실패한다."""
    return 132 * n * r + (1 << 20)


# --------------------------------------------------------------------------
# 비밀번호
# --------------------------------------------------------------------------
def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    n, r, p = _SCRYPT["n"], _SCRYPT["r"], _SCRYPT["p"]
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32,
                        n=n, r=r, p=p, maxmem=_maxmem(n, r))
    return f"scrypt${n}${r}${p}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n_s, r_s, p_s, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt":
            return False
        n, r, p = int(n_s), int(r_s), int(p_s)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
                            n=n, r=r, p=p, dklen=len(hash_hex) // 2,
                            maxmem=_maxmem(n, r))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# 저장소
# --------------------------------------------------------------------------
class AuthStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._users: dict[str, dict] = {}
        self._tokens: dict[str, dict] = {}
        self._fails: dict[str, list] = {}      # username -> [실패횟수, 잠금해제시각]

    # --- 파일 IO ---
    def load(self) -> None:
        AUTH_DIR.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._users = self._read(USERS_FILE)
            self._tokens = self._read(TOKENS_FILE)
            self._purge_expired()

    @staticmethod
    def _read(path: Path) -> dict:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"[auth] {path.name} 읽기 실패, 빈 상태로 시작: {e}", flush=True)
            return {}

    @staticmethod
    def _write(path: Path, data: dict) -> None:
        AUTH_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)          # 원자적 교체 — 쓰다 죽어도 파일이 깨지지 않는다
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _save_users(self) -> None:
        self._write(USERS_FILE, self._users)

    def _save_tokens(self) -> None:
        self._write(TOKENS_FILE, self._tokens)

    # --- 부트스트랩 ---
    def bootstrap(self) -> Optional[str]:
        """계정이 하나도 없으면 관리자를 만든다. 생성한 비밀번호를 돌려준다(있으면)."""
        with self._lock:
            if self._users:
                return None
            password = ADMIN_PASSWORD or secrets.token_urlsafe(12)
            generated = not ADMIN_PASSWORD
            self._users[ADMIN_USER] = {
                "password": hash_password(password),
                "created_at": time.time(),
                "role": "admin",
            }
            self._save_users()
        self.log_event("bootstrap", user=ADMIN_USER, detail="관리자 계정 생성")
        return password if generated else None

    # --- 계정 ---
    def has_users(self) -> bool:
        with self._lock:
            return bool(self._users)

    def list_users(self) -> list[dict]:
        with self._lock:
            return [{"username": u, "role": v.get("role", "user"),
                     "created_at": v.get("created_at")} for u, v in self._users.items()]

    def role_of(self, username: str) -> str:
        with self._lock:
            u = self._users.get(username)
            return (u or {}).get("role", "user")

    def create_user(self, username: str, password: str, role: str = "user") -> dict:
        username = (username or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,32}", username):
            raise ValueError("아이디는 영문·숫자·. _ - 조합 3~32자여야 합니다.")
        if len(password or "") < 8:
            raise ValueError("비밀번호는 8자 이상이어야 합니다.")
        if role not in ("admin", "user"):
            raise ValueError("역할은 admin 또는 user 여야 합니다.")
        with self._lock:
            if username in self._users:
                raise ValueError("이미 있는 아이디입니다.")
            if len(self._users) >= 50:
                raise ValueError("계정은 50개까지만 만들 수 있습니다.")
            self._users[username] = {"password": hash_password(password),
                                     "created_at": time.time(), "role": role}
            self._save_users()
        self.log_event("user_create", user=username, detail=f"role={role}")
        return {"username": username, "role": role}

    def set_role(self, username: str, role: str) -> dict:
        if role not in ("admin", "user"):
            raise ValueError("역할은 admin 또는 user 여야 합니다.")
        with self._lock:
            u = self._users.get(username)
            if not u:
                raise ValueError("없는 계정입니다.")
            admins = [n for n, v in self._users.items() if v.get("role") == "admin"]
            if role != "admin" and admins == [username]:
                raise ValueError("마지막 관리자의 역할은 바꿀 수 없습니다.")
            u["role"] = role
            self._save_users()
        self.log_event("user_role", user=username, detail=role)
        return {"username": username, "role": role}

    def reset_password(self, username: str, password: str) -> None:
        if len(password or "") < 8:
            raise ValueError("비밀번호는 8자 이상이어야 합니다.")
        with self._lock:
            u = self._users.get(username)
            if not u:
                raise ValueError("없는 계정입니다.")
            u["password"] = hash_password(password)
            self._save_users()
            gone = [tid for tid, t in self._tokens.items() if t["user"] == username]
            for tid in gone:
                self._tokens.pop(tid, None)
            self._save_tokens()
        self.log_event("user_reset", user=username, detail=f"토큰 {len(gone)}개 해제")

    def delete_user(self, username: str) -> None:
        with self._lock:
            if username not in self._users:
                raise ValueError("없는 계정입니다.")
            admins = [n for n, v in self._users.items() if v.get("role") == "admin"]
            if admins == [username]:
                raise ValueError("마지막 관리자는 삭제할 수 없습니다.")
            self._users.pop(username, None)
            gone = [tid for tid, t in self._tokens.items() if t["user"] == username]
            for tid in gone:
                self._tokens.pop(tid, None)
            self._save_users()
            self._save_tokens()
        self.log_event("user_delete", user=username)

    def locked_for(self, username: str) -> int:
        """남은 잠금 시간(초). 0 이면 잠기지 않음."""
        with self._lock:
            rec = self._fails.get(username)
            if not rec:
                return 0
            return max(0, int(rec[1] - time.time()))

    def authenticate(self, username: str, password: str) -> bool:
        username = (username or "").strip()
        with self._lock:
            if self.locked_for(username) > 0:
                return False
            user = self._users.get(username)
            ok = bool(user) and verify_password(password, user["password"])
            if ok:
                self._fails.pop(username, None)
            else:
                rec = self._fails.get(username) or [0, 0.0]
                rec[0] += 1
                if rec[0] >= LOGIN_MAX_FAILS:
                    rec[1] = time.time() + LOGIN_LOCK_SEC
                    rec[0] = 0
                self._fails[username] = rec
            return ok

    def change_password(self, username: str, old: str, new: str) -> None:
        if len(new) < 8:
            raise ValueError("새 비밀번호는 8자 이상이어야 합니다.")
        with self._lock:
            user = self._users.get(username)
            if not user or not verify_password(old, user["password"]):
                raise ValueError("현재 비밀번호가 올바르지 않습니다.")
            user["password"] = hash_password(new)
            self._save_users()
            # 비밀번호를 바꾸면 다른 기기의 세션을 모두 끊는다
            revoked = [tid for tid, t in self._tokens.items()
                       if t["user"] == username and t.get("kind") == "session"]
            for tid in revoked:
                self._tokens.pop(tid, None)
            self._save_tokens()
        self.log_event("password_change", user=username, detail=f"세션 {len(revoked)}개 해제")

    # --- 토큰 ---
    def create_token(self, username: str, kind: str = "session",
                     label: str = "", ua: str = "", ip: str = "",
                     days: Optional[int] = None) -> tuple[str, str]:
        """(토큰 원문, 토큰 ID) 를 돌려준다. 원문은 이 순간에만 존재한다."""
        token = secrets.token_urlsafe(32)
        tid = secrets.token_hex(8)
        now = time.time()
        ttl_days = SESSION_DAYS if days is None else days
        with self._lock:
            self._tokens[tid] = {
                "hash": _token_hash(token),
                "user": username,
                "kind": kind,                       # session | api
                "label": label or ("브라우저 세션" if kind == "session" else "API 토큰"),
                "created_at": now,
                "expires_at": (now + ttl_days * 86400) if ttl_days > 0 else None,
                "last_used": now,
                "last_ip": ip,
                "ua": ua[:200],
            }
            self._save_tokens()
        return token, tid

    def verify_token(self, token: str, ip: str = "", ua: str = "") -> Optional[dict]:
        if not token:
            return None
        h = _token_hash(token)
        now = time.time()
        with self._lock:
            for tid, rec in self._tokens.items():
                if not hmac.compare_digest(rec["hash"], h):
                    continue
                if rec.get("expires_at") and rec["expires_at"] < now:
                    self._tokens.pop(tid, None)
                    self._save_tokens()
                    return None
                # 마지막 사용 정보 갱신 (매 요청마다 디스크에 쓰면 낭비라 60초에 한 번)
                stale = now - rec.get("last_used", 0) > 60
                rec["last_used"] = now
                if ip:
                    rec["last_ip"] = ip
                if ua:
                    rec["ua"] = ua[:200]
                if stale:
                    self._save_tokens()
                role = (self._users.get(rec["user"]) or {}).get("role", "user")
                return {"user": rec["user"], "token_id": tid, "role": role,
                        "kind": rec["kind"], "label": rec["label"]}
        return None

    def list_tokens(self, username: str) -> list[dict]:
        with self._lock:
            self._purge_expired()
            return sorted(
                [{"id": tid, **{k: v for k, v in rec.items() if k != "hash"}}
                 for tid, rec in self._tokens.items() if rec["user"] == username],
                key=lambda r: r.get("created_at", 0), reverse=True)

    def revoke_token(self, username: str, tid: str) -> bool:
        with self._lock:
            rec = self._tokens.get(tid)
            if not rec or rec["user"] != username:
                return False
            self._tokens.pop(tid, None)
            self._save_tokens()
        return True

    def revoke_all(self, username: str, keep: str = "") -> int:
        with self._lock:
            gone = [tid for tid, r in self._tokens.items()
                    if r["user"] == username and tid != keep]
            for tid in gone:
                self._tokens.pop(tid, None)
            self._save_tokens()
        return len(gone)

    def _purge_expired(self) -> None:
        now = time.time()
        gone = [tid for tid, r in self._tokens.items()
                if r.get("expires_at") and r["expires_at"] < now]
        if gone:
            for tid in gone:
                self._tokens.pop(tid, None)
            self._save_tokens()

    # --- 접속 기록 ---
    def log_event(self, event: str, **fields: Any) -> None:
        entry = {"ts": round(time.time(), 3), "event": event, **fields}
        line = json.dumps(entry, ensure_ascii=False)
        try:
            AUTH_DIR.mkdir(parents=True, exist_ok=True)
            if ACCESS_LOG.exists() and ACCESS_LOG.stat().st_size > ACCESS_LOG_MAX_MB * 1024 * 1024:
                os.replace(ACCESS_LOG, ACCESS_LOG.with_suffix(".jsonl.1"))
            with ACCESS_LOG.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            print(f"[auth] 접속 기록 실패(무시): {e}", flush=True)

    def read_log(self, limit: int = 200) -> list[dict]:
        """최근 기록을 최신순으로. 파일이 커도 뒤쪽만 읽는다."""
        if not ACCESS_LOG.exists():
            return []
        try:
            size = ACCESS_LOG.stat().st_size
            with ACCESS_LOG.open("rb") as f:
                # 한 줄 평균 200바이트 가정, 넉넉히 뒤에서부터 읽는다
                back = min(size, max(limit * 400, 65536))
                f.seek(size - back)
                chunk = f.read().decode("utf-8", "replace")
        except OSError:
            return []
        lines = chunk.splitlines()
        if back < size and lines:
            lines = lines[1:]            # 잘린 첫 줄 버림
        out = []
        for ln in reversed(lines):
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except ValueError:
                continue
            if len(out) >= limit:
                break
        return out


store = AuthStore()


# --------------------------------------------------------------------------
# 클라이언트 IP
# --------------------------------------------------------------------------
def client_ip(request) -> str:
    """요청의 출발지 IP.

    ⚠ Docker Desktop for Windows 에서는 포트 포워딩이 출발지 IP 를 지운다(실측 확인).
    컨테이너는 LAN 접속도 원격 접속도 전부 브리지 게이트웨이(172.x.0.1)로 본다.
    진짜 IP 를 남기려면 Windows 호스트에 리버스 프록시를 두고 X-Forwarded-For 를 넘겨야 하며,
    그때만 TRUST_PROXY_HEADER 를 켠다. PROXY_SECRET 이 설정돼 있으면 그 헤더가 일치할 때만
    신뢰하므로 클라이언트가 XFF 를 위조해도 통하지 않는다.
    """
    if TRUST_PROXY_HEADER:
        if not PROXY_SECRET or hmac.compare_digest(
                request.headers.get("x-proxy-secret", ""), PROXY_SECRET):
            xff = request.headers.get("x-forwarded-for", "")
            if xff:
                return xff.split(",")[0].strip()[:64]
    return request.client.host if request.client else "-"


def role_allowed(role: str) -> bool:
    """접근이 허용되는 역할인지. REQUIRE_ROLE 이 비면 로그인만으로 통과."""
    return (not REQUIRE_ROLE) or role == REQUIRE_ROLE


def ip_is_meaningful() -> bool:
    """기록된 IP 를 신뢰할 수 있는 상태인지. UI 에서 경고를 띄우는 데 쓴다."""
    return TRUST_PROXY_HEADER
