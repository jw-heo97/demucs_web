import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAudioEngine } from "../hooks/useAudioEngine";
import { barsFromMap } from "../lib/songmap";
import { fmtDate, fmtSize, clock } from "../lib/time";
import type { Job } from "../types";
import { Mixer } from "./Mixer";

const LABEL: Record<string, string> = {
  queued: "대기",
  downloading: "다운로드",
  separating: "분리 중",
  encoding: "저장 중",
  done: "완료",
  error: "실패",
};

interface Props {
  jobs: Job[];
  onChanged: () => void;
  picked: { videoId: string; title: string } | null;
  onPickedUsed: () => void;
}

export function WorkTab({ jobs, onChanged, picked, onPickedUsed }: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("both");
  const [target, setTarget] = useState("all");
  const [saveOriginal, setSaveOriginal] = useState(true);
  const [metronome, setMetronome] = useState(true);
  const [minusMixes, setMinusMixes] = useState(false);
  const [hint, setHint] = useState("");
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!picked) return;
    setUrl(picked.videoId);
    setTitle(picked.title);
    onPickedUsed();
  }, [picked, onPickedUsed]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? jobs.filter((j) => (j.folder ?? j.title ?? j.url).toLowerCase().includes(q))
      : jobs;
  }, [jobs, filter]);

  const submit = async () => {
    if (!url.trim()) {
      setHint("주소를 입력하세요.");
      return;
    }
    setHint("등록 중…");
    try {
      await api.submit({
        url: url.trim(),
        title: title.trim(),
        format,
        target,
        save_original: saveOriginal,
        metronome,
        minus_mixes: minusMixes,
      });
      setUrl("");
      setTitle("");
      setHint("대기열에 추가했습니다.");
      onChanged();
    } catch (e) {
      setHint((e as Error).message);
    }
  };

  const fetchTitle = async () => {
    if (!url.trim()) return;
    setHint("제목 가져오는 중…");
    try {
      const d = await api.resolve(url.trim());
      setTitle(d.title);
      setHint(d.playable_in_embed === false ? "미리보기 불가 영상 (분리에는 영향 없음)" : "");
    } catch (e) {
      setHint((e as Error).message);
    }
  };

  return (
    <div>
      <div className="panel">
        <label htmlFor="url">YouTube 주소 또는 영상 ID</label>
        <input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "12px 0 5px" }}>
          <label style={{ margin: 0 }}>
            저장 제목 <span style={{ color: "var(--accent)" }}>(폴더 이름이 됩니다)</span>
          </label>
          <button className="ghost" onClick={fetchTitle}>YouTube 제목 가져오기</button>
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="비워두면 YouTube 제목을 사용합니다" />

        <div className="row" style={{ marginTop: 12 }}>
          <div>
            <label>출력 포맷</label>
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="both">wav + mp3</option>
              <option value="wav">wav만</option>
              <option value="mp3">mp3만</option>
            </select>
          </div>
          <div>
            <label>분리 대상</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="all">전체 (4스템)</option>
              <option value="vocals">보컬</option>
              <option value="drums">드럼</option>
              <option value="bass">베이스</option>
              <option value="other">기타</option>
            </select>
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={saveOriginal} onChange={(e) => setSaveOriginal(e.target.checked)} /> 원본도 함께 저장
        </label>
        <label className="check">
          <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> 메트로놈 트랙 추가
        </label>
        <label className="check">
          <input type="checkbox" checked={minusMixes} onChange={(e) => setMinusMixes(e.target.checked)} />
          각 스템 제외 믹스도 저장 <span className="meta">(용량 2배 — 보통 불필요)</span>
        </label>

        <div className="actions">
          <button onClick={submit}>분리 시작</button>
          <span className="meta">{hint}</span>
        </div>
      </div>

      <div className="actions" style={{ marginTop: 18 }}>
        <h2 style={{ margin: 0 }}>보관함 <span className="meta">{jobs.length}곡</span></h2>
        <input style={{ flex: 1, minWidth: 160 }} placeholder="제목으로 찾기…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="ghost" onClick={() => setOpenId(null)}>모두 접기</button>
      </div>

      {shown.length === 0 && <div className="empty">{jobs.length ? "검색 결과가 없습니다." : "아직 작업이 없습니다."}</div>}
      {shown.map((j) => (
        <JobRow
          key={j.id}
          job={j}
          open={openId === j.id || !["done", "error"].includes(j.status)}
          onToggle={() => setOpenId((v) => (v === j.id ? null : j.id))}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function JobRow({ job, open, onToggle, onChanged }: { job: Job; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const done = ["done", "error"].includes(job.status);
  const pct = Math.round((job.progress || 0) * 100);
  const name = job.folder ?? job.title_override ?? job.title ?? job.url;
  const size = (job.files ?? []).reduce((a, f) => a + (f.size || 0), 0);
  const [countIn, setCountIn] = useState(4);

  const engine = useAudioEngine(open && job.status === "done" ? job : null);
  const bars = useMemo(
    () => barsFromMap((job.songmap as never) ?? null, job.duration),
    [job.songmap, job.duration],
  );

  return (
    <div className={`job${open ? " open" : ""}`}>
      <div className="summary" onClick={onToggle}>
        <span className="caret">▶</span>
        <span className="job-title" title={name}>{name}</span>
        <span className="chips">
          {job.bpm ? <span className="chip">♩={job.bpm}</span> : null}
          {job.duration ? <span className="chip">{clock(job.duration)}</span> : null}
          {done && job.files?.length ? <span className="chip">{job.files.length}개 · {fmtSize(size)}</span> : null}
          <span className="chip">{fmtDate(job.created_at)}</span>
          <span className={`badge${job.status === "done" ? " done" : job.status === "error" ? " error" : ""}`}>
            {done ? LABEL[job.status] : `${pct}%`}
          </span>
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

          {job.status === "done" && (
            <Mixer
              engine={engine}
              bars={bars}
              jobId={job.id}
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
            {done && (
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
