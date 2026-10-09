/**
 * 마이크로 함께 연습 기기들을 맞춘다.
 *
 * 한 기기가 마이크로 듣는 동안 모든 기기가 정해진 서버 시각에 차례로(기기마다 칸을 나눠) 짧은 '삐'
 * 를 낸다. 듣는 기기는 각 기기의 삐가 '예정보다 몇 ms 늦게 들렸나' 를 재고, 자기 삐와의 차이를
 * 그 기기의 보정값으로 돌려준다. 같은 마이크로 다 들으므로 마이크 자체의 지연은 빼기에서 지워지고,
 * 스피커 지연·블루투스·시계 오차가 모두 들어간 '실제로 귀에 들리는 차이' 만 남는다.
 */

/** 기기(칸)마다 다른 주파수 — 시간 칸과 주파수 둘 다로 누구 소리인지 가린다 */
export const calibFreq = (slot: number) => 1600 + slot * 500;
/** 기기마다 칸 간격(ms) — 1초 안에 모두 들어가게, 2대면 450ms (어긋남이 ±200ms 까지 구분된다) */
export const calibSlotMs = (devices: number) => Math.floor(900 / Math.max(2, devices));
export const CALIB_COUNT = 6;

const RECORDER = `class R extends AudioWorkletProcessor{process(i){const x=i[0]&&i[0][0];
if(x)this.port.postMessage({f:currentFrame,d:x.slice(0)});return true}}
registerProcessor('calib-recorder',R)`;
const ready = new WeakMap<BaseAudioContext, Promise<void>>();

export interface Recording {
  stop(): { samples: Float32Array; firstFrame: number; sr: number };
}

/** 마이크 녹음을 시작한다 (사용자 제스처 안에서 불러야 권한 창이 뜬다) */
export async function startMic(ctx: AudioContext): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // 삐의 도착 시각을 재야 하므로 소리를 가공하는 기능은 모두 끈다
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  if (!ready.has(ctx))
    ready.set(ctx, ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([RECORDER], { type: "text/javascript" }))));
  await ready.get(ctx);
  const src = ctx.createMediaStreamSource(stream);
  const rec = new AudioWorkletNode(ctx, "calib-recorder");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(rec).connect(mute).connect(ctx.destination);
  const chunks: Float32Array[] = [];
  let firstFrame = -1;
  rec.port.onmessage = (e) => {
    const { f, d } = e.data as { f: number; d: Float32Array };
    if (firstFrame < 0) firstFrame = f;
    chunks.push(d);
  };
  return {
    stop() {
      src.disconnect();
      rec.disconnect();
      mute.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const samples = new Float32Array(n);
      let o = 0;
      for (const c of chunks) {
        samples.set(c, o);
        o += c.length;
      }
      return { samples, firstFrame: Math.max(0, firstFrame), sr: ctx.sampleRate };
    },
  };
}

/** 그 주파수 성분이 갑자기 커지는 순간들 (AudioContext 시각, 초) */
export function findBeeps(samples: Float32Array, firstFrame: number, sr: number, freq: number): number[] {
  const hop = 32;
  const win = 256;
  const w = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w);
  const pow: number[] = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    // Goertzel
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < win; i++) {
      const q0 = 2 * cos * q1 - q2 + samples[s + i];
      q2 = q1;
      q1 = q0;
    }
    pow.push(q1 * q1 + q2 * q2 - 2 * cos * q1 * q2);
  }
  // 문턱: 배경 잡음(중앙값)의 30배, 그리고 가장 큰 소리의 -40dB 중 큰 쪽 — 마이크에서 먼 기기의
  // 삐는 가까운 기기보다 훨씬 작게 들린다(20~30dB)
  let max = 1e-12;
  for (const v of pow) if (v > max) max = v;
  const sorted = Float64Array.from(pow).sort();
  const floor = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  const thr = Math.max(floor * 30, max * 1e-4);
  const look = Math.round((0.05 * sr) / hop);
  const out: number[] = [];
  let last = -1e9;
  for (let i = 1; i < pow.length; i++) {
    if (pow[i] >= thr && pow[i - 1] < thr && i - last > (0.12 * sr) / hop) {
      // 시작 시각은 '그 삐 자신의 꼭대기의 1/4 에 처음 닿은 곳' — 문턱을 넘은 곳으로 하면 큰 소리가
      // 작은 소리보다 일찍 잡혀(실측 4ms) 기기 간 차이가 그만큼 틀렸다
      let pk = i;
      for (let k = i; k < Math.min(pow.length, i + look); k++) if (pow[k] > pow[pk]) pk = k;
      let j = pk;
      while (j > 0 && pow[j - 1] > pow[pk] * 0.25) j--;
      out.push((firstFrame + j * hop + win) / sr);
      last = i;
    }
  }
  return out;
}

/**
 * 각 칸(기기)의 '예정보다 늦게 들린 정도' 중앙값(ms). expected(j, k) 는 j 번 기기의 k 번째 삐가
 * 원래 울려야 할 AudioContext 시각.
 */
export function lateness(
  /** 칸(기기)마다 그 기기 주파수로 찾은 소리 시작들 */
  onsets: number[][],
  expected: (slot: number, k: number) => number,
  slotMs: number,
  selfSlot: number,
): (number | null)[] {
  const within = slotMs / 2000 - 0.01;
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const lateOf = (j: number, shift: number) => {
    const xs: number[] = [];
    for (const t of onsets[j] ?? [])
      for (let k = 0; k < CALIB_COUNT; k++) {
        const d = t - expected(j, k) - shift;
        if (Math.abs(d) < within) xs.push(d + shift);
      }
    return xs;
  };
  // 1) 내 삐로 '내 마이크·스피커 지연' 을 먼저 잡는다
  const mine = lateOf(selfSlot, 0);
  if (mine.length < 3) return onsets.map(() => null);
  const m0 = med(mine);
  // 2) 나머지는 그만큼 옮긴 예정 시각 기준으로 (어긋남이 칸 간격의 절반까지 구분된다)
  return onsets.map((_, j) => {
    const xs = j === selfSlot ? mine : lateOf(j, m0);
    return xs.length < 3 ? null : med(xs) * 1000;
  });
}
