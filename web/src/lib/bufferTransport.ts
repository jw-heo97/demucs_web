/**
 * 재생기: 기기에 저장된 트랙을 풀어 두고(int16 PCM) 워클릿(lib/stretchWorklet)으로 내보낸다.
 *
 * 왜 이게 필요한가 — <audio> 는 "언제 실제로 소리가 나는지" 를 정할 수 없고, 알려 주는 재생 위치
 * (currentTime)도 기기마다 실제 소리와 어긋난다(아이패드 사파리 약 0.1초). 그래서 트랙마다 <audio>
 * 를 따로 틀면 트랙끼리·메트로놈과 어긋났고, 그걸 피하려고 한동안은 트랙을 한 파일로 합쳐 <audio>
 * 하나로 틀었다 (합칠 때마다 1~4초, 음소거·볼륨을 바꿀 때마다 다시 합침, 예비박도 파일에 구워야 했다).
 *
 * 지금은 <audio> 를 전혀 쓰지 않는다. 워클릿이 트랙을 섞어 내보내고, 속도가 1 이 아니면 WSOLA 로
 * 음정을 유지한 채 늘린다. 모든 소리(스템·메트로놈·예비박)가 AudioContext 시계 하나에서 나오므로
 * 시작 시각을 샘플 단위로 정할 수 있고(startAt), 재생 위치는 워클릿이 실제로 내보낸 프레임에서 계산한다.
 * 볼륨·음소거·솔로는 섞을 때의 게인이라 바로 먹는다.
 *
 * 메모리: 트랙은 int16 으로 들고(5분 스테레오 ~57MB) 워클릿에는 몇 초치 조각만 미리 보낸다.
 *
 * 엔진이 <audio> 에 쓰던 것(currentTime·paused·play·pause·ended·이벤트…)을 같은 이름으로 흉내 내서
 * 메트로놈·구간 안내·녹음 코드가 그대로 돈다.
 */
import { STRETCH_WORKLET_NAME, ensureStretchWorklet } from "./stretchWorklet";

export interface Pcm {
  /** interleaved int16 (ch 가 1 이면 그대로) */
  data: Int16Array;
  ch: 1 | 2;
  sr: number;
  frames: number;
}

/** 워클릿에 보내는 조각 길이(초)와 얼마나 앞서 보내 둘지(초). 탭이 뒤로 가면 타이머가 1초로 느려지니 넉넉히 */
const CHUNK_SEC = 0.5;
const AHEAD_SEC = 3;
const FEED_MS = 150;

/**
 * 파일을 받아 풀어 int16 PCM 으로. 좌우가 같은 파일(메트로놈 클릭처럼)은 모노로 줄여 든다.
 * decodeAudioData 는 통째로만 풀 수 있어 그 순간엔 float32 전체(5분 ~115MB)가 잠깐 산다 —
 * 그래서 트랙을 한 번에 하나씩 푼다 (부르는 쪽이 순서대로).
 */
export async function decodePcm(ctx: BaseAudioContext, url: string, signal?: AbortSignal): Promise<Pcm> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`트랙을 읽지 못했습니다 (${res.status})`);
  const audio = await ctx.decodeAudioData(await res.arrayBuffer());
  const frames = audio.length;
  const c0 = audio.getChannelData(0);
  let mono = audio.numberOfChannels === 1;
  if (!mono) {
    const c1 = audio.getChannelData(1);
    mono = true;
    // 전부 비교하면 느리니 띄엄띄엄 본다 (클릭 파일은 좌우가 완전히 같다)
    for (let i = 0; i < frames; i += 97) {
      if (Math.abs(c0[i] - c1[i]) > 1e-4) {
        mono = false;
        break;
      }
    }
  }
  const ch: 1 | 2 = mono ? 1 : 2;
  const data = new Int16Array(frames * ch);
  if (mono) {
    for (let i = 0; i < frames; i++) data[i] = toInt16(c0[i]);
  } else {
    const c1 = audio.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      data[2 * i] = toInt16(c0[i]);
      data[2 * i + 1] = toInt16(c1[i]);
    }
  }
  return { data, ch, sr: audio.sampleRate, frames };
}

function toInt16(x: number) {
  const v = Math.round(x * 32767);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

interface TrackState {
  pcm: Pcm;
  /** 트랙의 0초가 곡의 몇 초인가 */
  offset: number;
  gain: number;
}

export class BufferTransport extends EventTarget {
  private tracks: TrackState[];
  private sr: number;
  private gen = 0;
  /** 재생 중: 출력 프레임 ctxFrame 이 곡 프레임 song 이다 (워클릿 보고로 갱신) */
  private anchor = { song: 0, ctxFrame: 0 };
  private tempo = 1;
  private pos = 0;
  private feedTimer = 0;
  private sentUpTo = 0;
  private disposed = false;
  /** 진단: 워클릿이 조각이 없어 0 을 섞은 횟수 */
  underruns = 0;

  // <audio> 흉내 — 엔진·메트로놈·구간 안내가 읽는 것들
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  preservesPitch = true;
  muted = false;
  volume = 1;
  src = "buffer";

  /** 워클릿을 올리고 재생기를 만든다 */
  static async create(ctx: AudioContext, pcms: { pcm: Pcm; offset: number }[], out: AudioNode): Promise<BufferTransport> {
    await ensureStretchWorklet(ctx);
    const node = new AudioWorkletNode(ctx, STRETCH_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(out);
    return new BufferTransport(ctx, node, pcms);
  }

  private constructor(
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    pcms: { pcm: Pcm; offset: number }[],
  ) {
    super();
    this.tracks = pcms.map(({ pcm, offset }) => ({ pcm, offset, gain: 1 }));
    this.sr = ctx.sampleRate;
    node.port.onmessage = (e) => {
      const m = e.data as { type: string; gen: number; songFrame: number; ctxFrame: number };
      if (m.gen !== this.gen || this.paused) return;
      if (m.type === "pos") this.anchor = { song: m.songFrame, ctxFrame: m.ctxFrame };
      else if (m.type === "underrun") this.underruns += 1;
    };
    node.port.postMessage({ type: "config", tracks: this.tracks.length, gains: this.tracks.map((t) => t.gain) });
    // 개발자 도구에서 들여다볼 때 (마지막으로 만든 재생기)
    Object.assign(globalThis, { __transport: this });
  }

  get duration() {
    let d = 0;
    for (const t of this.tracks) d = Math.max(d, t.offset + t.pcm.frames / t.pcm.sr);
    return d;
  }

  /** 곡 위치(초). 재생 중이면 워클릿이 내보낸 프레임 기준 — 시작 전(예비박 중)엔 시작 위치보다 앞이다 */
  get currentTime() {
    if (this.paused) return this.pos;
    const a = this.anchor;
    return (a.song + (this.ctx.currentTime * this.sr - a.ctxFrame) * this.tempo) / this.sr;
  }
  set currentTime(v: number) {
    if (this.paused) this.pos = v;
    else this.startAt(this.ctx.currentTime + 0.03, v);
  }

  /** 속도. 음정은 유지된다 (워클릿의 WSOLA). 재생 중 바꾸면 같은 자리에서 이어진다 */
  get playbackRate() {
    return this.tempo;
  }
  set playbackRate(r: number) {
    const t = Math.max(0.25, Math.min(4, r || 1));
    if (Math.abs(t - this.tempo) < 1e-6) return;
    if (!this.paused) {
      // 워클릿과 같은 규칙으로 선형 대응을 다시 잡는다 (다음 보고가 오면 그걸로 맞춘다)
      const nowFrame = this.ctx.currentTime * this.sr;
      this.anchor = { song: this.anchor.song + (nowFrame - this.anchor.ctxFrame) * this.tempo, ctxFrame: nowFrame };
    }
    this.tempo = t;
    this.node.port.postMessage({ type: "tempo", tempo: t });
  }

  /** 트랙 i 의 볼륨 (0 = 음소거). 바로 먹는다 */
  setGain(i: number, v: number) {
    const t = this.tracks[i];
    if (!t || t.gain === v) return;
    t.gain = v;
    this.node.port.postMessage({ type: "gains", gains: this.tracks.map((x) => x.gain) });
  }

  /** 트랙 i 의 오프셋을 바꾼다. 재생 중이면 같은 자리에서 다시 시작한다 (조각을 새로 보내야 해서) */
  setOffset(i: number, offset: number) {
    const t = this.tracks[i];
    if (!t || Math.abs(t.offset - offset) < 1e-6) return;
    t.offset = offset;
    if (!this.paused) this.startAt(this.ctx.currentTime + 0.03, this.currentTime);
  }

  /** AudioContext 시각 when 에 곡 위치 pos 가 나오게 시작한다 (예비박 뒤 시작도 이걸로) */
  startAt(when: number, pos: number) {
    if (this.disposed) return;
    this.gen += 1;
    const songFrame = Math.round(pos * this.sr);
    const atFrame = Math.round(Math.max(this.ctx.currentTime, when) * this.sr);
    this.anchor = { song: songFrame, ctxFrame: atFrame };
    this.node.port.postMessage({ type: "start", gen: this.gen, songFrame, atFrame, tempo: this.tempo });
    this.sentUpTo = Math.max(0, songFrame);
    this.paused = false;
    this.ended = false;
    this.feed();
    if (!this.feedTimer) this.feedTimer = window.setInterval(() => this.tick(), FEED_MS);
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  }

  play(): Promise<void> {
    if (this.paused) this.startAt(this.ctx.currentTime + 0.03, this.ended ? 0 : this.pos);
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.pos = Math.max(0, this.currentTime);
    this.stop();
    this.dispatchEvent(new Event("pause"));
  }

  /** 트랙과 버퍼를 놓아준다 (곡을 바꿀 때) */
  dispose() {
    this.stop();
    this.disposed = true;
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.tracks = [];
  }

  // <audio> 흉내 — 엔진이 정리할 때 부른다
  load() {}
  removeAttribute() {}

  /** 트랙별 상태 요약 — 개발자 도구용 */
  debug() {
    return {
      tempo: this.tempo,
      paused: this.paused,
      sentUpToSec: +(this.sentUpTo / this.sr).toFixed(2),
      underruns: this.underruns,
      tracks: this.tracks.map((t) => ({
        ch: t.pcm.ch,
        sr: t.pcm.sr,
        sec: +(t.pcm.frames / t.pcm.sr).toFixed(2),
        offset: t.offset,
        gain: +t.gain.toFixed(3),
      })),
    };
  }

  // ---------------- 내부 ----------------

  private stop() {
    this.gen += 1; // 늦게 오는 보고·조각을 무시한다
    this.paused = true;
    if (this.feedTimer) {
      window.clearInterval(this.feedTimer);
      this.feedTimer = 0;
    }
    this.node.port.postMessage({ type: "stop" });
  }

  private tick() {
    if (this.paused) return;
    this.feed();
    if (this.currentTime >= this.duration + 0.05) {
      // 끝까지 들었다
      this.pos = this.duration;
      this.stop();
      this.ended = true;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
    }
  }

  /** 지금 위치에서 AHEAD_SEC 앞까지 조각을 보내 둔다 */
  private feed() {
    const sr = this.sr;
    const endFrame = Math.ceil(this.duration * sr) + sr; // 끝 뒤 1초까지 (0 이 섞인다)
    const target = Math.min(endFrame, Math.round(this.currentTime * sr) + Math.round((AHEAD_SEC + CHUNK_SEC) * sr));
    const chunk = Math.round(CHUNK_SEC * sr);
    while (this.sentUpTo < target) {
      const start = this.sentUpTo;
      const n = Math.min(chunk, endFrame - start);
      if (n <= 0) break;
      // 음소거된 트랙도 보낸다 — 켜는 순간 바로 들려야 한다 (조각이 없으면 0 이 섞인다)
      this.tracks.forEach((t, i) => this.sendChunk(i, t, start, n));
      this.sentUpTo = start + n;
    }
  }

  private sendChunk(i: number, t: TrackState, start: number, n: number) {
    const { pcm } = t;
    const off = Math.round(t.offset * pcm.sr);
    const L = new Float32Array(n);
    const R = pcm.ch === 2 ? new Float32Array(n) : null;
    // 곡 프레임 f ↔ 트랙 프레임 f − off. 트랙 밖은 0
    const a = Math.max(start, off);
    const b = Math.min(start + n, off + pcm.frames);
    if (b > a) {
      const d = pcm.data;
      if (pcm.ch === 1) {
        for (let f = a; f < b; f++) L[f - start] = d[f - off] / 32767;
      } else {
        for (let f = a; f < b; f++) {
          const k = (f - off) * 2;
          L[f - start] = d[k] / 32767;
          R![f - start] = d[k + 1] / 32767;
        }
      }
    }
    this.node.port.postMessage({ type: "chunk", gen: this.gen, track: i, start, L, R }, R ? [L.buffer, R.buffer] : [L.buffer]);
  }
}
