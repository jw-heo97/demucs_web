import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { InkDoc, InkStroke, ScoreMeasure } from "../types";

export const INK_COLORS: { c: string; label: string }[] = [
  { c: "#d22", label: "빨강" },
  { c: "#1d5fd6", label: "파랑" },
  { c: "#111", label: "검정" },
];
export type InkTool = { kind: "pen"; color: string } | { kind: "eraser" };

/** 곡의 필기 전체. 고치면 잠깐 뒤 서버에 통째로 저장한다 (펜을 떼자마자 매번 보내지 않게). */
export function useScoreInk(jobId: string) {
  const [doc, setDoc] = useState<InkDoc>({ pages: {} });
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(doc);
  const undo = useRef<InkDoc[]>([]);

  useEffect(() => {
    let alive = true;
    setDoc({ pages: {} });
    undo.current = [];
    if (!jobId) return;
    api.scoreInk(jobId).then((d) => alive && setDoc(latest.current = d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [jobId]);

  const flush = async () => {
    setState("saving");
    try {
      await api.saveScoreInk(jobId, latest.current);
      setState("saved");
    } catch {
      setState("error");
    }
  };
  const change = (page: number, f: (s: InkStroke[]) => InkStroke[]) => {
    const prev = latest.current;
    const cur = prev.pages[String(page)] ?? [];
    const next = f(cur);
    if (next === cur) return;
    undo.current = [...undo.current.slice(-50), prev];
    latest.current = { pages: { ...prev.pages, [String(page)]: next } };
    setDoc(latest.current);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 800);
  };
  const back = () => {
    const p = undo.current.pop();
    if (!p) return;
    latest.current = p;
    setDoc(p);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 800);
  };
  // 곡을 떠날 때 남은 저장
  useEffect(
    () => () => {
      if (timer.current && jobId) {
        window.clearTimeout(timer.current);
        void api.saveScoreInk(jobId, latest.current).catch(() => {});
      }
    },
    [jobId],
  );
  return { doc, change, back, canUndo: undo.current.length > 0, state };
}

/** 쪽의 어느 부분을 보여 주나 (쪽 기준 0~1). 없으면 쪽 전체 */
export interface InkView {
  x: number;
  y: number;
  w: number;
  h: number;
}
const FULL: InkView = { x: 0, y: 0, w: 1, h: 1 };

/**
 * 원본 악보 한 쪽 위의 필기 판. editing 이 아니면 보기만 (누름은 아래 악보로 간다).
 * view 를 주면 쪽의 그 부분만 확대해 보여 주는 판 — 좌표는 늘 쪽 기준으로 저장한다.
 * 펜을 한 번이라도 쓰면 손가락 터치는 무시한다 (손바닥).
 */
export function InkLayer({
  strokes,
  editing,
  tool,
  onChange,
  view = FULL,
}: {
  strokes: InkStroke[];
  editing: boolean;
  tool: InkTool;
  onChange: (f: (s: InkStroke[]) => InkStroke[]) => void;
  view?: InkView;
}) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const cur = useRef<{ id: number; s: InkStroke } | null>(null);
  const penSeen = useRef(false);

  useLayoutEffect(() => {
    const el = cv.current?.parentElement;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = () => {
    const c = cv.current;
    if (!c || !size.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(size.w * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = cur.current ? [...strokes, cur.current.s] : strokes;
    const X = (x: number) => ((x - view.x) / view.w) * size.w;
    const Y = (y: number) => ((y - view.y) / view.h) * size.h;
    for (const s of all) {
      ctx.strokeStyle = s.c;
      ctx.lineWidth = Math.max(1, (s.w / view.w) * size.w);
      ctx.beginPath();
      s.p.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      if (s.p.length === 1) ctx.lineTo(X(s.p[0][0]) + 0.1, Y(s.p[0][1]));
      ctx.stroke();
    }
  };
  useEffect(draw);

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = cv.current!.getBoundingClientRect();
    return [view.x + ((e.clientX - r.left) / r.width) * view.w, view.y + ((e.clientY - r.top) / r.height) * view.h];
  };
  const skip = (e: React.PointerEvent) => {
    if (e.pointerType === "pen") penSeen.current = true;
    return e.pointerType === "touch" && penSeen.current;
  };
  // 지우개: 누른 자리 가까이(보이는 폭의 1.5%) 지나는 획을 통째로 지운다
  const erase = (p: [number, number]) => {
    const r = 0.015 * view.w;
    // 쪽 높이/폭 (거리를 쪽 폭 단위로)
    const ratio = (size.h / view.h) / Math.max(1, size.w / view.w);
    onChange((ss) => {
      const kept = ss.filter((s) => !s.p.some(([x, y]) => Math.hypot(x - p[0], (y - p[1]) * ratio) < r));
      return kept.length === ss.length ? ss : kept;
    });
  };
  const down = (e: React.PointerEvent) => {
    if (!editing || skip(e)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      cv.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 이미 끝난 포인터 */
    }
    if (tool.kind === "eraser") {
      cur.current = null;
      erase(at(e));
      eraserId.current = e.pointerId;
      return;
    }
    // 굵기: 화면에서 2.6px — 확대해서 쓰면 쪽에서는 그만큼 가늘다
    cur.current = { id: e.pointerId, s: { c: tool.color, w: Math.max(0.0002, (2.6 / Math.max(1, size.w)) * view.w), p: [at(e)] } };
    draw();
  };
  const eraserId = useRef<number | null>(null);
  const move = (e: React.PointerEvent) => {
    if (!editing) return;
    if (eraserId.current === e.pointerId) return erase(at(e));
    const c = cur.current;
    if (!c || c.id !== e.pointerId) return;
    const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
    (evs.length ? evs : [e]).forEach((p) => c.s.p.push(at(p)));
    draw();
  };
  const up = (e: React.PointerEvent) => {
    if (eraserId.current === e.pointerId) eraserId.current = null;
    const c = cur.current;
    if (!c || c.id !== e.pointerId) return;
    cur.current = null;
    // 점을 줄여 저장 (소수 4자리, 거의 같은 자리 점은 빼기)
    const pts: [number, number][] = [];
    for (const [x, y] of c.s.p) {
      const q: [number, number] = [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5];
      const l = pts[pts.length - 1];
      if (!l || Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) > 0.0008 * view.w) pts.push(q);
    }
    onChange((ss) => [...ss, { ...c.s, p: pts }]);
  };

  return (
    <canvas
      ref={cv}
      className={`ink-layer${editing ? " editing" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}

/**
 * 필기용 확대 창: 고른 마디(또는 그 줄 전체)를 화면 폭에 맞게 크게 띄워 그 위에 쓴다.
 * 획은 쪽 좌표로 저장되므로 원래 쪽 보기에도 그대로 보인다.
 */
export function InkZoom({
  imgUrl,
  pageW,
  pageH,
  measures,
  start,
  strokesOf,
  onChange,
  tool,
  setTool,
  back,
  canUndo,
  state,
  onClose,
}: {
  /** 쪽 → 그림 주소 */
  imgUrl: (page: number) => string;
  pageW: (page: number) => number;
  pageH: (page: number) => number;
  measures: ScoreMeasure[];
  /** 처음 연 악보 마디 (0부터) */
  start: number;
  strokesOf: (page: number) => InkStroke[];
  onChange: (page: number, f: (s: InkStroke[]) => InkStroke[]) => void;
  tool: InkTool;
  setTool: (t: InkTool) => void;
  back: () => void;
  canUndo: boolean;
  state: string;
  onClose: () => void;
}) {
  const [mi, setMi] = useState(start);
  const [line, setLine] = useState(false);
  const m = measures[mi];
  const pg = m.page;
  const W = pageW(pg);
  const H = pageH(pg);
  // 보여 줄 범위 (쪽 단위): 줄의 세로 범위 x 마디(또는 줄) 가로
  const sh = m.bot - m.top;
  const pad = sh * 0.5;
  const x0 = Math.max(0, (line ? m.sys_x0 : m.x0) - pad);
  const x1 = Math.min(W, (line ? m.sys_x1 : m.x1) + pad);
  const y0 = Math.max(0, Math.min(m.y0, m.top - sh * 1.4));
  const y1 = Math.min(H, Math.max(m.y1, m.bot + sh * 1.2));
  const view: InkView = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  const aspect = (x1 - x0) / (y1 - y0);
  // 줄 보기에서 앞뒤는 줄 단위로
  const step = (d: number) => {
    let k = mi + d;
    if (line) {
      const sys = (q: ScoreMeasure) => `${q.page}:${q.system}`;
      while (k >= 0 && k < measures.length && sys(measures[k]) === sys(m)) k += d;
    }
    if (k >= 0 && k < measures.length) setMi(k);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // body 에 바로 띄운다 — 악보 칸 안에 두면 위치가 그 칸 기준이 되어 화면 가운데에 안 온다
  return createPortal(
    <div className="ink-zoom-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ink-zoom">
        <div className="actions ink-bar" style={{ marginTop: 0 }}>
          <button className="ghost" onClick={() => step(-1)} disabled={mi <= 0} aria-label="앞">◀</button>
          <b>{line ? `${pg + 1}쪽 ${m.system + 1}번째 줄` : `${m.number}번 마디`}</b>
          <button className="ghost" onClick={() => step(1)} disabled={mi >= measures.length - 1} aria-label="뒤">▶</button>
          <button className={`ghost${line ? " on" : ""}`} onClick={() => setLine((v) => !v)} title="이 마디가 있는 줄 전체">줄 전체</button>
          <span style={{ flex: 1 }} />
          {INK_COLORS.map((c) => (
            <button key={c.c} className={`ghost ink-color${tool.kind === "pen" && tool.color === c.c ? " on" : ""}`}
              onClick={() => setTool({ kind: "pen", color: c.c })} title={c.label} aria-label={c.label}>
              <span style={{ background: c.c }} />
            </button>
          ))}
          <button className={`ghost${tool.kind === "eraser" ? " on" : ""}`} onClick={() => setTool({ kind: "eraser" })}>지우개</button>
          <button className="ghost" onClick={back} disabled={!canUndo}>↶</button>
          <span className="meta">{state === "saving" ? "저장 중…" : state === "saved" ? "저장됨" : state === "error" ? "저장 실패" : ""}</span>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="ink-zoom-box" style={{ width: `min(100%, calc((100vh - 130px) * ${aspect}))`, aspectRatio: `${aspect}` }}>
          <img
            src={imgUrl(pg)}
            alt=""
            draggable={false}
            style={{
              width: `${(W / (x1 - x0)) * 100}%`,
              height: `${(H / (y1 - y0)) * 100}%`,
              left: `${(-x0 / (x1 - x0)) * 100}%`,
              top: `${(-y0 / (y1 - y0)) * 100}%`,
            }}
          />
          <InkLayer key={`${pg}`} strokes={strokesOf(pg)} editing tool={tool} view={view} onChange={(f) => onChange(pg, f)} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
