import { useCallback, useEffect, useRef, useState } from "react";
import { BASE } from "../api";

/** 방의 재생 상태. 곡 위치 = pos + (서버시각 - at)/1000 × rate (재생 중일 때) */
export interface RoomState {
  playing: boolean;
  pos: number;
  /** 서버 시각(ms) — 이 순간 곡 위치가 pos */
  at: number;
  rate: number;
  count_in: number;
  loop: { start: number; end: number } | null;
  seq: number;
  /** 마지막으로 조작한 사람 */
  by: string;
  /** '맞추고 시작' 준비 중 — 이 위치를 받아 두고 ready 를 보내면 모두 함께 시작한다 */
  prepare: { id: string; pos: number; count_in: number; lead: number } | null;
}

export interface Member {
  id: string;
  name: string;
  /** 서버 기준 어긋남(ms) — 그 기기가 스스로 잰 값 */
  err: number | null;
  rtt: number | null;
  ready: boolean;
  /** 시작 준비가 아직 안 끝남 */
  preparing: boolean;
}

const LS_NAME = "together.name";

/** 단조 증가하는 지금 시각(ms). Date.now() 는 시계 조정으로 튈 수 있다. */
const localNow = () => performance.timeOrigin + performance.now();

/**
 * 방 위치 계산 (서버 together.Room.position 과 같은 규칙). 반복 구간 끝에서는 멈춘다 —
 * 서버가 그 순간 모두를 멈추고 예비박부터 다시 시작시킨다.
 */
export function roomPosition(s: RoomState, serverMs: number) {
  if (!s.playing) return s.pos;
  const p = s.pos + (Math.max(0, serverMs - s.at) / 1000) * s.rate;
  const lp = s.loop;
  if (lp && lp.end - lp.start > 0.2 && s.pos < lp.end) return Math.min(p, lp.end);
  return p;
}

/**
 * 함께 연습 방 연결. 시계 맞추기(ping/pong)와 명령 전송만 맡고, 실제 재생은 Mixer 가 한다.
 *
 * 시계: 몇 번 주고받아 왕복 시간(RTT)이 가장 짧았던 측정으로 서버-기기 시계 차이를 잡는다
 * (왕복이 짧을수록 '가는 시간 = 오는 시간' 가정이 맞다). 20초마다 다시 잰다.
 */
export function useTogether(jobId: string, onState: (s: RoomState, fresh: boolean) => void) {
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<string>("");
  const [error, setError] = useState("");
  const [name, setNameState] = useState(() => {
    try {
      return localStorage.getItem(LS_NAME) ?? "";
    } catch {
      return "";
    }
  });
  const [rtt, setRtt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const offsetRef = useRef(0); // 서버 - 기기 (ms)
  const bestRef = useRef<{ rtt: number; at: number } | null>(null);
  const stateRef = useRef<RoomState | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const serverNow = useCallback(() => localNow() + offsetRef.current, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // 응답을 기다리는 ping (시작 직전에 시계를 다시 잴 때)
  const pongWait = useRef<(() => void) | null>(null);
  /** 시계를 다시 잰다 — 시작 직전에 부른다. 최선값을 버리고 n 번 새로 재서 그중 최선을 쓴다. */
  const resync = useCallback(
    (n = 6) =>
      new Promise<void>((resolve) => {
        bestRef.current = null;
        let got = 0;
        const done = () => {
          pongWait.current = null;
          resolve();
        };
        pongWait.current = () => {
          if (++got >= n) done();
        };
        for (let i = 0; i < n; i++) window.setTimeout(() => send({ t: "ping", c: localNow() }), i * 80);
        // 응답이 안 와도 오래 붙잡지 않는다
        window.setTimeout(done, 1500);
      }),
    [send],
  );

  const leave = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    stateRef.current = null;
    setJoined(false);
    setConnected(false);
    setMembers([]);
  }, []);

  const join = useCallback(() => {
    if (wsRef.current) return;
    setError("");
    setJoined(true);
    const base = BASE || location.origin;
    const url =
      base.replace(/^http/, "ws") +
      `/api/together/${encodeURIComponent(jobId)}` +
      (name ? `?name=${encodeURIComponent(name)}` : "");
    const ws = new WebSocket(url);
    wsRef.current = ws;
    bestRef.current = null;
    let timers: number[] = [];

    const burst = (n: number) => {
      for (let i = 0; i < n; i++)
        timers.push(window.setTimeout(() => send({ t: "ping", c: localNow() }), i * 120));
    };

    ws.onopen = () => {
      setConnected(true);
      burst(8);
      // 시계는 조금씩 흐른다 — 주기적으로 다시 잰다. 오래된 최선값은 버린다.
      timers.push(
        window.setInterval(() => {
          if (bestRef.current && localNow() - bestRef.current.at > 60_000) bestRef.current = null;
          burst(3);
        }, 20_000),
      );
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.t === "pong") {
        const t1 = localNow();
        const r = t1 - msg.c;
        // 왕복 시간이 가장 짧은 측정이 가장 정확하다
        if (!bestRef.current || r <= bestRef.current.rtt * 1.2) {
          offsetRef.current = msg.s - (msg.c + r / 2);
          if (!bestRef.current || r < bestRef.current.rtt) bestRef.current = { rtt: r, at: t1 };
          setRtt(Math.round(r));
        }
        pongWait.current?.();
      } else if (msg.t === "hello") {
        setMe(msg.you);
        setMembers(msg.members);
        if (!name) setNameState(msg.name);
        stateRef.current = msg.state;
        // 들어오자마자 서버 시각으로 대략 맞춰 둔다 (정확한 값은 pong 이 채운다)
        if (!bestRef.current) offsetRef.current = msg.server - localNow();
        onStateRef.current(msg.state, true);
      } else if (msg.t === "state") {
        stateRef.current = msg.state;
        onStateRef.current(msg.state, false);
      } else if (msg.t === "members") {
        setMembers(msg.members);
      }
    };
    ws.onclose = (ev) => {
      timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
      });
      timers = [];
      if (wsRef.current === ws) wsRef.current = null;
      setConnected(false);
      if (ev.code === 4403) setError("이 기기는 함께 연습에 들어갈 수 없습니다.");
      else if (ev.code === 4404) setError("곡을 찾을 수 없습니다.");
      else if (stateRef.current !== null) setError("연결이 끊어졌습니다. 다시 참여해 주세요.");
      stateRef.current = null;
      setJoined(false);
    };
  }, [jobId, name, send]);

  // 곡이 바뀌면 방을 나간다 (방은 곡마다 따로)
  useEffect(() => leave, [jobId, leave]);

  const setName = useCallback(
    (n: string) => {
      const v = n.trim().slice(0, 30);
      setNameState(v);
      try {
        localStorage.setItem(LS_NAME, v);
      } catch {
        /* 기억만 못 할 뿐 */
      }
      if (v) send({ t: "name", name: v });
    },
    [send],
  );

  return {
    joined,
    connected,
    members,
    me,
    error,
    name,
    rtt,
    setName,
    join,
    leave,
    send,
    resync,
    serverNow,
    state: stateRef,
  };
}
