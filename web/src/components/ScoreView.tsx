import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ScoreData, ScoreMeasure } from "../types";

/** 한 번에 보여줄 마디 수. 지금 마디가 든 4마디 묶음 + 다음 4마디라 늘 앞이 보인다. */
const BLOCK = 4;
const SHOW = 8;

/** 음원 마디 번호 → 악보 마디(0부터). 반복 기호가 있으면 order 가 순서를 정한다. */
export function measureOfBar(score: ScoreData, bar: number): number | null {
  const n = score.order ? score.order[bar - 1] : bar;
  return n && n >= 1 && n <= score.measures.length ? n - 1 : null;
}

const imgCache = new Map<string, HTMLImageElement>();
function useImage(url: string | null) {
  // 다 받은 그림만 처음부터 쓴다. 받는 중인 것을 미리 쥐고 있으면 load 때 같은 객체라
  // 상태가 안 바뀌어 다시 그리지 않는다 — 쪽이 넘어가는 순간 줄이 빈 채로 남았다.
  const [img, setImg] = useState<HTMLImageElement | null>(() => {
    const hit = url ? imgCache.get(url) : undefined;
    return hit?.complete ? hit : null;
  });
  useEffect(() => {
    if (!url) return setImg(null);
    const hit = imgCache.get(url);
    if (hit?.complete) return setImg(hit);
    const im = hit ?? new Image();
    if (!hit) {
      im.src = url;
      imgCache.set(url, im);
    }
    const done = () => setImg(im);
    im.addEventListener("load", done);
    return () => im.removeEventListener("load", done);
  }, [url]);
  return img;
}

interface Row {
  page: number;
  /** 이 줄에 보이는 악보 마디들 (0부터) */
  idx: number[];
  /** 음원 마디 번호 (idx 와 같은 순서) */
  bars: number[];
}

/**
 * 악보 8마디 보기. 페이지 이미지에서 해당 줄을 잘라 붙인다.
 * 지금 마디는 강조하고, 마디를 누르면 그 마디로 이동한다.
 */
export function ScoreView({
  score,
  bar,
  onPickBar,
}: {
  score: ScoreData;
  /** 지금 음원 마디 (첫 마디 전이면 1) */
  bar: number;
  onPickBar?: (bar: number) => void;
}) {
  const start = Math.floor((Math.max(1, bar) - 1) / BLOCK) * BLOCK + 1;
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let b = start; b < start + SHOW; b++) {
      const k = measureOfBar(score, b);
      if (k == null) continue;
      const m = score.measures[k];
      const last = out[out.length - 1];
      const prev = last ? score.measures[last.idx[last.idx.length - 1]] : null;
      // 같은 줄에서 바로 이어지는 마디만 한 덩어리로 (반복으로 되돌아가면 새 덩어리)
      if (last && prev && prev.page === m.page && prev.system === m.system && last.idx[last.idx.length - 1] + 1 === k) {
        last.idx.push(k);
        last.bars.push(b);
      } else out.push({ page: m.page, idx: [k], bars: [b] });
    }
    return out;
  }, [score, start]);

  // 줄 폭 기준: 가장 넓은 보표 줄
  const fullW = useMemo(
    () => Math.max(1, ...score.measures.map((m) => m.sys_x1 - m.sys_x0)),
    [score],
  );

  if (!rows.length) return <div className="empty">이 마디에 해당하는 악보가 없습니다.</div>;
  return (
    <div className="score">
      {rows.map((r) => (
        <ScoreRow
          key={`${r.page}:${r.idx[0]}`}
          url={api.fileUrl(score.page_urls[r.page])}
          page={score.pages[r.page]}
          ms={r.idx.map((k) => score.measures[k])}
          bars={r.bars}
          cur={bar}
          fullW={fullW}
          onPickBar={onPickBar}
        />
      ))}
    </div>
  );
}

function ScoreRow({
  url,
  page,
  ms,
  bars,
  cur,
  fullW,
  onPickBar,
}: {
  url: string;
  page: { w: number; h: number };
  ms: ScoreMeasure[];
  bars: number[];
  cur: number;
  fullW: number;
  onPickBar?: (bar: number) => void;
}) {
  const img = useImage(url);
  const cv = useRef<HTMLCanvasElement | null>(null);
  const first = ms[0];
  const last = ms[ms.length - 1];
  // 줄의 첫 마디면 음자리표·마디 번호까지 보이게 왼쪽 여백을 둔다
  const startsLine = Math.abs(first.x0 - first.sys_x0) < 1;
  const cx0 = startsLine ? Math.max(0, first.sys_x0 - 14) : first.x0 - 3;
  const cx1 = Math.min(page.w, last.x1 + 3);
  const cy0 = first.y0;
  const cy1 = first.y1;
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;

  useEffect(() => {
    const c = cv.current;
    if (!c || !img) return;
    const s = img.naturalWidth / page.w;
    c.width = Math.round(cw * s);
    c.height = Math.round(ch * s);
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, cx0 * s, cy0 * s, cw * s, ch * s, 0, 0, c.width, c.height);
  }, [img, cx0, cy0, cw, ch, page.w]);

  const staffH = first.bot - first.top;
  return (
    <div className="score-row" style={{ width: `${Math.min(100, (cw / fullW) * 100)}%` }}>
      <div className="score-crop" style={{ aspectRatio: `${cw} / ${ch}` }}>
        <canvas ref={cv} />
        {ms.map((m, i) => {
          const on = bars[i] === cur;
          return (
            <button
              key={i}
              type="button"
              className={`score-bar${on ? " on" : ""}`}
              title={`${bars[i]}마디로 이동`}
              onClick={() => onPickBar?.(bars[i])}
              style={{
                left: `${((m.x0 - cx0) / cw) * 100}%`,
                width: `${((m.x1 - m.x0) / cw) * 100}%`,
                top: `${((m.top - staffH * 0.9 - cy0) / ch) * 100}%`,
                height: `${((staffH * 2.8) / ch) * 100}%`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * 송 맵 탭의 악보 패널: 연결된 악보를 불러와 8마디씩 보여주고, 없으면 PDF 를 올리게 한다.
 * children 에는 악보로 하는 일(송 맵 만들기 등)의 버튼을 넣는다.
 */
export function ScorePanel({
  jobId,
  bar,
  onPickBar,
  onScore,
  children,
}: {
  jobId: string;
  bar: number;
  onPickBar?: (bar: number) => void;
  /** 불러온 악보를 바깥(송 맵 만들기)에서도 쓰게 알려준다 */
  onScore?: (s: ScoreData | null) => void;
  children?: React.ReactNode;
}) {
  const [score, setScore] = useState<ScoreData | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    setScore(undefined);
    setMsg("");
    api
      .score(jobId)
      .then((s) => alive && setScore(s))
      .catch(() => alive && setScore(null));
    return () => {
      alive = false;
    };
  }, [jobId]);
  useEffect(() => onScore?.(score ?? null), [score, onScore]);

  async function upload(f: File) {
    setBusy(true);
    setMsg("악보를 읽는 중…");
    try {
      const s = await api.uploadScore(jobId, f);
      setScore(s);
      setMsg(`${s.pages.length}쪽 · ${s.measures.length}마디${s.tempo ? ` · ♩=${s.tempo}` : ""}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function remove() {
    if (!confirm("이 곡에서 악보 연결을 끊고 score.pdf 를 지웁니다.")) return;
    try {
      await api.deleteScore(jobId);
      setScore(null);
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (score === undefined) return null;
  return (
    <div className="panel">
      <div className="actions" style={{ marginTop: 0, marginBottom: score ? 10 : 0 }}>
        <h2 style={{ margin: 0 }}>
          악보{" "}
          {score && (
            <span className="meta">
              {score.pages.length}쪽 · {score.measures.length}마디{score.tempo ? ` · ♩=${score.tempo}` : ""}
              {score.order ? " · 반복 순서 적용" : ""}
            </span>
          )}
        </h2>
        <span style={{ flex: 1 }} />
        {score && children}
        <input
          ref={file}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
        />
        <button className="ghost" disabled={busy} onClick={() => file.current?.click()}>
          {score ? "악보 바꾸기" : "악보 PDF 올리기"}
        </button>
        {score && (
          <button className="ghost" onClick={remove}>
            연결 끊기
          </button>
        )}
      </div>
      {msg && <div className="meta" style={{ marginBottom: 8 }}>{msg}</div>}
      {score?.warnings?.map((w) => (
        <div key={w} className="err" style={{ marginBottom: 6 }}>
          {w}
        </div>
      ))}
      {score && score.measures.length > 0 && (
        <ScoreView score={score} bar={bar} onPickBar={onPickBar} />
      )}
      {score && score.measures.length === 0 && (
        <div className="empty">마디를 찾지 못했습니다. 악보 프로그램에서 내보낸 PDF 인지 확인해 주세요 (스캔본은 안 됩니다).</div>
      )}
    </div>
  );
}

/**
 * 연주용 악보 보기(플레이리스트): 한 쪽씩 보여주고 좌우로 넘긴다. 지금 마디가 있는
 * 쪽으로 자동으로 넘기되, 쪽의 마지막 마디에 들어서면 다음 쪽으로 미리 넘긴다 —
 * 넘기는 순간 첫 마디를 이미 읽고 있어야 하기 때문이다. 손으로 밀어 넘길 수도 있고,
 * 그래도 연주가 다음 쪽으로 가면 다시 따라간다. 한 쪽이 화면 높이에 들어오게 폭을 맞춘다.
 */
export function ScorePages({
  score,
  bar,
  onPickBar,
}: {
  score: ScoreData;
  bar: number;
  onPickBar?: (bar: number) => void;
}) {
  const k = measureOfBar(score, Math.max(1, bar)) ?? 0;
  const m = score.measures[k];
  let page = m?.page ?? 0;
  const nextK = measureOfBar(score, Math.max(1, bar) + 1);
  if (m && nextK != null && score.measures[nextK].page !== page) {
    page = score.measures[nextK].page; // 쪽의 마지막 마디: 미리 넘긴다
  }

  // 음원 마디 → 악보 마디가 여러 번일 수 있어(반복) 악보 마디마다 처음 나오는 음원 마디를 기억
  const firstBarOf = useMemo(() => {
    const out = new Map<number, number>();
    const n = score.order ? score.order.length : score.measures.length;
    for (let b = 1; b <= n; b++) {
      const kk = measureOfBar(score, b);
      if (kk != null && !out.has(kk)) out.set(kk, b);
    }
    return out;
  }, [score]);

  const track = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState(page); // 지금 화면에 보이는 쪽 (손으로 넘기면 바뀐다)
  const go = (p: number, smooth = true) => {
    const el = track.current;
    if (!el) return;
    const q = Math.max(0, Math.min(score.pages.length - 1, p));
    el.scrollTo({ left: q * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
  };
  // 연주 위치의 쪽이 바뀌면 그 쪽으로
  const followed = useRef<number | null>(null);
  useEffect(() => {
    if (followed.current === page) return;
    go(page, followed.current !== null);
    followed.current = page;
  });
  // 손으로 밀었을 때 쪽 표시를 맞춘다
  const onScroll = () => {
    const el = track.current;
    if (el && el.clientWidth) setView(Math.round(el.scrollLeft / el.clientWidth));
  };
  const ratio = Math.min(...score.pages.map((pg) => pg.w / pg.h));

  return (
    <div className="score-slider" style={{ maxWidth: `calc((100vh - 60px) * ${ratio})` }}>
      <div className="score-track" ref={track} onScroll={onScroll}>
        {score.pages.map((pg, pi) => (
          <div key={pi} className="score-page" style={{ aspectRatio: `${pg.w} / ${pg.h}` }}>
            <img src={api.fileUrl(score.page_urls[pi])} alt={`${pi + 1}쪽`} draggable={false} />
            {score.measures.map((ms, mi) =>
              ms.page !== pi ? null : (
                <button
                  key={mi}
                  type="button"
                  className={`score-bar${mi === k ? " on" : ""}`}
                  title={firstBarOf.has(mi) ? `${firstBarOf.get(mi)}마디로 이동` : undefined}
                  onClick={() => firstBarOf.has(mi) && onPickBar?.(firstBarOf.get(mi)!)}
                  style={{
                    left: `${(ms.x0 / pg.w) * 100}%`,
                    width: `${((ms.x1 - ms.x0) / pg.w) * 100}%`,
                    top: `${((ms.top - (ms.bot - ms.top) * 0.9) / pg.h) * 100}%`,
                    height: `${(((ms.bot - ms.top) * 2.8) / pg.h) * 100}%`,
                  }}
                />
              ),
            )}
          </div>
        ))}
      </div>
      <div className="score-nav">
        <button className="ghost" onClick={() => go(view - 1)} disabled={view <= 0} aria-label="이전 쪽">
          ‹
        </button>
        <span className="meta">
          {view + 1} / {score.pages.length}
        </span>
        <button
          className="ghost"
          onClick={() => go(view + 1)}
          disabled={view >= score.pages.length - 1}
          aria-label="다음 쪽"
        >
          ›
        </button>
      </div>
    </div>
  );
}
