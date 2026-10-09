import { useMemo, useState } from "react";
import { confirmBox, notice, pickMany } from "../lib/dialog";
import { api } from "../api";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { barsFromMap } from "../lib/songmap";
import { fmtDate, fmtSize, clock } from "../lib/time";
import type { Job } from "../types";
import { ownsJob, useMe } from "../lib/me";
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
  const me = useMe();
  const { canEdit } = me;
  const mine = ownsJob(me, job.owner);
  const sharedTo = me.links.filter((l) => job.shared_links?.includes(l.id));

  const share = async () => {
    const links = await pickMany({
      title: `${name} 공유`,
      message: "고른 접속 링크로 들어온 사람들이 이 곡을 볼 수 있습니다. 고르지 않으면 나만 봅니다.",
      items: me.links.map((l) => ({ label: l.label, value: l.id })),
      selected: job.shared_links ?? [],
      okText: "저장",
      empty: "접속 링크가 없습니다. 접속자 관리 탭에서 먼저 만드세요.",
    });
    if (!links) return;
    try {
      await api.shareJob(job.id, links);
      onChanged();
    } catch (e) {
      await notice("공유를 바꾸지 못했습니다", (e as Error).message);
    }
  };
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
          {!!job.locked_versions && (
            <span className="chip" title={`잠긴 송 맵 버전 ${job.locked_versions}개 — 곡을 지울 수 없습니다`}>
              🔒
            </span>
          )}
          {me.admin && sharedTo.length > 0 && (
            <span className="chip" title={`공유: ${sharedTo.map((l) => l.label).join(", ")}`}>
              👥 {sharedTo.length === 1 ? sharedTo[0].label : `${sharedTo.length}곳`}
            </span>
          )}
          {!mine && (
            <span className="chip" title="다른 사람이 만든 곡 — 지울 수 없습니다">
              {job.owner_name || "관리자"}
            </span>
          )}
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
              title={me.admin ? "파일 다운로드 · 공유 · 삭제" : "파일 다운로드 · 삭제"}
              aria-label={me.admin ? "파일 다운로드 · 공유 · 삭제" : "파일 다운로드 · 삭제"}
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
            {me.admin && job.status === "done" && (
              <button className="ghost" onClick={() => void share()} title="이 곡을 볼 수 있는 접속 링크 고르기">
                공유{sharedTo.length ? ` (${sharedTo.length})` : ""}
              </button>
            )}
            {done && canEdit && mine && (
              <button
                className="ghost"
                disabled={!!job.locked_versions}
                title={job.locked_versions ? "잠긴 송 맵 버전이 있어 지울 수 없습니다. 송 맵에서 잠금을 먼저 푸세요." : undefined}
                onClick={async () => {
                  if (
                    !(await confirmBox({
                      title: `${name} 삭제`,
                      message: "결과 폴더(스템·송 맵·악보·트랙)까지 완전히 삭제합니다. 되돌릴 수 없습니다.",
                      okText: "삭제",
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await api.deleteJob(job.id);
                    onChanged();
                  } catch (e) {
                    await notice("삭제하지 못했습니다", (e as Error).message);
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
