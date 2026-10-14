import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DrawResult } from "../lib/drawNotation";
import { pageLayout, type Notation } from "../lib/notation";
import type { ScoreData } from "../types";
import { useBarDrag, useSwipePages } from "./ScoreView";

/** 쪽 비율 (A4 세로) */
const PAGE_W = 1100;
const PAGE_H = Math.round(PAGE_W * 1.414);

/**
 * 음표 악보를 오선으로 그린다 (VexFlow). 마디를 누르면 그 마디로, 끌면 구간 반복(onSelect),
 * 지금 마디는 칠한다. 편집 화면에서는 selected 마디를 따로 표시한다.
 *
 * paged: 원래 악보 PDF 처럼 쪽으로 나눠 한 쪽씩 화면 높이에 맞춰 보여준다 (태블릿에서 넘겨 보기 좋게).
 * 줄·쪽 나눔은 원래 PDF(score)를 그대로 따른다. 연주 위치의 쪽을 따라가고, 쪽의 마지막 마디에서 미리 넘긴다.
 * 폰처럼 좁으면 쪽 대신 한 줄 2마디로 이어서 그린다.
 */
export function NotationView({
  notation,
  bar,
  loop,
  selected,
  onPickBar,
  onSelect,
  follow = true,
  paged = false,
  score,
  popupBar,
  popup,
  onLines,
}: {
  notation: Notation;
  /** 지금 음원 마디 */
  bar: number;
  loop?: { from: number; to: number } | null;
  /** 편집 중인 마디 범위 */
  selected?: { from: number; to: number } | null;
  onPickBar: (bar: number) => void;
  onSelect?: (from: number, to: number) => void;
  /** 재생 위치를 따라가기 */
  follow?: boolean;
  paged?: boolean;
  /** 원래 악보 PDF 분석 (쪽·줄 나눔을 따른다) */
  score?: ScoreData | null;
  /** 이 마디 바로 아래에 띄울 것 (악보 편집 칸) */
  popupBar?: number | null;
  popup?: ReactNode;
  /** 그린 줄 나눔 [첫 마디, 끝 마디][] */
  onLines?: (lines: [number, number][]) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const svgBox = useRef<HTMLDivElement | null>(null);
  const [res, setRes] = useState<DrawResult | null>(null);
  const [err, setErr] = useState("");
  const [narrow, setNarrow] = useState(false);

  // 폭이 좁으면(폰) 한 줄 2마디로 이어서. 쪽 보기는 자기 폭을 화면 높이에 맞춰 줄이므로 바깥 칸의 폭으로 판단한다
  // (자기 폭으로 보면 줄인 폭 때문에 '좁음'이 되어 쪽 보기와 이어 보기를 오갔다)
  useLayoutEffect(() => {
    const el = host.current?.parentElement;
    if (!el) return;
    const update = () => setNarrow(el.clientWidth < 640);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const usePages = paged && !narrow;
  const pages = useMemo(() => pageLayout(notation.measures, score), [notation, score]);
  const pageOf = useMemo(() => {
    const m = new Map<number, number>();
    pages.forEach((lines, p) => lines.forEach(([a, b]) => {
      for (let n = a; n <= b; n++) m.set(n, p);
    }));
    return m;
  }, [pages]);
  // 연주 위치의 쪽 — 쪽의 마지막 마디에 들어서면 다음 쪽을 미리 (넘기는 순간 첫 마디를 이미 읽고 있어야 한다)
  let playPage = pageOf.get(Math.max(1, bar)) ?? 0;
  const nextPage = pageOf.get(Math.max(1, bar) + 1);
  if (nextPage != null && nextPage !== playPage) playPage = nextPage;
  const [view, setView] = useState(playPage);
  const followed = useRef(playPage);
  useEffect(() => {
    if (!follow || followed.current === playPage) return;
    followed.current = playPage;
    setView(playPage);
  }, [playPage, follow]);
  const pv = Math.max(0, Math.min(pages.length - 1, view));

  // VexFlow(약 1MB)는 악보를 그릴 때만 받는다 — 첫 화면을 무겁게 하지 않게
  useEffect(() => {
    let alive = true;
    import("../lib/drawNotation")
      .then(({ drawNotation }) => {
        const el = svgBox.current;
        if (!alive || !el) return;
        try {
          setRes(
            usePages
              ? drawNotation(el, notation, { width: PAGE_W, perLine: 4, lines: pages[pv], height: PAGE_H })
              : drawNotation(el, notation, { width: narrow ? 560 : 1100, perLine: narrow ? 2 : 4 }),
          );
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
  }, [notation, narrow, usePages, pages, pv]);

  const drag = useBarDrag(onSelect ?? (() => {}), onPickBar);
  const swipe = useSwipePages(() => setView(Math.max(0, pv - 1)), () => setView(Math.min(pages.length - 1, pv + 1)));
  const lo = drag.sel ? Math.min(drag.sel.a, drag.sel.b) : 0;
  const hi = drag.sel ? Math.max(drag.sel.a, drag.sel.b) : -1;

  // 이어 그리기: 지금 마디의 줄이 바뀌면 그 줄이 보이게
  const lineOf = useMemo(() => {
    const m = new Map<number, number>();
    res?.lines.forEach(([a, b], i) => {
      for (let n = a; n <= b; n++) m.set(n, i);
    });
    return m;
  }, [res]);
  const curLine = lineOf.get(bar) ?? -1;
  useEffect(() => {
    if (res) onLines?.(res.lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res]);
  const lastLine = useRef(-1);
  useEffect(() => {
    if (usePages || !follow || curLine < 0 || curLine === lastLine.current) return;
    lastLine.current = curLine;
    const el = host.current?.querySelector<HTMLElement>(`[data-bar="${bar}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [curLine, follow, bar, usePages]);

  // 편집 칸이 열리거나 다른 마디로 옮기면 화면 안으로
  const popRef = useRef<HTMLDivElement | null>(null);
  const popBox = popup && popupBar != null ? res?.boxes.find((b) => b.bar === popupBar) : undefined;
  useEffect(() => {
    if (popBox) popRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [popupBar, !!popBox]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`notation${usePages ? " paged" : ""}${onSelect ? " selecting" : ""}`}
      ref={host}
      // 화면 높이 − 아래 재생 막대·쪽 넘김 버튼 자리
      style={usePages ? { maxWidth: `calc((100vh - 150px) * ${PAGE_W / PAGE_H})` } : undefined}
    >
      {err && <div className="err">{err}</div>}
      <div className="notation-page" {...(onSelect ? drag.props : usePages ? swipe.props : {})}>
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
                onClick={onSelect ? undefined : () => !swipe.swiped.current && onPickBar(b.bar)}
                style={{
                  left: `${(b.x / res.width) * 100}%`,
                  top: `${(b.y / res.height) * 100}%`,
                  width: `${(b.w / res.width) * 100}%`,
                  height: `${(b.h / res.height) * 100}%`,
                }}
              />
            );
          })}
        {res && popBox && (
          <div
            ref={popRef}
            className="nt-pop"
            style={{ top: `${((popBox.y + popBox.h) / res.height) * 100}%` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="nt-pop-arrow" style={{ left: `${((popBox.x + popBox.w / 2) / res.width) * 100}%` }} />
            {popup}
          </div>
        )}
      </div>
      {usePages && pages.length > 1 && (
        <div className="score-nav">
          <button className="ghost" onClick={() => setView(pv - 1)} disabled={pv <= 0} aria-label="이전 쪽">‹</button>
          <span className="meta">{pv + 1} / {pages.length}</span>
          <button className="ghost" onClick={() => setView(pv + 1)} disabled={pv >= pages.length - 1} aria-label="다음 쪽">›</button>
        </div>
      )}
    </div>
  );
}
