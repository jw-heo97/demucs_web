import type { Bar, MapRange, SongMap } from "../types";

/** 한 클릭 사이의 간격(초). BPM 은 ♩ 기준이라 분모가 8이면 절반이 된다. */
export function stepOf(bpm: number, beatUnit: number): number {
  if (bpm <= 0 || beatUnit <= 0) return 0;
  return (60 / bpm) * (4 / beatUnit);
}

/**
 * 구성표에서 마디 목록을 만든다. 서버 `beats_from_map` 과 같은 규칙이라
 * 저장하기 전에도 화면에서 즉시 미리보기가 된다.
 *
 * 기준 시각은 '1마디 1박' 하나뿐이고, 그 뒤 마디는 앞 마디 길이를 쌓아 계산한다.
 * 다만 구간에 `anchor` 가 있으면 그 마디는 누적을 버리고 그 시각에서 다시 센다
 * — 녹음물은 박자가 미세하게 움직이므로 마디마다 직접 찍을 수 있어야 한다.
 */
export function barsFromMap(map: SongMap | null, duration: number): Bar[] {
  if (!map || !map.ranges?.length || duration <= 0 || !(map.bpm > 0)) return [];
  const ranges = [...map.ranges].sort((a, b) => a.from_bar - b.from_bar);
  const bars: Bar[] = [];
  let t = map.anchor ?? 0;
  let bar = 1;
  let ri = 0;
  const MAX = 5000;

  while (t < duration && bar <= MAX) {
    while (ri + 1 < ranges.length && ranges[ri + 1].from_bar <= bar) ri += 1;
    const r = ranges[ri];
    if (bar === r.from_bar && r.anchor != null) t = r.anchor;

    const bpb = Math.max(1, r.beats_per_bar || 4);
    const unit = Math.max(1, r.beat_unit || 4);
    const bpm = r.bpm || map.bpm;
    const step = stepOf(bpm, unit);
    if (step <= 0) break;

    bars.push({
      bar,
      start: t,
      beats_per_bar: bpb,
      beat_unit: unit,
      bpm,
      name: r.name || "",
      click_beats: r.click_beats ?? null,
      anchored: bar === r.from_bar && r.anchor != null,
    });
    t += bpb * step;
    bar += 1;
  }
  return bars;
}

/** 각 마디의 박자 위치와 강세·소리 여부. */
export function beatsFromBars(bars: Bar[], duration: number) {
  const beats: number[] = [];
  const accents: boolean[] = [];
  const sounds: boolean[] = [];
  for (const b of bars) {
    const step = stepOf(b.bpm, b.beat_unit);
    for (let k = 0; k < b.beats_per_bar; k++) {
      const t = b.start + k * step;
      if (t >= duration) break;
      beats.push(t);
      accents.push(k === 0);
      sounds.push(b.click_beats == null ? true : b.click_beats.includes(k + 1));
    }
  }
  return { beats, accents, sounds };
}

export function barAtTime(bars: Bar[], t: number): Bar | null {
  if (!bars.length) return null;
  let lo = 0,
    hi = bars.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].start <= t + 0.02) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? bars[found] : null;
}

export function nearestBar(bars: Bar[], t: number): Bar | null {
  if (!bars.length) return null;
  let best = bars[0];
  let bd = Math.abs(best.start - t);
  for (const b of bars) {
    const d = Math.abs(b.start - t);
    if (d < bd) {
      best = b;
      bd = d;
    }
    if (b.start > t + 10) break;
  }
  return best;
}

export function emptyRange(from_bar: number, prev?: MapRange): MapRange {
  return {
    from_bar,
    name: "",
    beats_per_bar: prev?.beats_per_bar ?? 4,
    beat_unit: prev?.beat_unit ?? 4,
    bpm: null,
    click_beats: prev?.click_beats ? [...prev.click_beats] : null,
    anchor: null,
  };
}

/** 시각 t 에 적용 중인 구간 */
export function rangeForBar(map: SongMap, bar: number): MapRange {
  const rs = [...map.ranges].sort((a, b) => a.from_bar - b.from_bar);
  let cur = rs[0];
  for (const r of rs) if (r.from_bar <= bar) cur = r;
  return cur;
}
