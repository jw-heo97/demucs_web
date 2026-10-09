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
    (내 계정 기기도 Tailscale 에 안 붙어 있으면 그냥 인터넷 접속이다) 접속 링크로 등록한다:
    접속자 관리 탭에서 **링크(`/join/<코드>`) + 비밀번호** 를 만들어 보내면, 받은 사람이 그
    링크에서 자기 이름과 비밀번호를 넣고 들어온다. 맞으면 그 브라우저를 그 이름으로 등록하고
    기기별 토큰을 1년짜리 HttpOnly 쿠키로 남긴다. 링크는 여러 사람·여러 기기가 같이 쓴다
    (예전 1회용 키는 기기마다 새로 만들어야 해서 번거로웠다). 링크가 새도 비밀번호를 모르면
    못 들어오고, 비밀번호는 IP 별로 5번(링크 전체로 30번) 틀리면 5분 막힌다.
    기기마다 토큰이 달라서 하나씩 끊을 수 있다.
  - TAILSCALE_ALLOW_USERS 가 있으면 그 계정의 tailnet 기기만 허용한다
    (다른 계정에 기기를 공유했을 때 그 사람을 막는다).
  - 헤더가 없는 요청(이 PC 에서 직접, 또는 태그 기기)은 허용한다.

관리자(접속자 관리 탭·/api/admin/*): 허용 계정으로 들어온 tailnet 기기와 이 PC 직접 접속.
funnel 로 등록한 기기는 앱은 쓰되 관리 화면은 못 본다.

수정 권한(role): 초대 링크로 등록한 기기는 'view'(보기만) 또는 'edit'. 보기만인 기기는
GET 과 믹스 받기(POST …/mixdown, 파일만 만들 뿐 아무것도 바꾸지 않는다)만 되고, 그 밖의
POST/PUT/PATCH/DELETE 는 403. 관리자(tailnet 허용 계정·이 PC)는 언제나 edit.
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
from html import escape

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse

from config import ALLOW_FUNNEL, OUTPUT_DIR, TAILSCALE_ALLOW_USERS
from lock import check_pin, clear_fails, hash_pin, locked_out, record_fail

DEVICE_COOKIE = "dw_device"
DEVICE_MAX_AGE = 365 * 24 * 3600
JOIN_PREFIX = "/join/"
# 한 링크에 여러 IP 가 번갈아 틀려도 막히게 (IP 하나당은 lock.MAX_FAILS)
LINK_MAX_FAILS = 30
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
    out = {k: v for k, v in dv.items() if k != "hash"}
    out.setdefault("role", "edit")       # 권한이 생기기 전에 등록된 기기는 전처럼 수정 가능
    return out


def normalize_password(pw: object) -> str:
    s = str(pw or "").strip()
    if not (4 <= len(s) <= 64):
        raise ValueError("비밀번호는 4~64자여야 합니다.")
    return s


def _role(v) -> str:
    return "view" if str(v or "").lower() == "view" else "edit"


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
            d.setdefault("links", [])
            # 예전 방식(여러 번 쓰는 키 → 1회용 키)은 '링크 + 비밀번호' 로 바뀌었다
            d.pop("invite_key", None)
            d.pop("invites", None)
            self._data = d
        return self._data

    def _save(self) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    # --- 접속 링크 (여러 번 쓰는 링크 + 비밀번호) ---
    def links(self) -> list[dict]:
        with self._lock:
            d = self._load()
            counts: dict[str, int] = {}
            for dv in d["devices"]:
                if dv.get("link"):
                    counts[dv["link"]] = counts.get(dv["link"], 0) + 1
            return [{**{k: v for k, v in x.items() if k != "pw"}, "devices": counts.get(x["id"], 0)}
                    for x in d["links"]]

    def link_by_code(self, code: str) -> Optional[dict]:
        with self._lock:
            return next((x for x in self._load()["links"]
                         if hmac.compare_digest(x["code"], code or "")), None)

    def check_link_password(self, lid: str, password: str) -> bool:
        with self._lock:
            stored = next((x["pw"] for x in self._load()["links"] if x["id"] == lid), None)
        return check_pin(stored, password)

    def create_link(self, label: str, password: str, role: str = "view") -> dict:
        """링크 주소는 다시 복사할 수 있게 그대로 저장하고, 비밀번호는 scrypt 해시만 남긴다.
        주소만으로는 못 들어온다 — 비밀번호가 실제 열쇠다."""
        pw = normalize_password(password)
        now = round(time.time(), 3)
        ln = {"id": uuid.uuid4().hex[:8], "code": secrets.token_urlsafe(9),
              "label": (str(label or "").strip() or "접속 링크")[:40],
              "role": _role(role), "pw": hash_pin(pw), "created": now, "uses": 0}
        with self._lock:
            self._load()["links"].append(ln)
            self._save()
        return {k: v for k, v in ln.items() if k != "pw"}

    def update_link(self, lid: str, label: Optional[str], password: Optional[str],
                    role: Optional[str]) -> dict:
        pw = hash_pin(normalize_password(password)) if password is not None else None
        with self._lock:
            for ln in self._load()["links"]:
                if ln["id"] == lid:
                    if label is not None:
                        ln["label"] = (str(label).strip() or ln["label"])[:40]
                    if pw is not None:
                        ln["pw"] = pw
                    if role is not None:
                        ln["role"] = _role(role)
                    self._save()
                    return {k: v for k, v in ln.items() if k != "pw"}
        raise KeyError(lid)

    def delete_link(self, lid: str) -> None:
        """링크를 지운다. 그 링크로 이미 등록한 기기는 그대로 들어온다 (끊으려면 기기를 해제)."""
        with self._lock:
            d = self._load()
            before = len(d["links"])
            d["links"] = [x for x in d["links"] if x["id"] != lid]
            if len(d["links"]) == before:
                raise KeyError(lid)
            self._save()

    def join(self, ln: dict, name: str, who: dict) -> tuple[str, dict]:
        """비밀번호를 확인한 뒤 부른다. 이 브라우저를 '이름' 으로 등록하고 기기 토큰을 돌려준다.
        같은 이름이 다른 기기로 또 들어오면 기기가 하나 더 생긴다 (폰·노트북)."""
        token = secrets.token_urlsafe(32)
        now = round(time.time(), 3)
        dv = {"id": uuid.uuid4().hex[:8], "hash": _hash(token), "name": name,
              "role": _role(ln.get("role")), "link": ln["id"],
              "ua": who["ua"], "created": now, "last": now,
              "last_ip": who["ip"], "blocked": False}
        with self._lock:
            d = self._load()
            d["devices"].append(dv)
            for x in d["links"]:
                if x["id"] == ln["id"]:
                    x["uses"] = x.get("uses", 0) + 1
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

    def update(self, did: str, name: Optional[str], blocked: Optional[bool],
               role: Optional[str] = None) -> dict:
        with self._lock:
            for dv in self._load()["devices"]:
                if dv["id"] == did:
                    if name is not None:
                        dv["name"] = (str(name).strip() or dv["name"])[:40]
                    if blocked is not None:
                        dv["blocked"] = bool(blocked)
                    if role is not None:
                        dv["role"] = _role(role)
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


def can_edit(who: dict, device: Optional[dict]) -> bool:
    """바꾸는 요청을 보낼 수 있는가. 관리자는 언제나, 등록 기기는 그 기기의 role 로."""
    if is_admin(who):
        return True
    if device is not None:
        return _role(device.get("role", "edit")) == "edit"
    return True


# 보기만인 기기도 할 수 있는 '바꾸는' 요청 — 파일을 만들 뿐 아무것도 바꾸지 않는다
_VIEW_OK = ("/mixdown",)


def is_mutation(method: str, path: str) -> bool:
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    return not path.endswith(_VIEW_OK)


def owner_key(who: dict, device: Optional[dict]) -> str:
    """'누가' 를 한 문자열로 — 송 맵 버전의 주인을 기록·비교하는 데 쓴다.
    등록 기기는 기기 id, tailnet 계정은 로그인, 이 PC·태그 기기는 관리자."""
    if device is not None:
        return f"device:{device['id']}"
    if who["via"] == "tailnet" and who["login"]:
        return f"login:{who['login'].lower()}"
    return "admin"


def owner_name(who: dict, device: Optional[dict]) -> str:
    if device is not None:
        return device["name"]
    if who["via"] == "tailnet":
        return who.get("name") or who["login"]
    return "관리자"


def is_owner(owner: Optional[str], who: dict, device: Optional[dict]) -> bool:
    """그 버전을 만든 사람인가. 주인이 기록되지 않은 예전 버전은 관리자 것. 관리자는 모두 다룰 수 있다."""
    if is_admin(who):
        return True
    if not owner or owner == "admin":
        return False
    return owner == owner_key(who, device)


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
    "unregistered": "등록되지 않은 기기입니다. 받은 접속 링크를 열고 이름과 비밀번호를 넣어 주세요.",
    "blocked": "이 기기는 접속이 차단되었습니다.",
    "user": "허용된 Tailscale 계정의 기기에서만 열 수 있습니다.",
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


# --------------------------------------------------------------------------
# 접속 링크 화면 (/join/<코드>) — 등록 전 기기가 보는 유일한 화면이라 React 앱 밖에서 그린다
# --------------------------------------------------------------------------
_JOIN_HTML = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>접속 — Demucs Web</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--border:#e2e5ea;--text:#16181d;--muted:#6b7280;--accent:#3b6df6;--err:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#12141a;--panel:#1a1d25;--border:#2b303b;--text:#e8eaf0;--muted:#98a0ae;--accent:#6d92ff;--err:#ff7a6b}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
 background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
form,.box{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:24px}
h1{font-size:1.25rem;margin:0 0 4px}
p{margin:0 0 18px;color:var(--muted);font-size:.92rem}
label{display:block;font-size:.85rem;color:var(--muted);margin:12px 0 4px}
input{width:100%;font:inherit;font-size:1.05rem;padding:12px;border-radius:9px;border:1px solid var(--border);
 background:var(--bg);color:var(--text)}
input:focus{outline:2px solid var(--accent);border-color:transparent}
button,a.btn{display:block;width:100%;margin-top:20px;padding:13px;border:0;border-radius:9px;background:var(--accent);
 color:#fff;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
button:disabled{opacity:.6}
.err{color:var(--err);font-size:.9rem;margin-top:12px;min-height:1.3em}
</style></head><body>__BODY__</body></html>"""

_JOIN_FORM = """<form id="f">
<h1>__LABEL__</h1>
<p>처음 한 번만 이름과 비밀번호를 넣으면 이 기기가 등록됩니다.</p>
<label for="n">이름</label>
<input id="n" name="name" maxlength="40" autocomplete="name" placeholder="예: 철수" required value="__NAME__">
<label for="p">비밀번호</label>
<input id="p" name="password" type="password" maxlength="64" autocomplete="current-password" required>
<button id="b">들어가기</button>
<div class="err" id="e" role="alert"></div>
</form>
<script>
const f=document.getElementById("f"),e=document.getElementById("e"),b=document.getElementById("b");
(f.name.value?f.password:f.name).focus();
f.addEventListener("submit",async(ev)=>{ev.preventDefault();e.textContent="";b.disabled=true;
 try{const r=await fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},
  credentials:"same-origin",body:JSON.stringify({name:f.name.value,password:f.password.value})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){location.replace("/");return}
  e.textContent=d.detail||("들어가지 못했습니다 ("+r.status+")");f.password.value="";f.password.focus();
 }catch(x){e.textContent="서버에 연결하지 못했습니다."}
 b.disabled=false});
</script>"""


def _join_page(body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(_JOIN_HTML.replace("__BODY__", body), status_code=status)


def _join_box(title: str, text: str) -> str:
    return '<div class="box"><h1>' + escape(title) + "</h1><p>" + escape(text) + "</p></div>"


def start_url(request: Request, device: Optional[dict]) -> str:
    """홈 화면 아이콘이 열 주소. 링크로 등록한 기기는 '그 링크 + 이 기기 토큰' — 홈 화면 앱이
    Safari 와 쿠키를 나눠 쓰지 않아도 처음 열 때 같은 기기로 이어진다 (_join 의 ?t=)."""
    token = request.cookies.get(DEVICE_COOKIE, "")
    if device is not None and device.get("link") and token:
        ln = next((x for x in store.links() if x["id"] == device["link"]), None)
        if ln is not None:
            return f"{JOIN_PREFIX}{ln['code']}?t={token}"
    return "/ui/"


async def _join(request: Request, who: dict, device: Optional[dict]):
    code = request.url.path[len(JOIN_PREFIX):].strip("/")
    ln = store.link_by_code(code)
    if request.method == "GET":
        if ln is None:
            return _join_page(_join_box("없는 링크", "지워졌거나 잘못된 접속 링크입니다. 링크를 다시 받아 주세요."), 404)
        # 링크를 '들어오는 주소' 로 계속 쓸 수 있게: 이미 들어올 수 있는 기기는 바로 앱으로 보낸다.
        # (관리자 기기는 등록하지 않는다 — 기기 쿠키가 생기면 송 맵 주인이 그 기기로 기록된다)
        if is_admin(who):
            return RedirectResponse("/", status_code=303)
        if device is not None and not device.get("blocked") and not request.query_params.get("again"):
            return RedirectResponse("/", status_code=303)
        # 홈 화면 아이콘: iPhone·iPad 의 홈 화면 앱은 Safari 와 쿠키 저장소가 따로라서 처음 열면
        # 등록이 안 된 상태다. 그래서 manifest 의 start_url 에 이 기기 토큰을 실어 두고(?t=),
        # 그걸로 같은 기기 등록을 이어 준다 — 비밀번호를 다시 넣지 않아도 되고 기기도 늘지 않는다.
        t = request.query_params.get("t")
        if t:
            dv = store.device_for(t)
            if dv is not None and not dv.get("blocked") and dv.get("link") == ln["id"]:
                resp = RedirectResponse("/", status_code=303)
                resp.set_cookie(DEVICE_COOKIE, t, max_age=DEVICE_MAX_AGE, httponly=True,
                                secure=who["via"] != "direct", samesite="lax")
                _log(who, dv, "홈 화면 앱에서 등록 이어받음")
                return resp
        return _join_page(_JOIN_FORM.replace("__LABEL__", escape(ln["label"]))
                          .replace("__NAME__", escape(device["name"]) if device else ""))

    if request.method != "POST":
        return JSONResponse({"detail": "허용되지 않는 요청입니다."}, status_code=405)
    if ln is None:
        return JSONResponse({"detail": "지워졌거나 잘못된 접속 링크입니다."}, status_code=404)
    if is_admin(who):
        return JSONResponse({"detail": "관리자 기기는 등록하지 않아도 됩니다."}, status_code=400)
    if device is not None and device.get("blocked"):
        return JSONResponse({"detail": _MESSAGES["blocked"]}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = None
    body = body if isinstance(body, dict) else {}
    name = " ".join(str(body.get("name") or "").split())[:40]
    password = str(body.get("password") or "").strip()
    if not name:
        return JSONResponse({"detail": "이름을 넣어 주세요."}, status_code=400)

    lk = "join:" + ln["id"]
    wait = locked_out(lk, who["ip"]) or locked_out(lk, "*", LINK_MAX_FAILS)
    if wait:
        return JSONResponse({"detail": f"비밀번호를 여러 번 틀렸습니다. {(wait + 59) // 60}분 뒤에 다시 해 주세요."},
                            status_code=429)
    if not store.check_link_password(ln["id"], password):
        left = record_fail(lk, who["ip"])
        record_fail(lk, "*", LINK_MAX_FAILS)
        _log(who, device, f"접속 링크 비밀번호 틀림 ({name} / {ln['label']})")
        return JSONResponse({"detail": "비밀번호가 맞지 않습니다." + (f" (남은 기회 {left}번)" if left else "")},
                            status_code=403)
    clear_fails(lk, who["ip"])

    if device is not None:
        # 같은 브라우저가 다른 이름으로 다시 등록 — 예전 등록은 지운다
        try:
            store.delete(device["id"])
        except KeyError:
            pass
    token, dv = store.join(ln, name, who)
    resp = JSONResponse({"ok": True, "name": dv["name"]})
    resp.set_cookie(DEVICE_COOKIE, token, max_age=DEVICE_MAX_AGE, httponly=True,
                    secure=who["via"] != "direct", samesite="lax")
    _log(who, dv, f"기기 등록 — {name} (링크 {ln['label']})")
    return resp


async def middleware(request: Request, call_next):
    who = classify(request)
    method, path = request.method, request.url.path
    device = store.device_for(request.cookies.get(DEVICE_COOKIE, ""))

    # 접속 링크: 이름 + 비밀번호로 이 브라우저를 등록한다 (등록 전이라 _denied 보다 먼저)
    if path.startswith(JOIN_PREFIX):
        resp = await _join(request, who, device)
        _remember(who, device, method, path, resp.status_code, resp.status_code >= 400)
        if method != "GET" or resp.status_code >= 400:
            _log(who, device, f"{method} {JOIN_PREFIX}… {resp.status_code}")
        resp.headers["Cache-Control"] = "no-store"
        return resp

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
    elif path.startswith("/api/") and is_mutation(method, path) and not can_edit(who, device):
        status = 403
        resp = JSONResponse({"detail": "보기 전용 기기입니다. 재생·다운로드만 할 수 있습니다."},
                            status_code=403)
    else:
        request.state.who = who
        request.state.device = device
        resp = await call_next(request)
        status = resp.status_code

    # API 응답은 캐시하지 않는다 (목록·송 맵·잠금 상태가 늘 최신이어야 한다). 파일·악보 그림은 제외
    if path.startswith("/api/") and "/files/" not in path and "/score/pages/" not in path:
        resp.headers.setdefault("Cache-Control", "no-store")
    if device and not reason:
        store.touch(device, who["ip"])
    _remember(who, device, method, path, status, bool(reason))
    quiet = (method, path) in _QUIET_EXACT or any(p in path for p in _QUIET_PARTS)
    if reason or status == 403 or not quiet:
        _log(who, device, f"{method} {path} {status}" + (" (차단)" if reason else ""))
    return resp
