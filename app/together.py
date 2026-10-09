"""함께 연습 — 떨어져 있는 여러 기기가 같은 곡을 같은 순간에 재생한다.

곡마다 방이 하나 있다(작업 id). 방에 들어온 기기는 누구든 재생·일시정지·이동·속도·구간
반복을 할 수 있고, 모두가 따라간다. 볼륨·음소거·솔로는 각자 따로다(연습하는 파트가 다르다).

동기화 방식:
  - 서버 시계를 기준으로 삼는다. 기기는 ping/pong 으로 자기 시계와 서버 시계의 차이를
    잰다 (왕복 시간이 가장 짧았던 측정을 믿는다 — NTP 와 같은 생각).
  - 재생 상태는 "서버 시각 at(ms)에 곡 위치 pos(초), 속도 rate" 하나로 나타낸다.
    그러면 어느 순간이든 곡 위치 = pos + (지금 - at)/1000 × rate 로 모두가 같은 값을 낸다.
    구간 반복(loop)이 있으면 그 안에서 되감는다.
  - 재생을 누르면 바로 시작하지 않고 '맞추고 시작' 한다: 모두가 그 위치로 가서 오디오를
    받아 두고 시계를 다시 잰 뒤 ready 를 보내고, 전원이 준비되면(최대 PREPARE_TIMEOUT)
    서버가 at 을 조금 뒤로 잡아 모두가 그 순간에 맞춰 예비박을 세고 들어간다.
    준비 없이 정해진 시각에 바로 들어가면 원격 기기는 아직 받는 중이라 늦게 들어갔다.
  - 늦게 들어온 기기는 지금 위치로 바로 합류한다.

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
# '맞추고 시작': 모두 준비되면 이만큼 뒤에 들어간다 (예비박이 있으면 그 길이만큼 더)
GO_LEAD = 1.0
# 준비가 안 끝난 기기를 기다리는 최대 시간 — 넘으면 준비된 기기만 먼저 시작하고, 늦은
# 기기는 준비되는 대로 지금 위치로 합류한다
PREPARE_TIMEOUT = 10.0


def now_ms() -> float:
    return time.time() * 1000.0


class Room:
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        self.members: dict[str, dict] = {}       # id → {ws, name, err, rtt}
        # prepare: 시작 준비 중이면 {id, pos, count_in, lead} — 모두 그 위치를 받아 두고
        # 'ready' 를 보내면(또는 PREPARE_TIMEOUT 이 지나면) 그때 시작 시각을 정한다
        self.state = {"playing": False, "pos": 0.0, "at": now_ms(), "rate": 1.0,
                      "count_in": 0, "loop": None, "seq": 0, "by": "", "prepare": None}
        self.ready: set[str] = set()
        self._prep_task: Optional[asyncio.Task] = None
        self._loop_task: Optional[asyncio.Task] = None
        # 반복 구간을 다시 시작할 때 쓸 예비박 수와 여유 — 마지막 재생 요청의 것을 따른다
        self.loop_count_in = 0
        self.loop_lead = GO_LEAD
        # 소리로 맞춤 확인 중이면 첫 클릭의 서버 시각(ms). 그때부터 1초마다 모두 클릭한다
        self.beep_at: Optional[float] = None

    def cancel_prepare(self) -> None:
        if self._prep_task and not self._prep_task.done():
            self._prep_task.cancel()
        self._prep_task = None
        self.state["prepare"] = None
        self.ready.clear()

    async def prepare(self, pos: float, count_in: int, lead: float, by: str) -> None:
        """'맞추고 시작': 모두가 pos 를 받아 두고 시계를 다시 잰 뒤 ready 를 보내면 시작한다."""
        self.cancel_prepare()
        pid = uuid.uuid4().hex[:6]
        self.state.update(playing=False, pos=pos, at=now_ms(), count_in=0, by=by,
                          prepare={"id": pid, "pos": pos, "count_in": count_in, "lead": lead})
        await self.push_state()
        await self.push_members()
        self._prep_task = asyncio.create_task(self._go_after_timeout(pid))

    async def _go_after_timeout(self, pid: str) -> None:
        try:
            await asyncio.sleep(PREPARE_TIMEOUT)
        except asyncio.CancelledError:
            return
        p = self.state.get("prepare")
        if p and p["id"] == pid:
            await self.go()

    async def mark_ready(self, mid: str, pid: str) -> None:
        p = self.state.get("prepare")
        if not p or p["id"] != pid:
            return
        self.ready.add(mid)
        await self.push_members()
        if set(self.members) <= self.ready:
            await self.go()

    async def go(self) -> None:
        p = self.state.get("prepare")
        if not p:
            return
        if self._prep_task and self._prep_task is not asyncio.current_task() and not self._prep_task.done():
            self._prep_task.cancel()
        self._prep_task = None
        self.ready.clear()
        self.state.update(playing=True, pos=p["pos"], at=now_ms() + max(GO_LEAD, p["lead"]) * 1000,
                          count_in=p["count_in"], prepare=None)
        await self.push_state()
        await self.push_members()

    def position(self, t_ms: float) -> float:
        s = self.state
        if not s["playing"]:
            return s["pos"]
        p = s["pos"] + max(0.0, t_ms - s["at"]) / 1000.0 * s["rate"]
        lp = s["loop"]
        # 반복 구간 끝에서는 멈춘다 — 그 순간 _loop_restart 가 모두를 예비박부터 다시 시작시킨다
        if lp and lp["end"] - lp["start"] > 0.2 and s["pos"] < lp["end"]:
            p = min(p, lp["end"])
        return p

    def _schedule_loop(self) -> None:
        """재생 중이고 반복 구간이 있으면 끝나는 순간에 다시 시작하도록 걸어 둔다."""
        if self._loop_task and self._loop_task is not asyncio.current_task() and not self._loop_task.done():
            self._loop_task.cancel()
        self._loop_task = None
        s, lp = self.state, self.state.get("loop")
        if not (s["playing"] and lp and s["pos"] < lp["end"]):
            return
        delay = max(0.0, (s["at"] - now_ms()) / 1000.0) + (lp["end"] - s["pos"]) / max(0.1, s["rate"])
        self._loop_task = asyncio.create_task(self._loop_restart(s["seq"], delay))

    async def _loop_restart(self, seq: int, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        s, lp = self.state, self.state.get("loop")
        if s["seq"] != seq or not s["playing"] or not lp:
            return          # 그새 다른 조작이 있었다
        # 반복 끝: 모두 멈추고 → 반복 시작을 받아 두고 → 예비박부터 같이
        await self.prepare(lp["start"], self.loop_count_in, self.loop_lead, s["by"])

    def members_view(self) -> list[dict]:
        preparing = self.state.get("prepare") is not None
        return [{"id": k, "name": m["name"], "err": m.get("err"), "rtt": m.get("rtt"),
                 "dev": m.get("dev"), "delay": m.get("delay"),
                 "ready": (k in self.ready) if preparing else m.get("ready", False),
                 "preparing": preparing and k not in self.ready}
                for k, m in self.members.items()]

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
        self._schedule_loop()
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
    # 웹소켓은 http 미들웨어를 거치지 않으므로 곡 공유 범위도 여기서 확인한다
    if access._denied(who, device) or (access.job_guard and not access.job_guard(job_id, who, device)):
        await ws.close(code=4403)
        return
    await ws.accept()

    room = rooms.setdefault(job_id, Room(job_id))
    mid = uuid.uuid4().hex[:8]
    name = (ws.query_params.get("name") or "").strip()[:30] or _default_name(who, device)
    room.members[mid] = {"ws": ws, "name": name}
    print(f"[together] {job_id} 입장 {name} ({who['via']} {who['ip']}) — {len(room.members)}명", flush=True)
    await room.send(mid, {"t": "hello", "you": mid, "name": name, "state": room.state,
                          "server": now_ms(), "members": room.members_view(),
                          "beep": room.beep_at})
    await room.push_members()

    try:
        while True:
            msg = json.loads(await ws.receive_text())
            t = msg.get("t")
            if t == "ping":
                # 받은 즉시 서버 시각을 돌려준다 (기기가 왕복 시간으로 시계 차이를 잰다)
                await room.send(mid, {"t": "pong", "c": msg.get("c"), "s": now_ms()})
            elif t == "play":
                if room.beep_at is not None:      # 음악을 틀면 확인 클릭은 끈다
                    room.beep_at = None
                    await room.broadcast({"t": "beep", "at": None, "by": name})
                # 바로 시작하지 않고 '맞추고 시작' — 모두 그 위치를 받아 둔 뒤 같이 들어간다
                room.state.update(rate=_num(msg.get("rate"), room.state["rate"], 0.5, 1.5),
                                  loop=_clamp_loop(msg.get("loop")))
                count_in = int(_num(msg.get("count_in"), 0, 0, 16))
                lead = _num(msg.get("lead"), GO_LEAD, 0.0, MAX_LEAD)
                if room.state["loop"]:
                    room.loop_count_in, room.loop_lead = count_in, lead
                await room.prepare(_num(msg.get("pos"), 0.0, 0.0, 86400.0), count_in, lead, name)
            elif t == "ready":
                await room.mark_ready(mid, str(msg.get("id") or ""))
            elif t == "pause":
                preparing = room.state.get("prepare") is not None
                room.cancel_prepare()
                pos = room.position(now_ms())
                if msg.get("pos") is not None and not room.state["playing"] and not preparing:
                    pos = _num(msg.get("pos"), pos, 0.0, 86400.0)
                room.state.update(playing=False, pos=pos, at=now_ms(), count_in=0, by=name)
                await room.push_state()
                await room.push_members()
            elif t == "seek":
                pos = _num(msg.get("pos"), 0.0, 0.0, 86400.0)
                if room.state["playing"] or room.state.get("prepare"):
                    # 재생 중 이동: 새 자리를 모두 받아 둔 뒤 같이 이어간다 (예비박 없이).
                    # 합친 재생은 조용한 앞부분(1.5초)에서 위치를 맞추므로 그만큼 여유를 더 둔다
                    await room.prepare(pos, 0, GO_LEAD + 1.7, name)
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
            elif t == "beep":
                # 소리로 맞춤 확인: 모두가 같은 서버 시각들에 클릭을 낸다. 한 번 '딱' 으로 들리면 맞은 것,
                # '따닥' 으로 갈라지면 어긋난 것 — 각자 '내 기기 지연' 을 조정한다
                # 한 번 누르면 켜지고(멈출 때까지 1초마다), 다시 누르면 꺼진다
                room.beep_at = (now_ms() + 1000) if msg.get("on", True) else None
                await room.broadcast({"t": "beep", "at": room.beep_at, "by": name})
            elif t == "calib":
                # 마이크로 자동 맞춤: 모두가 서버 시각 at 부터 1초마다, 기기마다 정해진 칸(order 순서)에
                # 짧은 삐를 낸다. 누른 기기가 마이크로 듣고 각 기기에 보정값(adjust)을 보낸다
                await room.broadcast({"t": "calib", "at": now_ms() + 2500, "order": list(room.members),
                                      "by": mid, "by_name": name})
            elif t == "adjust":
                target = str(msg.get("id") or "")
                if target in room.members:
                    await room.send(target, {"t": "adjust", "ms": _num(msg.get("ms"), 0.0, -400.0, 400.0),
                                             "by": name})
            elif t == "report":
                # 기기가 잰 자기 상태(서버 기준 어긋남 ms, 왕복 시간) — 참여자 목록에 보인다
                m = room.members.get(mid)
                if m:
                    m["err"] = msg.get("err")
                    m["rtt"] = msg.get("rtt")
                    m["ready"] = bool(msg.get("ready"))
                    # 기기 자동 측정값·내 기기 지연 (참여자 목록에 보인다)
                    m["dev"] = msg.get("dev")
                    m["delay"] = msg.get("delay")
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
        room.ready.discard(mid)
        print(f"[together] {job_id} 퇴장 {name} — {len(room.members)}명", flush=True)
        if room.members:
            await room.push_members()
            # 준비를 기다리던 사람이 나갔으면 남은 사람끼리 시작한다
            if room.state.get("prepare") and set(room.members) <= room.ready:
                await room.go()
        else:
            room.cancel_prepare()
            # 아무도 없으면 방을 비운다 (다음에 들어오면 멈춘 상태에서 시작)
            rooms.pop(job_id, None)
