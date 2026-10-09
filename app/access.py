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
    (내 계정 기기도 Tailscale 에 안 붙어 있으면 그냥 인터넷 접속이다) 기기 등록 키를 쓴다:
    ACCESS_KEY 가 든 링크(`/?key=...`)를 한 번 열면 그 브라우저에 1년짜리 HttpOnly 쿠키가
    남고, 이후엔 그 쿠키로 들어온다. 키를 바꾸면 등록된 기기가 모두 해제된다.
    로그인이 없는 앱을 그냥 열면 주소를 아는 누구나 곡 삭제·GPU 작업 등록을 할 수 있다.
  - TAILSCALE_ALLOW_USERS 가 있으면 그 계정의 tailnet 기기만 허용한다
    (다른 계정에 기기를 공유했을 때 그 사람을 막는다).
  - 헤더가 없는 요청(이 PC 에서 직접, 또는 태그 기기)은 허용한다.
"""
from __future__ import annotations

import hmac
import time
from urllib.parse import urlencode
from collections import OrderedDict
from typing import Optional
from email.header import decode_header, make_header

from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse

from config import ACCESS_KEY, ALLOW_FUNNEL, TAILSCALE_ALLOW_USERS

KEY_COOKIE = "dw_device"
KEY_MAX_AGE = 365 * 24 * 3600

# 기록에서 뺄 요청 — 1초마다 도는 폴링·헬스체크·오디오 구간 요청까지 남기면 쓸모가 없다
_QUIET_EXACT = {("GET", "/api/jobs"), ("GET", "/healthz"), ("GET", "/favicon.ico")}
_QUIET_PARTS = ("/files/", "/peaks", "/score/pages/", "/ui/assets/")

# 최근 접속자: (경로, IP, 계정) → 정보. 기기 목록 화면/API 용 (재시작하면 비워진다)
_MAX_CLIENTS = 200
_clients: "OrderedDict[tuple, dict]" = OrderedDict()


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
        via = "proxy"       # serve 를 거쳤지만 신원이 없음 (이 PC 자신, 태그 기기)
    else:
        via = "direct"      # 127.0.0.1:8080 직접 (이 PC)
    return {"via": via, "ip": ip, "login": login,
            "name": _header(request, "tailscale-user-name"),
            "ua": request.headers.get("user-agent", "")[:160]}


def _key_ok(value: str) -> bool:
    return bool(ACCESS_KEY) and bool(value) and hmac.compare_digest(value, ACCESS_KEY)


def denied_reason(who: dict, request: Request) -> Optional[str]:
    if who["via"] == "funnel" and not ALLOW_FUNNEL             and not _key_ok(request.cookies.get(KEY_COOKIE, "")):
        return "funnel"
    if who["via"] == "tailnet" and TAILSCALE_ALLOW_USERS \
            and who["login"].lower() not in TAILSCALE_ALLOW_USERS:
        return "user"
    return None


def _remember(who: dict, method: str, path: str, status: int, denied: bool) -> None:
    key = (who["via"], who["ip"], who["login"])
    now = time.time()
    c = _clients.pop(key, None) or {**who, "first": now, "requests": 0, "denied": 0}
    c.update(ua=who["ua"] or c.get("ua", ""), last=now, last_path=f"{method} {path}",
             last_status=status)
    c["requests"] += 1
    c["denied"] += int(denied)
    _clients[key] = c
    while len(_clients) > _MAX_CLIENTS:
        _clients.popitem(last=False)


def recent_clients() -> list[dict]:
    """최근 접속자(마지막 접속 순)."""
    out = []
    for c in reversed(_clients.values()):
        out.append({k: (round(v, 3) if isinstance(v, float) else v) for k, v in c.items()})
    return out


async def middleware(request: Request, call_next):
    who = classify(request)
    method, path = request.method, request.url.path

    # 기기 등록: 키가 맞으면 쿠키를 남기고 키를 뺀 주소로 보낸다 (주소창·기록에 키가 남지 않게)
    key = request.query_params.get("key")
    if key is not None:
        ok = _key_ok(key)
        if ok:
            rest = [(k, v) for k, v in request.query_params.multi_items() if k != "key"]
            url = path + ("?" + urlencode(rest) if rest else "")
            resp = RedirectResponse(url, status_code=303)
            resp.set_cookie(KEY_COOKIE, ACCESS_KEY, max_age=KEY_MAX_AGE, httponly=True,
                            secure=who["via"] in ("funnel", "tailnet", "proxy"), samesite="lax")
            _remember(who, method, path, 303, False)
            print(f"[access] {who['via']} {who['ip']} 기기 등록", flush=True)
            return resp
        print(f"[access] {who['via']} {who['ip']} 기기 등록 실패(키 불일치)", flush=True)

    reason = denied_reason(who, request)
    if reason:
        status = 403
        msg = ("등록되지 않은 기기입니다. 접속 링크(?key=…)로 한 번 열어 주세요." if reason == "funnel"
               else "허용된 Tailscale 계정의 기기에서만 열 수 있습니다.")
        resp = (JSONResponse({"detail": msg}, status_code=403) if path.startswith("/api/")
                else PlainTextResponse(msg, status_code=403))
    else:
        resp = await call_next(request)
        status = resp.status_code

    _remember(who, method, path, status, bool(reason))
    quiet = (method, path) in _QUIET_EXACT or any(p in path for p in _QUIET_PARTS)
    if reason or not quiet:
        tag = who["via"] + (f":{who['login']}" if who["login"] else "")
        print(f"[access] {tag} {who['ip']} {method} {path} {status}"
              + (" (차단)" if reason else ""), flush=True)
    return resp
