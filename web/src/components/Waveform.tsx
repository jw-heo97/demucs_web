import { useCallback, useEffect, useRef, useState } from "react";
import { colorOf, sectionColors } from "../lib/sectionColors";
import type { Bar } from "../types";

export type WaveMode = "seek" | "tap" | "drag" | "loop";

export interface LoopRegion {
  start: number;
  end: number;
}

interface Props {
  /** 파형에 그린 트랙 이름 (화면에 표시) */
  stemLabel?: string;
  peaks: number[] | null;
  duration: number;
  currentTime: number;
  playing: boolean;
  bars: Bar[];
  loop: LoopRegion | null;
  mode: WaveMode;
  /** 재생 위치 이동 */
  onSeek: (t: number) => void;
  /** 첫박 찍기 — 그 시각에 마디를 고정한다 */
  onTapDownbeat: (t: number) => void;
  /** 기존 마디선을 끌어 옮김 */
  onDragBar: (bar: number, t: number) => void;
  onLoopChange: (r: LoopRegion | null) => void;
}

/**
 * 파형 편집기.
 *
 * 이 앱의 조작은 대부분 여기서 이뤄진다:
 *   이동   드래그로 재생 위치
 *   첫박   클릭한 자리에 마디를 고정 (녹음물은 박자가 미세하게 흔들려서 필수)
 *   마디   기존 마디선을 잡아 끌어 미세 조정
 *   구간   드래그로 A-B 반복 구간 지정
 * 공통: 휠 확대/축소, Shift+휠 좌우 이동, 더블클릭 전체보기.
 */
export function Waveform({
  stemLabel,
  peaks,
  duration,
  currentTime,
  playing,
  bars,
  loop,
  mode,
  onSeek,
  onTapDownbeat,
  onDragBar,
  onLoopChange,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{
    kind: "seek" | "bar" | "loop";
    bar?: number;
    from?: number;
    /** 이동(pan)용 — 누른 지점과 그때의 보기 창 */
    x0?: number;
    vs0?: number;
    ve0?: number;
    moved?: boolean;
  } | null>(null);
  const [hoverBar, setHoverBar] = useState<number | null>(null);

  const v = view ?? { start: 0, end: duration || 1 };
  const span = Math.max(1e-6, v.end - v.start);

  const clampView = useCallback(
    (start: number, end: number) => {
      if (!duration) return;
      let s2 = Math.max(0.25, Math.min(end - start, duration));
      let st = Math.max(0, Math.min(start, duration - s2));
      setView(s2 >= duration - 1e-6 ? null : { start: st, end: st + s2 });
    },
    [duration],
  );

  const timeAt = useCallback(
    (clientX: number) => {
      const el = boxRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return v.start + f * span;
    },
    [v.start, span],
  );

  const xOf = useCallback(
    (t: number, w: number) => ((t - v.start) / span) * w,
    [v.start, span],
  );

  /** 커서 근처(6px)의 마디선 */
  const barNear = useCallback(
    (t: number, w: number) => {
      const tol = (6 / Math.max(1, w)) * span;
      let best: Bar | null = null;
      let bd = Infinity;
      for (const b of bars) {
        const d = Math.abs(b.start - t);
        if (d < bd) {
          bd = d;
          best = b;
        }
        if (b.start > t + 5) break;
      }
      return best && bd <= tol ? best : null;
    },
    [bars, span],
  );

  // ---------------- 그리기 ----------------
  const draw = useCallback(() => {
    const cv = cvRef.current;
    const box = boxRef.current;
    if (!cv || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.body);
    const cAccent = css.getPropertyValue("--accent").trim() || "#3b6df6";
    const cMuted = css.getPropertyValue("--muted").trim() || "#888";
    const cBorder = css.getPropertyValue("--border").trim() || "#ddd";
    const cOk = css.getPropertyValue("--ok").trim() || "#12855b";
    const mid = h / 2;

    // A-B 반복 구간
    if (loop) {
      const x0 = xOf(loop.start, w);
      const x1 = xOf(loop.end, w);
      g.fillStyle = cOk;
      g.globalAlpha = 0.14;
      g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      g.globalAlpha = 1;
    }

    // 파형 — 구간마다 색을 달리한다 (같은 이름은 같은 색). 이름 없는 곳은 회색.
    const colors = sectionColors(bars);
    if (peaks && peaks.length && duration) {
      const n = peaks.length;
      g.fillStyle = cMuted;
      g.globalAlpha = 0.6;
      let bi = -1; // 지금 열이 속한 마디 (x 가 커지면 앞으로만 간다)
      let fill = cMuted;
      for (let x = 0; x < w; x++) {
        const t0 = v.start + (x / w) * span;
        const t1 = v.start + ((x + 1) / w) * span;
        while (bi + 1 < bars.length && bars[bi + 1].start <= t0) bi++;
        const c = (bi >= 0 && colorOf(colors, bars[bi].name)) || cMuted;
        if (c !== fill) {
          fill = c;
          g.fillStyle = c;
        }
        let i0 = Math.max(0, Math.min(n - 1, Math.floor((t0 / duration) * n)));
        const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil((t1 / duration) * n)));
        let val = 0;
        for (let i = i0; i < i1; i++) if (peaks[i] > val) val = peaks[i];
        const half = Math.max(1, val * (mid - 10));
        g.fillRect(x, mid - half, 1, half * 2);
      }
      g.globalAlpha = 1;
    }

    // 마디선
    if (bars.length) {
      const pxPerBar = bars.length > 1 ? xOf(bars[1].start, w) - xOf(bars[0].start, w) : w;
      const every = pxPerBar > 46 ? 1 : pxPerBar > 16 ? 4 : pxPerBar > 6 ? 8 : 16;
      g.font = "10px system-ui, sans-serif";
      for (const b of bars) {
        const x = xOf(b.start, w);
        if (x < -4) continue;
        if (x > w + 4) break;
        const major = (b.bar - 1) % every === 0;
        const hot = hoverBar === b.bar;
        g.strokeStyle = b.anchored ? cOk : major ? cAccent : cBorder;
        g.globalAlpha = hot ? 1 : b.anchored ? 0.95 : major ? 0.7 : 0.32;
        g.lineWidth = hot ? 3 : b.anchored ? 2 : 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        if (major || hot) {
          g.globalAlpha = 0.95;
          g.fillStyle = hot ? cAccent : cMuted;
          g.fillText(String(b.bar), x + 3, 11);
        }
        if (b.anchored) {
          g.globalAlpha = 1;
          g.fillStyle = cOk;
          g.fillRect(x - 2.5, 0, 5, 7);
        }
      }
      g.globalAlpha = 1;
    }

    // 구간 이름 — 이름이 바뀌는 마디에만 한 번 찍는다
    g.font = "600 11px system-ui, sans-serif";
    let lastName = "";
    for (const b of bars) {
      if (b.name && b.name !== lastName) {
        const x = xOf(b.start, w);
        lastName = b.name;
        if (x < -80 || x > w + 80) continue;
        g.fillStyle = colorOf(colors, b.name) ?? cAccent;
        g.globalAlpha = 0.95;
        g.fillText(b.name, x + 4, h - 6);
        g.globalAlpha = 1;
      }
    }

    // 재생 위치
    const px = xOf(currentTime, w);
    if (px >= -2 && px <= w + 2) {
      g.strokeStyle = cAccent;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, h);
      g.stroke();
      g.fillStyle = cAccent;
      g.beginPath();
      g.moveTo(px - 5, 0);
      g.lineTo(px + 5, 0);
      g.lineTo(px, 8);
      g.closePath();
      g.fill();
    }
  }, [peaks, duration, currentTime, bars, loop, v.start, span, xOf, hoverBar]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(box);
    return () => ro.disconnect();
  }, [draw]);

  // 재생 중 화면이 헤드를 따라간다
  useEffect(() => {
    if (!playing || !view) return;
    const s = view.end - view.start;
    if (currentTime < view.start || currentTime > view.end - s * 0.12) {
      clampView(Math.max(0, currentTime - s * 0.3), Math.max(0, currentTime - s * 0.3) + s);
    }
  }, [currentTime, playing, view, clampView]);

  // ---------------- 입력 ----------------
  const onPointerDown = (e: React.PointerEvent) => {
    const box = boxRef.current!;
    box.focus();
    box.setPointerCapture(e.pointerId);
    const w = box.getBoundingClientRect().width;
    const t = timeAt(e.clientX);

    if (mode === "tap") {
      onTapDownbeat(t);
      return;
    }
    if (mode === "drag") {
      const b = barNear(t, w);
      if (b) {
        drag.current = { kind: "bar", bar: b.bar };
        onDragBar(b.bar, t);
        return;
      }
    }
    if (mode === "loop") {
      drag.current = { kind: "loop", from: t };
      onLoopChange({ start: t, end: t });
      return;
    }
    // 눌렀을 때는 아직 판단하지 않는다.
    //   살짝 움직이면 → 클릭으로 보고 그 지점으로 이동
    //   끌면          → 파형을 좌우로 이동(pan)
    drag.current = { kind: "seek", x0: e.clientX, vs0: v.start, ve0: v.end, moved: false };
  };

  const snap = (t: number, on: boolean) => {
    if (!on || !bars.length) return t;
    let best = bars[0].start;
    let bd = Math.abs(best - t);
    for (const b of bars) {
      const d = Math.abs(b.start - t);
      if (d < bd) {
        best = b.start;
        bd = d;
      }
      if (b.start > t + 10) break;
    }
    return best;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const box = boxRef.current;
    if (!box) return;
    const w = box.getBoundingClientRect().width;
    const t = timeAt(e.clientX);

    if (!drag.current) {
      if (mode === "drag") {
        const b = barNear(t, w);
        setHoverBar(b ? b.bar : null);
      } else if (hoverBar !== null) setHoverBar(null);
      return;
    }
    if (drag.current.kind === "seek") {
      const dx = e.clientX - (drag.current.x0 ?? e.clientX);
      if (!drag.current.moved && Math.abs(dx) < 4) return;   // 클릭과 구분하는 문턱
      drag.current.moved = true;
      const el = boxRef.current;
      if (!el) return;
      const wpx = el.getBoundingClientRect().width || 1;
      const vs0 = drag.current.vs0 ?? 0;
      const ve0 = drag.current.ve0 ?? duration;
      const sp = ve0 - vs0;
      const shift = (dx / wpx) * sp;      // 잡은 지점이 손을 따라오도록 반대로 민다
      clampView(vs0 - shift, ve0 - shift);
    }
    else if (drag.current.kind === "bar" && drag.current.bar != null)
      onDragBar(drag.current.bar, t);
    else if (drag.current.kind === "loop" && drag.current.from != null) {
      const a = drag.current.from;
      onLoopChange({ start: Math.min(a, t), end: Math.max(a, t) });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (drag.current?.kind === "seek" && !drag.current.moved) {
      onSeek(snap(timeAt(e.clientX), e.shiftKey));
    }
    if (drag.current?.kind === "loop") {
      const box = boxRef.current;
      if (box) {
        const t = timeAt(e.clientX);
        const a = drag.current.from ?? t;
        if (Math.abs(t - a) < 0.15) onLoopChange(null); // 클릭만 하면 해제
      }
    }
    drag.current = null;
    try {
      boxRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  /**
   * 휠 확대는 **네이티브 리스너**로 붙인다.
   * React 의 onWheel 은 루트에 passive 로 등록돼서 preventDefault() 가 무시되고,
   * 그러면 파형을 확대하면서 페이지까지 같이 스크롤된다.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        const d = ((e.deltaY || e.deltaX) / 500) * span;
        clampView(v.start + d, v.end + d);
      } else {
        const t = timeAt(e.clientX);
        const f = e.deltaY < 0 ? 1 / 1.25 : 1.25;
        const ns = span * f;
        const frac = (t - v.start) / span;
        clampView(t - ns * frac, t - ns * frac + ns);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [span, v.start, v.end, clampView, timeAt]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!duration) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = (e.shiftKey ? span / 4 : span / 40) * (e.key === "ArrowRight" ? 1 : -1);
      onSeek(Math.max(0, Math.min(duration, currentTime + d)));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      clampView(currentTime - span / 3, currentTime + span / 3);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      clampView(currentTime - span, currentTime + span);
    } else if (e.key === "0") {
      e.preventDefault();
      setView(null);
    }
  };

  const zoomLabel = duration ? `${(duration / span).toFixed(1)}배` : "";

  return (
    <div className="wavewrap">
      <div
        ref={boxRef}
        className={`wavebox mode-${mode}`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setView(null)}
        onKeyDown={onKeyDown}
      >
        <canvas ref={cvRef} />
        <div className="wavehint">
          {peaks ? `${stemLabel ?? ""} 파형` : "파형 불러오는 중…"}
          {peaks ? " · " : ""}
          {mode === "seek" && "클릭 이동 · 끌면 좌우 이동 · 휠 확대"}
          {mode === "tap" && "클릭한 자리에 마디를 고정합니다"}
          {mode === "drag" && "마디선을 잡아 끌어 미세 조정"}
          {mode === "loop" && "드래그로 반복 구간 · 클릭하면 해제"}
        </div>
        <div className="wavezoom">{zoomLabel}</div>
      </div>
    </div>
  );
}
