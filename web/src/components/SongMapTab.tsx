import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { sectionAt } from "../lib/sectionColors";
import { barsFromMap, emptyRange, nearestBar, stepOf } from "../lib/songmap";
import { stemFilesOf } from "../lib/stems";
import { showTime } from "../lib/time";
import type { Job, MapPayload, MapVersion, SongMap } from "../types";
import { Mixer, type MixerControl } from "./Mixer";
import { TimeInput } from "./TimeInput";
import { Waveform, type LoopRegion, type WaveMode } from "./Waveform";

const STEM_LABEL: Record<string, string> = {
  drums: "드럼",
  bass: "베이스",
  vocals: "보컬",
  other: "기타",
  original: "원본",
  click: "메트로놈",
};

interface Props {
  jobs: Job[];
  onChanged: () => void;
}

export function SongMapTab({ jobs, onChanged }: Props) {
  const done = useMemo(() => jobs.filter((j) => j.status === "done"), [jobs]);
  const [jobId, setJobId] = useState("");
  const job = useMemo(() => done.find((j) => j.id === jobId) ?? null, [done, jobId]);

  const [map, setMap] = useState<SongMap | null>(null);
  const [payload, setPayload] = useState<MapPayload | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  // 파형에 어떤 트랙을 그릴지. 드럼이 타점이 뚜렷해 마디 잡기엔 제일 좋지만,
  // 드럼이 늦게 들어오는 곡은 앞부분이 비어 보여서 원본으로 바꿀 수 있어야 한다.
  const [stem, setStem] = useState("drums");
  const [mode, setMode] = useState<WaveMode>("seek");
  const [loop, setLoopRegion] = useState<LoopRegion | null>(null);
  const [countIn, setCountIn] = useState(4);
  const mixer = useRef<MixerControl | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [addBar, setAddBar] = useState("");
  const [bulk, setBulk] = useState("");

  // 파형에 그릴 수 있는 트랙. 제외 믹스(no_*)와 버전별 메트로놈은 뺀다.
  const stems = useMemo(() => {
    const found = job ? stemFilesOf(job) : new Map<string, unknown>();
    const order = ["drums", "bass", "other", "vocals", "original", "click"];
    return order.filter((k) => found.has(k));
  }, [job]);

  const engine = useAudioEngine(job);
  const duration = payload?.duration || job?.duration || engine.duration || 0;

  // 편집 중인 구성표에서 즉시 마디를 계산한다 (저장 전에도 파형에 반영)
  const bars = useMemo(() => barsFromMap(map, duration), [map, duration]);

  /**
   * fromBar~toBar 구간을 연습할 반복 범위: 2마디 전부터 다음 구간 첫 마디 끝까지
   * (Verse A 13~18 → 11~19마디). 들어가는 흐름과 넘어가는 첫 마디까지 연습하려고.
   */
  const loopFor = (fromBar: number, toBar: number) => {
    if (!bars.length) return null;
    const first = bars[0].bar;
    const last = bars[bars.length - 1].bar;
    const a = Math.max(first, fromBar - 2);
    const b = Math.min(last, toBar + 1);
    const start = bars.find((x) => x.bar === a)?.start;
    const end = bars.find((x) => x.bar === b + 1)?.start ?? duration;
    if (start == null || end - start < 0.3) return null;
    return { start, end, fromBar: a, toBar: b };
  };
  const sameLoop = (x: LoopRegion | null, y: LoopRegion | null) =>
    !!x && !!y && Math.abs(x.start - y.start) < 0.002 && Math.abs(x.end - y.end) < 0.002;

  const load = useCallback(async (id: string) => {
    const d = await api.map(id);
    setPayload(d);
    setMap(
      d.map?.ranges?.length
        ? d.map
        : { anchor: 0, bpm: d.bpm ?? 120, ranges: [emptyRange(1)] },
    );
  }, []);

  useEffect(() => {
    setPayload(null);
    setMap(null);
    setLoopRegion(null);
    if (!jobId) return;
    load(jobId).catch((e) => setMsg(e.message));
  }, [jobId, load]);

  // 곡이 바뀌면 그 곡에 있는 스템으로 맞춘다
  useEffect(() => {
    if (stems.length && !stems.includes(stem)) setStem(stems[0]);
  }, [stems, stem]);

  // 파형 피크 — 서버가 캐시하므로 같은 조합은 즉시 온다
  useEffect(() => {
    setPeaks(null);
    if (!jobId || !stem) return;
    let alive = true;
    api
      .peaks(jobId, stem, 12000)
      .then((d) => alive && setPeaks(d.peaks))
      .catch(() => alive && setPeaks(null));
    return () => {
      alive = false;
    };
  }, [jobId, stem]);

  // engine 객체는 렌더마다 새로 만들어지므로 안정적인 setLoop 만 의존성에 둔다
  const setLoopFn = engine.setLoop;
  useEffect(() => setLoopFn(loop), [loop, setLoopFn]);

  const versions: MapVersion[] = payload?.versions ?? [];
  const active = payload?.active ?? null;

  // ---------------- 파형 조작 ----------------
  /** 클릭한 자리를 그 마디의 첫박으로 고정한다. 녹음물은 박자가 미세하게 움직인다. */
  const tapDownbeat = (t: number) => {
    if (!map) return;
    const near = nearestBar(bars, t);
    const barNo = near ? near.bar : 1;
    setMap(pinBar(map, barNo, t));
    setMsg(`${barNo}마디를 ${showTime(t)} 에 고정했습니다.`);
  };

  const dragBar = (barNo: number, t: number) => {
    if (!map) return;
    setMap(pinBar(map, barNo, t));
  };

  // ---------------- 구성표 편집 ----------------
  const patchRange = (i: number, patch: Partial<SongMap["ranges"][number]>) =>
    setMap((m) => (m ? { ...m, ranges: m.ranges.map((r, k) => (k === i ? { ...r, ...patch } : r)) } : m));

  const removeRange = (i: number) =>
    setMap((m) => (m && m.ranges.length > 1 ? { ...m, ranges: m.ranges.filter((_, k) => k !== i) } : m));

  // 마디 번호를 손으로 고치면 순서가 어긋날 수 있다. 입력 중에는 그대로 두고(17 을 치려면
  // 1 을 먼저 거친다) 입력란을 떠날 때 정렬한다. 같은 마디가 둘이면 표시해 두고 저장을 막는다
  // (서버도 거절하지만, 어느 줄인지 여기서 보여야 고칠 수 있다).
  const sortRanges = () =>
    setMap((m) => (m ? { ...m, ranges: [...m.ranges].sort((a, b) => a.from_bar - b.from_bar) } : m));
  const dupBars = useMemo(() => {
    const seen = new Set<number>();
    const dup = new Set<number>();
    for (const r of map?.ranges ?? []) (seen.has(r.from_bar) ? dup : seen).add(r.from_bar);
    return dup;
  }, [map]);

  const addRow = (n: number) => {
    if (!map || !(n >= 1)) return;
    if (map.ranges.some((r) => r.from_bar === n)) {
      setMsg(`${n}마디는 이미 있습니다.`);
      return;
    }
    const prev = [...map.ranges].reverse().find((r) => r.from_bar <= n) ?? map.ranges[0];
    setMap({ ...map, ranges: [...map.ranges, emptyRange(n, prev)].sort((a, b) => a.from_bar - b.from_bar) });
    setMsg(`${n}마디를 추가했습니다.`);
  };

  const bulkAdd = () => {
    if (!map) return;
    const nums = [...new Set(bulk.split(/[^0-9]+/).filter(Boolean).map(Number))]
      .filter((n) => n >= 1)
      .sort((a, b) => a - b);
    if (!nums.length) {
      setMsg("마디 번호를 입력하세요. 예: 1/17/30/100");
      return;
    }
    let next = [...map.ranges];
    const skipped: number[] = [];
    for (const n of nums) {
      if (next.some((r) => r.from_bar === n)) {
        skipped.push(n);
        continue;
      }
      const prev = [...next].reverse().find((r) => r.from_bar <= n) ?? next[0];
      next.push(emptyRange(n, prev));
    }
    next.sort((a, b) => a.from_bar - b.from_bar);
    setMap({ ...map, ranges: next });
    setBulk("");
    setMsg(
      `${nums.length - skipped.length}개 추가` + (skipped.length ? ` (건너뜀: ${skipped.join(", ")})` : ""),
    );
  };

  const setAllBeats = (kind: "all" | "none" | "down") =>
    setMap((m) =>
      m
        ? {
            ...m,
            ranges: m.ranges.map((r) => ({
              ...r,
              click_beats:
                kind === "all" ? null : kind === "none" ? [] : (r.beats_per_bar || 4) > 1 ? [1] : null,
            })),
          }
        : m,
    );

  // ---------------- 저장 ----------------
  const save = async () => {
    if (!job || !map) return;
    setBusy(true);
    setMsg("저장 중… (다운로드용 클릭 파일도 함께 만듭니다)");
    try {
      const r = await api.saveMap(job.id, map);
      setMsg(`저장 완료 — ♩=${r.bpm} · ${r.bars}마디 · 박자 ${r.beats}개`);
      await load(job.id);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const detect = async () => {
    if (!job) return;
    setBusy(true);
    setMsg("재검출 중…");
    try {
      const r = await api.detectMap(job.id);
      await load(job.id);
      onChanged();
      setMsg(`검출 완료 — ♩=${r.bpm} (${r.octave_note}, 원본 ${r.raw_bpm})`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verAction = async (fn: () => Promise<unknown>, note: string) => {
    if (!job) return;
    setBusy(true);
    try {
      await fn();
      await load(job.id);
      onChanged();
      setMsg(note);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <label htmlFor="mapSong">곡 선택</label>
        <select id="mapSong" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">— 보관함에서 곡을 고르세요 —</option>
          {done.map((j) => (
            <option key={j.id} value={j.id}>
              {j.folder ?? j.title ?? j.id}
            </option>
          ))}
        </select>
        {payload && (
          <div className="meta" style={{ marginTop: 6 }}>
            길이 {showTime(duration)} · {bars.length}마디
            {payload.octave_note ? ` · ${payload.octave_note}` : ""}
            {payload.raw_bpm ? ` (검출 원본 ${payload.raw_bpm})` : ""}
          </div>
        )}
      </div>

      {job && map && (
        <>
          <div className="panel">
            <div className="modebar">
              {(
                [
                  ["seek", "이동"],
                  ["tap", "첫박 찍기"],
                  ["drag", "마디 끌기"],
                  ["loop", "구간 반복"],
                ] as [WaveMode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  className={`ghost${mode === m ? " on" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {label}
                </button>
              ))}
              <span className="meta">|</span>
              <span className="meta">파형</span>
              <select
                style={{ width: 104 }}
                value={stem}
                onChange={(e) => setStem(e.target.value)}
                title="파형에 그릴 트랙"
              >
                {stems.map((k) => (
                  <option key={k} value={k}>
                    {STEM_LABEL[k] ?? k}
                  </option>
                ))}
              </select>
              <span style={{ flex: 1 }} />
              {loop && (
                <button className="ghost" onClick={() => setLoopRegion(null)}>
                  반복 해제 ({showTime(loop.start)}~{showTime(loop.end)})
                </button>
              )}
            </div>

            {/* key 로 곡마다 새로 만든다 — 안 그러면 이전 곡에서 확대한 보기 창이 남아
                짧은 곡으로 바꿨을 때 끝을 지난 빈 구간을 보게 된다 */}
            <Waveform
              key={job.id}
              stemLabel={STEM_LABEL[stem] ?? stem}
              peaks={peaks}
              duration={duration}
              currentTime={engine.time}
              playing={engine.playing}
              bars={bars}
              loop={loop}
              mode={mode}
              onSeek={engine.seek}
              onTapDownbeat={tapDownbeat}
              onDragBar={dragBar}
              onLoopChange={setLoopRegion}
            />

            <Mixer
              engine={engine}
              bars={bars}
              jobId={job.id}
              onChanged={onChanged}
              showRate
              loopButton={{
                on: !!loop,
                region: loop,
                title: loop
                  ? `반복 해제 (${showTime(loop.start)}~${showTime(loop.end)})`
                  : "지금 재생 위치가 속한 구간(같은 이름이 이어지는 마디들)을 반복합니다",
                onToggle: () => {
                  if (loop) return setLoopRegion(null);
                  const s = sectionAt(bars, engine.time, duration);
                  const lp = s && loopFor(s.fromBar, s.toBar);
                  if (!s || !lp) return;
                  setLoopRegion({ start: lp.start, end: lp.end });
                  setMsg(`${s.name || `${s.fromBar}마디`} 반복 — ${lp.fromBar}~${lp.toBar}마디`);
                },
              }}
              control={mixer}
              countIn={countIn}
              onCountInChange={setCountIn}
            />
          </div>

          <div className="panel">
            <div className="vertabs">
              {versions.map((v) => (
                <button
                  key={v.id}
                  className="vertab"
                  aria-selected={v.id === active}
                  onClick={() =>
                    v.id !== active &&
                    verAction(() => api.activateVersion(job.id, v.id), "버전을 전환했습니다.")
                  }
                >
                  {v.name}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <button
                className="ghost"
                onClick={() => {
                  const name = prompt("새 버전 이름 (지금 화면 내용을 복사합니다)", "연습용");
                  if (name != null)
                    verAction(() => api.createVersion(job.id, name, map), `'${name}' 버전 생성`);
                }}
              >
                + 새 버전
              </button>
              {active && (
                <button
                  className="ghost"
                  onClick={() => {
                    const cur = versions.find((v) => v.id === active);
                    const name = prompt("버전 이름", cur?.name ?? "");
                    if (name != null)
                      verAction(() => api.renameVersion(job.id, active, name), "이름 변경");
                  }}
                >
                  이름 변경
                </button>
              )}
              {versions.length > 1 && active && (
                <button
                  className="ghost"
                  onClick={() =>
                    confirm("이 버전과 메트로놈 파일을 삭제합니다.") &&
                    verAction(() => api.deleteVersion(job.id, active), "버전 삭제")
                  }
                >
                  삭제
                </button>
              )}
              {!!payload?.history?.length && (
                <button
                  className="ghost"
                  onClick={() => {
                    const lines = payload.history
                      .map(
                        (h) =>
                          `${h.index}: ♩=${h.bpm} · 마디 ${h.ranges}개${h.names?.length ? ` · ${h.names.join("/")}` : ""}`,
                      )
                      .join("\n");
                    const pick = prompt("되돌릴 이력 번호\n\n" + lines, "0");
                    if (pick != null)
                      verAction(() => api.restoreMap(job.id, parseInt(pick, 10)), "이력에서 되돌림");
                  }}
                >
                  이력 {payload.history.length}
                </button>
              )}
            </div>

            <div className="row" style={{ marginBottom: 12 }}>
              <div>
                <label>1마디 1박 위치</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <TimeInput value={map.anchor} onChange={(v) => setMap({ ...map, anchor: v })} />
                  <button className="ghost" onClick={() => setMap({ ...map, anchor: +engine.time.toFixed(3) })}>
                    현재
                  </button>
                </div>
              </div>
              <div>
                <label>기본 BPM (♩)</label>
                <input
                  type="number"
                  min={20}
                  max={400}
                  step={0.01}
                  value={map.bpm}
                  onChange={(e) => setMap({ ...map, bpm: Number(e.target.value) || map.bpm })}
                />
              </div>
            </div>

            <div className="modebar">
              <span className="meta">일괄 입력</span>
              <input
                style={{ flex: 1, minWidth: 180 }}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder="1/17/30/100/102/103"
                onKeyDown={(e) => e.key === "Enter" && bulkAdd()}
              />
              <button className="ghost" onClick={bulkAdd}>
                한번에 추가
              </button>
              <span style={{ flex: 1 }} />
              <span className="meta">클릭 박</span>
              <button className="ghost" onClick={() => setAllBeats("none")}>전체 끄기</button>
              <button className="ghost" onClick={() => setAllBeats("down")}>첫 박만</button>
              <button className="ghost" onClick={() => setAllBeats("all")}>전체 켜기</button>
            </div>

            <div className="tblwrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 82 }}>마디</th>
                    <th style={{ width: 96 }}>시각</th>
                    <th>이름</th>
                    <th style={{ width: 106 }}>박자</th>
                    <th style={{ width: 86 }}>BPM</th>
                    <th style={{ width: 150 }}>클릭할 박</th>
                    <th style={{ width: 120 }}>적용 범위</th>
                    <th style={{ width: 200 }} />
                  </tr>
                </thead>
                <tbody>
                  {map.ranges.map((r, i) => {
                    const t = bars.find((b) => b.bar === r.from_bar)?.start;
                    const until = map.ranges[i + 1] ? `${map.ranges[i + 1].from_bar - 1}마디까지` : "끝까지";
                    return (
                      <tr key={i} className={dupBars.has(r.from_bar) ? "dup" : undefined}>
                        <td>
                          <input
                            type="number"
                            min={1}
                            value={r.from_bar}
                            disabled={i === 0}
                            title={dupBars.has(r.from_bar) ? "같은 마디가 두 번 지정되었습니다" : undefined}
                            onChange={(e) => patchRange(i, { from_bar: Math.max(1, Number(e.target.value) || 1) })}
                            onBlur={sortRanges}
                          />
                        </td>
                        <td className="meta">
                          {r.anchor != null ? (
                            <span className="pinned">📌 {showTime(r.anchor)}</span>
                          ) : t != null ? (
                            showTime(t)
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <input
                            value={r.name}
                            placeholder="Intro / Verse / Chorus…"
                            onChange={(e) => patchRange(i, { name: e.target.value })}
                          />
                        </td>
                        <td>
                          <div className="sig">
                            <select
                              value={r.beats_per_bar}
                              onChange={(e) => patchRange(i, { beats_per_bar: Number(e.target.value) })}
                            >
                              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16].map((n) => (
                                <option key={n}>{n}</option>
                              ))}
                            </select>
                            <span>/</span>
                            <select
                              value={r.beat_unit}
                              onChange={(e) => patchRange(i, { beat_unit: Number(e.target.value) })}
                            >
                              {[2, 4, 8, 16].map((n) => (
                                <option key={n}>{n}</option>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={20}
                            max={400}
                            step={0.01}
                            value={r.bpm ?? ""}
                            placeholder="기본"
                            onChange={(e) =>
                              patchRange(i, { bpm: e.target.value === "" ? null : Number(e.target.value) })
                            }
                          />
                        </td>
                        <td>
                          <div className="beatsel">
                            {Array.from({ length: r.beats_per_bar || 4 }, (_, k) => {
                              const on = r.click_beats == null || r.click_beats.includes(k + 1);
                              return (
                                <button
                                  key={k}
                                  className={`ghost${on ? " on" : ""}`}
                                  onClick={() => {
                                    const n = r.beats_per_bar || 4;
                                    const cur = new Set(
                                      r.click_beats == null
                                        ? Array.from({ length: n }, (_, x) => x + 1)
                                        : r.click_beats,
                                    );
                                    cur.has(k + 1) ? cur.delete(k + 1) : cur.add(k + 1);
                                    const picked = [...cur].filter((x) => x >= 1 && x <= n).sort((a, b) => a - b);
                                    patchRange(i, { click_beats: picked.length === n ? null : picked });
                                  }}
                                >
                                  {k + 1}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        <td className="meta">
                          {r.from_bar}~{until}
                        </td>
                        <td>
                          <div className="rowbtns">
                            <button
                              className="ghost"
                              onClick={() => {
                                if (t == null) return;
                                setLoopRegion(null);
                                // 듣고 있으면 그 자리로 옮겨 계속, 멈춰 있으면 예비박부터
                                if (engine.playing) engine.seek(t);
                                else mixer.current?.playFrom(t, null);
                              }}
                              title="이 구간 첫 마디부터 재생 (멈춰 있으면 예비박부터)"
                            >
                              ▶
                            </button>
                            {(() => {
                              const toBar = map.ranges[i + 1]
                                ? map.ranges[i + 1].from_bar - 1
                                : bars[bars.length - 1]?.bar ?? r.from_bar;
                              const lp = loopFor(r.from_bar, toBar);
                              const on = sameLoop(loop, lp);
                              return (
                                <button
                                  className={`ghost${on ? " on" : ""}`}
                                  disabled={!lp}
                                  onClick={() => {
                                    if (!lp) return;
                                    if (on) return setLoopRegion(null);
                                    const region = { start: lp.start, end: lp.end };
                                    setLoopRegion(region);
                                    setMsg(`${r.name || `${r.from_bar}마디`} 반복 — ${lp.fromBar}~${lp.toBar}마디`);
                                    mixer.current?.playFrom(region.start, region);
                                  }}
                                  title={
                                    lp
                                      ? `${lp.fromBar}~${lp.toBar}마디 반복 재생 (구간 2마디 전부터 다음 구간 첫 마디까지, 예비박부터)`
                                      : ""
                                  }
                                >
                                  반복
                                </button>
                              );
                            })()}
                            <button
                              className="ghost"
                              onClick={() =>
                                patchRange(i, { anchor: r.anchor != null ? null : +engine.time.toFixed(3) })
                              }
                              title="현재 재생 위치에 고정 / 해제"
                            >
                              {r.anchor != null ? "해제" : "고정"}
                            </button>
                            {i > 0 && (
                              <button className="ghost" onClick={() => removeRange(i)}>
                                삭제
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <span className="meta">마디</span>
              <input
                type="number"
                min={1}
                style={{ width: 84 }}
                value={addBar}
                onChange={(e) => setAddBar(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    addRow(parseInt(addBar, 10));
                    setAddBar("");
                  }
                }}
              />
              <button
                className="ghost"
                onClick={() => {
                  addRow(parseInt(addBar, 10));
                  setAddBar("");
                }}
              >
                추가
              </button>
              <button className="ghost" onClick={detect} disabled={busy}>
                자동 재검출
              </button>
              <span style={{ flex: 1 }} />
              {dupBars.size > 0 && (
                <span className="err">
                  {[...dupBars].sort((a, b) => a - b).join(", ")}마디가 중복됩니다
                </span>
              )}
              <button
                onClick={save}
                disabled={busy || dupBars.size > 0}
                title="메트로놈은 저장하지 않아도 편집한 대로 바로 들립니다. 저장하면 맵이 남고 다운로드용 클릭 파일이 갱신됩니다."
              >
                저장
              </button>
            </div>
            {msg && <div className="meta" style={{ marginTop: 8 }}>{msg}</div>}
          </div>
        </>
      )}
    </div>
  );
}

/** 특정 마디를 절대 시각에 고정한다. 그 마디의 구간이 없으면 만든다. */
function pinBar(map: SongMap, barNo: number, t: number): SongMap {
  const at = +t.toFixed(3);
  if (barNo <= 1) return { ...map, anchor: at, ranges: map.ranges };
  const idx = map.ranges.findIndex((r) => r.from_bar === barNo);
  if (idx >= 0) {
    return { ...map, ranges: map.ranges.map((r, k) => (k === idx ? { ...r, anchor: at } : r)) };
  }
  const prev = [...map.ranges].reverse().find((r) => r.from_bar <= barNo) ?? map.ranges[0];
  const next = { ...emptyRange(barNo, prev), anchor: at };
  return { ...map, ranges: [...map.ranges, next].sort((a, b) => a.from_bar - b.from_bar) };
}

export { stepOf };
