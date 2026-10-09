import { useEffect, useRef } from "react";

/**
 * 위아래로 끌거나(터치·마우스) 휠을 굴려 값을 바꾸는 다이얼. 위로 = 커짐.
 * 끌기는 2px 에 1, 휠은 한 칸에 1 (Shift 를 누르면 10). 두 번 누르면 0.
 */
export function ScrollDial({
  value,
  onChange,
  min,
  max,
  unit = "",
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cur = useRef(value);
  cur.current = value;
  const cb = useRef(onChange);
  cb.current = onChange;
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));

  // 휠은 passive 가 아니어야 페이지가 같이 스크롤되지 않는다 (React onWheel 은 passive)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      // 빠르게 굴리면 다시 그리기 전에 다음 칸이 온다 — 렌더를 기다리지 않고 바로 쌓는다
      cur.current = clamp(cur.current + (e.deltaY < 0 ? step : -step));
      cb.current(cur.current);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [min, max]);

  const drag = useRef<{ y: number; v: number } | null>(null);

  return (
    <div
      ref={ref}
      className="dial"
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={title}
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, v: value };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onChange(clamp(d.v + (d.y - e.clientY) / 2));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onChange(clamp(0))}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") onChange(clamp(value + (e.shiftKey ? 10 : 1)));
        else if (e.key === "ArrowDown") onChange(clamp(value - (e.shiftKey ? 10 : 1)));
        else return;
        e.preventDefault();
      }}
    >
      <span className="dial-arrow">▲</span>
      <span className="dial-val">
        {value > 0 ? "+" : ""}
        {value}
        {unit}
      </span>
      <span className="dial-arrow">▼</span>
    </div>
  );
}
