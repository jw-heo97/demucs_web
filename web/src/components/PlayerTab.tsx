import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { colorOf, sectionColors } from "../lib/sectionColors";
import { barAtTime, barsFromMap } from "../lib/songmap";
import type { Bar, Job, ScoreData } from "../types";
import { AiScore } from "./AiScore";
import { Mixer, type MixerControl } from "./Mixer";
import { ScoreSheet, useBarDrag } from "./ScoreView";
import { NotationView } from "./NotationView";
import type { Notation } from "../lib/notation";
import { PickedSong, SongPicker } from "./SongPicker";

interface Props {
  jobs: Job[];
  onChanged: () => void;
  /** 보관함에서 고른 곡 (n 은 같은 곡을 다시 골라도 알아채게) */
  pick: { id: string; n: number } | null;
  /** 이 곡의 송 맵 편집으로 */
  onOpenMap: (id: string) => void;
  /** 고른 곡을 바깥에 알려 탭을 오가도 그 곡으로 돌아오게 한다 ("" = 목록) */
  onPickSong: (id: string) => void;
}

/** 같은 이름이 이어지는 마디들 = 파트. 이름이 없는 앞부분은 빼고 이름 있는 것만. */
function partsOf(bars: Bar[]) {
  const out: { name: string; from: number; to: number }[] = [];
  let name = "";
  for (const b of bars) {
    if (b.name) name = b.name; // 이름이 빈 마디는 앞 이름이 이어진다
    const last = out[out.length - 1];
    if (last && last.name === name) last.to = b.bar;
    else if (name) out.push({ name, from: b.bar, to: b.bar });
  }
  return out;
}

/**
 * 연습용 재생 창. 보관함에서 곡을 누르면 여기로 온다.
 * 악보가 있으면 한 쪽 전체를 보여주고, 마디를 끌어 구간 반복, 파트 버튼으로 파트 반복을 한다.
 * 악보가 없으면 마디 칸으로 같은 일을 한다. 구성표 편집은 송 맵에서.
 */
export function PlayerTab({ jobs, onChanged, pick, onOpenMap, onPickSong }: Props) {
  const [jobId, setJobId] = useState(pick?.id ?? "");
  useEffect(() => {
    if (pick) setJobId(pick.id);
  }, [pick]);
  const job = useMemo(() => jobs.find((j) => j.id === jobId && j.status === "done") ?? null, [jobs, jobId]);
  const choose = (id: string) => {
    setJobId(id);
    onPickSong(id);
  };

  const engine = useAudioEngine(job);
  const [countIn, setCountIn] = useState(4);
  const mixer = useRef<MixerControl | null>(null);
  const duration = job?.duration || engine.duration || 0;
  const bars = useMemo(() => (job ? barsFromMap((job.songmap as never) ?? null, duration) : []), [job, duration]);
  const parts = useMemo(() => partsOf(bars), [bars]);
  const cur = barAtTime(bars, engine.time)?.bar ?? 1;

  // 반복: 음원 마디 범위로 들고, 시각은 마디에서 계산한다 (송 맵이 바뀌어도 마디 기준 그대로)
  const [loopBars, setLoopBars] = useState<{ from: number; to: number; label: string } | null>(null);
  const region = useMemo(() => {
    if (!loopBars || !bars.length) return null;
    const s = bars.find((b) => b.bar === loopBars.from)?.start;
    const e = bars.find((b) => b.bar === loopBars.to + 1)?.start ?? duration;
    return s != null && e - s > 0.3 ? { start: s, end: e } : null;
  }, [loopBars, bars, duration]);
  const setLoopFn = engine.setLoop;
  useEffect(() => setLoopFn(region), [region, setLoopFn]);
  useEffect(() => setLoopBars(null), [jobId]);

  const startLoop = (from: number, to: number, label: string) => {
    setLoopBars({ from, to, label });
    // 재생 중이면 새 반복의 시작으로 가서 예비박부터
    const s = bars.find((b) => b.bar === from)?.start;
    const e = bars.find((b) => b.bar === to + 1)?.start ?? duration;
    if (engine.playing && s != null) mixer.current?.playFrom(s, { start: s, end: e });
  };
  // 마디를 끌어 반복 구간 고르기는 구간 반복이 켜져 있을 때만 — 꺼져 있으면 악보를 자유롭게 밀고 넘긴다
  const selectLoop = region ? (a: number, b: number) => startLoop(a, b, "") : undefined;
  const seekBar = (b: number) => {
    const t = bars.find((x) => x.bar === b)?.start;
    if (t != null) engine.seek(t);
  };

  // 연결된 악보
  const [score, setScore] = useState<ScoreData | null>(null);
  const scoreJob = job?.files.some((f) => f.rel === "score.pdf") ? job.id : null;
  useEffect(() => {
    let alive = true;
    setScore(null);
    if (scoreJob) api.score(scoreJob).then((s) => alive && setScore(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [scoreJob]);

  // 편집 가능한 음표 악보가 있으면 그걸 그린다 (PDF 그림보다 우선)
  const [notation, setNotation] = useState<Notation | null>(null);
  const notationSig = job?.files.find((f) => f.rel === "_notation.json")?.mtime ?? null;
  useEffect(() => {
    let alive = true;
    setNotation(null);
    if (job && notationSig != null) api.notation(job.id).then((n) => alive && setNotation(n)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [job?.id, notationSig]);

  if (!job) return <SongPicker jobs={jobs} title="재생할 곡" onPick={choose} />;

  const colors = sectionColors(bars);
  return (
    <div>
      <div className="panel">
        <PickedSong job={job} onBack={() => choose("")}>
          <button className="ghost" onClick={() => onOpenMap(job.id)} title="이 곡의 구성표(마디·구간·박자) 편집">
            송 맵 편집
          </button>
        </PickedSong>
        <AiScore job={job} onChanged={onChanged} />

        {parts.length > 0 && (
          <div className="parts">
            <span className="meta">파트 반복</span>
            {parts.map((p) => {
              const on = loopBars?.from === p.from && loopBars?.to === p.to;
              const c = colorOf(colors, p.name);
              return (
                <button
                  key={`${p.from}`}
                  className={`ghost part${on ? " on" : ""}`}
                  style={c && !on ? { borderLeft: `4px solid ${c}` } : undefined}
                  onClick={() => (on ? setLoopBars(null) : startLoop(p.from, p.to, p.name))}
                  title={`${p.from}~${p.to}마디${on ? " — 누르면 해제" : ""}`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="loopinfo meta">
          {loopBars && region ? (
            <>
              반복: {loopBars.label && <b>{loopBars.label}</b>} {loopBars.from}~{loopBars.to}마디
              <button className="ghost" onClick={() => setLoopBars(null)}>반복 해제</button>
            </>
          ) : (
            "마디를 누르면 그 마디로 이동 · 구간 반복을 켜면 마디를 끌어 반복 구간을 고를 수 있습니다"
          )}
        </div>

        <Mixer
          engine={engine}
          bars={bars}
          jobId={job.id}
          onChanged={onChanged}
          showRate
          loopButton={{
            on: !!region,
            region,
            title: region ? "반복 해제" : "지금 마디가 속한 파트를 반복합니다",
            onToggle: () => {
              if (region) return setLoopBars(null);
              const p = parts.find((x) => x.from <= cur && cur <= x.to);
              if (p) startLoop(p.from, p.to, p.name);
              // 구간 이름이 없는 곳(첫 마디 앞 등)은 지금 마디부터 4마디 — 켠 뒤 마디를 끌어 바꾸면 된다
              else if (bars.length) startLoop(cur, Math.min(bars[bars.length - 1].bar, cur + 3), "");
            },
          }}
          control={mixer}
          countIn={countIn}
          onCountInChange={setCountIn}
        />
      </div>

      {notation ? (
        <NotationView
          notation={notation}
          paged
          score={score}
          bar={cur}
          loop={loopBars}
          onPickBar={seekBar}
          onSelect={selectLoop}
        />
      ) : score && score.measures.length > 0 ? (
        <ScoreSheet
          score={score}
          bar={cur}
          loop={loopBars}
          onPickBar={seekBar}
          onSelect={selectLoop}
        />
      ) : bars.length > 0 ? (
        <BarGrid bars={bars} cur={cur} loop={loopBars} colors={colors} onPickBar={seekBar}
          onSelect={selectLoop} />
      ) : (
        <div className="empty">송 맵이 없어 마디를 모릅니다. 송 맵에서 1마디 1박과 BPM 을 잡아 주세요.</div>
      )}
    </div>
  );
}

/** 악보가 없을 때: 마디 칸. 구간 이름이 바뀌는 곳에서 줄을 바꾸고 구간 색을 칠한다. */
function BarGrid({
  bars,
  cur,
  loop,
  colors,
  onPickBar,
  onSelect,
}: {
  bars: Bar[];
  cur: number;
  loop: { from: number; to: number } | null;
  colors: Map<string, string>;
  onPickBar: (bar: number) => void;
  onSelect?: (a: number, b: number) => void;
}) {
  const drag = useBarDrag(onSelect ?? (() => {}), onPickBar);
  const groups = useMemo(() => {
    const out: { name: string; bars: Bar[] }[] = [];
    let name = "";
    for (const b of bars) {
      const changed = !!b.name && b.name !== name;
      if (b.name) name = b.name;
      if (changed || !out.length) out.push({ name, bars: [b] });
      else out[out.length - 1].bars.push(b);
    }
    return out;
  }, [bars]);
  const lo = drag.sel ? Math.min(drag.sel.a, drag.sel.b) : 0;
  const hi = drag.sel ? Math.max(drag.sel.a, drag.sel.b) : -1;
  return (
    <div className={`panel bargrid${onSelect ? " selecting" : ""}`} {...(onSelect ? drag.props : {})}>
      {groups.map((g) => (
        <div key={g.bars[0].bar} className="bargroup">
          <div className="meta bargroup-name" style={{ color: colorOf(colors, g.name) ?? undefined }}>
            {g.name || "—"}
          </div>
          <div className="barcells">
            {g.bars.map((b) => (
              <div
                key={b.bar}
                data-bar={b.bar}
                className={`barcell${b.bar === cur ? " on" : ""}${loop && b.bar >= loop.from && b.bar <= loop.to ? " inloop" : ""}${b.bar >= lo && b.bar <= hi ? " picking" : ""}`}
                title={`${b.bar}마디 (${b.beats_per_bar}/${b.beat_unit})`}
                onClick={onSelect ? undefined : () => onPickBar(b.bar)}
              >
                {b.bar}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
