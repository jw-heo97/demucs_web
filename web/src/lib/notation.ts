/**
 * 음표 악보 (_notation.json, app/notation.py 와 같은 형식) — 마디마다 악기별 칸 문자열.
 *
 *   {beats: 4, unit: 4, steps: 16, lanes: {hh: "x-x-x-x-x-x-x-x-", sn: "----x-------x---", bd: "x-------x-x-----"}}
 *
 * 칸 기호: '-' 없음, 'x' 침, '>' 악센트, 'g' 고스트, 'f' 플램, 'o' 열린 하이햇(hh 만),
 * '1' '2' '3' 기둥 사선(더블 스트로크 — 사선 수만큼 쪼개 친다), 'z' 버즈.
 * 오선으로 그리는 것은 drawNotation.ts.
 */

export type Lane =
  | "cr" | "cr2" | "spl" | "chn" | "rd" | "rb" | "hh" | "t1" | "t2" | "sn" | "rim" | "ft" | "cb" | "bd" | "hhp";

export interface NMeasure {
  beats: number;
  unit: number;
  steps: number;
  lanes: Partial<Record<Lane, string>>;
  section?: string;
  /** 화면에 '%'(앞 마디 반복)로 그린다. lanes 에는 실제 내용 */
  simile?: boolean;
  /** 사용자가 고친 마디 — 원본 악보(PDF) 위에 이 마디만 덮어 그린다 */
  edited?: boolean;
  /** 박마다 편집 칸 수 (그 박만 셋잇단 등). 없으면 타격으로 짐작한다 */
  divs?: number[];
}

export interface Notation {
  version: 1;
  tempo?: number;
  source?: string;
  measures: NMeasure[];
}

/** 편집 화면에 보일 순서 (위 = 심벌, 아래 = 발) */
export const LANES: { key: Lane; label: string; short: string }[] = [
  { key: "cr", label: "크래시", short: "CR" },
  { key: "cr2", label: "크래시 2", short: "CR2" },
  { key: "spl", label: "스플래시", short: "SPL" },
  { key: "chn", label: "차이나", short: "CHN" },
  { key: "rd", label: "라이드", short: "RD" },
  { key: "rb", label: "라이드 벨", short: "RB" },
  { key: "hh", label: "하이햇", short: "HH" },
  { key: "t1", label: "하이 탐", short: "T1" },
  { key: "t2", label: "미드 탐", short: "T2" },
  { key: "sn", label: "스네어", short: "SN" },
  { key: "rim", label: "크로스 스틱", short: "RIM" },
  { key: "ft", label: "플로어 탐", short: "FT" },
  { key: "cb", label: "카우벨", short: "CB" },
  { key: "bd", label: "베이스 드럼", short: "BD" },
  { key: "hhp", label: "하이햇 페달", short: "HHP" },
];
export const FEET: Lane[] = ["bd", "hhp"];

/** 한 박(♩) = 48 틱 (16분 12 · 32분 6 · 8분 셋잇단 16 · 16분 셋잇단 8) */
export const TPQ = 48;
export const measureTicks = (m: Pick<NMeasure, "beats" | "unit">) => (m.beats * TPQ * 4) / m.unit;
export const beatTicks = (m: Pick<NMeasure, "unit">) => (TPQ * 4) / m.unit;
export const stepTicks = (m: NMeasure) => measureTicks(m) / m.steps;

/** 칸 수 선택지: 4/4 기준 이름 */
export function stepChoices(m: Pick<NMeasure, "beats" | "unit">): { steps: number; label: string }[] {
  const per = (n: number) => m.beats * n * (4 / m.unit);
  const out = [
    { steps: per(2), label: "8분" },
    { steps: per(3), label: "8분 셋잇단" },
    { steps: per(4), label: "16분" },
    { steps: per(6), label: "16분 셋잇단" },
    { steps: per(8), label: "32분" },
    { steps: per(12), label: "16분+셋잇단" },
  ];
  return out.filter((c) => Number.isInteger(c.steps) && c.steps >= 1 && measureTicks(m) % c.steps === 0);
}

export function emptyMeasure(beats = 4, unit = 4, steps = 16): NMeasure {
  return { beats, unit, steps, lanes: {} };
}

/** 칸 수를 바꾼다: 타격은 가장 가까운 새 칸으로 (겹치면 앞의 것) */
export function resample(m: NMeasure, steps: number): NMeasure {
  const tot = measureTicks(m);
  const oldStep = tot / m.steps;
  const newStep = tot / steps;
  const lanes: NMeasure["lanes"] = {};
  for (const [k, v] of Object.entries(m.lanes) as [Lane, string][]) {
    const arr = Array(steps).fill("-");
    [...v].forEach((c, i) => {
      if (c === "-") return;
      const j = Math.min(steps - 1, Math.round((i * oldStep) / newStep));
      if (arr[j] === "-") arr[j] = c;
    });
    lanes[k] = arr.join("");
  }
  return { ...m, steps, lanes, divs: undefined };
}

/** 박자를 바꾼다: 칸 간격(16분 등)은 그대로 두고 길이만 맞춘다 */
export function changeMeter(m: NMeasure, beats: number, unit: number): NMeasure {
  const st = stepTicks(m);
  const tot = (beats * TPQ * 4) / unit;
  const steps = Number.isInteger(tot / st) ? tot / st : Math.round(tot / 12);
  const lanes: NMeasure["lanes"] = {};
  for (const [k, v] of Object.entries(m.lanes) as [Lane, string][]) {
    lanes[k] = v.slice(0, steps).padEnd(steps, "-");
  }
  return { ...m, beats, unit, steps, lanes, divs: undefined };
}

export function cell(m: NMeasure, lane: Lane, i: number): string {
  return m.lanes[lane]?.[i] ?? "-";
}

export function setCell(m: NMeasure, lane: Lane, i: number, c: string): NMeasure {
  const v = (m.lanes[lane] ?? "-".repeat(m.steps)).split("");
  v[i] = c;
  const s = v.join("");
  const lanes = { ...m.lanes };
  if (/^-+$/.test(s)) delete lanes[lane];
  else lanes[lane] = s;
  return { ...m, lanes, simile: false };
}

// ---- 박마다 나누기 (편집 칸): 한 박을 2·3·4·6·8 칸으로 따로 고른다 (그 박만 셋잇단 등)
/** 고를 수 있는 박 나누기 (누를 때 이 차례로) */
export const BEAT_DIVS = [4, 3, 6, 8, 2] as const;
export const BEAT_DIV_LABEL: Record<number, string> = { 1: "4분", 2: "8분", 3: "셋잇단", 4: "16분", 6: "16분셋", 8: "32분", 12: "16+셋", 24: "세밀" };

/** 한 박을 가장 잘게 나눌 칸 수 — 2·3·4·6·8 을 다 담는다 (분모 8 이상은 12: 서버 한도 192칸 안에) */
const finePer = (m: Pick<NMeasure, "unit">) => (m.unit >= 8 ? 12 : 24);

/** 가장 잘게 (박마다 다르게 나눠도 담기게) */
export function toFine(m: NMeasure): NMeasure {
  const steps = m.beats * finePer(m);
  return m.steps === steps ? m : { ...resample(m, steps), divs: m.divs };
}

/** 박 b 의 타격 틱들 (박 안에서 0 부터) */
function beatHits(m: NMeasure, b: number): number[] {
  const st = stepTicks(m);
  const B = beatTicks(m);
  const out: number[] = [];
  for (const v of Object.values(m.lanes)) {
    [...(v ?? "")].forEach((c, i) => {
      const t = Math.round(i * st) - b * B;
      if (c !== "-" && t >= 0 && t < B) out.push(t);
    });
  }
  return out;
}

/** 박 b 를 몇 칸으로 보나: 타격이 다 들어맞는 가장 작은 나누기 (없으면 마디 기본 칸) */
export function beatDiv(m: NMeasure, b: number): number {
  const B = beatTicks(m);
  const set = m.divs?.[b];
  if (set && B % set === 0) return set;
  const hits = beatHits(m, b);
  // 마디 기본 칸(16분 등). 아주 잘게 나뉜 마디(편집 뒤)는 16분으로 본다
  let base = Math.max(1, Math.round(m.steps / m.beats));
  if (base > 8 || B % base !== 0) base = B % 4 === 0 ? 4 : 2;
  const fits = (d: number) => B % d === 0 && hits.every((t) => t % (B / d) === 0);
  if (fits(base)) return base;
  for (const d of [2, 4, 3, 6, 8, 12, 24]) if (fits(d)) return d;
  return base;
}

/** 박 b 를 d 칸으로: 타격은 가장 가까운 새 칸으로 (겹치면 앞의 것) */
export function setBeatDiv(m: NMeasure, b: number, d: number): NMeasure {
  const f = toFine(m);
  const per = f.steps / f.beats;
  const lanes: NMeasure["lanes"] = {};
  for (const [k, v] of Object.entries(f.lanes) as [Lane, string][]) {
    const arr = [...v];
    const seg = arr.slice(b * per, (b + 1) * per);
    const next = Array(per).fill("-");
    seg.forEach((c, i) => {
      if (c === "-") return;
      const j = Math.min(d - 1, Math.round((i * d) / per)) * (per / d);
      if (next[j] === "-") next[j] = c;
    });
    arr.splice(b * per, per, ...next);
    lanes[k] = arr.join("");
  }
  const divs = Array.from({ length: f.beats }, (_, i) => (i === b ? d : beatDiv(m, i)));
  return compact({ ...f, lanes, simile: false, divs });
}

/** 칸 수를 타격이 담기는 가장 작은 값으로 줄인다 (저장 크기·보기 위해) — 박마다 기본 칸 수는 남긴다 */
export function compact(m: NMeasure, minPer = 4): NMeasure {
  const tot = measureTicks(m);
  const st = stepTicks(m);
  const ticks: number[] = [];
  for (const v of Object.values(m.lanes)) [...(v ?? "")].forEach((c, i) => c !== "-" && ticks.push(Math.round(i * st)));
  const cands = [1, 2, 3, 4, 6, 8, 12, 24].map((d) => m.beats * d).filter((s) => s >= m.beats * Math.min(minPer, finePer(m)));
  for (const s of cands) {
    if (tot % s === 0 && ticks.every((t) => t % (tot / s) === 0)) return s === m.steps ? m : { ...resample(m, s), divs: m.divs };
  }
  return m;
}

/** 칸을 누를 때 기호 순환 */
export function nextSymbol(lane: Lane, c: string): string {
  const order = lane === "hh" ? ["-", "x", "o", ">", "g"] : ["-", "x", ">", "g", "f", "1", "2"];
  const i = order.indexOf(c);
  return order[(i + 1) % order.length];
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 두 마디 내용이 같은가 (simile 판단) */
export function sameContent(a: NMeasure, b: NMeasure): boolean {
  if (a.beats !== b.beats || a.unit !== b.unit) return false;
  const n = (a.steps * b.steps) / gcd(a.steps, b.steps);
  const key = (m: NMeasure) => {
    const r = resample(m, n);
    return JSON.stringify(Object.keys(r.lanes).sort().map((k) => [k, r.lanes[k as Lane]]));
  };
  return key(a) === key(b);
}

/**
 * 쪽 나누기: 쪽마다 줄들 [첫 마디, 끝 마디]. 원래 악보 PDF 가 있으면 그 쪽·줄 나눔을 그대로 따른다
 * (같은 마디가 같은 줄·같은 쪽에 — 종이 악보와 나란히 봐도 헷갈리지 않게). 없으면 한 줄 perLine 마디, 한 쪽 linesPerPage 줄.
 */
export function pageLayout(
  measures: Pick<NMeasure, "simile">[],
  score?: { measures: { page: number; system: number }[]; order?: number[] | null } | null,
  perLine = 4,
  linesPerPage = 10,
): [number, number][][] {
  const n = measures.length;
  const pages: [number, number][][] = [];
  if (score && !score.order && score.measures.length === n && n > 0) {
    let key = "";
    let page = -1;
    score.measures.forEach((m, i) => {
      const k = `${m.page}:${m.system}`;
      if (m.page !== page) {
        pages.push([]);
        page = m.page;
      }
      const cur = pages[pages.length - 1];
      if (k !== key) cur.push([i + 1, i + 1]);
      else cur[cur.length - 1][1] = i + 1;
      key = k;
    });
    return pages;
  }
  for (const line of lineBreaks(measures, n, perLine)) {
    if (!pages.length || pages[pages.length - 1].length >= linesPerPage) pages.push([]);
    pages[pages.length - 1].push(line);
  }
  return pages;
}

/**
 * 줄 나누기: 한 줄 perLine 마디. 줄이 찼는데 바로 뒤가 '%'(앞 마디 반복)면 그 묶음이 끝날 때까지 같은 줄에
 * 붙이고(4마디를 넘어도), 묶음이 끝나면 줄을 바꾼다 — 원래 악보처럼 (% 는 좁게 그려지고 반복이 한 줄에 모인다).
 * 한 줄 최대 maxPerLine.
 */
export function lineBreaks(
  measures: Pick<NMeasure, "simile">[] | null | undefined,
  n: number,
  perLine: number,
  maxPerLine = 8,
  from = 1,
): [number, number][] {
  const out: [number, number][] = [];
  let a = from;
  while (a <= n) {
    let b = a;
    // perLine 마디가 차면 줄을 바꾸되, 바로 뒤가 '%' 면 그 묶음이 끝날 때까지 같은 줄에
    while (b + 1 <= n && b - a + 1 < maxPerLine) {
      const sim = !!measures?.[b]?.simile;
      if (!sim && b - a + 1 >= perLine) break;
      b += 1;
    }
    out.push([a, b]);
    a = b + 1;
  }
  return out;
}
