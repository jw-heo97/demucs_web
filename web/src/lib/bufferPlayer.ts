/**
 * 합친 음원을 Web Audio 버퍼로 재생한다 — 함께 연습용.
 *
 * <audio> 는 '언제 실제로 소리가 나는지' 를 정확히 정할 수 없고, 알려 주는 재생 위치(currentTime)도
 * 기기마다 틀리는 정도가 달라서(아이패드 0.1초) 기기끼리 맞추지 못했다. 버퍼는 start(when) 으로
 * AudioContext 시각에 샘플 단위로 시작한다 — 마이크로 맞춘 삐와 똑같은 방식이라, 삐가 맞으면
 * 음악도 맞는다.
 *
 * 엔진이 <audio> 에 쓰던 것(currentTime·paused·play·pause·이벤트…)을 같은 이름으로 흉내 내서
 * 엔진·메트로놈·구간 안내 코드가 그대로 돈다. 대가: 속도를 바꾸면 음정도 같이 바뀐다.
 */
export class BufferPlayer extends EventTarget {
  private node: AudioBufferSourceNode | null = null;
  private startCtx = 0;
  private startPos = 0;
  private pos = 0;
  private rate = 1;
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
    private buf: AudioBuffer,
    private out: AudioNode,
  ) {
    super();
  }

  get duration() {
    return this.buf.duration;
  }
  get currentTime() {
    return this.paused ? this.pos : this.startPos + (this.ctx.currentTime - this.startCtx) * this.rate;
  }
  set currentTime(v: number) {
    if (this.paused) this.pos = v;
    else this.startAt(this.ctx.currentTime + 0.02, v);
  }
  get playbackRate() {
    return this.rate;
  }
  set playbackRate(r: number) {
    if (Math.abs(r - this.rate) < 1e-6) return;
    const at = this.currentTime;
    this.rate = r;
    if (!this.paused) this.startAt(this.ctx.currentTime + 0.02, at);
  }

  /** AudioContext 시각 when 에 곡 위치 pos 가 나오게 시작한다 (pos 가 음수면 그만큼 늦게 0 부터) */
  startAt(when: number, pos: number) {
    this.stopNode();
    const n = this.ctx.createBufferSource();
    n.buffer = this.buf;
    n.playbackRate.value = this.rate;
    n.connect(this.out);
    if (pos < 0) n.start(when + -pos / this.rate, 0);
    else n.start(Math.max(this.ctx.currentTime, when), Math.min(pos, this.buf.duration));
    this.node = n;
    this.startCtx = when;
    this.startPos = pos;
    this.paused = false;
    this.ended = false;
    n.onended = () => {
      if (this.node !== n || this.paused) return;
      this.pos = this.buf.duration;
      this.paused = true;
      this.ended = true;
      this.node = null;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
    };
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  }

  play(): Promise<void> {
    if (this.paused) this.startAt(this.ctx.currentTime + 0.03, this.ended ? 0 : this.pos);
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.pos = this.currentTime;
    this.stopNode();
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  private stopNode() {
    const n = this.node;
    this.node = null;
    if (n) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* 시작 전이거나 이미 끝남 */
      }
      n.disconnect();
    }
  }

  // <audio> 흉내 — 엔진이 정리할 때 부른다
  load() {}
  removeAttribute() {}
}

/** 합친 PCM(16bit 스테레오 interleaved)을 AudioBuffer 로 */
export function pcmToBuffer(ctx: BaseAudioContext, pcm: Int16Array, frames: number, sr: number): AudioBuffer {
  const b = ctx.createBuffer(2, Math.max(1, frames), sr);
  const L = b.getChannelData(0);
  const R = b.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    L[i] = pcm[2 * i] / 32767;
    R[i] = pcm[2 * i + 1] / 32767;
  }
  return b;
}
