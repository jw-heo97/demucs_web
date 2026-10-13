import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DrawResult } from "../lib/drawNotation";
import type { Notation } from "../lib/notation";
import { useBarDrag } from "./ScoreView";

/**
 * 음표 악보를 오선으로 그린다 (VexFlow). 마디를 누르면 그 마디로, 끌면 구간 반복(onSelect),
 * 지금 마디는 칠하고 그 줄이 보이게 따라 내려간다. 편집 화면에서는 selected 마디를 따로 표시한다.
 */
export function NotationView({
  notation,
  bar,
  loop,
  selected,
  onPickBar,
  onSelect,
  follow = true,
}: {
  notation: Notation;
  /** 지금 음원 마디 */
  bar: number;
  loop?: { from: number; to: number } | null;
  /** 편집 중인 마디 범위 */
  selected?: { from: number; to: number } | null;
  onPickBar: (bar: number) => void;
  onSelect?: (from: number, to: number) => void;
  /** 재생 위치를 따라 스크롤 */
  follow?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const svgBox = useRef<HTMLDivElement | null>(null);
  const [res, setRes] = useState<DrawResult | null>(null);
  const [err, setErr] = useState("");
  const [narrow, setNarrow] = useState(false);

  // 폭이 좁으면(폰) 한 줄 2마디
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // VexFlow(약 1MB)는 악보를 그릴 때만 받는다 — 첫 화면을 무겁게 하지 않게
  useEffect(() => {
    let alive = true;
    import("../lib/drawNotation")
      .then(({ drawNotation }) => {
        const el = svgBox.current;
        if (!alive || !el) return;
        try {
          setRes(drawNotation(el, notation, { width: narrow ? 560 : 1100, perLine: narrow ? 2 : 4 }));
          setErr("");
        } catch (e) {
          setErr(`악보를 그리지 못했습니다: ${(e as Error).message}`);
          setRes(null);
        }
      })
      .catch(() => alive && setErr("악보 그리기 모듈을 받지 못했습니다."));
    return () => {
      alive = false;
    };
  }, [notation, narrow]);

  const drag = useBarDrag(onSelect ?? (() => {}), onPickBar);
  const lo = drag.sel ? Math.min(drag.sel.a, drag.sel.b) : 0;
  const hi = drag.sel ? Math.max(drag.sel.a, drag.sel.b) : -1;

  // 지금 마디의 줄이 바뀌면 그 줄이 보이게
  const lineOf = useMemo(() => {
    const m = new Map<number, number>();
    res?.lines.forEach(([a, b], i) => {
      for (let n = a; n <= b; n++) m.set(n, i);
    });
    return m;
  }, [res]);
  const curLine = lineOf.get(bar) ?? -1;
  const lastLine = useRef(-1);
  useEffect(() => {
    if (!follow || curLine < 0 || curLine === lastLine.current) return;
    lastLine.current = curLine;
    const box = res?.boxes.find((b) => b.bar === bar);
    const el = host.current?.querySelector<HTMLElement>(`[data-bar="${box?.bar}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [curLine, follow, bar, res]);

  return (
    <div className="notation" ref={host}>
      {err && <div className="err">{err}</div>}
      <div className="notation-page" {...(onSelect ? drag.props : {})}>
        <div ref={svgBox} className="notation-svg" />
        {res &&
          res.boxes.map((b) => {
            const on = b.bar === bar;
            const inLoop = !!loop && b.bar >= loop.from && b.bar <= loop.to;
            const sel = !!selected && b.bar >= selected.from && b.bar <= selected.to;
            const picking = b.bar >= lo && b.bar <= hi;
            return (
              <div
                key={b.bar}
                data-bar={b.bar}
                className={`score-bar${on ? " on" : ""}${inLoop ? " inloop" : ""}${sel ? " editing" : ""}${picking ? " picking" : ""}`}
                title={`${b.bar}마디`}
                onClick={onSelect ? undefined : () => onPickBar(b.bar)}
                style={{
                  left: `${(b.x / res.width) * 100}%`,
                  top: `${(b.y / res.height) * 100}%`,
                  width: `${(b.w / res.width) * 100}%`,
                  height: `${(b.h / res.height) * 100}%`,
                }}
              />
            );
          })}
      </div>
    </div>
  );
}
