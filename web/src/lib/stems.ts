import type { Job, JobFile } from "../types";

const KEY_RE = /_(no_)?(drums|bass|vocals|other|original|click)\.(mp3|wav)$/i;

/**
 * 파일이 어떤 트랙인지 (drums / no_vocals / click …). 트랙이 아니면 null.
 *
 * 서버는 스템을 `{폴더명}_{키}.{ext}` 로 굽는다. 그 이름이 정확히 맞아야 한다 —
 * 뒤쪽만 보면 버전별 메트로놈 `곡_click_drums.mp3` 가 드럼으로 잡힌다.
 * `folder` 가 없으면(이름이 안 맞는 옛 폴더) 끝부분만으로 판단하되
 * `_click_` 이 들어간 버전 파일은 뺀다.
 */
export function stemKeyOf(folder: string | null, f: JobFile): string | null {
  // 믹스다운 결과는 트랙이 아니다 — `곡_mix_vocals.mp3` 가 보컬로 잡히면 안 된다
  if (f.rel.startsWith("mix/")) return null;
  const m = KEY_RE.exec(f.name);
  if (!m) return null;
  const key = (m[1] ? "no_" : "") + m[2].toLowerCase();
  if (folder) {
    return f.name.toLowerCase() === `${folder}_${key}.${m[3]}`.toLowerCase() ? key : null;
  }
  return /_click_/i.test(f.name) ? null : key;
}

/** 작업의 트랙 파일을 키별로. mp3 우선 — 용량이 작아 스트리밍이 빠르다. */
export function stemFilesOf(job: Job): Map<string, JobFile> {
  const pick = (folder: string | null) => {
    const best = new Map<string, { file: JobFile; mp3: boolean }>();
    for (const f of job.files ?? []) {
      const key = stemKeyOf(folder, f);
      if (!key) continue;
      const isMp3 = /\.mp3$/i.test(f.name);
      const prev = best.get(key);
      if (!prev || (isMp3 && !prev.mp3)) best.set(key, { file: f, mp3: isMp3 });
    }
    return best;
  };
  // 폴더 이름으로 정확히 맞춰보고, 하나도 없으면(탐색기에서 폴더를 바꾼 경우) 느슨하게
  let best = job.folder ? pick(job.folder) : new Map();
  if (!best.size) best = pick(null);
  return new Map([...best].map(([k, v]) => [k, v.file]));
}
