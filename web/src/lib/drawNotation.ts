/**
 * 음표 악보 → 오선 (VexFlow). 손(기둥 위)·발(기둥 아래) 두 성부의 타악기 보표.
 *
 * 칸 문자열에는 '언제 치나'만 있고 음표 길이가 없다. 길이는 여기서 정한다:
 * 한 박 안에서 다음 타격까지(박을 넘지 않게), 남는 곳은 쉼표. 그 박에 셋잇단 자리(8분·16분 셋잇단)가
 * 있으면 그 박 전체를 셋잇단으로 묶는다. 드럼 악보의 관례(박마다 빔으로 묶기)와 같다.
 */
import {
  Annotation,
  Articulation,
  BarlineType,
  Beam,
  Dot,
  Formatter,
  Fraction,
  GraceNote,
  GraceNoteGroup,
  Parenthesis,
  Renderer,
  Stave,
  StaveNote,
  Stem,
  Tremolo,
  Tuplet,
  Voice,
} from "vexflow/bravura";
import { FEET, lineBreaks, beatTicks, measureTicks, stepTicks, type Lane, type NMeasure, type Notation } from "./notation";

/** 타악기 보표의 자리 (높은음자리표 기준 음 이름 / 머리 모양) */
const KEY: Record<Lane, string> = {
  chn: "c/6/x2",
  spl: "b/5/x2",
  cr2: "b/5/x2",
  cr: "a/5/x2",
  hh: "g/5/x2",
  rd: "f/5/x2",
  rb: "f/5/d2",
  t1: "e/5",
  t2: "d/5",
  sn: "c/5",
  rim: "c/5/x2",
  cb: "e/5/t2",
  ft: "a/4",
  bd: "f/4",
  hhp: "d/4/x2",
};

interface Ev {
  tick: number;
  keys: string[];
  accent: boolean;
  ghost: boolean;
  flam: boolean;
  open: boolean;
  /** 기둥 사선 수 (더블 스트로크 1·2·3) */
  trem: number;
  buzz: boolean;
}

function events(m: NMeasure, feet: boolean): Ev[] {
  const st = stepTicks(m);
  const byTick = new Map<number, Ev>();
  for (const [lane, v] of Object.entries(m.lanes) as [Lane, string][]) {
    if (FEET.includes(lane) !== feet || !v) continue;
    [...v].forEach((c, i) => {
      if (c === "-") return;
      const t = Math.round(i * st);
      const e = byTick.get(t) ?? { tick: t, keys: [], accent: false, ghost: true, flam: false, open: false, trem: 0, buzz: false };
      if (!e.keys.includes(KEY[lane])) e.keys.push(KEY[lane]);
      if (c === ">") e.accent = true;
      if (c !== "g") e.ghost = false;
      if (c === "f") e.flam = true;
      if (c === "o") e.open = true;
      if (c >= "1" && c <= "3") e.trem = Math.max(e.trem, Number(c));
      if (c === "z") e.buzz = true;
      byTick.set(t, e);
    });
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

/** 틱 길이 → VexFlow 길이 (점 포함) */
const STRAIGHT: [number, string, number][] = [
  [192, "w", 0], [144, "h", 1], [96, "h", 0], [72, "q", 1], [48, "q", 0], [36, "8", 1], [24, "8", 0],
  [18, "16", 1], [12, "16", 0], [6, "32", 0], [3, "64", 0],
];
/** 셋잇단 안: 실제 틱 → 겉으로 적는 길이 (3:2) */
const TRIPLET: [number, string][] = [[32, "q"], [16, "8"], [8, "16"], [4, "32"]];

interface Tok {
  dur: string;
  dots: number;
  ev?: Ev;
}

/** 한 성부를 박 단위로 잘라 음표·쉼표로. 셋잇단 박은 tuplet 으로 묶을 수 있게 따로 돌려준다. */
function tokenize(m: NMeasure, evs: Ev[]): { toks: Tok[]; triplets: [number, number][] } {
  const M = measureTicks(m);
  const B = beatTicks(m);
  const toks: Tok[] = [];
  const triplets: [number, number][] = [];
  const restRun: number[] = []; // 연속된 '박 전체 쉼' 개수를 모아 큰 쉼표로
  const flushRests = () => {
    let n = restRun.length;
    restRun.length = 0;
    while (n > 0) {
      const ticks = n * B;
      const pick = STRAIGHT.find(([t]) => t <= ticks && t % B === 0) ?? [B, "q", 0];
      toks.push({ dur: pick[1], dots: pick[2] });
      n -= pick[0] / B;
    }
  };
  for (let b = 0; b < M; b += B) {
    const inBeat = evs.filter((e) => e.tick >= b && e.tick < b + B);
    if (!inBeat.length) {
      restRun.push(b);
      continue;
    }
    flushRests();
    const trip = inBeat.some((e) => (e.tick - b) % 12 !== 0 && (e.tick - b) % 8 === 0);
    const unit = trip ? 8 : 6;
    // 셋잇단이 아닌 박인데 셋잇단 자리에 있는 타격은 가까운 16분/32분으로, 셋잇단 박은 그 반대로
    const snap = (t: number) => b + Math.round((t - b) / unit) * unit;
    const pts = [...new Map(inBeat.map((e) => [snap(e.tick), e])).entries()].sort((x, y) => x[0] - y[0]);
    const first = toks.length;
    let cur = b;
    const fill = (len: number, ev?: Ev) => {
      // len 틱을 음표(첫 조각만 ev) + 쉼표로
      let left = len;
      let e = ev;
      while (left > 0) {
        if (trip) {
          const pick = TRIPLET.find(([t]) => t <= left) ?? TRIPLET[TRIPLET.length - 1];
          toks.push({ dur: pick[1], dots: 0, ev: e });
          left -= pick[0];
        } else {
          const pick = STRAIGHT.find(([t]) => t <= left && t <= B) ?? STRAIGHT[STRAIGHT.length - 1];
          toks.push({ dur: pick[1], dots: pick[2], ev: e });
          left -= pick[0];
        }
        e = undefined;
      }
    };
    for (let i = 0; i < pts.length; i++) {
      const [t, e] = pts[i];
      if (t > cur) fill(t - cur);
      const end = i + 1 < pts.length ? pts[i + 1][0] : b + B;
      fill(end - t, e);
      cur = end;
    }
    if (trip) triplets.push([first, toks.length]);
  }
  flushRests();
  return { toks, triplets };
}

function buildVoice(m: NMeasure, feet: boolean, solo: boolean) {
  const evs = events(m, feet);
  if (!evs.length && !solo) return null;
  const { toks, triplets } = tokenize(m, evs);
  const stem = feet ? Stem.DOWN : Stem.UP;
  const notes = toks.map((t) => {
    const rest = !t.ev;
    const n = new StaveNote({
      keys: rest ? [feet ? "e/4" : solo ? "b/4" : "e/5"] : t.ev!.keys,
      duration: t.dur + (rest ? "r" : ""),
      dots: t.dots,
      clef: "percussion",
      stem_direction: stem,
    });
    if (t.dots) Dot.buildAndAttach([n], { all: true });
    if (t.ev) {
      if (t.ev.accent) n.addModifier(new Articulation("a>").setPosition(feet ? 4 : 3), 0);
      if (t.ev.open) n.addModifier(new Annotation("o").setVerticalJustification(Annotation.VerticalJustify.TOP), 0);
      if (t.ev.ghost) Parenthesis.buildAndAttach([n]);
      if (t.ev.trem) n.addModifier(new Tremolo(t.ev.trem), 0);
      if (t.ev.buzz) n.addModifier(new Annotation("z").setVerticalJustification(feet ? Annotation.VerticalJustify.BOTTOM : Annotation.VerticalJustify.TOP), 0);
      if (t.ev.flam) {
        const g = new GraceNote({ keys: [t.ev.keys[0]], duration: "8", slash: true, stem_direction: stem });
        n.addModifier(new GraceNoteGroup([g], false), 0);
      }
    }
    return n;
  });
  const tuplets = triplets.map(([a, b]) => new Tuplet(notes.slice(a, b), { num_notes: 3, notes_occupied: 2, location: feet ? -1 : 1 }));
  const voice = new Voice({ num_beats: m.beats, beat_value: m.unit }).setMode(Voice.Mode.SOFT).addTickables(notes);
  const beams = Beam.generateBeams(notes, {
    groups: [m.unit === 8 && m.beats % 3 === 0 ? new Fraction(3, 8) : new Fraction(1, m.unit)],
    stem_direction: stem,
    beam_rests: false,
    maintain_stem_directions: true,
  });
  return { voice, beams, tuplets, weight: notes.length };
}

export interface MeasureBox {
  /** 음원 마디 번호 (1부터) */
  bar: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawResult {
  width: number;
  height: number;
  boxes: MeasureBox[];
  /** 줄마다 [첫 마디, 끝 마디] */
  lines: [number, number][];
}

/**
 * el 안에 SVG 로 그린다 (논리 폭 width — 화면에서는 viewBox 로 늘어난다).
 * perLine: 한 줄에 몇 마디.
 */
export function drawNotation(
  el: HTMLElement,
  nt: Notation,
  opts: {
    width: number;
    perLine: number;
    from?: number;
    to?: number;
    /** 줄마다 [첫 마디, 끝 마디] — 주면 perLine·from·to 대신 이대로 (원래 PDF 의 줄 나눔) */
    lines?: [number, number][];
    /** 쪽 높이 — 주면 이 높이에 줄을 고르게 놓는다 (A4 쪽) */
    height?: number;
  },
): DrawResult {
  el.innerHTML = "";
  const { width, perLine } = opts;
  const from = opts.lines?.[0]?.[0] ?? opts.from ?? 1;
  const to = Math.min(nt.measures.length, opts.lines?.[opts.lines.length - 1]?.[1] ?? opts.to ?? nt.measures.length);
  const plan: [number, number][] = opts.lines ?? [];
  if (!opts.lines) plan.push(...lineBreaks(nt.measures, to, perLine, perLine <= 2 ? 5 : 8, from));
  const lineCount = Math.max(1, plan.length);
  const TOP = 46;
  // 쪽 높이가 정해져 있으면 줄 사이를 그에 맞춘다 (너무 촘촘하면 음표가 겹치니 최소 112)
  const LINE_H = opts.height ? Math.max(112, Math.min(170, (opts.height - TOP - 30) / lineCount)) : 150;
  const left = 10;
  const usable = width - 2 * left;
  const height = Math.max(opts.height ?? 0, TOP + lineCount * LINE_H);

  const renderer = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  const svg = el.querySelector("svg");
  if (svg) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "auto";
  }

  const boxes: MeasureBox[] = [];
  const lines: [number, number][] = [];
  let prev: NMeasure | null = from > 1 ? nt.measures[from - 2] : null;
  for (let li = 0; li < plan.length; li++) {
    const [a, b] = plan[li];
    lines.push([a, b]);
    const y = TOP + li * LINE_H;
    // 마디 폭: 음표 수에 비례하되 최소 폭을 둔다. 줄 첫 마디는 음자리표 자리만큼 더.
    const built: { n: number; m: NMeasure; hands: ReturnType<typeof buildVoice>; feet: ReturnType<typeof buildVoice> }[] = [];
    for (let n = a; n <= b; n++) {
      const m = nt.measures[n - 1];
      const hands = m.simile ? null : buildVoice(m, false, !events(m, true).length);
      const feet = m.simile ? null : buildVoice(m, true, false);
      built.push({ n, m, hands, feet });
    }
    // '%' 마디는 좁게 (원래 악보처럼 — 반복이 한 줄에 여럿 들어간다)
    const weights = built.map((x) => (x.m.simile ? 4 : Math.max(6, (x.hands?.weight ?? 0) + (x.feet?.weight ?? 0) * 0.6)));
    // 줄 첫 마디는 음자리표, 박자가 바뀌는 마디는 박자표 자리만큼 넓게
    const extra = built.map((x, i) => {
      const before = i === 0 ? prev : built[i - 1].m;
      const meter = !before || before.beats !== x.m.beats || before.unit !== x.m.unit;
      return (i === 0 ? 40 : 0) + (meter ? 28 : 0);
    });
    const sumW = weights.reduce((s, w) => s + w, 0);
    const room = usable - extra.reduce((s, w) => s + w, 0);
    let x = left;
    built.forEach((it, i) => {
      const w = extra[i] + (room * weights[i]) / sumW;
      const stave = new Stave(x, y, w);
      const meterChanged = !prev || prev.beats !== it.m.beats || prev.unit !== it.m.unit;
      if (i === 0) stave.addClef("percussion");
      if (meterChanged) stave.addTimeSignature(`${it.m.beats}/${it.m.unit}`);
      if (i === 0) stave.setMeasure(it.n);
      if (it.m.section) stave.setSection(it.m.section, 0);
      if (it.n === nt.measures.length) stave.setEndBarType(3); // 끝세로줄
      stave.setContext(ctx).draw();
      const voices = [it.hands, it.feet].filter(Boolean) as NonNullable<typeof it.hands>[];
      if (voices.length) {
        const fmtW = stave.getNoteEndX() - stave.getNoteStartX() - 10;
        new Formatter().joinVoices(voices.map((v) => v.voice)).format(voices.map((v) => v.voice), Math.max(20, fmtW));
        voices.forEach((v) => v.voice.draw(ctx, stave));
        voices.forEach((v) => v.beams.forEach((bm) => bm.setContext(ctx).draw()));
        voices.forEach((v) => v.tuplets.forEach((tp) => tp.setContext(ctx).draw()));
      } else if (it.m.simile) {
        // '%' 한 마디 반복
        const cx = (stave.getNoteStartX() + stave.getNoteEndX()) / 2;
        const top = stave.getYForLine(0);
        ctx.save();
        ctx.setFont("Arial", 30, "bold");
        ctx.fillText("%", cx - 12, top + 31);
        ctx.restore();
      }
      boxes.push({ bar: it.n, x, y: stave.getYForLine(0) - 22, w, h: stave.getYForLine(4) - stave.getYForLine(0) + 44 });
      x += w;
      prev = it.m;
    });
  }
  return { width, height, boxes, lines };
}

/**
 * 마디 하나를 원본 악보(PDF) 위에 덮어 그릴 조각으로. 음자리표·마디선 없이 오선과 음표만.
 * aspect: 덮을 칸의 가로/세로. 칸은 오선 위로 0.6, 아래로 0.7 (오선 높이 기준) 더 크다.
 */
export function drawMeasurePatch(el: HTMLElement, m: NMeasure, aspect: number): void {
  el.innerHTML = "";
  const SP = 10; // 줄 간격 (VexFlow 기본)
  const staffH = 4 * SP;
  const H = staffH * 2.3;
  const W = Math.max(60, H * aspect);
  const renderer = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(W, H);
  const ctx = renderer.getContext();
  const svg = el.querySelector("svg");
  if (svg) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "100%";
  }
  // 맨 윗줄이 칸 위에서 0.6 오선 높이에 오게 (Stave 는 y 아래 4칸 뒤에 첫 줄을 긋는다)
  const stave = new Stave(0, staffH * 0.6 - 4 * SP, W, { left_bar: false, right_bar: false });
  stave.setBegBarType(BarlineType.NONE).setEndBarType(BarlineType.NONE);
  stave.setContext(ctx).draw();
  if (m.simile) {
    ctx.save();
    ctx.setFont("Arial", 30, "bold");
    ctx.fillText("%", W / 2 - 12, stave.getYForLine(0) + 31);
    ctx.restore();
    return;
  }
  const hands = buildVoice(m, false, !events(m, true).length);
  const feet = buildVoice(m, true, false);
  const voices = [hands, feet].filter(Boolean) as NonNullable<typeof hands>[];
  if (!voices.length) return;
  const fmtW = stave.getNoteEndX() - stave.getNoteStartX() - 10;
  new Formatter().joinVoices(voices.map((v) => v.voice)).format(voices.map((v) => v.voice), Math.max(20, fmtW));
  voices.forEach((v) => v.voice.draw(ctx, stave));
  voices.forEach((v) => v.beams.forEach((bm) => bm.setContext(ctx).draw()));
  voices.forEach((v) => v.tuplets.forEach((tp) => tp.setContext(ctx).draw()));
}
