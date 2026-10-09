/**
 * 재생 워클릿 (AudioWorklet): 트랙을 섞어 내보내고, 속도가 1 이 아니면 WSOLA 로 음정을 유지한 채 시간을 늘린다.
 *
 * 왜 워클릿인가 — Web Audio 버퍼 소스는 속도를 바꾸면 음정이 같이 변하고, 브라우저의 음정 유지 시간 늘리기는
 * <audio> 로만 쓸 수 있었다. <audio> 는 시작 시각을 정할 수 없고 재생 위치도 기기마다 어긋나서(아이패드 0.1초)
 * 여기서 직접 늘린다. 그러면 모든 소리가 AudioContext 시계 하나에서 나온다.
 *
 * 동기:
 *  - 트랙은 늘리기 전에 섞는다. 트랙마다 따로 늘리면 각자 다른 이음 위치를 골라 서로 어긋난다.
 *  - 속도 1 은 늘리지 않고 그대로 내보낸다(바이패스) — 샘플 단위로 정확하다.
 *  - 속도 ≠ 1 은 WSOLA: 출력 n 프레임 ↔ 입력 tempo·n 프레임이 선형으로 대응하고(누적 오차 없음), 이음 위치만
 *    탐색 창(±W/2, 약 ±6ms) 안에서 고른다. 그래서 메트로놈과의 어긋남은 그 창을 넘지 않는다.
 *  - 시작은 atFrame(AudioContext 프레임)에 정확히 맞춘다. 블록(128) 중간이면 앞을 0 으로 채운다.
 *
 * 입력은 메인 스레드가 조각(song 프레임 좌표, 트랙별 float32)으로 미리 보내 준다. 메모리는 메인이 int16 으로
 * 들고 있고 여기엔 몇 초치만 산다.
 *
 * 메시지 (메인 → 워클릿):
 *   {type:'config', tracks:N, gains:number[]}        트랙 수·볼륨
 *   {type:'gains', gains}                            볼륨 (바로 먹는다)
 *   {type:'tempo', tempo}                            속도 (재생 중 바꿀 수 있다)
 *   {type:'start', gen, songFrame, atFrame, tempo}   gen 세대로 songFrame 부터 atFrame 에 시작. 조각 버퍼를 비운다
 *   {type:'chunk', gen, track, start, L, R?}         조각 (R 이 없으면 모노)
 *   {type:'stop'}                                    멈춤 (조용히)
 * (워클릿 → 메인):
 *   {type:'pos', gen, songFrame, ctxFrame}           ctxFrame 에 내보낸 출력이 곡의 songFrame 이다 (주기적으로)
 *   {type:'underrun', gen, songFrame}                조각이 없어 0 을 섞었다 (진단용)
 */
export const STRETCH_WORKLET_NAME = "demucs-stretch";

export const STRETCH_WORKLET_SRC = String.raw`
class Fifo {
  constructor() { this.chunks = []; }
  clear() { this.chunks.length = 0; }
  push(c) { this.chunks.push(c); }
  /** [from, from+n) 을 outL/outR 에 g 배로 더한다. 빠진 구간은 0. 전부 있었으면 true */
  addInto(outL, outR, from, n, g) {
    let covered = 0;
    for (const c of this.chunks) {
      const cs = c.start, ce = c.start + c.L.length;
      if (ce <= from) continue;
      if (cs >= from + n) break;
      const a = Math.max(cs, from), b = Math.min(ce, from + n);
      const L = c.L, R = c.R || c.L;
      for (let f = a; f < b; f++) {
        outL[f - from] += L[f - cs] * g;
        outR[f - from] += R[f - cs] * g;
      }
      covered += b - a;
    }
    return covered >= n;
  }
  dropBefore(f) {
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].L.length <= f) this.chunks.shift();
  }
}

class Stretch extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    // SoundTouch 와 비슷한 값: 겹침 8ms, 구간 40ms, 탐색 12ms
    this.O = Math.round(0.008 * sr);
    this.S = Math.round(0.040 * sr);
    this.W = Math.round(0.012 * sr);
    this.tracks = [];
    this.gains = [];
    this.tempo = 1;
    this.gen = 0;
    this.playing = false;
    this.started = false;
    this.atFrame = 0;
    this.inPos = 0;            // 다음에 읽을 입력(곡) 프레임 — 늘리기의 명목 머리
    this.anchorIn = 0;         // 출력 anchorOut 프레임이 곡의 anchorIn 프레임 (선형 대응의 기준)
    this.anchorOut = 0;
    this.outCount = 0;         // 시작 뒤 내보낸 출력 프레임 수
    this.midL = new Float32Array(this.O);
    this.midR = new Float32Array(this.O);
    this.midValid = false;
    this.qL = new Float32Array(0);  // 늘리기 출력 대기열
    this.qR = new Float32Array(0);
    this.qHead = 0;
    const need = this.W + this.S;
    this.tmpL = new Float32Array(need);
    this.tmpR = new Float32Array(need);
    this.blocks = 0;
    this.lastUnderrun = -1e9;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'config':
        this.tracks = [];
        for (let i = 0; i < m.tracks; i++) this.tracks.push(new Fifo());
        this.gains = m.gains.slice();
        break;
      case 'gains':
        this.gains = m.gains.slice();
        break;
      case 'tempo':
        this.setTempo(m.tempo);
        break;
      case 'start':
        this.gen = m.gen;
        for (const t of this.tracks) t.clear();
        this.tempo = m.tempo;
        this.inPos = m.songFrame;
        this.atFrame = m.atFrame;
        this.anchorIn = m.songFrame;
        this.anchorOut = m.atFrame;
        this.outCount = 0;
        this.midValid = false;
        this.qHead = 0;
        this.qL = new Float32Array(0);
        this.qR = new Float32Array(0);
        this.started = false;
        this.playing = true;
        break;
      case 'chunk':
        if (m.gen !== this.gen) break;
        if (this.tracks[m.track]) this.tracks[m.track].push({ start: m.start, L: m.L, R: m.R || null });
        break;
      case 'stop':
        this.playing = false;
        this.started = false;
        for (const t of this.tracks) t.clear();
        break;
    }
  }

  /** 속도를 바꾼다: 지금 출력 프레임을 기준으로 선형 대응을 다시 잡는다 */
  setTempo(t) {
    if (t === this.tempo) return;
    if (this.playing && this.started) {
      const outNow = this.atFrame + this.outCount; // 다음에 내보낼 출력 프레임
      this.anchorIn = this.anchorIn + (outNow - this.anchorOut) * this.tempo;
      this.anchorOut = outNow;
      // 늘리기 머리도 같은 자리에서 다시: 대기열은 옛 속도로 만든 것이라 버린다
      this.inPos = this.anchorIn;
      this.qHead = 0;
      this.qL = new Float32Array(0);
      this.qR = new Float32Array(0);
      this.midValid = false;
    }
    this.tempo = t;
  }

  /** 곡 프레임 from 부터 n 프레임을 섞어 outL/outR 에 쓴다 */
  mix(outL, outR, from, n) {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    let ok = true;
    for (let i = 0; i < this.tracks.length; i++) {
      const g = this.gains[i] || 0;
      if (g <= 0) continue;
      if (!this.tracks[i].addInto(outL, outR, from, n, g)) ok = false;
    }
    if (!ok && currentFrame - this.lastUnderrun > sampleRate) {
      this.lastUnderrun = currentFrame;
      this.port.postMessage({ type: 'underrun', gen: this.gen, songFrame: from });
    }
  }

  /** WSOLA 한 바퀴: S−O 프레임을 대기열에 더한다 */
  stretchOnce() {
    const O = this.O, S = this.S, W = this.W;
    const half = W >> 1;
    const base = Math.round(this.inPos) - half;   // 탐색 창을 명목 위치 가운데에 둔다
    const need = W + S;
    const tL = this.tmpL, tR = this.tmpR;
    this.mix(tL, tR, base, need);
    // 이음 위치: midBuffer 와 가장 닮은 곳 (모노 합으로 상관). 거칠게(4칸) 훑고 ±4 안에서 다듬는다
    let off = half;
    if (this.midValid) {
      const mL = this.midL, mR = this.midR;
      let em = 1e-9;
      for (let i = 0; i < O; i++) { const y = mL[i] + mR[i]; em += y * y; }
      // 정규화 상관(−1~1). 조용한 구간(상관이 다 0)에서는 가운데(명목 위치)를 고르게 아주 작은 벌점을 더한다 —
      // 안 그러면 첫 후보(가장 이른 쪽)로 쏠려 소리가 늘 6ms 늦게 나온다
      const corrAt = (o) => {
        let c = 0, e = 1e-9;
        for (let i = 0; i < O; i++) {
          const x = tL[o + i] + tR[o + i];
          c += x * (mL[i] + mR[i]);
          e += x * x;
        }
        return c / Math.sqrt(e * em) - 0.002 * Math.abs(o - half) / half;
      };
      let best = -Infinity, bo = half;
      for (let o = 0; o < W; o += 4) {
        const c = corrAt(o);
        if (c > best) { best = c; bo = o; }
      }
      for (let o = Math.max(0, bo - 3); o < Math.min(W, bo + 4); o++) {
        if (o % 4 === 0) continue;
        const c = corrAt(o);
        if (c > best) { best = c; bo = o; }
      }
      off = bo;
    }
    // 출력: 겹침 O 프레임은 mid 에서 새 구간으로 넘어가고, 그 뒤 S−2O 프레임은 그대로
    const n = S - O;
    const oL = new Float32Array(n), oR = new Float32Array(n);
    for (let i = 0; i < O; i++) {
      const k = i / O;
      if (this.midValid) {
        oL[i] = this.midL[i] * (1 - k) + tL[off + i] * k;
        oR[i] = this.midR[i] * (1 - k) + tR[off + i] * k;
      } else {
        oL[i] = tL[off + i] * k;  // 처음(또는 탐색 뒤)엔 짧게 페이드인
        oR[i] = tR[off + i] * k;
      }
    }
    for (let i = O; i < n; i++) {
      oL[i] = tL[off + i];
      oR[i] = tR[off + i];
    }
    // 다음 바퀴의 겹침 재료
    for (let i = 0; i < O; i++) {
      this.midL[i] = tL[off + n + i];
      this.midR[i] = tR[off + n + i];
    }
    this.midValid = true;
    this.inPos += this.tempo * n;
    // 대기열에 붙인다
    const rem = this.qL.length - this.qHead;
    const nL = new Float32Array(rem + n), nR = new Float32Array(rem + n);
    nL.set(this.qL.subarray(this.qHead)); nR.set(this.qR.subarray(this.qHead));
    nL.set(oL, rem); nR.set(oR, rem);
    this.qL = nL; this.qR = nR; this.qHead = 0;
    for (const t of this.tracks) t.dropBefore(base - W);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    L.fill(0); R.fill(0);
    if (!this.playing) return true;
    const blockStart = currentFrame;
    let from = 0;
    if (!this.started) {
      if (blockStart + n <= this.atFrame) return true; // 아직
      this.started = true;
      from = Math.max(0, this.atFrame - blockStart);  // 블록 중간 시작: 앞은 0
    }
    const m = n - from;
    if (this.tempo === 1) {
      // 바이패스: 곡 프레임을 그대로
      const at = Math.round(this.inPos);
      this.mix(this.tmpL, this.tmpR, at, m);
      L.set(this.tmpL.subarray(0, m), from);
      R.set(this.tmpR.subarray(0, m), from);
      this.inPos = at + m;
      for (const t of this.tracks) t.dropBefore(at - 256);
    } else {
      while (this.qL.length - this.qHead < m) this.stretchOnce();
      L.set(this.qL.subarray(this.qHead, this.qHead + m), from);
      R.set(this.qR.subarray(this.qHead, this.qHead + m), from);
      this.qHead += m;
    }
    this.outCount += m;
    if ((++this.blocks & 7) === 0) {
      const outNow = this.atFrame + this.outCount;
      this.port.postMessage({
        type: 'pos', gen: this.gen,
        songFrame: this.anchorIn + (outNow - this.anchorOut) * this.tempo,
        ctxFrame: outNow,
      });
    }
    return true;
  }
}
registerProcessor('${STRETCH_WORKLET_NAME}', Stretch);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** 워클릿 모듈을 이 컨텍스트에 (한 번만) 올린다 */
export function ensureStretchWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([STRETCH_WORKLET_SRC], { type: "text/javascript" }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
  }
  return p;
}
