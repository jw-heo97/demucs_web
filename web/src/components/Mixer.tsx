import { useEffect, useRef, useState } from "react";
import type { useAudioEngine } from "../hooks/useAudioEngine";
import type { Bar } from "../types";
import { barAtTime, stepOf } from "../lib/songmap";
import { clock } from "../lib/time";

type Engine = ReturnType<typeof useAudioEngine>;

interface Props {
  engine: Engine;
  bars: Bar[];
  /** 속도 조절 노출 여부 (송 맵에서만) */
  showRate?: boolean;
  countIn: number;
  onCountInChange: (n: number) => void;
}

let sharedCtx: AudioContext | null = null;
const audioCtx = () => (sharedCtx ??= new AudioContext());

/**
 * 트랜스포트 + 트랙 볼륨/음소거/솔로 + 예비박.
 *
 * 예비박은 파일에 굽지 않고 Web Audio 로 즉석에서 만든다. 파일에 넣으려면 모든 스템 앞에
 * 같은 길이의 무음을 붙여 전부 재인코딩해야 하고, 곡 중간부터 연습할 때는 쓸 수 없다.
 */
export function Mixer({ engine, bars, showRate, countIn, onCountInChange }: Props) {
  const { tracks, playing, time, duration, rate, muted, solo, vol } = engine;
  const [counting, setCounting] = useState(0);
  const [hint, setHint] = useState("");
  const timers = useRef<{ t?: number; i?: number; oscs: OscillatorNode[] }>({ oscs: [] });

  /** 재생 실패(자동재생 차단, 파일 없음)를 버튼 옆에 보여준다. 조용히 삼키면 ▶ 만 남는다. */
  async function startPlay() {
    try {
      setHint("");
      await engine.play();
    } catch (e) {
      setHint((e as Error).message);
    }
  }

  useEffect(() => () => cancelCount(), []);

  // 스페이스바 = 재생/일시정지. 입력칸에 있을 때는 원래 동작(공백 입력)을 살린다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      e.preventDefault();
      void handlePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function cancelCount() {
    if (timers.current.t) clearTimeout(timers.current.t);
    if (timers.current.i) clearInterval(timers.current.i);
    timers.current.oscs.forEach((o) => {
      try {
        o.stop();
      } catch {
        /* 이미 끝난 경우 */
      }
    });
    timers.current = { oscs: [] };
    setCounting(0);
  }

  const cur = barAtTime(bars, time);
  const next = cur ? bars.find((b) => b.bar === cur.bar + 1) : bars[0];

  async function handlePlay() {
    if (playing || counting) {
      cancelCount();
      engine.pause();
      return;
    }
    const pos = time;
    // 예비박은 곡 처음부터 재생할 때만. 중간에서 매번 붙으면 방해가 된다.
    if (!countIn || pos > 0.25) {
      await startPlay();
      return;
    }
    const b = cur ?? bars[0];
    const stepRaw = b ? stepOf(b.bpm, b.beat_unit) : 0.5;
    const step = stepRaw / (rate || 1);
    const bpb = b?.beats_per_bar ?? 4;

    let ctx: AudioContext;
    try {
      ctx = audioCtx();
      await ctx.resume();
    } catch {
      await startPlay();
      return;
    }
    // 실제 재생은 예비박이 끝난 뒤 타이머에서 시작한다. iOS 는 사용자 제스처 밖의 play()
    // 를 거부하므로, 지금(버튼을 누른 제스처 안에서) 트랙들을 미리 풀어둔다.
    engine.prime();

    // 마지막 클릭과 "곡의 다음 박자" 사이가 정확히 한 박이 되도록 맞춘다.
    // 이걸 안 하면 클릭은 일정한데 음악 진입만 최대 한 박까지 어긋난다.
    const nextBeat = nextBeatAfter(bars, pos);
    const margin = 0.15;
    const tBeat = ctx.currentTime + countIn * step + margin;

    timers.current.oscs = [];
    for (let k = countIn; k >= 1; k--) {
      click(ctx, tBeat - k * step, (countIn - k) % bpb === 0 ? 1500 : 1000, timers.current.oscs);
    }

    const startAt = Math.max(ctx.currentTime, tBeat - (nextBeat - pos) / (rate || 1));
    setCounting(countIn);
    timers.current.i = window.setInterval(() => {
      const left = Math.ceil((tBeat - ctx.currentTime) / step);
      setCounting(Math.max(0, Math.min(left, countIn)));
    }, 60);
    timers.current.t = window.setTimeout(
      async () => {
        if (timers.current.i) clearInterval(timers.current.i);
        setCounting(0);
        const late = Math.max(0, ctx.currentTime - startAt) * (rate || 1);
        engine.seek(pos + late);
        await startPlay();
      },
      Math.max(0, (startAt - ctx.currentTime) * 1000),
    );
  }

  const pct = duration ? (time / duration) * 1000 : 0;

  return (
    <div className="mixer">
      <div className="transport">
        <button className="playbtn" onClick={handlePlay}>
          {counting ? counting : playing ? "❚❚" : "▶"}
        </button>
        <input
          className="seek"
          type="range"
          min={0}
          max={1000}
          value={Math.round(pct)}
          onChange={(e) => duration && engine.seek((Number(e.target.value) / 1000) * duration)}
        />
        <span className="time">
          {clock(time)} / {clock(duration)}
        </span>
        {showRate && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="meta">속도</span>
            <select
              style={{ width: 82 }}
              value={String(rate)}
              onChange={(e) => engine.setRate(Number(e.target.value))}
            >
              {[0.5, 0.6, 0.75, 0.85, 1, 1.15, 1.25].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </span>
        )}
        <select
          style={{ width: 112 }}
          value={String(countIn)}
          onChange={(e) => onCountInChange(Number(e.target.value))}
        >
          <option value="0">예비박 없음</option>
          <option value="2">예비박 2박</option>
          <option value="4">예비박 4박</option>
          <option value="8">예비박 8박</option>
        </select>
        {hint && <span className="err">{hint}</span>}
      </div>

      <div className="sectbar">
        {cur ? (
          <>
            <span className="nowsec">
              {cur.bar}마디 · {beatOf(cur, time)}박
            </span>
            <span className="meta">
              {cur.beats_per_bar}/{cur.beat_unit} · ♩={cur.bpm}
            </span>
            {cur.name && <span className="meta">{cur.name}</span>}
            {next?.name && next.name !== cur.name && (
              <span className={next.start - time <= 8 ? "nowsec" : "meta"}>
                → {next.name} {(next.start - time).toFixed(1)}초 후
              </span>
            )}
          </>
        ) : (
          <span className="meta">{bars.length ? "1마디 전" : "구성표 없음"}</span>
        )}
      </div>

      {tracks.map((t, i) => (
        <div className="trk" key={t.key}>
          <span className="nm">{t.label}</span>
          <span className="tog">
            <button
              className={`ghost${muted[i] ? " on" : ""}`}
              onClick={() => engine.toggleMute(i)}
            >
              음소거
            </button>
            <button className={`ghost${solo[i] ? " on" : ""}`} onClick={() => engine.toggleSolo(i)}>
              솔로
            </button>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((vol[i] ?? 1) * 100)}
            onChange={(e) => engine.setVolume(i, Number(e.target.value) / 100)}
          />
          <span className="pct">{Math.round((vol[i] ?? 1) * 100)}</span>
        </div>
      ))}
    </div>
  );
}

function beatOf(b: Bar, t: number) {
  const step = stepOf(b.bpm, b.beat_unit);
  return Math.min(b.beats_per_bar, Math.floor((t - b.start) / step) + 1);
}

function nextBeatAfter(bars: Bar[], pos: number) {
  for (const b of bars) {
    const step = stepOf(b.bpm, b.beat_unit);
    for (let k = 0; k < b.beats_per_bar; k++) {
      const t = b.start + k * step;
      if (t >= pos - 0.005) return t;
    }
  }
  return pos;
}

function click(ctx: AudioContext, when: number, freq: number, sink: OscillatorNode[]) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.35, when + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
  osc.connect(g).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.09);
  sink.push(osc);
}
