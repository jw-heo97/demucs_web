import { metroOut, scheduleClick } from "./audioCtx";

/**
 * 합친 재생: 기기에 저장된 트랙들을 지금 믹서 설정(음소거·솔로·볼륨·오프셋)대로 한 덩어리로 더해
 * <audio> 하나로 재생한다. 트랙마다 <audio> 를 따로 틀면 실제로 소리가 나는 순간이 트랙마다·기기마다
 * 달라(아이패드) 메트로놈과 음악이 맞았다 안 맞았다 했다. 한 파일이면 어긋날 수가 없다.
 * 예비박도 그 파일 안에 넣는다 (makeCountInWav).
 *
 * 파일의 시간축: 앞에 PRE 초의 여백을 둔다 → 파일 시각 = 곡 시각 + PRE. 예비박이 곡 0초보다
 * 앞에 와야 할 때(1마디가 곡 맨 앞) 그 여백에 찍는다.
 */
export const PRE = 10;

export interface MixSource {
  url: string;
  gain: number;
  /** 트랙의 0초가 곡의 몇 초인가 */
  offsetSec: number;
}

export interface MixPcm {
  /** 스테레오 interleaved 16bit */
  pcm: Int16Array;
  sr: number;
  frames: number;
}

/** 0.7 까지 그대로, 위는 0.9 로 부드럽게 (메트로놈을 크게 올려도 찌그러지지 않게 — metroOut 과 같은 곡선) */
function soft(x: number) {
  const a = Math.abs(x);
  return a <= 0.7 ? x : Math.sign(x) * (0.7 + 0.2 * Math.tanh((a - 0.7) / 0.2));
}

/** 트랙을 하나씩 풀어 더한다 (한꺼번에 풀면 아이패드 메모리가 모자랄 수 있다). 소리 안 나는 트랙은 건너뛴다. */
export async function renderMix(
  ctx: BaseAudioContext,
  sources: MixSource[],
  onProgress?: (done: number, total: number) => void,
): Promise<MixPcm> {
  const sr = ctx.sampleRate;
  let L: Float32Array | null = null;
  let R: Float32Array | null = null;
  const live = sources.filter((s) => s.gain > 0);
  let done = 0;
  for (const s of live) {
    const buf = await (await fetch(s.url)).arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const off = Math.round(s.offsetSec * sr);
    const need = Math.max(0, audio.length + off);
    if (!L || !R || L.length < need) {
      const len: number = Math.max(need, L ? L.length : 0);
      const nL = new Float32Array(len);
      const nR = new Float32Array(len);
      if (L && R) {
        nL.set(L);
        nR.set(R);
      }
      L = nL;
      R = nR;
    }
    const outL: Float32Array = L;
    const outR: Float32Array = R as Float32Array;
    const c0 = audio.getChannelData(0);
    const c1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : c0;
    const g = s.gain;
    const from = Math.max(0, -off);
    for (let i = from; i < audio.length; i++) {
      const j = i + off;
      outL[j] += c0[i] * g;
      outR[j] += c1[i] * g;
    }
    onProgress?.(++done, live.length);
  }
  const frames = L?.length ?? 0;
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm[2 * i] = Math.round(soft(L![i]) * 32767);
    pcm[2 * i + 1] = Math.round(soft(R![i]) * 32767);
  }
  return { pcm, sr, frames };
}

function wavHeader(frames: number, sr: number): ArrayBuffer {
  const h = new ArrayBuffer(44);
  const v = new DataView(h);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  const bytes = frames * 4;
  w(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, bytes, true);
  return h;
}

const wavUrl = (frames: number, sr: number, parts: Int16Array[]) =>
  URL.createObjectURL(
    new Blob([wavHeader(frames, sr), ...parts.map((x) => x as unknown as BlobPart)], { type: "audio/wav" }),
  );

/** 곡 전체: [여백 PRE 초][합친 곡] */
export function makeFullWav(m: MixPcm): string {
  const pre = PRE * m.sr;
  return wavUrl(pre + m.frames, m.sr, [new Int16Array(pre * 2), m.pcm]);
}

export interface CountInClick {
  /** 곡 시각(초) — 0 보다 작을 수 있다(여백에 찍힌다) */
  t: number;
  freq: number;
}

/**
 * 예비박 재생용: 곡 위치 pos 앞은 조용하고(그 앞의 음악은 들리면 안 된다) 예비박 클릭이 찍힌 파일.
 * 같은 시간축(파일 시각 = 곡 시각 + PRE)이라 재생 위치 계산이 곡 전체 파일과 똑같다.
 * 클릭이 pos 뒤에 오면(긴 인트로 위에 얹는 경우) 그 부분만 음악에 더한다.
 */
export async function makeCountInWav(
  m: MixPcm,
  pos: number,
  clicks: CountInClick[],
  peak: number,
): Promise<string> {
  const sr = m.sr;
  const pre = PRE * sr;
  const total = pre + m.frames;
  const at = (t: number) => Math.max(0, Math.min(total, Math.round((t + PRE) * sr)));
  const ok = clicks.filter((c) => c.t > -PRE + 0.01);
  const p = at(pos);
  // 클릭을 렌더링할 범위: 첫 클릭부터 마지막 클릭 + 0.25초 (pos 보다 앞은 늘 포함)
  const c0 = Math.min(p, ok.length ? at(ok[0].t) : p);
  const c1 = Math.max(p, ok.length ? at(ok[ok.length - 1].t + 0.25) : p);
  let clickPcm = new Float32Array(0);
  let clickR = new Float32Array(0);
  if (c1 > c0 && ok.length) {
    const off = new OfflineAudioContext(2, c1 - c0, sr);
    for (const c of ok) scheduleClick(off, (at(c.t) - c0) / sr + 0.0001, c.freq, metroOut(off), { peak });
    const r = await off.startRendering();
    clickPcm = r.getChannelData(0);
    clickR = r.getChannelData(1);
  }
  // [0, c0) 조용 · [c0, c1) 클릭 (+ pos 뒤면 음악) · [c1, 끝) 음악 그대로
  const region = new Int16Array((c1 - c0) * 2);
  for (let i = c0; i < c1; i++) {
    const k = i - c0;
    const songIdx = i - pre;
    const musL = i >= p && songIdx < m.frames ? m.pcm[2 * songIdx] / 32767 : 0;
    const musR = i >= p && songIdx < m.frames ? m.pcm[2 * songIdx + 1] / 32767 : 0;
    region[2 * k] = Math.round(soft(musL + (clickPcm[k] ?? 0)) * 32767);
    region[2 * k + 1] = Math.round(soft(musR + (clickR[k] ?? 0)) * 32767);
  }
  const tailFrom = Math.max(0, c1 - pre);
  return wavUrl(total, sr, [new Int16Array(c0 * 2), region, m.pcm.subarray(tailFrom * 2)]);
}

/** iOS: 제스처 안에서 한 번 재생해 둔 <audio> 만 나중에 재생할 수 있다 — 그때 쓸 아주 짧은 무음 */
let silentUrl: string | null = null;
export function silentWav(): string {
  if (!silentUrl) silentUrl = wavUrl(2205, 44100, [new Int16Array(2205 * 2)]);
  return silentUrl;
}
