import { useCallback, useEffect, useMemo, useState } from "react";
import { ask, confirmBox } from "../lib/dialog";
import { api } from "../api";
import { useMe } from "../lib/me";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { barAtTime, barsFromMap } from "../lib/songmap";
import { clock } from "../lib/time";
import type { Job, Playlist, ScoreData } from "../types";
import { Mixer } from "./Mixer";
import { ScorePages } from "./ScoreView";

interface Props {
  jobs: Job[];
  onChanged: () => void;
}

const LS_SELECTED = "playlist.selected";
const LS_AUTONEXT = "playlist.autoNext";
const LS_SHOWSCORE = "playlist.showScore";

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 사생활 보호 모드 등 — 기억만 못 할 뿐 동작에는 지장 없다 */
  }
}

const nameOf = (j: Job) => j.folder ?? j.title_override ?? j.title ?? j.url;

/**
 * 보관함 곡을 순서대로 묶어 연달아 연습한다.
 * 곡마다 따로 저장하는 설정은 없고, 각 곡의 현재 송 맵(활성 버전)을 그대로 쓴다.
 */
export function PlaylistTab({ jobs, onChanged }: Props) {
  const { canEdit } = useMe();
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [selId, setSelId] = useState<string | null>(() => lsGet(LS_SELECTED));
  const [cur, setCur] = useState(0);
  const [autoNext, setAutoNext] = useState(() => lsGet(LS_AUTONEXT) !== "0");
  const [countIn, setCountIn] = useState(4);
  // 늘어날 때마다 믹서가 새 곡을 재생 버튼 누른 것처럼 시작한다
  const [autoToken, setAutoToken] = useState(0);
  const [hint, setHint] = useState("");
  const [addId, setAddId] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await api.playlists();
      setLists(d.playlists);
    } catch (e) {
      setHint((e as Error).message);
      setLists((v) => v ?? []);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const byId = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const done = useMemo(() => jobs.filter((j) => j.status === "done"), [jobs]);

  const sel = lists?.find((p) => p.id === selId) ?? lists?.[0] ?? null;
  const items = sel?.items ?? [];
  const playable = (i: number) => byId.get(items[i])?.status === "done";
  const curJob = playable(cur) ? byId.get(items[cur])! : null;

  // 선택한 플레이리스트가 지워졌거나 처음 열었을 때 첫 번째로 맞춘다
  useEffect(() => {
    if (sel && sel.id !== selId) setSelId(sel.id);
  }, [sel, selId]);
  useEffect(() => {
    if (selId) lsSet(LS_SELECTED, selId);
  }, [selId]);
  useEffect(() => {
    if (cur >= items.length && items.length) setCur(items.length - 1);
  }, [cur, items.length]);

  const nextPlayable = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (playable(i)) return i;
    return -1;
  };

  const engine = useAudioEngine(curJob, {
    carryMix: true,
    onEnded: () => {
      if (!autoNext) return;
      const n = nextPlayable(cur, 1);
      if (n < 0) return; // 마지막 곡
      setCur(n);
      setAutoToken((t) => t + 1);
    },
  });
  // 연결된 악보 (곡이 바뀌면 다시 받는다)
  const [score, setScore] = useState<ScoreData | null>(null);
  const [showScore, setShowScore] = useState(() => lsGet(LS_SHOWSCORE) !== "0");
  const scoreJob = curJob?.files.some((f) => f.rel === "score.pdf") ? curJob.id : null;
  useEffect(() => {
    let alive = true;
    setScore(null);
    if (scoreJob) api.score(scoreJob).then((s) => alive && setScore(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [scoreJob]);

  const bars = useMemo(
    () => (curJob ? barsFromMap((curJob.songmap as never) ?? null, curJob.duration) : []),
    [curJob],
  );

  /** 서버에 곡 목록을 저장한다. 화면은 먼저 바꾸고, 실패하면 서버 상태로 되돌린다. */
  async function saveItems(next: string[], nextCur = cur) {
    if (!sel) return;
    setLists((ls) => ls?.map((p) => (p.id === sel.id ? { ...p, items: next } : p)) ?? ls);
    setCur(nextCur);
    try {
      setHint("");
      await api.updatePlaylist(sel.id, { items: next });
    } catch (e) {
      setHint((e as Error).message);
      void reload();
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    // 지금 곡이 자리를 옮겨도 같은 곡을 가리키게 한다
    void saveItems(next, cur === i ? j : cur === j ? i : cur);
  }

  function remove(i: number) {
    const next = items.filter((_, k) => k !== i);
    void saveItems(next, i < cur ? cur - 1 : Math.min(cur, Math.max(0, next.length - 1)));
  }

  function add() {
    if (!addId) return;
    void saveItems([...items, addId]);
    setAddId("");
  }

  async function create() {
    const name = await ask({ title: "새 플레이리스트", value: `플레이리스트 ${(lists?.length ?? 0) + 1}`, okText: "만들기" });
    if (!name?.trim()) return;
    try {
      const p = await api.createPlaylist(name.trim());
      setLists((ls) => [...(ls ?? []), p]);
      setSelId(p.id);
      setCur(0);
    } catch (e) {
      setHint((e as Error).message);
    }
  }

  async function rename() {
    if (!sel) return;
    const name = await ask({ title: "플레이리스트 이름", value: sel.name, okText: "바꾸기" });
    if (!name?.trim() || name.trim() === sel.name) return;
    try {
      const p = await api.updatePlaylist(sel.id, { name: name.trim() });
      setLists((ls) => ls?.map((x) => (x.id === p.id ? p : x)) ?? ls);
    } catch (e) {
      setHint((e as Error).message);
    }
  }

  async function removeList() {
    if (
      !sel ||
      !(await confirmBox({ title: `'${sel.name}' 삭제`, message: "플레이리스트만 지웁니다. 곡 파일은 그대로 남습니다.", okText: "삭제", danger: true }))
    )
      return;
    try {
      await api.deletePlaylist(sel.id);
      setLists((ls) => ls?.filter((x) => x.id !== sel.id) ?? ls);
      setSelId(null);
      setCur(0);
    } catch (e) {
      setHint((e as Error).message);
    }
  }

  function jump(i: number, play: boolean) {
    if (!playable(i)) return;
    setCur(i);
    if (play) setAutoToken((t) => t + 1);
  }

  if (lists === null) return <div className="empty">불러오는 중…</div>;

  return (
    <div>
      <div className="vertabs">
        {lists.map((p) => (
          <button
            key={p.id}
            className="vertab"
            aria-selected={p.id === sel?.id}
            onClick={() => {
              setSelId(p.id);
              setCur(0);
            }}
          >
            {p.name} <span className="meta">{p.items.length}</span>
          </button>
        ))}
        {canEdit && <button className="ghost" onClick={create}>+ 새 플레이리스트</button>}
      </div>

      {hint && <div className="err" style={{ marginBottom: 10 }}>{hint}</div>}

      {!sel ? (
        <div className="empty">플레이리스트가 없습니다. "+ 새 플레이리스트"로 만들어 보세요.</div>
      ) : (
        <>
          <div className="panel">
            <div className="actions" style={{ marginTop: 0 }}>
              <h2 style={{ margin: 0, flex: 1, minWidth: 0 }} className="job-title">
                {curJob ? nameOf(curJob) : sel.name}
              </h2>
              <button className="ghost" onClick={() => jump(nextPlayable(cur, -1), engine.playing)} disabled={nextPlayable(cur, -1) < 0}>
                ⏮ 이전
              </button>
              <button className="ghost" onClick={() => jump(nextPlayable(cur, 1), engine.playing)} disabled={nextPlayable(cur, 1) < 0}>
                다음 ⏭
              </button>
              <label className="check" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={autoNext}
                  onChange={(e) => {
                    setAutoNext(e.target.checked);
                    lsSet(LS_AUTONEXT, e.target.checked ? "1" : "0");
                  }}
                />
                자동 다음 곡
              </label>
              {score && (
                <label className="check" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={showScore}
                    onChange={(e) => {
                      setShowScore(e.target.checked);
                      lsSet(LS_SHOWSCORE, e.target.checked ? "1" : "0");
                    }}
                  />
                  악보
                </label>
              )}
            </div>
            {curJob ? (
              <Mixer
                engine={engine}
                bars={bars}
                jobId={curJob.id}
              showRate
                onChanged={onChanged}
                countIn={countIn}
                onCountInChange={setCountIn}
                autoStart={autoToken}
              />
            ) : (
              <div className="empty">{items.length ? "재생할 수 있는 곡이 없습니다." : "아래에서 보관함 곡을 추가하세요."}</div>
            )}
            {curJob && score && showScore && score.measures.length > 0 && (
              <ScorePages
                score={score}
                bar={barAtTime(bars, engine.time)?.bar ?? 1}
                onPickBar={(b) => {
                  const t = bars.find((x) => x.bar === b)?.start;
                  if (t != null) engine.seek(t);
                }}
              />
            )}
          </div>

          <div className="actions">
            <h2 style={{ margin: 0 }}>
              {sel.name} <span className="meta">{items.length}곡</span>
            </h2>
            <span style={{ flex: 1 }} />
            {canEdit && <button className="ghost" onClick={rename}>이름 변경</button>}
            {canEdit && <button className="ghost" onClick={removeList}>플레이리스트 삭제</button>}
          </div>

          <div style={{ marginTop: 10 }}>
            {items.map((id, i) => {
              const j = byId.get(id);
              const ok = j?.status === "done";
              return (
                <div key={`${i}:${id}`} className={`job plrow${i === cur && ok ? " open" : ""}`}>
                  <div className="summary" onClick={() => ok && jump(i, false)} onDoubleClick={() => ok && jump(i, true)}>
                    <span className="plnum">{i === cur && engine.playing ? "▶" : i + 1}</span>
                    <span className="job-title" title={j ? nameOf(j) : id}>
                      {j ? nameOf(j) : "보관함에 없는 곡"}
                    </span>
                    <span className="chips">
                      {j?.bpm ? <span className="chip">♩={j.bpm}</span> : null}
                      {j?.duration ? <span className="chip">{clock(j.duration)}</span> : null}
                    </span>
                    <span className="rowbtns" onClick={(e) => e.stopPropagation()}>
                      {/* 터치에선 두 번 탭이 어색하다 — 바로 재생하는 버튼을 따로 둔다 */}
                      <button
                        className={`ghost${i === cur && engine.playing ? " on" : ""}`}
                        onClick={() => jump(i, true)}
                        disabled={!ok}
                        title="이 곡 재생 (예비박부터)"
                      >
                        ▶
                      </button>
                      {canEdit && (
                        <>
                          <button className="ghost" onClick={() => move(i, -1)} disabled={i === 0} title="위로">▲</button>
                          <button className="ghost" onClick={() => move(i, 1)} disabled={i === items.length - 1} title="아래로">▼</button>
                          <button className="ghost" onClick={() => remove(i)} title="플레이리스트에서 빼기">✕</button>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {canEdit && (
          <div className="actions">
            <select value={addId} onChange={(e) => setAddId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
              <option value="">보관함에서 곡 고르기…</option>
              {done.map((j) => (
                <option key={j.id} value={j.id}>
                  {nameOf(j)}
                  {items.includes(j.id) ? " (이미 있음)" : ""}
                </option>
              ))}
            </select>
            <button onClick={add} disabled={!addId}>추가</button>
          </div>
          )}
          <div className="meta" style={{ marginTop: 6 }}>
            곡을 누르면 선택, ▶ 를 누르면(또는 두 번 누르면) 바로 재생합니다. 음소거·볼륨은 곡이 바뀌어도 이어집니다.
          </div>
        </>
      )}
    </div>
  );
}
