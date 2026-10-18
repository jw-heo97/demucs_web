import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { InkDoc, InkStroke } from "../types";

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

/**
 * 원본 악보 한 쪽 위의 필기 판. editing 이 아니면 보기만 (누름은 아래 악보로 간다).
 * 펜을 한 번이라도 쓰면 손가락 터치는 무시한다 (손바닥).
 */
export function InkLayer({
  strokes,
  editing,
  tool,
  onChange,
}: {
  strokes: InkStroke[];
  editing: boolean;
  tool: InkTool;
  onChange: (f: (s: InkStroke[]) => InkStroke[]) => void;
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
    for (const s of all) {
      ctx.strokeStyle = s.c;
      ctx.lineWidth = Math.max(1, s.w * size.w);
      ctx.beginPath();
      s.p.forEach(([x, y], i) => (i ? ctx.lineTo(x * size.w, y * size.h) : ctx.moveTo(x * size.w, y * size.h)));
      if (s.p.length === 1) ctx.lineTo(s.p[0][0] * size.w + 0.1, s.p[0][1] * size.h);
      ctx.stroke();
    }
  };
  useEffect(draw);

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = cv.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const skip = (e: React.PointerEvent) => {
    if (e.pointerType === "pen") penSeen.current = true;
    return e.pointerType === "touch" && penSeen.current;
  };
  // 지우개: 누른 자리 가까이(쪽 폭의 1.5%) 지나는 획을 통째로 지운다
  const erase = (p: [number, number]) => {
    const r = 0.015;
    const ratio = size.h / Math.max(1, size.w);
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
    cur.current = { id: e.pointerId, s: { c: tool.color, w: 0.0028, p: [at(e)] } };
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
      const q: [number, number] = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
      const l = pts[pts.length - 1];
      if (!l || Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) > 0.0008) pts.push(q);
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
