import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { audioCtx, scheduleClick } from "../lib/audioCtx";
import { beatsFromBars } from "../lib/songmap";
import type { Bar } from "../types";
import type { useAudioEngine } from "./useAudioEngine";

type Engine = ReturnType<typeof useAudioEngine>;

interface ClickEvent {
  /** 곡 시각(초) */
  t: number;
  /** 마디 첫 박 / 나머지 박 / 박 사이(8비트) */
  kind: "accent" | "beat" | "sub";
}

const SOUND: Record<ClickEvent["kind"], { freq: number; peak: number; length: number }> = {
  accent: { freq: 1500, peak: 0.35, length: 0.07 },
  beat: { freq: 1000, peak: 0.35, length: 0.07 },
  // 박과 헷갈리지 않게 더 높고 짧고 작게 (서버 믹스다운의 8비트와 같은 소리)
  sub: { freq: 2200, peak: 0.16, length: 0.04 },
};

const LS_SUBDIV = "metronome.subdiv";

/**
 * 메트로놈 4비트(1) / 8비트(2). 곡마다가 아니라 연습 방식이라 브라우저에 하나로 기억한다.
 */
export function useSubdiv(): [1 | 2, (n: 1 | 2) => void] {
  const [v, setV] = useState<1 | 2>(() => {
    try {
      return localStorage.getItem(LS_SUBDIV) === "2" ? 2 : 1;
    } catch {
      return 1;
    }
  });
  const set = useCallback((n: 1 | 2) => {
    setV(n);
    try {
      localStorage.setItem(LS_SUBDIV, String(n));
    } catch {
      /* 기억만 못 할 뿐 */
    }
  }, []);
  return [v, set];
}

/** 이만큼 앞까지 미리 예약한다(곡 시간 기준, 초) */
const LOOKAHEAD = 0.15;
const TICK_MS = 15;
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
export function useLiveMetronome(engine: Engine, bars: Bar[], subdiv: 1 | 2 = 1) {
  const { tracks, rate, duration } = engine;
  const ci = tracks.findIndex((t) => t.virtual);
  const mix = ci >= 0 ? engine.mixOf(ci) : { on: false, vol: 0 };

  const events = useMemo<ClickEvent[]>(() => {
    const { beats, accents, sounds } = beatsFromBars(bars, duration > 0 ? duration : 1e9);
    const out: ClickEvent[] = [];
    beats.forEach((t, i) => {
      if (!sounds[i]) return;
      out.push({ t, kind: accents[i] ? "accent" : "beat" });
      // 8비트: 소리 나는 박마다 다음 박과의 한가운데. 마지막 박은 직전 간격을 쓴다.
      if (subdiv === 2 && beats.length >= 2) {
        const gap = i + 1 < beats.length ? beats[i + 1] - t : t - beats[i - 1];
        out.push({ t: t + gap / 2, kind: "sub" });
      }
    });
    return out.sort((a, b) => a.t - b.t);
  }, [bars, duration, subdiv]);

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
    // 재생 상태(playing)를 기다리지 않고 <audio> 를 직접 지켜본다. playing 은 play() 가
    // 끝난 뒤에야 켜져서, 그 사이(수백 ms) 지나간 첫 박 — 곡 맨 앞이나 예비박 직후의
    // 1마디 1박 — 이 빠졌다.
    if (!enabled) return;
    const ctx = audioCtx();
    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    const out = gainRef.current;
    out.gain.setValueAtTime(levelRef.current, ctx.currentTime);

    let anchor: { ctx: number; song: number; rate: number } | null = null;
    // 재생을 눌러도 <audio> 는 수십 ms 뒤에야 실제로 움직인다. 그 전에 기준점을 잡으면
    // 첫 클릭들이 음악보다 그만큼 일찍 울리므로, 재생 위치가 처음 움직인 뒤에 잡는다.
    let startPos: number | null = null;
    // 멈춰 있던 위치. 재생을 처음 알아챈 순간에는 이미 몇 ms 진행돼 있으므로 여기서부터 센다.
    let restPos: number | null = null;
    let watched: HTMLAudioElement | null = null;
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
      if (!a || a.paused || a !== watched) {
        // 멈췄거나 곡이 바뀌면 처음부터 다시 맞춘다
        if (anchor || startPos !== null) {
          anchor = null;
          startPos = null;
          cancelFuture();
        }
        if (a !== watched) restPos = null;
        watched = a ?? null;
        if (!a || a.paused) {
          restPos = a ? a.currentTime : null;
          return;
        }
      }
      const now = ctx.currentTime;
      const r = rateRef.current || 1;
      const actual = a.currentTime;
      const ev = eventsRef.current;

      if (!anchor) {
        if (startPos === null) {
          // 멈춘 자리에서 이어 재생하는 경우만 믿는다 (자동 다음 곡처럼 바로 재생 중인 새 곡은 지금 위치)
          startPos = restPos !== null && actual - restPos >= 0 && actual - restPos < 0.3 ? restPos : actual;
        }
        if (actual === startPos) return;
      }
      let pred = anchor ? anchor.song + (now - anchor.ctx) * r : actual;
      const err = actual - pred;
      // 막 재생을 시작했으면 시작 위치부터 센다 — 움직임을 알아챈 순간에는 이미 첫 박
      // (곡 맨 앞, 예비박 직후의 1마디 1박)을 수십 ms 지나 있어서 빠뜨리게 된다.
      // 그 박은 아래에서 '지금' 울린다. 탐색 등으로 다시 맞출 때는 지난 박을 울리지 않는다.
      let from = actual;
      if (!anchor && startPos !== null) from = Math.min(startPos, actual);
      if (!anchor || Math.abs(err) > RESYNC || anchor.rate !== r) {
        anchor = { ctx: now, song: actual, rate: r };
        pred = actual;
        cancelFuture();
        next = lowerBound(ev, from);
        dirtyRef.current = false; // 방금 최신 박으로 다시 셌다
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
        let when = anchor.ctx + (e.t - anchor.song) / r;
        // 시작하며 살짝 지나친 박은 바로 울린다 (그 밖에 지난 박은 위에서 이미 걸러졌다)
        if (when < now - 0.15) continue;
        when = Math.max(when, now);
        const s = SOUND[e.kind];
        live.push({ osc: scheduleClick(ctx, when, s.freq, out, s), when });
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
  }, [enabled, engine.audios]);
}
