/**
 * 정밀 재생: 기기에 저장된 트랙을 풀어 두고(PCM) Web Audio 버퍼로 재생한다.
 *
 * 왜 이게 필요한가 — <audio> 는 "언제 실제로 소리가 나는지" 를 정할 수 없고, 알려 주는 재생 위치
 * (currentTime)도 기기마다 실제 소리와 어긋난다(아이패드 사파리 약 0.1초). 그래서 트랙마다 <audio>
 * 를 따로 틀면 트랙끼리·메트로놈과 어긋났고, 그걸 피하려고 한동안은 트랙을 한 파일로 합쳐 <audio>
 * 하나로 틀었다 (합칠 때마다 1~4초, 음소거·볼륨을 바꿀 때마다 다시 합침, 예비박도 파일에 구워야 했다).
 *
 * 버퍼 재생은 AudioBufferSourceNode.start(when) 으로 AudioContext 시각에 샘플 단위로 시작한다.
 * 트랙마다 소스를 따로 두되 같은 when 에 걸면 트랙끼리 어긋날 수 없고, 메트로놈·예비박 클릭도 같은
 * 시계로 예약되므로 합칠 필요가 없다. 볼륨·음소거·솔로는 트랙별 GainNode 라 바로 먹는다.
 * 재생 위치는 AudioContext 시각에서 계산하므로 기기 지연 측정도 필요 없다.
 *
 * 메모리: AudioBuffer 는 float32 라 5분 스테레오 한 트랙이 ~115MB 다. 4스템을 그대로 들고 있으면
 * 아이패드가 버틴다는 보장이 없어서, 트랙은 int16 으로 들고(절반) 재생할 때만 10초씩 AudioBuffer 로
 * 바꿔 앞서 예약한다. 이어지는 조각은 샘플 단위 시각에 시작하므로 이음새가 없다.
 *
 * 엔진이 <audio> 에 쓰던 것(currentTime·paused·play·pause·ended·이벤트…)을 같은 이름으로 흉내 내서
 * 엔진·메트로놈·구간 안내·녹음 코드가 그대로 돈다.
 *
 * 한계: 속도(playbackRate)는 지원하지 않는다 — 버퍼 소스의 속도 변경은 음정이 같이 바뀐다.
 * 속도를 바꾸면 엔진이 <audio> 재생으로 돌아간다.
 */

export interface Pcm {
  /** interleaved int16 (ch 가 1 이면 그대로) */
  data: Int16Array;
  ch: 1 | 2;
  sr: number;
  frames: number;
}

/** 한 번에 AudioBuffer 로 바꿔 예약하는 길이(초)와 얼마나 앞서 예약해 둘지(초) */
const CHUNK_SEC = 10;
const HORIZON_SEC = 25;
const TICK_MS = 200;

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
  gain: GainNode;
  /** 트랙의 0초가 곡의 몇 초인가 */
  offset: number;
  /** 다음에 예약할 트랙 프레임 */
  nextFrame: number;
  live: Set<AudioBufferSourceNode>;
}

export class BufferTransport extends EventTarget {
  private tracks: TrackState[] = [];
  private startCtx = 0;
  private startPos = 0;
  private pos = 0;
  private timer = 0;
  private disposed = false;

  // <audio> 흉내 — 엔진·메트로놈·구간 안내가 읽는 것들
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  preservesPitch = true;
  muted = false;
  volume = 1;
  src = "buffer";

  constructor(
    private ctx: AudioContext,
    pcms: { pcm: Pcm; offset: number }[],
    out: AudioNode,
  ) {
    super();
    this.tracks = pcms.map(({ pcm, offset }) => {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(out);
      return { pcm, gain, offset, nextFrame: 0, live: new Set() };
    });
    // 개발자 도구에서 들여다볼 때 (마지막으로 만든 재생기)
    Object.assign(globalThis, { __transport: this });
  }

  /** 트랙별 상태 요약 — 개발자 도구용 */
  debug() {
    return this.tracks.map((t) => ({
      ch: t.pcm.ch,
      sr: t.pcm.sr,
      sec: +(t.pcm.frames / t.pcm.sr).toFixed(2),
      offset: t.offset,
      gain: +t.gain.gain.value.toFixed(3),
      nextSec: +(t.nextFrame / t.pcm.sr).toFixed(2),
      live: t.live.size,
    }));
  }

  get duration() {
    let d = 0;
    for (const t of this.tracks) d = Math.max(d, t.offset + t.pcm.frames / t.pcm.sr);
    return d;
  }

  /** 곡 위치(초). 재생 중이면 AudioContext 시계에서 계산한다 — 시작 전(예비박 중)엔 시작 위치보다 앞이다 */
  get currentTime() {
    return this.paused ? this.pos : this.startPos + (this.ctx.currentTime - this.startCtx);
  }
  set currentTime(v: number) {
    if (this.paused) this.pos = v;
    else this.startAt(this.ctx.currentTime + 0.03, v);
  }

  /** 속도는 지원하지 않는다 (엔진이 1 이 아니면 <audio> 로 돌아간다) */
  get playbackRate() {
    return 1;
  }
  set playbackRate(_r: number) {
    /* 무시 */
  }

  /** 트랙 i 의 볼륨 (0 = 음소거). 예약해 둔 조각에도 바로 적용된다 */
  setGain(i: number, v: number) {
    const t = this.tracks[i];
    if (!t) return;
    t.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /**
   * 트랙 i 의 오프셋을 바꾼다. 재생 중이면 그 트랙만 조금 뒤 시각에 옛 조각을 끊고 새 오프셋으로
   * 이어 건다 — 다른 트랙은 손대지 않는다.
   */
  setOffset(i: number, offset: number) {
    const t = this.tracks[i];
    if (!t || Math.abs(t.offset - offset) < 1e-6) return;
    t.offset = offset;
    if (this.paused) return;
    const at = this.ctx.currentTime + 0.05;
    for (const n of t.live) {
      try {
        n.stop(at);
      } catch {
        /* 이미 끝남 */
      }
    }
    t.live.clear();
    const songAt = this.startPos + (at - this.startCtx);
    this.resetFrom(t, songAt);
    this.scheduleTrack(t, this.ctx.currentTime);
  }

  /** AudioContext 시각 when 에 곡 위치 pos 가 나오게 시작한다 (예비박 뒤 시작도 이걸로) */
  startAt(when: number, pos: number) {
    if (this.disposed) return;
    this.stopAll();
    this.startCtx = when;
    this.startPos = pos;
    this.paused = false;
    this.ended = false;
    for (const t of this.tracks) this.resetFrom(t, pos);
    this.scheduleAll();
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), TICK_MS);
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
    this.stopAll();
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** 트랙과 버퍼를 놓아준다 (곡을 바꿀 때) */
  dispose() {
    this.stopAll();
    this.paused = true;
    this.disposed = true;
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = [];
  }

  // <audio> 흉내 — 엔진이 정리할 때 부른다
  load() {}
  removeAttribute() {}

  // ---------------- 내부 ----------------

  /** 곡 위치 songPos 에서 트랙 t 가 다음에 낼 프레임 */
  private resetFrom(t: TrackState, songPos: number) {
    const local = songPos - t.offset;
    t.nextFrame = local <= 0 ? 0 : Math.min(t.pcm.frames, Math.round(local * t.pcm.sr));
  }

  private ctxTimeOfFrame(t: TrackState, frame: number) {
    return this.startCtx + (t.offset + frame / t.pcm.sr - this.startPos);
  }

  private scheduleAll() {
    const now = this.ctx.currentTime;
    for (const t of this.tracks) this.scheduleTrack(t, now);
  }

  private scheduleTrack(t: TrackState, now: number) {
    const { pcm } = t;
    const chunk = Math.round(CHUNK_SEC * pcm.sr);
    while (t.nextFrame < pcm.frames) {
      const when = this.ctxTimeOfFrame(t, t.nextFrame);
      if (when > now + HORIZON_SEC) break;
      const n = Math.min(chunk, pcm.frames - t.nextFrame);
      const buf = this.ctx.createBuffer(pcm.ch, n, pcm.sr);
      const from = t.nextFrame;
      if (pcm.ch === 1) {
        const o = buf.getChannelData(0);
        const d = pcm.data;
        for (let i = 0; i < n; i++) o[i] = d[from + i] / 32767;
      } else {
        const L = buf.getChannelData(0);
        const R = buf.getChannelData(1);
        const d = pcm.data;
        let k = from * 2;
        for (let i = 0; i < n; i++) {
          L[i] = d[k++] / 32767;
          R[i] = d[k++] / 32767;
        }
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(t.gain);
      // 이미 지난 시각이면(늦게 깬 타이머 등) 그만큼 건너뛰어 지금 시작한다
      if (when < now) src.start(now, Math.min(now - when, buf.duration));
      else src.start(when);
      t.live.add(src);
      src.onended = () => {
        t.live.delete(src);
        src.disconnect();
      };
      t.nextFrame += n;
    }
  }

  private tick() {
    if (this.paused) return;
    const now = this.ctx.currentTime;
    for (const t of this.tracks) this.scheduleTrack(t, now);
    if (this.currentTime >= this.duration + 0.05) {
      // 끝까지 들었다
      this.pos = this.duration;
      this.stopAll();
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
    }
  }

  private stopAll() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
    for (const t of this.tracks) {
      for (const n of t.live) {
        n.onended = null;
        try {
          n.stop();
        } catch {
          /* 시작 전이거나 이미 끝남 */
        }
        n.disconnect();
      }
      t.live.clear();
    }
  }
}
