/** 예비박·실시간 메트로놈이 함께 쓰는 AudioContext. 페이지에 하나만 둔다. */
let shared: AudioContext | null = null;

export const audioCtx = () => (shared ??= new AudioContext());

/**
 * 짧은 사인파 클릭 하나를 when(AudioContext 시각)에 예약한다.
 * 서버가 굽는 클릭 파일과 비슷한 소리 — 마디 첫 박 1500Hz, 나머지 1000Hz.
 */
export function scheduleClick(
  ctx: AudioContext,
  when: number,
  freq: number,
  dest: AudioNode,
  opts: { peak?: number; length?: number } = {},
): OscillatorNode {
  const peak = opts.peak ?? 0.5;
  const length = opts.length ?? 0.07;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, when + length);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + length + 0.02);
  return osc;
}
