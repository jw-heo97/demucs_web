import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { NMeasure, Notation } from "../lib/notation";
import { NotationView } from "./NotationView";

/** 오선 한 칸 간격 (CSS px) — 펜으로 그리기 편한 크기 */
const G = 18;
const LEFT = 46;
const TOP = 70; // 맨 윗줄 (위로 크래시 덧줄·마디 번호 자리)
const H = TOP + 4 * G + 70; // 아래로 하이햇 페달·발 기둥 자리

/** 악기 자리 (맨 윗줄 F5 에서 반 칸 단위로 몇 칸 아래인가) — transcribe.md 의 표와 같다 */
const GUIDE: [string, number][] = [
  ["CR", -2], ["HH", -1], ["RD", 0], ["T1", 1], ["T2", 2], ["SN", 3], ["FT", 5], ["BD", 7], ["HHP", 9],
];

type Stroke = { x: number; y: number }[];

/**
 * 손으로 그리는 악보 (아이패드 펜). 앱이 오선·마디선·박 점선·악기 자리를 그려 두고, 그 위에 그린 음표를
 * AI 가 읽어 칸으로 바꾼다. 결과를 미리 보여 주고 '적용' 해야 악보에 들어간다 (저장은 편집기의 저장으로).
 */
export function DrawPad({
  jobId,
  firstBar,
  measures,
  onApply,
  onClose,
}: {
  jobId: string;
  firstBar: number;
  /** 그릴 마디들 (박자를 쓴다) */
  measures: NMeasure[];
  onApply: (ms: NMeasure[]) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const ink = useRef<HTMLCanvasElement | null>(null);
  const [w, setW] = useState(0);
  const strokes = useRef<Stroke[]>([]);
  const cur = useRef<{ id: number; s: Stroke } | null>(null);
  const penSeen = useRef(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ measures: NMeasure[]; note: string; seconds?: number } | null>(null);
  const last = firstBar + measures.length - 1;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setW(Math.floor(el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 마디마다 가로 자리 (박 수에 비례)
  const total = measures.reduce((a, m) => a + m.beats / m.unit, 0);
  const segs: [number, number][] = [];
  {
    let x = LEFT;
    for (const m of measures) {
      const ww = ((w - LEFT - 8) * (m.beats / m.unit)) / total;
      segs.push([x, x + ww]);
      x += ww;
    }
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const setup = (c: HTMLCanvasElement | null) => {
    if (!c) return null;
    c.width = Math.round(w * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };

  // 바탕: 오선·마디선·박 점선·악기 자리
  useEffect(() => {
    if (!w) return;
    const ctx = setup(bg.current);
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, H);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(LEFT, TOP + i * G);
      ctx.lineTo(w - 8, TOP + i * G);
      ctx.stroke();
    }
    // 악기 자리는 반 칸(9px)씩이라 두 줄로 번갈아 (겹치지 않게), 자리마다 짧은 눈금
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    GUIDE.forEach(([name, half], i) => {
      const y = TOP + (half * G) / 2;
      ctx.fillStyle = "#9aa3b2";
      ctx.fillText(name, i % 2 ? 22 : 2, y);
      ctx.strokeStyle = "#c9cfdb";
      ctx.beginPath();
      ctx.moveTo(LEFT - 6, y);
      ctx.lineTo(LEFT - 1, y);
      ctx.stroke();
    });
    measures.forEach((m, i) => {
      const [a, b] = segs[i];
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1.5;
      for (const x of i === 0 ? [a, b] : [b]) {
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, TOP + 4 * G);
        ctx.stroke();
      }
      ctx.fillStyle = "#666";
      ctx.fillText(String(firstBar + i), a + 3, TOP - 2.5 * G);
      // 박 점선 (마디 안을 박 수로 고르게)
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = "#c9cfdb";
      ctx.lineWidth = 1;
      const pad = (b - a) * 0.04;
      for (let k = 0; k < m.beats; k++) {
        const x = a + pad + ((b - a - 2 * pad) * k) / m.beats;
        ctx.beginPath();
        ctx.moveTo(x, TOP - 2 * G);
        ctx.lineTo(x, TOP + 6 * G);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, measures, firstBar]);

  const redraw = () => {
    const ctx = setup(ink.current);
    if (!ctx) return;
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
      ctx.stroke();
    }
  };
  useEffect(() => {
    if (w) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w]);

  const pos = (e: React.PointerEvent) => {
    const r = ink.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // 펜을 한 번이라도 쓰면 손가락 터치는 무시 (손바닥이 닿아도 그려지지 않게)
  const ignore = (e: React.PointerEvent) => {
    if (e.pointerType === "pen") penSeen.current = true;
    return e.pointerType === "touch" && penSeen.current;
  };
  const down = (e: React.PointerEvent) => {
    if (ignore(e) || busy) return;
    e.preventDefault();
    try {
      ink.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 이미 끝난 포인터 */
    }
    cur.current = { id: e.pointerId, s: [pos(e)] };
    strokes.current.push(cur.current.s);
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    const c = cur.current;
    if (!c || c.id !== e.pointerId) return;
    const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
    const r = ink.current!.getBoundingClientRect();
    if (evs.length) evs.forEach((p) => c.s.push({ x: p.clientX - r.left, y: p.clientY - r.top }));
    else c.s.push(pos(e));
    redraw();
  };
  const up = (e: React.PointerEvent) => {
    if (cur.current?.id !== e.pointerId) return;
    cur.current = null;
    setCount(strokes.current.length);
  };

  const undoStroke = () => {
    strokes.current.pop();
    setCount(strokes.current.length);
    redraw();
  };
  const clear = () => {
    strokes.current = [];
    setCount(0);
    setResult(null);
    redraw();
  };

  async function recognize() {
    if (!bg.current || !ink.current || !strokes.current.length) return;
    // 바탕 + 손글씨를 한 장으로
    const c = document.createElement("canvas");
    c.width = bg.current.width;
    c.height = bg.current.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bg.current, 0, 0);
    ctx.drawImage(ink.current, 0, 0);
    const image = c.toDataURL("image/png");
    setErr("");
    setResult(null);
    const t0 = Date.now();
    setBusy(1);
    const tick = window.setInterval(() => setBusy(Math.max(1, Math.round((Date.now() - t0) / 1000))), 1000);
    try {
      const r = await api.recognizeDrawing(jobId, {
        image,
        first_bar: firstBar,
        measures: measures.map((m) => ({ beats: m.beats, unit: m.unit, steps: m.steps })),
      });
      setResult({ measures: r.measures, note: r.note ?? "", seconds: r.seconds });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      window.clearInterval(tick);
      setBusy(0);
    }
  }

  const preview: Notation | null = result ? { version: 1, measures: result.measures } : null;

  return (
    <div className="drawpad">
      <div className="actions" style={{ marginTop: 0 }}>
        <b>✍ {measures.length > 1 ? `${firstBar}~${last}마디` : `${firstBar}마디`} 손으로 그리기</b>
        <span className="meta">펜으로 음표를 그리고 '인식' — 머리 높이는 줄·칸에, 가로는 박 점선에 맞춰 그리면 잘 읽습니다</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onClose} aria-label="그리기 닫기">✕</button>
      </div>
      <div ref={box} className="drawpad-canvas" style={{ height: H }}>
        <canvas ref={bg} style={{ width: w, height: H }} />
        <canvas
          ref={ink}
          style={{ width: w, height: H }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="ghost" onClick={undoStroke} disabled={!count || !!busy}>↶ 한 획 지우기</button>
        <button className="ghost" onClick={clear} disabled={!count || !!busy}>모두 지우기</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => void recognize()} disabled={!count || !!busy}>
          {busy ? `인식 중… ${busy}초` : "인식"}
        </button>
      </div>
      {err && <div className="err">{err}</div>}
      {result && preview && (
        <div className="drawpad-result">
          <div className="meta">
            인식 결과{result.seconds ? ` (${result.seconds}초)` : ""} — 맞으면 적용하세요. 적용해도 '저장' 전까지는 파일에 들어가지 않습니다.
          </div>
          {result.note && <div className="meta">AI: {result.note}</div>}
          <NotationView notation={preview} bar={0} onPickBar={() => {}} follow={false} />
          <div className="actions" style={{ marginTop: 6 }}>
            <button onClick={() => onApply(result.measures)}>적용</button>
            <button className="ghost" onClick={() => setResult(null)}>버리기</button>
          </div>
        </div>
      )}
    </div>
  );
}
