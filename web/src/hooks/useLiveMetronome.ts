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

  /**
   * 예비박이 끝나 음악이 시작될 AudioContext 시각과 그때의 곡 위치.
   * 이게 있으면 오디오가 움직이길 기다리지 않고 예비박과 같은 시계로 박을 이어 센다 —
   * 예비박 마지막 클릭과 1마디 1박 사이가 정확히 한 박이 된다.
   */
  const hintRef = useRef<{
    ctx: number;
    song: number;
    onLag?: (lag: number) => void;
    /** 재생이 걸린 뒤 처음 본 위치 — 이 값에서 움직이면 실제로 소리가 나기 시작한 것 */
    pos0?: number;
  } | null>(null);
  // 예약해 둔 클릭을 버리고 처음부터 (예비박 시작·취소)
  const resetRef = useRef(false);
  /** onLag: 음악이 예정보다 몇 초 늦게 시작했는지(음수면 이르게) 한 번 알려준다 */
  const expect = useCallback(
    (ctxTime: number, songPos: number, onLag?: (lag: number) => void) => {
      hintRef.current = { ctx: ctxTime, song: songPos, onLag };
      resetRef.current = true;
    },
    [],
  );
  const cancel = useCallback(() => {
    hintRef.current = null;
    resetRef.current = true;
  }, []);

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
    // 시작 지연 측정: 소리가 나기 시작하고 조금 뒤(재생 위치가 안정된 뒤) 예비박 시계와 비교한다.
    // 막 움직인 순간의 위치는 들쭉날쭉해서 그때 재면 한쪽으로 치우친다.
    let measure: { at: number; ctx: number; song: number; onLag: (lag: number) => void } | null = null;
    // 예비박 직후 이 시각까지는 음악 쪽으로 당기지 않는다 — 1마디 1박이 예비박 박자 그대로 와야 한다.
    // (음악 시작이 몇십 ms 흔들려도 그건 다음 재생의 시작 보정으로 고친다)
    let graceUntil = 0;
    let next = 0;
    const live: { osc: OscillatorNode; when: number; t: number }[] = [];
    // 마지막으로 실제로 울린(취소되지 않은) 클릭의 곡 시각 — 다시 맞출 때 겹치거나 빠지지 않게
    let lastSounded = -Infinity;

    const cancelFuture = () => {
      const now = ctx.currentTime;
      for (const x of live) {
        if (x.when <= now) lastSounded = Math.max(lastSounded, x.t);
        else {
          try {
            x.osc.stop();
          } catch {
            /* 이미 끝남 */
          }
        }
      }
      live.length = 0;
    };

    const schedule = (now: number, pred: number, r: number) => {
      const ev = eventsRef.current;
      const horizon = pred + LOOKAHEAD * r;
      while (anchor && next < ev.length && ev[next].t < horizon) {
        const e = ev[next++];
        let when = anchor.ctx + (e.t - anchor.song) / r;
        // 시작하며 살짝 지나친 박은 바로 울린다 (그 밖에 지난 박은 이미 걸러졌다)
        if (when < now - 0.15) continue;
        when = Math.max(when, now);
        const s = SOUND[e.kind];
        live.push({ osc: scheduleClick(ctx, when, s.freq, out, s), when, t: e.t });
      }
      // 끝난 것은 놓아준다
      while (live.length && live[0].when < now - 0.5) {
        lastSounded = Math.max(lastSounded, live[0].t);
        live.shift();
      }
    };

    const tick = () => {
      const a = engine.audios.current[0];
      const now = ctx.currentTime;
      const r = rateRef.current || 1;
      if (resetRef.current) {
        resetRef.current = false;
        anchor = null;
        startPos = null;
        measure = null;
        cancelFuture();
        lastSounded = -Infinity;
      }

      // 예비박 중 ~ 음악이 실제로 소리 나기 시작할 때까지: 언제 어디서 시작할지 아니까
      // 그 시계(예비박과 같은 시계)로 박을 예약한다. 음악은 시작 지연만큼 미리 재생이 걸려
      // 있어서, 그 사이 재생 위치는 아직 멈춰 있다 — 여기서 맞추면 오히려 어긋난다.
      const h = hintRef.current;
      if (h) {
        if (now > h.ctx + 1.5) {
          hintRef.current = null; // 재생이 시작되지 않았다 (막힘·취소)
        } else {
          watched = a ?? null;
          if (!anchor) {
            anchor = { ctx: h.ctx, song: h.song, rate: r };
            next = lowerBound(eventsRef.current, h.song);
            dirtyRef.current = false;
          }
          const pred = anchor.song + (now - anchor.ctx) * r;
          let moving = false;
          if (a && !a.paused) {
            if (h.pos0 === undefined) h.pos0 = a.currentTime;
            else moving = a.currentTime !== h.pos0;
          }
          if (!moving) {
            if (dirtyRef.current) {
              dirtyRef.current = false;
              cancelFuture();
              next = lowerBound(eventsRef.current, Math.max(h.song, pred));
            }
            schedule(now, pred, r);
            return;
          }
          // 소리가 나기 시작했다: 이후엔 음악 쪽으로 맞추고, 조금 뒤 어긋난 정도를 잰다
          if (h.onLag) measure = { at: now + 0.3, ctx: h.ctx, song: h.song, onLag: h.onLag };
          graceUntil = now + 0.35;
          hintRef.current = null;
        }
      }

      if (!a || a.paused || a !== watched) {
        // 멈췄거나 곡이 바뀌면 처음부터 다시 맞춘다
        if (anchor || startPos !== null) {
          anchor = null;
          startPos = null;
          cancelFuture();
          lastSounded = -Infinity;
        }
        if (a !== watched) restPos = null;
        watched = a ?? null;
        if (!a || a.paused) {
          restPos = a ? a.currentTime : null;
          return;
        }
      }
      const actual = a.currentTime;
      const ev = eventsRef.current;
      if (measure && now >= measure.at) {
        // 예비박 시계로 예측한 위치보다 음악이 뒤에 있으면 그만큼 늦게 시작한 것
        measure.onLag(measure.song + (now - measure.ctx) * r - actual);
        measure = null;
      }

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
      const grace = now < graceUntil;
      if (!anchor || Math.abs(err) > (grace ? 0.15 : RESYNC) || anchor.rate !== r) {
        // 조금 어긋나 다시 맞추는 경우(탐색이 아닌): 음악이 앞서 지나쳐 버린 박도 아직 안
        // 울렸으면 바로 울리고, 이미 울린 박은 다시 울리지 않는다.
        const drift = !!anchor && Math.abs(err) < 0.3 && anchor.rate === r;
        cancelFuture();
        if (drift) from = Math.max(actual - 0.12, lastSounded + 0.005);
        anchor = { ctx: now, song: actual, rate: r };
        pred = actual;
        next = lowerBound(ev, from);
        dirtyRef.current = false; // 방금 최신 박으로 다시 셌다
      } else if (!grace && Math.abs(err) > 0.004) {
        // 작은 오차는 조금씩만 따라간다 — 재생 위치 값 자체가 몇 ms 씩 흔들린다
        anchor.song += err * 0.1;
        pred += err * 0.1;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        cancelFuture();
        next = lowerBound(ev, pred);
      }
      schedule(now, pred, r);
    };

    const id = window.setInterval(tick, TICK_MS);
    tick();
    return () => {
      window.clearInterval(id);
      cancelFuture();
    };
  }, [enabled, engine.audios]);

  return { expect, cancel };
}
