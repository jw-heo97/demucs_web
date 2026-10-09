import { useEffect, useMemo, useRef } from "react";
import { audioCtx, scheduleClick } from "../lib/audioCtx";
import { beatsFromBars } from "../lib/songmap";
import type { Bar } from "../types";
import type { useAudioEngine } from "./useAudioEngine";

type Engine = ReturnType<typeof useAudioEngine>;

interface ClickEvent {
  /** 곡 시각(초) */
  t: number;
  accent: boolean;
}

/** 이만큼 앞까지 미리 예약한다(곡 시간 기준, 초) */
const LOOKAHEAD = 0.15;
const TICK_MS = 25;
/** 예측한 곡 시각과 실제 재생 위치가 이보다 벌어지면 시계를 다시 맞춘다 (탐색·구간 반복·끊김) */
const RESYNC = 0.05;

/** 정렬된 events 에서 t 이상인 첫 인덱스 */
function lowerBound(ev: ClickEvent[], t: number) {
  let lo = 0,
    hi = ev.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ev[mid].t < t - 0.002) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 송 맵(마디 목록)대로 메트로놈 클릭을 실시간으로 울린다.
 *
 * 예전에는 서버가 구운 클릭 파일을 재생해서, 송 맵을 고칠 때마다 저장 → 파일 재생성을
 * 기다려야 소리가 바뀌었다. 지금은 화면의 마디 목록에서 바로 박을 계산해 Web Audio 로
 * 예약하므로 저장 전 편집도 다음 박부터 들린다.
 *
 * 시계: 음악은 <audio> 가 재생하고 클릭은 AudioContext 가 울리므로 두 시계를 이어야 한다.
 * 재생 위치를 기준점(anchor)으로 잡고 AudioContext 시각으로 앞으로의 곡 시각을 예측해
 * 클릭을 예약한다. 실제 위치와 조금 어긋나면 기준점을 살짝 당기고, 크게 어긋나면
 * (탐색·구간 반복·버퍼링) 다시 잡는다.
 */
export function useLiveMetronome(engine: Engine, bars: Bar[]) {
  const { tracks, playing, rate, duration } = engine;
  const ci = tracks.findIndex((t) => t.virtual);
  const mix = ci >= 0 ? engine.mixOf(ci) : { on: false, vol: 0 };

  const events = useMemo<ClickEvent[]>(() => {
    const { beats, accents, sounds } = beatsFromBars(bars, duration > 0 ? duration : 1e9);
    const out: ClickEvent[] = [];
    beats.forEach((t, i) => {
      if (sounds[i]) out.push({ t, accent: accents[i] });
    });
    return out;
  }, [bars, duration]);

  const eventsRef = useRef(events);
  const dirtyRef = useRef(false);
  useEffect(() => {
    eventsRef.current = events;
    dirtyRef.current = true; // 예약해 둔 클릭을 버리고 새 박으로 다시 예약
  }, [events]);

  const rateRef = useRef(rate);
  rateRef.current = rate;

  // 음소거·솔로·볼륨은 마스터 게인 하나로 — 이미 예약한 클릭에도 바로 적용된다
  const gainRef = useRef<GainNode | null>(null);
  const level = mix.on ? mix.vol : 0;
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    const g = gainRef.current;
    if (g) g.gain.setTargetAtTime(level, g.context.currentTime, 0.01);
  }, [level]);

  const enabled = ci >= 0;
  useEffect(() => {
    if (!playing || !enabled) return;
    const ctx = audioCtx();
    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    const out = gainRef.current;
    out.gain.setValueAtTime(levelRef.current, ctx.currentTime);

    let anchor: { ctx: number; song: number; rate: number } | null = null;
    let next = 0;
    const live: { osc: OscillatorNode; when: number }[] = [];

    const cancelFuture = () => {
      const now = ctx.currentTime;
      for (const x of live) {
        if (x.when > now) {
          try {
            x.osc.stop();
          } catch {
            /* 이미 끝남 */
          }
        }
      }
      live.length = 0;
    };

    const tick = () => {
      const a = engine.audios.current[0];
      if (!a || a.paused) return;
      const now = ctx.currentTime;
      const r = rateRef.current || 1;
      const actual = a.currentTime;
      const ev = eventsRef.current;

      let pred = anchor ? anchor.song + (now - anchor.ctx) * r : actual;
      const err = actual - pred;
      if (!anchor || Math.abs(err) > RESYNC || anchor.rate !== r) {
        anchor = { ctx: now, song: actual, rate: r };
        pred = actual;
        cancelFuture();
        next = lowerBound(ev, actual);
      } else if (Math.abs(err) > 0.004) {
        // 작은 오차는 조금씩만 따라간다 — 재생 위치 값 자체가 몇 ms 씩 흔들린다
        anchor.song += err * 0.1;
        pred += err * 0.1;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        cancelFuture();
        next = lowerBound(ev, pred);
      }

      const horizon = pred + LOOKAHEAD * r;
      while (next < ev.length && ev[next].t < horizon) {
        const e = ev[next++];
        const when = anchor.ctx + (e.t - anchor.song) / r;
        if (when < now) continue;
        live.push({ osc: scheduleClick(ctx, when, e.accent ? 1500 : 1000, out), when });
      }
      // 끝난 것은 놓아준다
      while (live.length && live[0].when < now - 0.5) live.shift();
    };

    const id = window.setInterval(tick, TICK_MS);
    tick();
    return () => {
      window.clearInterval(id);
      cancelFuture();
    };
  }, [playing, enabled, engine.audios]);
}
