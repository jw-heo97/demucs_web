/**
 * 풀어 둔 트랙(int16 PCM)을 곡이 바뀌어도 얼마간 들고 있는다 — 플레이리스트에서 다음 곡으로 넘어갔다
 * 돌아오거나, 다음 곡을 미리 풀어 두는 데 쓴다. 곡을 풀면 트랙 하나에 몇 초가 걸려서(5분 mp3 4개면
 * 10초 안팎) 매번 다시 풀면 곡을 넘길 때마다 기다려야 했다.
 *
 * 메모리는 예산(BUDGET)으로 막는다. 재생기가 쓰는 중인 트랙은 pin 으로 잡아 두고, 그 밖의 것은 오래된
 * 순서로 버린다. 4스템 5분 곡이 48kHz 에서 ~230MB 라 예산 480MB 면 두 곡쯤 들어간다 (아이패드에서
 * 4스템 곡이 도는 것은 확인했지만 그 이상은 아직이라 넉넉히 잡지 않았다).
 *
 * 트랙을 푸는 것(decodeAudioData)은 전역으로 한 번에 하나씩만 한다 — 푸는 순간엔 float32 전체가 잠깐 살아서
 * (5분 ~115MB) 여러 곡을 동시에 풀면 아이패드가 버겁다.
 */
import { decodePcm, type Pcm } from "./bufferTransport";

const BUDGET = 480 * 1024 * 1024;

interface Entry {
  pcm: Pcm;
  bytes: number;
  last: number;
  pins: number;
}

const entries = new Map<string, Entry>();
let total = 0;
let chain: Promise<unknown> = Promise.resolve();

/** 풀어 둔 것이 있나 (네트워크·디코딩 없이) */
export const hasPcm = (url: string) => entries.has(url);

/**
 * 트랙을 (캐시에 있으면 그대로, 없으면 풀어서) 돌려준다. 푸는 것은 전역으로 직렬이다.
 * key 는 서버 주소(?v= 포함 — 파일이 바뀌면 다른 키), src 는 실제로 읽을 곳(기기에 받아 둔 blob: 주소).
 */
export function getPcm(ctx: BaseAudioContext, key: string, src: string, signal?: AbortSignal): Promise<Pcm> {
  const hit = entries.get(key);
  if (hit) {
    hit.last = performance.now();
    return Promise.resolve(hit.pcm);
  }
  const run = chain.then(async () => {
    const again = entries.get(key);
    if (again) {
      again.last = performance.now();
      return again.pcm;
    }
    if (signal?.aborted) throw new DOMException("취소", "AbortError");
    const pcm = await decodePcm(ctx, src, signal);
    const bytes = pcm.data.byteLength;
    entries.set(key, { pcm, bytes, last: performance.now(), pins: 0 });
    total += bytes;
    evict();
    return pcm;
  });
  chain = run.catch(() => {});
  return run;
}

/** 재생기가 쓰는 동안 버리지 않게 잡아 둔다 */
export function pinPcm(urls: string[]) {
  for (const u of urls) {
    const e = entries.get(u);
    if (e) e.pins += 1;
  }
}
export function unpinPcm(urls: string[]) {
  for (const u of urls) {
    const e = entries.get(u);
    if (e) e.pins = Math.max(0, e.pins - 1);
  }
  evict();
}

/** 이 트랙들을 캐시에서 지운다 (기기 저장을 지울 때) */
export function dropPcm(urls: string[]) {
  for (const u of urls) {
    const e = entries.get(u);
    if (e && e.pins === 0) {
      entries.delete(u);
      total -= e.bytes;
    }
  }
}

function evict() {
  while (total > BUDGET) {
    let oldest: [string, Entry] | null = null;
    for (const kv of entries) {
      if (kv[1].pins > 0) continue;
      if (!oldest || kv[1].last < oldest[1].last) oldest = kv;
    }
    if (!oldest) break;
    entries.delete(oldest[0]);
    total -= oldest[1].bytes;
  }
}

/** 개발자 도구용 */
export function pcmCacheInfo() {
  return {
    totalMB: Math.round(total / 1048576),
    budgetMB: Math.round(BUDGET / 1048576),
    tracks: [...entries].map(([u, e]) => ({ url: u.slice(-40), mb: Math.round(e.bytes / 1048576), pins: e.pins })),
  };
}
Object.assign(globalThis, { __pcmCache: pcmCacheInfo });
