/**
 * 스템 오디오를 기기(브라우저 Cache Storage)에 통째로 받아 두고 blob: 주소로 재생한다.
 *
 * <audio> 에 서버 주소를 그대로 주면 정지·이동·재생 때마다 Range 요청으로 다시 받는다.
 * 원격(Tailscale·LTE)에서는 그 사이 버퍼링·이동 멈춤이 잦았고, 한 브라우저에서 여러
 * 트랙이 동시에 받으면 연결 수 한도에 걸려 이동이 아예 멈추기도 했다. 한 번 다 받아 두면
 * 이후로는 네트워크를 타지 않는다. 새로고침해도 남고, 파일이 바뀌면(주소의 ?v=수정시각) 새로 받는다.
 *
 * Cache Storage 는 보안 컨텍스트(https, localhost)에서만 있다. 없으면 메모리에만 둔다.
 */

const CACHE_NAME = "demucs-audio-v1";
/** 이번 세션에 만든 blob: 주소. 너무 쌓이면 오래된 것부터 놓아준다(지금 쓰는 곡 것은 최근이라 남는다). */
const MAX_URLS = 16;
const objectUrls = new Map<string, string>();

const hasCache = () => typeof caches !== "undefined";

/** 받다 만 파일 — 다음에 이어 받는다 (이번 세션 메모리에만) */
const partials = new Map<string, { chunks: Uint8Array[]; got: number; total: number; type: string }>();

function remember(url: string, blob: Blob) {
  const prev = objectUrls.get(url);
  if (prev) return prev;
  const u = URL.createObjectURL(blob);
  objectUrls.set(url, u);
  while (objectUrls.size > MAX_URLS) {
    const [k, v] = objectUrls.entries().next().value as [string, string];
    objectUrls.delete(k);
    URL.revokeObjectURL(v);
  }
  return u;
}

/** 이미 받아 둔 것이 있으면 blob: 주소, 없으면 null (네트워크를 타지 않는다) */
export async function cachedUrl(url: string): Promise<string | null> {
  const mem = objectUrls.get(url);
  if (mem) return mem;
  if (!hasCache()) return null;
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(url);
    if (!hit) return null;
    return remember(url, await hit.blob());
  } catch {
    return null;
  }
}

/**
 * 통째로 받아 기기에 넣고 blob: 주소를 돌려준다. onProgress(받은 바이트, 전체 바이트|0).
 * 같은 파일의 예전 버전(?v= 가 다른 것)은 지운다.
 */
export async function download(
  url: string,
  onProgress?: (got: number, total: number) => void,
  signal?: AbortSignal,
  priority: "high" | "low" | "auto" = "auto",
): Promise<string> {
  // 중간에 멈춘(재생을 시작해 양보한) 파일은 받은 데까지 이어 받는다 (서버가 Range 를 지원한다)
  const part = partials.get(url);
  const headers: Record<string, string> = part ? { Range: `bytes=${part.got}-` } : {};
  // priority: 뒤에서 받을 때는 low — 재생·악보 같은 다른 요청이 먼저 나가게 (지원 안 하면 무시된다)
  const res = await fetch(url, { signal, priority, headers } as RequestInit);
  if (!res.ok || !res.body) throw new Error(`받기 실패 (${res.status})`);
  const resumed = !!part && res.status === 206;
  const chunks: Uint8Array[] = resumed ? part!.chunks : [];
  let got = resumed ? part!.got : 0;
  const total = resumed ? part!.total : Number(res.headers.get("content-length")) || 0;
  const type = res.headers.get("content-type") || part?.type || "audio/mpeg";
  partials.delete(url);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(got, total);
    }
  } catch (e) {
    if (got > 0) partials.set(url, { chunks, got, total, type });
    throw e;
  }
  const blob = new Blob(chunks as BlobPart[], { type });
  if (hasCache()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      // 같은 트랙의 예전 사본 정리 — ?v= 만 다른 것, 그리고 wav↔mp3 로 바뀐 것
      // (재생용 mp3 가 새로 생기면 예전에 받아 둔 wav 는 더 안 쓴다)
      const trackOf = (u: string) =>
        new URL(u, location.href).pathname.replace(/\/(wav|mp3)\//i, "/").replace(/\.(wav|mp3)$/i, "");
      const me = trackOf(url);
      const href = new URL(url, location.href).href;
      for (const req of await cache.keys()) {
        if (trackOf(req.url) === me && req.url !== href) await cache.delete(req);
      }
      await cache.put(
        url,
        new Response(blob, { headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) } }),
      );
    } catch {
      /* 저장 공간이 모자라면 이번 세션 메모리에서만 쓴다 */
    }
  }
  return remember(url, blob);
}

/** 이 트랙들을 기기에서 지운다 (같은 트랙의 wav/mp3·다른 버전 사본까지) */
export async function removeFromDevice(urls: string[]) {
  const trackOf = (u: string) =>
    new URL(u, location.href).pathname.replace(/\/(wav|mp3)\//i, "/").replace(/\.(wav|mp3)$/i, "");
  const mine = new Set(urls.map(trackOf));
  for (const [k, v] of [...objectUrls]) {
    if (mine.has(trackOf(k))) {
      objectUrls.delete(k);
      URL.revokeObjectURL(v);
    }
  }
  for (const u of urls) partials.delete(u);
  if (!hasCache()) return;
  const cache = await caches.open(CACHE_NAME);
  for (const req of await cache.keys()) if (mine.has(trackOf(req.url))) await cache.delete(req);
}

/** 기기에 받아 둔 오디오 전체 크기(바이트) — 설정·안내용 */
export async function cachedBytes(): Promise<number> {
  if (!hasCache()) return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    let n = 0;
    for (const req of await cache.keys()) {
      const r = await cache.match(req);
      n += Number(r?.headers.get("content-length")) || 0;
    }
    return n;
  } catch {
    return 0;
  }
}

/** 기기에 받아 둔 오디오를 모두 지운다 */
export async function clearCache() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
  if (hasCache()) await caches.delete(CACHE_NAME);
}
