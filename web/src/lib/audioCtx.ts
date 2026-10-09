/** 예비박·실시간 메트로놈이 함께 쓰는 AudioContext. 페이지에 하나만 둔다. */
let shared: AudioContext | null = null;

export const audioCtx = () => (shared ??= new AudioContext());

/** 메트로놈 소리 종류. 사인파는 배음이 없어 음악에 잘 묻혀서, 기본은 '딱' 하는 타격음이다. */
export type ClickSound =
  | "wood"
  | "cowbell"
  | "stick"
  | "clave"
  | "hihat"
  | "clap"
  | "marimba"
  | "digital"
  | "drum"
  | "beep";
export const CLICK_SOUNDS: { value: ClickSound; label: string }[] = [
  { value: "wood", label: "우드블록" },
  { value: "cowbell", label: "카우벨" },
  { value: "stick", label: "스틱" },
  { value: "clave", label: "클라베" },
  { value: "hihat", label: "하이햇" },
  { value: "clap", label: "박수" },
  { value: "marimba", label: "마림바" },
  { value: "digital", label: "전자음" },
  { value: "drum", label: "드럼 (첫 박 킥)" },
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
 * 메트로놈·예비박이 나가는 출구. 볼륨을 100% 넘게(최대 600%) 올려도 찌그러지지 않게
 * 리미터(빠른 컴프레서)를 거친다.
 */
// 예전엔 브라우저 컴프레서(DynamicsCompressor)를 리미터로 썼는데, 실측해 보니 문턱 아래 소리까지
// 11dB 가량 줄이고(크롬의 자동 보정) 1ms 어택이 클릭 머리를 못 잡아 꼭대기가 0dB 를 넘었다.
// 지금은 곡선(웨이브셰이퍼)으로 0.7 까지는 그대로, 그 위만 부드럽게 눌러 0.9 를 못 넘게 한다 —
// 지연도 없고 작은 소리는 손대지 않는다. 셰이퍼 입력은 -1~1 이라 앞에서 1/8 로 줄이고 곡선에서
// 8 배로 되돌린다 (볼륨 600% 까지 넣어도 곡선 범위 안).
const HEAD = 8;
let limiter: { ctx: BaseAudioContext; input: GainNode } | null = null;
export function metroOut(ctx: BaseAudioContext): AudioNode {
  if (!limiter || limiter.ctx !== ctx) {
    const pre = ctx.createGain();
    pre.gain.value = 1 / HEAD;
    const shaper = ctx.createWaveShaper();
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * HEAD;
      const a = Math.abs(x);
      // 0.7 까지 그대로, 그 위는 0.9 로 수렴 (오버샘플링을 끈 대신 여유를 둔다)
      const y = a <= 0.7 ? a : 0.7 + 0.2 * Math.tanh((a - 0.7) / 0.2);
      curve[i] = Math.sign(x) * y;
    }
    shaper.curve = curve;
    // 오버샘플링은 끈다 — 잡음 소리(하이햇)에서 필터 출렁임으로 꼭대기가 +4dB 넘게 튀었다(실측)
    shaper.oversample = "none";
    pre.connect(shaper).connect(ctx.destination);
    limiter = { ctx, input: pre };
  }
  return limiter.input;
}

let noise: AudioBuffer | null = null;
function noiseBuf(ctx: BaseAudioContext) {
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
  ctx: BaseAudioContext,
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
  const burst = (to: AudioNode, len: number, at = when) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf(ctx);
    n.connect(to);
    n.start(at);
    n.stop(at + len + 0.02);
    srcs.push(n);
  };
  const filter = (type: BiquadFilterType, f: number, q: number, to: AudioNode) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.connect(to);
    return b;
  };
  // 박 종류 (freq 로 넘어온다): 마디 첫 박 1500, 박 1000, 8비트 사잇박 2200
  const accent = freq >= 1200 && freq < 2000;
  const sub = freq >= 2000;

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
  } else if (kind === "clave") {
    // 클라베: 높고 아주 짧은 나무 소리
    const f0 = 2300 * Math.pow(r, 0.5);
    osc("sine", f0, env(peak, 0.04), 0.04);
    osc("triangle", f0 * 0.5, env(peak * 0.5, 0.03), 0.03);
  } else if (kind === "hihat") {
    // 하이햇: 높은 잡음. 첫 박은 길게(살짝 열린 소리), 사잇박은 짧고 작게
    const len = accent ? 0.13 : sub ? 0.03 : 0.05;
    burst(filter("highpass", 7000, 0.7, env(peak * (sub ? 1.6 : 3.2), len)), len);
  } else if (kind === "clap") {
    // 박수: 대역 잡음을 세 번 빠르게 + 꼬리
    const g = env(peak * 3.4, 0.11);
    const bp = filter("bandpass", 1300 * Math.pow(r, 0.4), 0.9, g);
    burst(bp, 0.11);
    for (const d of [0.008, 0.017]) burst(filter("bandpass", 1300, 0.9, env(peak * 1.6, d + 0.006)), 0.006, when + d);
  } else if (kind === "marimba") {
    // 마림바: 부드러운 사인 + 4배음, 조금 길게
    const f0 = 620 * Math.pow(r, 0.6);
    osc("sine", f0, env(peak, 0.22), 0.22);
    osc("sine", f0 * 4, env(peak * 0.25, 0.06), 0.06);
  } else if (kind === "digital") {
    // 전자음: 짧은 사각파 (드럼머신 메트로놈)
    const lp = filter("lowpass", 5000, 0.7, env(peak, 0.05));
    osc("square", freq * 0.8, lp, 0.05);
  } else if (kind === "drum") {
    // 드럼: 마디 첫 박은 킥 + 하이햇, 나머지는 하이햇만
    if (accent) {
      const g = env(peak * 1.3, 0.18);
      const o = osc("sine", 140, g, 0.18);
      o.frequency.setValueAtTime(150, when);
      o.frequency.exponentialRampToValueAtTime(48, when + 0.12);
    }
    const len = sub ? 0.03 : 0.045;
    burst(filter("highpass", 7000, 0.7, env(peak * (sub ? 1.6 : 3.2), len)), len);
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

// 개발자 도구에서 소리별 크기를 잴 때 쓴다 (OfflineAudioContext 로 렌더링)
Object.assign(globalThis, { __scheduleClick: scheduleClick, __metroOut: metroOut });
