"""함께 연습 — 떨어져 있는 여러 기기가 같은 곡을 같은 순간에 재생한다.

곡마다 방이 하나 있다(작업 id). 방에 들어온 기기는 누구든 재생·일시정지·이동·속도·구간
반복을 할 수 있고, 모두가 따라간다. 볼륨·음소거·솔로는 각자 따로다(연습하는 파트가 다르다).

동기화 방식:
  - 서버 시계를 기준으로 삼는다. 기기는 ping/pong 으로 자기 시계와 서버 시계의 차이를
    잰다 (왕복 시간이 가장 짧았던 측정을 믿는다 — NTP 와 같은 생각).
  - 재생 상태는 "서버 시각 at(ms)에 곡 위치 pos(초), 속도 rate" 하나로 나타낸다.
    그러면 어느 순간이든 곡 위치 = pos + (지금 - at)/1000 × rate 로 모두가 같은 값을 낸다.
    구간 반복(loop)이 있으면 그 안에서 되감는다.
  - 재생을 누르면 at 을 조금 뒤(예비박 + 네트워크 여유)로 잡아 모두가 그 순간에 맞춰
    예비박을 세고 들어간다. 늦게 들어온 기기는 지금 위치로 바로 합류한다.

접근 제한은 HTTP 미들웨어가 WebSocket 에는 걸리지 않으므로 여기서 같은 규칙으로 직접 막는다.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

import access

# 재생을 누르고 실제로 들어가기까지 최소 여유 — 멀리 있는 기기에도 메시지가 닿아야 한다
MIN_LEAD = 0.6
MAX_LEAD = 8.0


def now_ms() -> float:
    return time.time() * 1000.0


class Room:
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        self.members: dict[str, dict] = {}       # id → {ws, name, err, rtt}
        self.state = {"playing": False, "pos": 0.0, "at": now_ms(), "rate": 1.0,
                      "count_in": 0, "loop": None, "seq": 0, "by": ""}

    def position(self, t_ms: float) -> float:
        s = self.state
        if not s["playing"]:
            return s["pos"]
        p = s["pos"] + max(0.0, t_ms - s["at"]) / 1000.0 * s["rate"]
        lp = s["loop"]
        if lp and lp["end"] - lp["start"] > 0.2 and p >= lp["end"]:
            p = lp["start"] + (p - lp["start"]) % (lp["end"] - lp["start"])
        return p

    def members_view(self) -> list[dict]:
        return [{"id": k, "name": m["name"], "err": m.get("err"), "rtt": m.get("rtt"),
                 "ready": m.get("ready", False)} for k, m in self.members.items()]

    async def send(self, mid: str, msg: dict) -> None:
        m = self.members.get(mid)
        if not m:
            return
        try:
            await m["ws"].send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            pass

    async def broadcast(self, msg: dict) -> None:
        await asyncio.gather(*(self.send(k, msg) for k in list(self.members)))

    async def push_state(self) -> None:
        self.state["seq"] += 1
        await self.broadcast({"t": "state", "state": self.state, "server": now_ms()})

    async def push_members(self) -> None:
        await self.broadcast({"t": "members", "members": self.members_view()})


rooms: dict[str, Room] = {}


def _clamp_loop(v) -> Optional[dict]:
    try:
        if v and float(v["end"]) - float(v["start"]) > 0.2:
            return {"start": max(0.0, float(v["start"])), "end": float(v["end"])}
    except (KeyError, TypeError, ValueError):
        pass
    return None


def _num(v, default: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if x != x:          # NaN
        return default
    return min(hi, max(lo, x))


def _default_name(who: dict, device: Optional[dict]) -> str:
    if device:
        return device["name"]
    if who["via"] == "direct":
        return "이 PC"
    return who.get("name") or who.get("login") or "참여자"


async def handle(ws: WebSocket, job_id: str) -> None:
    who = access.classify(ws)  # type: ignore[arg-type]  (헤더·쿠키·client 는 Request 와 같다)
    device = access.store.device_for(ws.cookies.get(access.DEVICE_COOKIE, ""))
    if access._denied(who, device):
        await ws.close(code=4403)
        return
    await ws.accept()

    room = rooms.setdefault(job_id, Room(job_id))
    mid = uuid.uuid4().hex[:8]
    name = (ws.query_params.get("name") or "").strip()[:30] or _default_name(who, device)
    room.members[mid] = {"ws": ws, "name": name}
    print(f"[together] {job_id} 입장 {name} ({who['via']} {who['ip']}) — {len(room.members)}명", flush=True)
    await room.send(mid, {"t": "hello", "you": mid, "name": name, "state": room.state,
                          "server": now_ms(), "members": room.members_view()})
    await room.push_members()

    try:
        while True:
            msg = json.loads(await ws.receive_text())
            t = msg.get("t")
            if t == "ping":
                # 받은 즉시 서버 시각을 돌려준다 (기기가 왕복 시간으로 시계 차이를 잰다)
                await room.send(mid, {"t": "pong", "c": msg.get("c"), "s": now_ms()})
            elif t == "play":
                lead = _num(msg.get("lead"), MIN_LEAD, MIN_LEAD, MAX_LEAD)
                rate = _num(msg.get("rate"), room.state["rate"], 0.5, 1.5)
                room.state.update(playing=True, pos=_num(msg.get("pos"), 0.0, 0.0, 86400.0),
                                  at=now_ms() + lead * 1000, rate=rate,
                                  count_in=int(_num(msg.get("count_in"), 0, 0, 16)),
                                  loop=_clamp_loop(msg.get("loop")), by=name)
                await room.push_state()
            elif t == "pause":
                pos = room.position(now_ms())
                if msg.get("pos") is not None and not room.state["playing"]:
                    pos = _num(msg.get("pos"), pos, 0.0, 86400.0)
                room.state.update(playing=False, pos=pos, at=now_ms(), count_in=0, by=name)
                await room.push_state()
            elif t == "seek":
                pos = _num(msg.get("pos"), 0.0, 0.0, 86400.0)
                if room.state["playing"]:
                    # 재생 중 이동: 모두에게 닿을 만큼 조금 뒤에 그 자리에서 이어간다 (예비박 없이)
                    room.state.update(pos=pos, at=now_ms() + MIN_LEAD * 1000, count_in=0, by=name)
                else:
                    room.state.update(pos=pos, at=now_ms(), by=name)
                await room.push_state()
            elif t == "rate":
                rate = _num(msg.get("rate"), 1.0, 0.5, 1.5)
                if room.state["playing"]:
                    at = now_ms() + MIN_LEAD * 1000
                    room.state.update(pos=room.position(at), at=at, rate=rate, count_in=0, by=name)
                else:
                    room.state.update(rate=rate, by=name)
                await room.push_state()
            elif t == "loop":
                lp = _clamp_loop(msg.get("loop"))
                if room.state["playing"]:
                    at = now_ms() + MIN_LEAD * 1000
                    room.state.update(pos=room.position(at), at=at, loop=lp, count_in=0, by=name)
                else:
                    room.state.update(loop=lp, by=name)
                await room.push_state()
            elif t == "report":
                # 기기가 잰 자기 상태(서버 기준 어긋남 ms, 왕복 시간) — 참여자 목록에 보인다
                m = room.members.get(mid)
                if m:
                    m["err"] = msg.get("err")
                    m["rtt"] = msg.get("rtt")
                    m["ready"] = bool(msg.get("ready"))
                    await room.push_members()
            elif t == "name":
                m = room.members.get(mid)
                if m:
                    m["name"] = (str(msg.get("name") or "").strip()[:30] or m["name"])
                    name = m["name"]
                    await room.push_members()
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:                # 잘못된 메시지 등 — 이 연결만 끊는다
        print(f"[together] {job_id} {name} 연결 오류: {e}", flush=True)
    finally:
        room.members.pop(mid, None)
        print(f"[together] {job_id} 퇴장 {name} — {len(room.members)}명", flush=True)
        if room.members:
            await room.push_members()
        else:
            # 아무도 없으면 방을 비운다 (다음에 들어오면 멈춘 상태에서 시작)
            rooms.pop(job_id, None)
