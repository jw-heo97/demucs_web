import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { choose, confirmBox } from "../lib/dialog";
import { useMe } from "../lib/me";
import {
  LANES,
  FEET,
  changeMeter,
  emptyMeasure,
  nextSymbol,
  resample,
  sameContent,
  setCell,
  stepChoices,
  type Lane,
  type NMeasure,
  type Notation,
} from "../lib/notation";
import type { Bar, Job, MapRange, SongMap } from "../types";
import { DrawPad } from "./DrawPad";
import { NotationView } from "./NotationView";

const SYM_LABEL: Record<string, string> = {
  x: "침", ">": "악센트", g: "고스트", f: "플램", o: "열린 HH",
  "1": "더블 (사선 1)", "2": "사선 2", "3": "사선 3", z: "버즈", "-": "지우개",
};

/**
 * 송 맵의 악보 편집 (음표 수준). 평소에는 보기만 한다 — 마디를 누르면 그 마디로 이동.
 * '편집' 을 눌러 편집 모드에 들어가면 마디를 누를 때 아래에 그 마디의 칸 편집기가 열린다.
 * 칸을 누르면 고른 기호를 넣고(같은 기호면 지움), 오선 악보가 바로 다시 그려진다.
 * 저장하면 서버에 통째로 (바로 전 것은 이력에).
 */
export function NotationEditor({
  job,
  bars,
  bar,
  map,
  onSeek,
  onPlayFrom,
  onApplyMap,
}: {
  job: Job;
  /** 송 맵 마디 (빈 악보를 만들 때 박자·구간을 가져온다) */
  bars: Bar[];
  /** 지금 재생 마디 */
  bar: number;
  map: SongMap | null;
  onSeek: (bar: number) => void;
  onPlayFrom: (bar: number) => void;
  /** 악보의 박자·구간으로 송 맵을 바꾼다 */
  onApplyMap: (m: SongMap) => void;
}) {
  const { canEdit } = useMe();
  const [nt, setNt] = useState<Notation | null | undefined>(undefined);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  // 손으로 그리기: 그릴 마디 범위 (편집 칸 대신 그리기 판이 뜬다)
  const [draw, setDraw] = useState<{ from: number; to: number } | null>(null);
  const [lines, setLines] = useState<[number, number][]>([]);
  const [msg, setMsg] = useState("");
  const [tool, setTool] = useState("x");
  const [clip, setClip] = useState<NMeasure[] | null>(null);
  const undo = useRef<Notation[]>([]);
  const redo = useRef<Notation[]>([]);
  const has = job.files.some((f) => f.rel === "_notation.json");

  useEffect(() => {
    let alive = true;
    setNt(undefined);
    setSel(null);
    setDirty(false);
    setEditing(false);
    undo.current = [];
    redo.current = [];
    if (!has) {
      setNt(null);
      return;
    }
    api.notation(job.id).then((n) => alive && setNt(n)).catch(() => alive && setNt(null));
    return () => {
      alive = false;
    };
    // 파일이 바뀌면(다른 기기·AI) 다시 받는다 — 저장 안 한 편집이 있으면 덮지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, has]);

  // 늘 바로 앞 상태에서 고친다 — 칸을 빠르게 연달아 누르면 화면이 다시 그려지기 전에 다음 누름이 온다
  const update = (f: (prev: Notation) => Notation) => {
    setNt((prev) => {
      if (!prev) return prev;
      const next = f(prev);
      if (next === prev) return prev;
      // 개발 모드(StrictMode)는 이 함수를 두 번 부른다 — 같은 상태를 두 번 넣지 않게
      if (undo.current[undo.current.length - 1] !== prev) undo.current.push(prev);
      undo.current = undo.current.slice(-100);
      redo.current = [];
      return next;
    });
    setDirty(true);
  };
  const change = (next: Notation) => {
    setNt((prev) => {
      if (prev && undo.current[undo.current.length - 1] !== prev) undo.current.push(prev);
      undo.current = undo.current.slice(-100);
      redo.current = [];
      return next;
    });
    setDirty(true);
  };
  const editMeasure = (n: number, f: (m: NMeasure) => NMeasure) =>
    update((prev) => {
      const ms = prev.measures.slice();
      ms[n - 1] = { ...f(ms[n - 1]), edited: true };
      return { ...prev, measures: ms };
    });

  function createEmpty() {
    const ms: NMeasure[] = (bars.length ? bars : [{ bar: 1, beats_per_bar: 4, beat_unit: 4, name: "" } as Bar]).map((b, i, arr) => {
      const m = emptyMeasure(b.beats_per_bar, b.beat_unit, b.beat_unit === 8 ? b.beats_per_bar * 2 : b.beats_per_bar * 4);
      if (b.name && (i === 0 || arr[i - 1].name !== b.name)) m.section = b.name;
      return m;
    });
    change({ version: 1, tempo: map?.bpm, measures: ms });
    setEditing(true);
    setSel({ from: 1, to: 1 });
  }

  async function save(): Promise<boolean> {
    if (!nt) return false;
    setMsg("저장 중…");
    try {
      const saved = await api.saveNotation(job.id, nt, "편집");
      setNt(saved);
      setDirty(false);
      setMsg("저장했습니다.");
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    }
  }

  // 편집 끝 — 저장 안 한 게 있으면 저장할지 버릴지 묻는다
  async function endEdit() {
    if (dirty) {
      const v = await choose({
        title: "편집 끝내기",
        message: "저장하지 않은 변경이 있습니다.",
        items: [
          { label: "저장하고 끝내기", value: "save" },
          { label: "변경 버리기", sub: "마지막으로 저장한 악보로 되돌립니다", value: "drop" },
        ],
      });
      if (v === "save") {
        if (!(await save())) return;
      } else if (v === "drop") {
        try {
          setNt(has ? await api.notation(job.id) : null);
        } catch {
          setNt(null);
        }
        setDirty(false);
        setMsg("");
      } else return;
    }
    undo.current = [];
    redo.current = [];
    setSel(null);
    setDraw(null);
    setEditing(false);
  }

  // 악보의 박자·구간 → 송 맵 구간 (1마디 1박·BPM 은 그대로)
  function toMap() {
    if (!nt || !map) return;
    const ranges: MapRange[] = [];
    let prev: NMeasure | null = null;
    nt.measures.forEach((m, i) => {
      const meter = !prev || prev.beats !== m.beats || prev.unit !== m.unit;
      if (i === 0 || meter || m.section) {
        ranges.push({
          from_bar: i + 1,
          name: m.section ?? "",
          beats_per_bar: m.beats,
          beat_unit: m.unit,
          bpm: null,
          click_beats: null,
        } as MapRange);
      }
      prev = m;
    });
    onApplyMap({ ...map, ranges });
  }

  const cur = sel ? nt?.measures[sel.from - 1] ?? null : null;
  const [extraLanes, setExtraLanes] = useState<Lane[]>([]);
  const mismatch = useMismatch(nt ?? null, bars);
  const lanesShown = useMemo<Lane[]>(() => {
    if (!cur) return [];
    const used = new Set(Object.keys(cur.lanes) as Lane[]);
    const base: Lane[] = ["cr", "hh", "sn", "t1", "t2", "ft", "bd", "hhp"];
    return LANES.map((l) => l.key).filter((k) => used.has(k) || base.includes(k) || extraLanes.includes(k));
  }, [cur, extraLanes]);

  // 키보드: ← → 마디 이동, Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (!nt || !editing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const p = undo.current.pop();
        if (p) {
          redo.current.push(nt);
          setNt(p);
          setDirty(true);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        const p = redo.current.pop();
        if (p) {
          undo.current.push(nt);
          setNt(p);
          setDirty(true);
        }
      } else if (sel && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const n = Math.max(1, Math.min(nt.measures.length, sel.from + (e.key === "ArrowLeft" ? -1 : 1)));
        setSel({ from: n, to: n });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nt, sel, editing]);

  if (nt === undefined) return null;
  if (nt === null)
    return (
      <div className="panel">
        <div className="actions" style={{ marginTop: 0 }}>
          <h2 style={{ margin: 0 }}>악보 편집</h2>
          <span className="meta">편집 가능한 악보가 없습니다. ✨ AI 악보로 만들거나, 빈 악보에서 직접 적을 수 있습니다.</span>
          <span style={{ flex: 1 }} />
          {canEdit && (
            <button className="ghost" onClick={createEmpty} disabled={!bars.length}>
              빈 악보 만들기 ({bars.length}마디)
            </button>
          )}
        </div>
      </div>
    );

  const n = sel?.from ?? 0;
  // 그리기 범위: 고른 마디들, 또는 그 마디가 있는 줄 전체 (8마디까지)
  const drawRange = (s: { from: number; to: number }, line: boolean) => {
    const ln = line ? lines.find(([a, b]) => s.from >= a && s.from <= b) : undefined;
    const [a, b] = ln ?? [s.from, s.to];
    return { from: a, to: Math.min(b, a + 7, nt.measures.length) };
  };
  const pickBar = (b: number) => {
    setSel({ from: b, to: b });
    onSeek(b);
  };
  const ops = {
    copy: () => sel && setClip(nt.measures.slice(sel.from - 1, sel.to).map((m) => structuredClone(m))),
    paste: () => {
      if (!sel || !clip) return;
      const ms = nt.measures.slice();
      clip.forEach((m, i) => {
        if (sel.from - 1 + i < ms.length) ms[sel.from - 1 + i] = { ...structuredClone(m), section: ms[sel.from - 1 + i].section, edited: true };
      });
      change({ ...nt, measures: ms });
    },
    insert: (after: boolean) => {
      if (!sel) return;
      const at = after ? sel.to : sel.from - 1;
      const ref = nt.measures[Math.min(nt.measures.length - 1, at)] ?? emptyMeasure();
      const ms = nt.measures.slice();
      ms.splice(at, 0, { ...emptyMeasure(ref.beats, ref.unit, ref.steps), edited: true });
      change({ ...nt, measures: ms });
      setSel({ from: at + 1, to: at + 1 });
    },
    remove: async () => {
      if (!sel || nt.measures.length <= sel.to - sel.from + 1) return;
      const cnt = sel.to - sel.from + 1;
      if (!(await confirmBox({ title: "마디 삭제", message: `${sel.from}${cnt > 1 ? `~${sel.to}` : ""}마디를 지웁니다. 뒤 마디 번호가 당겨집니다 — 송 맵과 마디 수가 달라질 수 있습니다.`, okText: "삭제", danger: true })))
        return;
      const ms = nt.measures.slice();
      ms.splice(sel.from - 1, cnt);
      change({ ...nt, measures: ms });
      setSel({ from: Math.min(sel.from, ms.length), to: Math.min(sel.from, ms.length) });
    },
    simile: () => {
      if (!sel || sel.from < 2) return;
      editMeasure(sel.from, (m) => {
        const prev = nt.measures[sel.from - 2];
        return m.simile ? { ...m, simile: false } : { ...structuredClone(prev), simile: true, section: m.section };
      });
    },
  };

  return (
    <div className="panel">
      <div className="actions" style={{ marginTop: 0, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>
          악보 편집 <span className="meta">{nt.measures.length}마디{nt.tempo ? ` · ♩=${nt.tempo}` : ""}</span>
        </h2>
        <span style={{ flex: 1 }} />
        {mismatch && <span className="err" title={mismatch}>⚠ 송 맵과 다름</span>}
        {editing && canEdit && map && (
          <button className="ghost" onClick={toMap} title="악보의 박자·구간 이름으로 송 맵 구간을 다시 만듭니다 (1마디 1박·BPM 은 그대로)">
            송 맵에 박자·구간 반영
          </button>
        )}
        {editing && (
          <button onClick={() => void save()} disabled={!dirty}>
            {dirty ? "저장" : "저장됨"}
          </button>
        )}
        {canEdit &&
          (editing ? (
            <button className="ghost" onClick={() => void endEdit()}>편집 끝</button>
          ) : (
            <button className="ghost" onClick={() => setEditing(true)}>✏ 편집</button>
          ))}
      </div>
      {msg && <div className="meta" style={{ marginBottom: 6 }}>{msg}</div>}

      <NotationView
        notation={nt}
        bar={bar}
        selected={editing ? sel : null}
        onPickBar={editing ? pickBar : onSeek}
        onSelect={editing ? (a, b) => setSel({ from: a, to: b }) : undefined}
        follow={!editing || !sel}
        onLines={setLines}
        popupBar={editing && cur && canEdit ? (draw ? draw.from : sel!.from) : null}
        popup={editing && cur && canEdit && (draw ? (
          <DrawPad
            key={`${draw.from}-${draw.to}`}
            jobId={job.id}
            firstBar={draw.from}
            measures={nt.measures.slice(draw.from - 1, draw.to)}
            onClose={() => setDraw(null)}
            onApply={(ms) => {
              update((prev) => {
                const all = prev.measures.slice();
                ms.forEach((m, i) => {
                  const k = draw.from - 1 + i;
                  if (k < all.length) all[k] = { ...all[k], steps: m.steps, lanes: m.lanes, simile: false, edited: true };
                });
                return { ...prev, measures: all };
              });
              setSel({ from: draw.from, to: draw.to });
              setDraw(null);
            }}
          />
        ) : (
        <div className="nted">
          <div className="actions" style={{ marginTop: 0 }}>
            <button className="ghost" onClick={() => n > 1 && setSel({ from: n - 1, to: n - 1 })} disabled={n <= 1}>◀</button>
            <b>
              {sel!.from}
              {sel!.to > sel!.from ? `~${sel!.to}` : ""}마디
            </b>
            <button className="ghost" onClick={() => n < nt.measures.length && setSel({ from: n + 1, to: n + 1 })} disabled={n >= nt.measures.length}>▶</button>
            <button className="ghost" onClick={() => onPlayFrom(n)} title="이 마디부터 재생 (예비박)">▶ 여기서 재생</button>
            <span style={{ flex: 1 }} />
            <button className="ghost" onClick={() => setDraw(drawRange(sel!, false))} title="펜으로 그려서 AI 가 읽기 (고른 마디들)">
              ✍ 그리기{sel!.to > sel!.from ? ` (${Math.min(8, sel!.to - sel!.from + 1)}마디)` : ""}
            </button>
            <button className="ghost" onClick={() => setDraw(drawRange(sel!, true))} title="이 마디가 있는 줄 전체를 펜으로">
              ✍ 이 줄
            </button>
            <button className="ghost" onClick={() => setSel(null)} aria-label="닫기" title="닫기">✕</button>
            <span className="meta">|</span>
            <label className="inline">
              박자
              <select
                value={`${cur.beats}/${cur.unit}`}
                onChange={(e) => {
                  const [b, u] = e.target.value.split("/").map(Number);
                  editMeasure(n, (m) => changeMeter(m, b, u));
                }}
              >
                {["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8", "1/4"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="inline">
              칸
              <select value={cur.steps} onChange={(e) => editMeasure(n, (m) => resample(m, Number(e.target.value)))}>
                {stepChoices(cur).map((c) => (
                  <option key={c.steps} value={c.steps}>
                    {c.label} ({c.steps})
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              구간
              <input
                style={{ width: 110 }}
                value={cur.section ?? ""}
                placeholder="(이어짐)"
                onChange={(e) => editMeasure(n, (m) => ({ ...m, section: e.target.value || undefined }))}
              />
            </label>
          </div>

          <div className="actions" style={{ marginTop: 4 }}>
            <span className="meta">넣을 기호</span>
            {["x", ">", "g", "f", "o", "1", "2", "3", "z", "-"].map((s) => (
              <button key={s} className={`ghost sym${tool === s ? " on" : ""}`} onClick={() => setTool(s)} title={SYM_LABEL[s]}>
                {s === "-" ? "⌫" : s} <span className="meta">{SYM_LABEL[s]}</span>
              </button>
            ))}
          </div>

          <div className="ntgrid" style={{ ["--steps" as string]: cur.steps }}>
            {lanesShown.map((lane) => (
              <div key={lane} className={`ntrow${FEET.includes(lane) ? " feet" : ""}`}>
                <div className="ntlane" title={LANES.find((l) => l.key === lane)?.label}>
                  {LANES.find((l) => l.key === lane)?.short}
                </div>
                {Array.from({ length: cur.steps }, (_, i) => {
                  const c = cur.lanes[lane]?.[i] ?? "-";
                  const perBeat = cur.steps / cur.beats;
                  return (
                    <button
                      key={i}
                      className={`ntcell${c !== "-" ? " hit" : ""}${i % perBeat === 0 ? " beat" : ""}`}
                      onClick={() =>
                        editMeasure(n, (m) => {
                          const want = tool === "o" && lane !== "hh" ? "x" : tool;
                          const now = m.lanes[lane]?.[i] ?? "-";
                          return setCell(m, lane, i, now === want ? "-" : want);
                        })
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        editMeasure(n, (m) => setCell(m, lane, i, nextSymbol(lane, m.lanes[lane]?.[i] ?? "-")));
                      }}
                    >
                      {c === "-" ? "" : c}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="ntrow">
              <div className="ntlane" />
              <select
                className="ntadd"
                value=""
                onChange={(e) => e.target.value && setExtraLanes((v) => [...v, e.target.value as Lane])}
              >
                <option value="">+ 악기</option>
                {LANES.filter((l) => !lanesShown.includes(l.key)).map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="actions" style={{ marginTop: 6 }}>
            <button className="ghost" onClick={ops.copy}>복사</button>
            <button className="ghost" onClick={ops.paste} disabled={!clip}>붙여넣기{clip ? ` (${clip.length})` : ""}</button>
            <button className="ghost" onClick={ops.simile} disabled={n < 2} title="앞 마디와 같게 (악보에 % 로)">
              {cur.simile ? "% 해제" : "% 앞 마디와 같게"}
            </button>
            <button className="ghost" onClick={() => ops.insert(false)}>앞에 마디 추가</button>
            <button className="ghost" onClick={() => ops.insert(true)}>뒤에 마디 추가</button>
            <button className="ghost" onClick={() => void ops.remove()}>마디 삭제</button>
            <span className="meta">칸을 누르면 고른 기호, 같은 기호면 지움 · 오른쪽 클릭은 기호 차례로 · ←→ 마디 · Ctrl+Z</span>
          </div>
          {n > 1 && !cur.simile && sameContent(cur, nt.measures[n - 2]) && (
            <div className="meta">앞 마디와 같습니다 — % 로 표시할 수 있습니다.</div>
          )}
        </div>
        ))}
      />
      {editing && !cur && <div className="meta" style={{ marginTop: 6 }}>고칠 마디를 누르세요. 여러 마디를 끌어 고르면 복사·삭제를 한꺼번에.</div>}
      {!editing && canEdit && <div className="meta" style={{ marginTop: 6 }}>마디를 누르면 그 마디로 이동합니다. 고치려면 ✏ 편집.</div>}
    </div>
  );
}

function useMismatch(nt: Notation | null, bars: Bar[]): string | null {
  return useMemo(() => {
    if (!nt || !bars.length) return null;
    const bad: number[] = [];
    nt.measures.forEach((m, i) => {
      const b = bars[i];
      if (b && (b.beats_per_bar !== m.beats || b.beat_unit !== m.unit)) bad.push(i + 1);
    });
    if (!bad.length) return null;
    return `박자가 다른 마디: ${bad.slice(0, 12).join(", ")}${bad.length > 12 ? " …" : ""} — '송 맵에 박자·구간 반영' 으로 맞출 수 있습니다`;
  }, [nt, bars]);
}
