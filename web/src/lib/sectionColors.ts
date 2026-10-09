import type { Bar } from "../types";

/**
 * 구간 색. 밝은·어두운 화면 모두에서 파형이 보이도록 중간 명도로 골랐다.
 * 처음 나온 이름부터 차례로 쓰고, 다 쓰면 처음부터 다시 쓴다.
 */
const PALETTE = [
  "#3b82f6", // 파랑
  "#f59e0b", // 주황
  "#10b981", // 초록
  "#ec4899", // 분홍
  "#8b5cf6", // 보라
  "#ef4444", // 빨강
  "#14b8a6", // 청록
  "#eab308", // 노랑
  "#6366f1", // 남색
  "#84cc16", // 연두
];

/** 같은 구간으로 볼 이름 (대소문자·앞뒤 공백 무시) */
const keyOf = (name: string) => name.trim().toLowerCase();

/** 구간 이름 → 색. 이름이 같으면 곡 안 어디서든 같은 색이다. */
export function sectionColors(bars: Bar[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bars) {
    if (!b.name) continue;
    const k = keyOf(b.name);
    if (!out.has(k)) out.set(k, PALETTE[out.size % PALETTE.length]);
  }
  return out;
}

export function colorOf(colors: Map<string, string>, name: string | undefined | null) {
  return name ? colors.get(keyOf(name)) ?? null : null;
}

/**
 * 시각 t 가 속한 구간 — 같은 이름이 이어지는 마디들. 이름이 없으면 그 마디 하나.
 * 첫 마디보다 앞이면 첫 구간.
 */
export function sectionAt(bars: Bar[], t: number, duration: number) {
  if (!bars.length) return null;
  let i = 0;
  for (let k = 0; k < bars.length; k++) {
    if (bars[k].start <= t + 0.02) i = k;
    else break;
  }
  const name = bars[i].name;
  let s = i;
  let e = i;
  if (name) {
    while (s > 0 && bars[s - 1].name === name) s--;
    while (e + 1 < bars.length && bars[e + 1].name === name) e++;
  }
  return {
    name,
    fromBar: bars[s].bar,
    toBar: bars[e].bar,
    start: bars[s].start,
    end: e + 1 < bars.length ? bars[e + 1].start : duration,
  };
}
