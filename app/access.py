"""접속자 기록과 접근 제한 (Tailscale serve / funnel 경유).

이 앱은 로그인이 없어서 '누가 들어올 수 있나' 는 네트워크가 정한다. 포트는 127.0.0.1 에만
열려 있고, 바깥 접속은 Windows 의 `tailscale serve`(tailnet) 나 `tailscale funnel`(인터넷 공개)
이 프록시해 준다. 그 프록시가 붙여 주는 헤더로 접속자를 구분한다.

  Tailscale-Funnel-Request: ?1   funnel 로 들어온 인터넷 접속 (tailnet 밖)
  Tailscale-User-Login: <계정>   tailnet 기기 — 그 기기 주인의 로그인
  X-Forwarded-For: <IP>          실제 접속 IP (serve/funnel 모두)

Tailscale 은 이 헤더들을 바깥에서 보낸 값이 있어도 지우고 다시 채우므로 funnel 방문자가
위조할 수 없다. 프록시를 거치지 않은 요청(이 PC 에서 127.0.0.1:8080 직접)은 헤더가 없다
— Docker 가 출발지 IP 를 보존하지 않아 컨테이너에선 전부 172.x 로 보이므로 IP 로는 못 가른다.

규칙:
  - funnel 접속은 '등록된 기기' 만 받는다. funnel 로는 Tailscale 계정을 알 수 없어서
    (내 계정 기기도 Tailscale 에 안 붙어 있으면 그냥 인터넷 접속이다) 초대 링크로 등록한다:
    접속자 관리 탭에서 사람 이름을 넣어 **1회용** 링크(`/?key=...`)를 만들고, 그 링크를 연
    브라우저에 기기별 토큰을 발급해 1년짜리 HttpOnly 쿠키로 남긴다. 링크는 한 번 쓰면
    사라지고(친구가 남에게 넘겨도 소용없다), INVITE_DAYS 일 안에 안 쓰면 만료된다.
    기기마다 토큰이 달라서 하나씩 끊을 수 있다.
  - TAILSCALE_ALLOW_USERS 가 있으면 그 계정의 tailnet 기기만 허용한다
    (다른 계정에 기기를 공유했을 때 그 사람을 막는다).
  - 헤더가 없는 요청(이 PC 에서 직접, 또는 태그 기기)은 허용한다.

관리자(접속자 관리 탭·/api/admin/*): 허용 계정으로 들어온 tailnet 기기와 이 PC 직접 접속.
funnel 로 등록한 기기는 앱은 쓰되 관리 화면은 못 본다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from email.header import decode_header, make_header
from typing import Optional
from urllib.parse import urlencode

from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse

from config import ALLOW_FUNNEL, OUTPUT_DIR, TAILSCALE_ALLOW_USERS

DEVICE_COOKIE = "dw_device"
DEVICE_MAX_AGE = 365 * 24 * 3600
# 1회용 초대 링크 유효 기간
INVITE_DAYS = 7
# 보관함과 같은 폴더라 함께 백업된다 (_playlists.json 처럼)
STATE_FILE = "_access.json"

# 기록에서 뺄 요청 — 1초마다 도는 폴링·헬스체크·오디오 구간 요청까지 남기면 쓸모가 없다
_QUIET_EXACT = {("GET", "/api/jobs"), ("GET", "/healthz"), ("GET", "/favicon.ico"),
                ("GET", "/api/admin/access"), ("GET", "/api/me")}
_QUIET_PARTS = ("/files/", "/peaks", "/score/pages/", "/ui/assets/")

# 최근 접속자: (경로, IP, 계정/기기) → 정보. 재시작하면 비워진다
_MAX_CLIENTS = 200
_clients: "OrderedDict[tuple, dict]" = OrderedDict()


# --------------------------------------------------------------------------
# 등록 기기·초대 키 (data/output/_access.json)
# --------------------------------------------------------------------------
def _hash(token: str) -> str:
    # 쿠키 원문은 저장하지 않는다 — 파일이 새어도 그걸로 들어올 수 없게
    return hashlib.sha256(token.encode()).hexdigest()


def _public(dv: dict) -> dict:
    return {k: v for k, v in dv.items() if k != "hash"}


class _Store:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: Optional[dict] = None

    @property
    def path(self):
        return OUTPUT_DIR / STATE_FILE

    def _load(self) -> dict:
        if self._data is None:
            try:
                d = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                d = {}
            d.setdefault("devices", [])
            d.setdefault("invites", [])
            d.pop("invite_key", None)      # 예전 여러 번 쓰는 초대 키 — 1회용으로 바뀌었다
            self._data = d
        return self._data

    def _save(self) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    # --- 1회용 초대 ---
    @staticmethod
    def _prune(d: dict) -> None:
        now = time.time()
        d["invites"] = [x for x in d["invites"] if x["expires"] > now]

    def invites(self) -> list[dict]:
        with self._lock:
            d = self._load()
            self._prune(d)
            return [_public(x) for x in d["invites"]]

    def create_invite(self, name: str) -> tuple[str, dict]:
        """이름을 붙인 1회용 초대 키. 원문은 돌려주기만 하고 해시만 저장한다."""
        key = secrets.token_urlsafe(18)
        now = time.time()
        inv = {"id": uuid.uuid4().hex[:8], "hash": _hash(key),
               "name": (str(name or "").strip() or "이름 없음")[:40],
               "created": round(now, 3), "expires": round(now + INVITE_DAYS * 86400, 3)}
        with self._lock:
            d = self._load()
            self._prune(d)
            d["invites"].append(inv)
            self._save()
        return key, _public(inv)

    def cancel_invite(self, iid: str) -> None:
        with self._lock:
            d = self._load()
            before = len(d["invites"])
            d["invites"] = [x for x in d["invites"] if x["id"] != iid]
            if len(d["invites"]) == before:
                raise KeyError(iid)
            self._save()

    def redeem(self, key: str, who: dict) -> Optional[tuple[str, dict]]:
        """초대 키가 맞으면 그 초대를 지우고(1회용) 기기를 등록한다. 기기 이름 = 초대 이름."""
        h = _hash(key)
        with self._lock:
            d = self._load()
            self._prune(d)
            inv = next((x for x in d["invites"] if hmac.compare_digest(x["hash"], h)), None)
            if inv is None:
                return None
            d["invites"].remove(inv)
            token = secrets.token_urlsafe(32)
            now = round(time.time(), 3)
            dv = {"id": uuid.uuid4().hex[:8], "hash": _hash(token), "name": inv["name"],
                  "ua": who["ua"], "created": now, "last": now,
                  "last_ip": who["ip"], "blocked": False}
            d["devices"].append(dv)
            self._save()
        return token, dv

    def device_for(self, token: str) -> Optional[dict]:
        if not token:
            return None
        h = _hash(token)
        with self._lock:
            for dv in self._load()["devices"]:
                if hmac.compare_digest(dv["hash"], h):
                    return dv
        return None

    def touch(self, dv: dict, ip: str) -> None:
        # 마지막 접속은 1분에 한 번만 파일에 쓴다 (폴링마다 쓰지 않게)
        now = time.time()
        if now - dv.get("last", 0) < 60 and dv.get("last_ip") == ip:
            return
        with self._lock:
            dv["last"], dv["last_ip"] = round(now, 3), ip
            self._save()

    def devices(self) -> list[dict]:
        with self._lock:
            return [_public(dv) for dv in self._load()["devices"]]

    def update(self, did: str, name: Optional[str], blocked: Optional[bool]) -> dict:
        with self._lock:
            for dv in self._load()["devices"]:
                if dv["id"] == did:
                    if name is not None:
                        dv["name"] = (str(name).strip() or dv["name"])[:40]
                    if blocked is not None:
                        dv["blocked"] = bool(blocked)
                    self._save()
                    return _public(dv)
        raise KeyError(did)

    def delete(self, did: str) -> None:
        with self._lock:
            d = self._load()
            before = len(d["devices"])
            d["devices"] = [x for x in d["devices"] if x["id"] != did]
            if len(d["devices"]) == before:
                raise KeyError(did)
            self._save()


store = _Store()


# --------------------------------------------------------------------------
# 요청 구분
# --------------------------------------------------------------------------
def _header(request: Request, name: str) -> str:
    v = request.headers.get(name, "")
    # Tailscale 은 비ASCII 값(한글 이름 등)을 RFC 2047(=?utf-8?q?...?=) 로 넣는다
    if v.startswith("=?"):
        try:
            v = str(make_header(decode_header(v)))
        except Exception:
            pass
    else:
        # 그대로 보낸 UTF-8 은 latin-1 로 풀려 들어온다
        try:
            v = v.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return v.strip()


def classify(request: Request) -> dict:
    """요청이 어디서 왔는지: via = funnel | tailnet | proxy | direct"""
    xff = _header(request, "x-forwarded-for")
    ip = xff.split(",")[0].strip() if xff else (request.client.host if request.client else "")
    login = _header(request, "tailscale-user-login")
    if request.headers.get("tailscale-funnel-request"):
        via = "funnel"
    elif login:
        via = "tailnet"
    elif xff:
        via = "proxy"       # serve 를 거쳤지만 신원이 없음 (태그 기기)
    else:
        via = "direct"      # 127.0.0.1:8080 직접 (이 PC)
    return {"via": via, "ip": ip, "login": login,
            "name": _header(request, "tailscale-user-name"),
            "ua": request.headers.get("user-agent", "")[:200]}


def is_admin(who: dict) -> bool:
    """접속자 관리 화면을 볼 수 있는가: 허용 계정의 tailnet 기기, 이 PC 직접."""
    if who["via"] == "direct":
        return True
    if who["via"] == "tailnet":
        return not TAILSCALE_ALLOW_USERS or who["login"].lower() in TAILSCALE_ALLOW_USERS
    return False


def _denied(who: dict, device: Optional[dict]) -> Optional[str]:
    if who["via"] == "funnel" and not ALLOW_FUNNEL:
        if device is None:
            return "unregistered"
        if device.get("blocked"):
            return "blocked"
    if who["via"] == "tailnet" and TAILSCALE_ALLOW_USERS \
            and who["login"].lower() not in TAILSCALE_ALLOW_USERS:
        return "user"
    return None


_MESSAGES = {
    "unregistered": "등록되지 않은 기기입니다. 받은 접속 링크로 한 번 열어 주세요.",
    "blocked": "이 기기는 접속이 차단되었습니다.",
    "user": "허용된 Tailscale 계정의 기기에서만 열 수 있습니다.",
    "badkey": "이미 사용했거나 만료된 접속 링크입니다. 링크를 다시 받아 주세요.",
}


def _remember(who: dict, device: Optional[dict], method: str, path: str,
              status: int, denied: bool) -> None:
    key = (who["via"], who["ip"], who["login"] or (device or {}).get("id", ""))
    now = time.time()
    c = _clients.pop(key, None) or {**who, "first": now, "requests": 0, "denied": 0}
    c.update(ua=who["ua"] or c.get("ua", ""), last=now, last_path=f"{method} {path}",
             last_status=status, device=(device or {}).get("name"),
             device_id=(device or {}).get("id"))
    c["requests"] += 1
    c["denied"] += int(denied)
    _clients[key] = c
    while len(_clients) > _MAX_CLIENTS:
        _clients.popitem(last=False)


def recent_clients() -> list[dict]:
    """최근 접속자(마지막 접속 순)."""
    return [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in c.items()}
            for c in reversed(_clients.values())]


def _log(who: dict, device: Optional[dict], text: str) -> None:
    tag = who["via"] + (f":{who['login']}" if who["login"] else "") \
        + (f"[{device['name']}]" if device else "")
    print(f"[access] {tag} {who['ip']} {text}", flush=True)


async def middleware(request: Request, call_next):
    who = classify(request)
    method, path = request.method, request.url.path
    device = store.device_for(request.cookies.get(DEVICE_COOKIE, ""))

    # 기기 등록: 1회용 초대 키가 맞으면 기기 토큰을 쿠키로 남기고 키를 뺀 주소로 보낸다
    # (주소창·방문 기록에 키가 남지 않게). 이미 등록된 브라우저가 열면 초대를 쓰지 않는다
    # — 내가 링크를 시험 삼아 열어도 친구 몫이 사라지지 않게.
    key = request.query_params.get("key")
    if key is not None:
        rest = [(k, v) for k, v in request.query_params.multi_items() if k != "key"]
        clean = path + ("?" + urlencode(rest) if rest else "")
        if device is not None:
            return RedirectResponse(clean, status_code=303)
        got = store.redeem(key, who)
        if got:
            token, device = got
            resp = RedirectResponse(clean, status_code=303)
            resp.set_cookie(DEVICE_COOKIE, token, max_age=DEVICE_MAX_AGE, httponly=True,
                            secure=who["via"] != "direct", samesite="lax")
            _log(who, device, "기기 등록 (초대 사용)")
            _remember(who, device, method, path, 303, False)
            return resp
        _log(who, device, "기기 등록 실패(없거나 이미 쓴 초대)")
        if who["via"] == "funnel":
            _remember(who, device, method, path, 403, True)
            return PlainTextResponse(_MESSAGES["badkey"], status_code=403)

    reason = _denied(who, device)
    if reason:
        status = 403
        msg = _MESSAGES[reason]
        resp = (JSONResponse({"detail": msg}, status_code=403) if path.startswith("/api/")
                else PlainTextResponse(msg, status_code=403))
    elif path.startswith("/api/admin/") and not is_admin(who):
        status = 403
        resp = JSONResponse({"detail": "관리 화면은 내 Tailscale 계정 기기에서만 열 수 있습니다."},
                            status_code=403)
    else:
        request.state.who = who
        request.state.device = device
        resp = await call_next(request)
        status = resp.status_code

    if device and not reason:
        store.touch(device, who["ip"])
    _remember(who, device, method, path, status, bool(reason))
    quiet = (method, path) in _QUIET_EXACT or any(p in path for p in _QUIET_PARTS)
    if reason or status == 403 or not quiet:
        _log(who, device, f"{method} {path} {status}" + (" (차단)" if reason else ""))
    return resp
