/** 예비박·실시간 메트로놈이 함께 쓰는 AudioContext. 페이지에 하나만 둔다. */
let shared: AudioContext | null = null;

export const audioCtx = () => (shared ??= new AudioContext());

/** 메트로놈 소리 종류. 사인파는 배음이 없어 음악에 잘 묻혀서, 기본은 '딱' 하는 타격음이다. */
export type ClickSound = "wood" | "cowbell" | "stick" | "beep";
export const CLICK_SOUNDS: { value: ClickSound; label: string }[] = [
  { value: "wood", label: "우드블록" },
  { value: "cowbell", label: "카우벨" },
  { value: "stick", label: "스틱" },
  { value: "beep", label: "삐 (예전 소리)" },
];
const LS_SOUND = "metronome.sound";
let sound: ClickSound = (() => {
  try {
    const v = localStorage.getItem(LS_SOUND) as ClickSound | null;
    return v && CLICK_SOUNDS.some((s) => s.value === v) ? v : "wood";
  } catch {
    return "wood";
  }
})();
export const getClickSound = () => sound;
export function setClickSound(v: ClickSound) {
  sound = v;
  try {
    localStorage.setItem(LS_SOUND, v);
  } catch {
    /* 기억만 못 할 뿐 */
  }
}

/**
 * 메트로놈·예비박이 나가는 출구. 볼륨을 100% 넘게(최대 300%) 올려도 찌그러지지 않게
 * 리미터(빠른 컴프레서)를 거친다.
 */
let limiter: DynamicsCompressorNode | null = null;
export function metroOut(ctx: AudioContext): AudioNode {
  if (!limiter || limiter.context !== ctx) {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    limiter.connect(ctx.destination);
  }
  return limiter;
}

let noise: AudioBuffer | null = null;
function noiseBuf(ctx: AudioContext) {
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.08), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** 예약한 클릭 하나. 예비박 취소·재예약 때 stop() 으로 끊는다. */
export interface ClickHandle {
  stop(): void;
}

/**
 * 클릭 하나를 when(AudioContext 시각)에 예약한다. freq 는 박의 높낮이 — 마디 첫 박 1500,
 * 나머지 1000, 8비트 사잇박 2200. 사인('삐')은 그 주파수 그대로, 타격음은 그 비율만큼
 * 음높이를 올려 첫 박을 구분한다.
 */
export function scheduleClick(
  ctx: AudioContext,
  when: number,
  freq: number,
  dest: AudioNode,
  opts: { peak?: number; length?: number; sound?: ClickSound } = {},
): ClickHandle {
  const kind = opts.sound ?? sound;
  const peak = opts.peak ?? 0.9;
  const r = freq / 1000;
  const srcs: AudioScheduledSourceNode[] = [];

  /** 1ms 만에 올라가 len 초에 걸쳐 사라지는 엔벨로프 */
  const env = (level: number, len: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + len);
    g.connect(dest);
    return g;
  };
  const osc = (type: OscillatorType, f: number, to: AudioNode, len: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(to);
    o.start(when);
    o.stop(when + len + 0.02);
    srcs.push(o);
    return o;
  };
  const burst = (to: AudioNode, len: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf(ctx);
    n.connect(to);
    n.start(when);
    n.stop(when + len + 0.02);
    srcs.push(n);
  };

  if (kind === "beep") {
    const len = opts.length ?? 0.07;
    osc("sine", freq, env(peak, len), len);
  } else if (kind === "wood") {
    // 우드블록: 짧게 사라지는 삼각파 + 어긋난 배음 + 아주 짧은 잡음 어택
    const f0 = 900 * Math.pow(r, 0.6);
    const len = 0.08;
    osc("triangle", f0, env(peak, len), len);
    osc("sine", f0 * 2.76, env(peak * 0.35, len * 0.6), len);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    hp.connect(env(peak * 0.5, 0.008));
    burst(hp, 0.01);
  } else if (kind === "cowbell") {
    // 카우벨(808 식): 어긋난 두 사각파를 대역통과
    const k = Math.pow(r, 0.5);
    const len = 0.14;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1100 * k;
    bp.Q.value = 1.6;
    bp.connect(env(peak * 0.9, len));
    osc("square", 587 * k, bp, len);
    osc("square", 845 * k, bp, len);
  } else {
    // 스틱(림샷 비슷): 대역 잡음 + 짧은 음높이
    const k = Math.pow(r, 0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600 * k;
    bp.Q.value = 0.7;
    // 대역통과한 잡음은 에너지가 많이 빠져서 크게 키운다 (넘치는 것은 리미터가 받는다).
    // 실측: 이만큼이어야 30ms 평균이 다른 소리와 비슷하다(-12dB 안팎)
    bp.connect(env(peak * 3.3, 0.05));
    burst(bp, 0.05);
    osc("triangle", 1700 * k, env(peak * 0.78, 0.025), 0.025);
  }

  return {
    stop() {
      srcs.forEach((s) => {
        try {
          s.stop();
        } catch {
          /* 이미 끝난 경우 */
        }
      });
    },
  };
}
