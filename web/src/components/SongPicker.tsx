import { useMemo, useState } from "react";
import { scoreRel } from "../lib/instrument";
import { clock } from "../lib/time";
import type { Job } from "../types";

const nameOf = (j: Job) => j.folder ?? j.title_override ?? j.title ?? j.url;

/** 보관함처럼 곡을 고르는 목록 (재생 창·송 맵). 제목으로 찾을 수 있다. */
export function SongPicker({
  jobs,
  title,
  onPick,
}: {
  jobs: Job[];
  title: string;
  onPick: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const done = useMemo(() => jobs.filter((j) => j.status === "done"), [jobs]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? done.filter((j) => nameOf(j).toLowerCase().includes(q)) : done;
  }, [done, filter]);

  return (
    <div>
      <div className="actions">
        <h2 style={{ margin: 0 }}>
          {title} <span className="meta">{done.length}곡</span>
        </h2>
        <input style={{ flex: 1, minWidth: 160 }} placeholder="제목으로 찾기…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {shown.length === 0 && <div className="empty">{done.length ? "검색 결과가 없습니다." : "아직 완료된 곡이 없습니다."}</div>}
      {shown.map((j) => (
        <div key={j.id} className="job">
          <div className="summary" onClick={() => onPick(j.id)}>
            <span className="caret" style={{ transform: "none" }}>♪</span>
            <span className="job-title" title={nameOf(j)}>{nameOf(j)}</span>
            <span className="chips">
              {j.files?.some((f) => f.rel === scoreRel("score.pdf")) ? <span className="chip" title="악보 있음">🎼</span> : null}
              {j.bpm ? <span className="chip">♩={j.bpm}</span> : null}
              {j.duration ? <span className="chip">{clock(j.duration)}</span> : null}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 고른 곡 제목 줄 + 곡 목록으로 돌아가는 버튼 */
export function PickedSong({ job, onBack, children }: { job: Job; onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="actions" style={{ marginTop: 0, marginBottom: 10 }}>
      <button className="ghost" onClick={onBack} title="곡 목록으로">
        ← 곡 목록
      </button>
      <h2 style={{ margin: 0, flex: 1, minWidth: 0 }} className="job-title" title={nameOf(job)}>
        {nameOf(job)}
      </h2>
      {children}
    </div>
  );
}
