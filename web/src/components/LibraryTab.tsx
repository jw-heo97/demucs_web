import { useMemo, useState } from "react";
import type { Job } from "../types";
import { JobRow } from "./JobRow";

interface Props {
  jobs: Job[];
  onChanged: () => void;
  /** 곡을 눌렀을 때 — 송 맵으로 간다 */
  onOpen: (id: string) => void;
}

/** 분리가 끝난 곡 목록(홈). 곡을 누르면 송 맵으로 가고, ⋯ 로 파일·삭제를 연다. */
export function LibraryTab({ jobs, onChanged, onOpen }: Props) {
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const done = useMemo(() => jobs.filter((j) => j.status === "done"), [jobs]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? done.filter((j) => (j.folder ?? j.title ?? j.url).toLowerCase().includes(q))
      : done;
  }, [done, filter]);

  return (
    <div>
      <div className="actions">
        <h2 style={{ margin: 0 }}>보관함 <span className="meta">{done.length}곡</span></h2>
        <input style={{ flex: 1, minWidth: 160 }} placeholder="제목으로 찾기…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="ghost" onClick={() => setOpenId(null)}>모두 접기</button>
      </div>

      {shown.length === 0 && (
        <div className="empty">{done.length ? "검색 결과가 없습니다." : "아직 완료된 곡이 없습니다."}</div>
      )}
      {shown.map((j) => (
        <JobRow
          key={j.id}
          job={j}
          open={openId === j.id}
          onToggle={() => setOpenId((v) => (v === j.id ? null : j.id))}
          onChanged={onChanged}
          onOpen={() => onOpen(j.id)}
        />
      ))}
    </div>
  );
}
