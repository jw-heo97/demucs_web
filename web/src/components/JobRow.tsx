import { useMemo, useState } from "react";
import { api } from "../api";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { barsFromMap } from "../lib/songmap";
import { fmtDate, fmtSize, clock } from "../lib/time";
import type { Job } from "../types";
import { useMe } from "../lib/me";
import { Mixer } from "./Mixer";

const LABEL: Record<string, string> = {
  queued: "대기",
  downloading: "다운로드",
  separating: "분리 중",
  encoding: "저장 중",
  done: "완료",
  error: "실패",
};

/**
 * 작업 한 줄. 펼치면 진행 상황(진행 중) 또는 믹서·파일(완료)이 보인다.
 * onOpen 을 주면(보관함) 줄을 누를 때 그리로 가고(송 맵), 믹서 대신 ⋯ 버튼으로 파일·삭제만 연다.
 */
export function JobRow({
  job,
  open,
  onToggle,
  onChanged,
  onOpen,
}: {
  job: Job;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onOpen?: () => void;
}) {
  const { canEdit } = useMe();
  const done = ["done", "error"].includes(job.status);
  const pct = Math.round((job.progress || 0) * 100);
  const name = job.folder ?? job.title_override ?? job.title ?? job.url;
  const size = (job.files ?? []).reduce((a, f) => a + (f.size || 0), 0);
  const [countIn, setCountIn] = useState(4);

  const engine = useAudioEngine(open && job.status === "done" && !onOpen ? job : null);
  const bars = useMemo(
    () => barsFromMap((job.songmap as never) ?? null, job.duration),
    [job.songmap, job.duration],
  );

  return (
    <div className={`job${open ? " open" : ""}`}>
      <div className="summary" onClick={onOpen ?? onToggle}>
        {onOpen ? <span className="caret" style={{ transform: "none" }}>♪</span> : <span className="caret">▶</span>}
        <span className="job-title" title={name}>{name}</span>
        <span className="chips">
          {job.bpm ? <span className="chip">♩={job.bpm}</span> : null}
          {job.duration ? <span className="chip">{clock(job.duration)}</span> : null}
          {done && job.files?.length ? <span className="chip">{job.files.length}개 · {fmtSize(size)}</span> : null}
          <span className="chip">{fmtDate(job.created_at)}</span>
          <span className={`badge${job.status === "done" ? " done" : job.status === "error" ? " error" : ""}`}>
            {done ? LABEL[job.status] : `${pct}%`}
          </span>
          {onOpen && (
            <button
              className={`ghost${open ? " on" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              title="파일 다운로드 · 삭제"
              aria-label="파일 다운로드 · 삭제"
            >
              ⋯
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="detail">
          {job.folder && <div className="folder">data/output/{job.folder}/</div>}
          {!done && (
            <>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              <div className="meta">{job.stage} — {pct}%</div>
            </>
          )}
          {job.error && <div className="err" style={{ marginTop: 8 }}>{job.error}</div>}

          {job.status === "done" && !onOpen && (
            <Mixer
              engine={engine}
              bars={bars}
              jobId={job.id}
              showRate
              onChanged={onChanged}
              countIn={countIn}
              onCountInChange={setCountIn}
            />
          )}

          {!!job.files?.length && (
            <details style={{ marginTop: 10 }}>
              <summary className="meta" style={{ cursor: "pointer" }}>파일 {job.files.length}개 — 다운로드</summary>
              <div className="files">
                {job.files.map((f) => (
                  <a key={f.rel} href={api.fileUrl(f.url, true)} download>
                    {f.name}<span className="meta">{fmtSize(f.size)}</span>
                  </a>
                ))}
              </div>
            </details>
          )}

          <div className="actions">
            {job.video_id && (
              <a className="meta" href={`https://www.youtube.com/watch?v=${job.video_id}`} target="_blank" rel="noopener">
                YouTube에서 열기 ↗
              </a>
            )}
            <span style={{ flex: 1 }} />
            {done && canEdit && (
              <button
                className="ghost"
                onClick={async () => {
                  if (!confirm("결과 폴더까지 완전히 삭제합니다. 계속할까요?")) return;
                  try {
                    await api.deleteJob(job.id);
                    onChanged();
                  } catch (e) {
                    alert((e as Error).message);
                  }
                }}
              >
                삭제
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
