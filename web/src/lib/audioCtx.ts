/** 예비박·실시간 메트로놈·재생기가 함께 쓰는 AudioContext. 페이지에 하나만 둔다. */
let shared: AudioContext | null = null;

export const audioCtx = () => (shared ??= new AudioContext());

/**
 * 메트로놈·예비박이 나가는 출구. 볼륨을 100% 넘게(최대 600%) 올려도 찌그러지지 않게
 * 리미터를 거친다.
 */
// 예전엔 브라우저 컴프레서(DynamicsCompressor)를 리미터로 썼는데, 실측해 보니 문턱 아래 소리까지
// 11dB 가량 줄이고(크롬의 자동 보정) 1ms 어택이 클릭 머리를 못 잡아 꼭대기가 0dB 를 넘었다.
// 지금은 곡선(웨이브셰이퍼)으로 0.7 까지는 그대로, 그 위만 부드럽게 눌러 0.9 를 못 넘게 한다 —
// 지연도 없고 작은 소리는 손대지 않는다. 셰이퍼 입력은 -1~1 이라 앞에서 1/8 로 줄이고 곡선에서
// 8 배로 되돌린다 (볼륨 600% 까지 넣어도 곡선 범위 안).
const HEAD = 8;
// 컨텍스트마다 하나
const limiters = new WeakMap<BaseAudioContext, GainNode>();
export function metroOut(ctx: BaseAudioContext): AudioNode {
  let input = limiters.get(ctx);
  if (!input) {
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
    shaper.oversample = "none";
    pre.connect(shaper).connect(ctx.destination);
    limiters.set(ctx, pre);
    input = pre;
  }
  return input;
}

/** 예약한 클릭 하나. 예비박 취소·재예약 때 stop() 으로 끊는다. */
export interface ClickHandle {
  stop(): void;
}

/**
 * 클릭('삐') 하나를 when(AudioContext 시각)에 예약한다. freq 는 박의 높낮이 — 마디 첫 박 1500,
 * 나머지 1000, 8비트 사잇박 2200. 1ms 만에 올라가 length 초에 걸쳐 사라지는 사인파.
 * (한때 우드블록·카우벨 같은 타격음을 고를 수 있었는데 헷갈리기만 해서 삐 하나로 돌아갔다.)
 */
export function scheduleClick(
  ctx: BaseAudioContext,
  when: number,
  freq: number,
  dest: AudioNode,
  opts: { peak?: number; length?: number } = {},
): ClickHandle {
  const peak = opts.peak ?? 0.9;
  const len = opts.length ?? 0.07;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + len);
  g.connect(dest);
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.value = freq;
  o.connect(g);
  o.start(when);
  o.stop(when + len + 0.02);
  return {
    stop() {
      try {
        o.stop();
      } catch {
        /* 이미 끝난 경우 */
      }
    },
  };
}

// 개발자 도구에서 소리 크기를 잴 때 쓴다 (OfflineAudioContext 로 렌더링)
Object.assign(globalThis, { __scheduleClick: scheduleClick, __metroOut: metroOut });
