import { audioCtx } from "./audioCtx";

/**
 * 기기 보정: <audio> 가 알려 주는 재생 위치(currentTime)와 그 소리가 실제로 Web Audio 에 도착하는
 * 시각의 차이를 이 기기에서 잰다.
 *
 * 메트로놈은 currentTime 을 보고 클릭을 찍는데, 아이패드 사파리는 currentTime 이 실제 소리보다
 * 약 0.1초 뒤처져 있어서 클릭이 그만큼 늦었다 (실측: 같은 송 맵에서 PC -5ms, 아이패드 +91ms).
 * 이 차이는 곡이 아니라 기기의 성질이라 한 번 재서 기억해 두고 모든 곡의 클릭에 더한다.
 *
 * 재는 법: 위치를 정확히 아는 클릭이 든 시험 음원(WAV)을 소리 없이(게인 0) 재생하며, 오디오
 * 그래프에서 클릭이 도착한 시각(샘플 단위)과 currentTime 으로 예측한 시각을 비교한다.
 * 마이크가 필요 없고, 이어폰을 꽂아도 된다.
 */

const LS_KEY = "audio.deviceLatency";

export interface DeviceLatency {
  /** 클릭에 더할 값(ms). 음수면 클릭을 앞당긴다 */
  ms: number;
  /** 잰 시각 (Date.now) */
  at: number;
  /** 잰 클릭 수와 흔들림(ms) */
  n: number;
  spread: number;
}

export function readDeviceLatency(): DeviceLatency | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    return v && Number.isFinite(v.ms) ? v : null;
  } catch {
    return null;
  }
}

function saveDeviceLatency(v: DeviceLatency) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(v));
  } catch {
    /* 기억만 못 할 뿐 */
  }
}

/** 0.4초부터 0.3초마다 짧은 펄스가 든 WAV (16bit mono) */
function testWav(sec: number, sr = 44100): { url: string; pulses: number[] } {
  const n = Math.round(sec * sr);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  const pulses: number[] = [];
  for (let t = 0.4; t < sec - 0.2; t += 0.3) {
    pulses.push(t);
    const s0 = Math.round(t * sr);
    for (let j = 0; j < 30; j++) v.setInt16(44 + (s0 + j) * 2, 24000, true);
  }
  return { url: URL.createObjectURL(new Blob([buf], { type: "audio/wav" })), pulses };
}

const DETECTOR = `class D extends AudioWorkletProcessor{constructor(){super();this.last=-1e9}
process(i){const x=i[0]&&i[0][0];if(x){for(let k=0;k<x.length;k++){const f=currentFrame+k;
if(Math.abs(x[k])>0.25&&f-this.last>sampleRate*0.15){this.last=f;this.port.postMessage(f/sampleRate)}}}return true}}
registerProcessor('latency-detector',D)`;
let workletReady: Promise<void> | null = null;

/**
 * 잰다. 반드시 사용자 제스처(버튼 누름) 안에서 불러야 한다 — iOS 는 제스처 밖의 play() 를 막는다.
 * 성공하면 저장하고 돌려준다. 못 재면 null.
 */
export async function measureDeviceLatency(): Promise<DeviceLatency | null> {
  const ctx = audioCtx();
  const { url, pulses } = testWav(3.6);
  const a = new Audio();
  a.preload = "auto";
  a.src = url;
  // 소리는 내지 않는다(게인 0) — 그래프에는 흐른다. 재생보다 먼저 그래프에 물려 두어야
  // 아래 첫 재생도 스피커로 새지 않는다
  const src = ctx.createMediaElementSource(a);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  src.connect(mute);
  // 제스처 안에서 먼저 재생을 걸어 둔다 (iOS 는 제스처 밖의 첫 play() 를 막는다)
  const first = a.play().catch(() => {});
  try {
    await ctx.resume();
    workletReady ??= ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([DETECTOR], { type: "text/javascript" })),
    );
    await workletReady;
    await first;
    a.pause();
    const det = new AudioWorkletNode(ctx, "latency-detector");
    src.connect(det).connect(mute);
    const hits: number[] = [];
    det.port.onmessage = (e) => hits.push(e.data as number);
    a.currentTime = 0;
    await new Promise((r) => a.addEventListener("seeked", r, { once: true }));
    // 메트로놈과 같은 방식으로 '재생 위치 ↔ AudioContext 시각' 짝을 모은다
    const pairs: { c: number; t: number }[] = [];
    await a.play();
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const id = window.setInterval(() => {
        if (!a.paused && a.currentTime > 0) pairs.push({ c: ctx.currentTime, t: a.currentTime });
        if (performance.now() - t0 > 3400 || a.ended) {
          clearInterval(id);
          resolve();
        }
      }, 15);
    });
    a.pause();
    src.disconnect();
    det.disconnect();
    mute.disconnect();
    URL.revokeObjectURL(url);
    if (pairs.length < 20 || hits.length < 4) return null;

    // 각 펄스가 currentTime 으로는 언제 와야 했나 (그 직전·직후 짝으로) vs 실제 도착
    const leads: number[] = [];
    for (const h of hits) {
      const k = pairs.findIndex((p) => p.c >= h);
      if (k <= 0) continue;
      const p = pairs[k - 1];
      const songAtHit = p.t + (h - p.c); // currentTime 으로 본 그 순간의 곡 위치
      const pulse = pulses.reduce((best, x) => (Math.abs(x - songAtHit) < Math.abs(best - songAtHit) ? x : best));
      if (Math.abs(pulse - songAtHit) < 0.14) leads.push(pulse - songAtHit);
    }
    if (leads.length < 4) return null;
    leads.sort((x, y) => x - y);
    const med = leads[Math.floor(leads.length / 2)];
    // lead>0: 소리가 currentTime 보다 앞서 도착 → 클릭을 그만큼 앞당긴다(음수)
    const r: DeviceLatency = {
      ms: Math.round(-med * 1000),
      at: Date.now(),
      n: leads.length,
      spread: Math.round((leads[leads.length - 1] - leads[0]) * 1000),
    };
    saveDeviceLatency(r);
    return r;
  } catch {
    return null;
  } finally {
    a.pause();
  }
}
