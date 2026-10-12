import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { ask, confirmBox } from "../lib/dialog";
import { useMe } from "../lib/me";
import type { AiRun, Job } from "../types";

const LABEL: Record<AiRun["phase"], string> = {
  queued: "대기 중",
  running: "만드는 중",
  done: "완료",
  failed: "실패",
};

/** 도구 이름 → 사람이 읽는 단계 */
const STEP: Record<string, string> = {
  get_job: "곡 확인",
  download_video: "영상 받기",
  look: "화면 보기",
  find_score_band: "악보 위치 찾기",
  extract_strips: "악보 띠 뽑기",
  show_strips: "띠 확인",
  strip_table: "마디 검산",
  edit_strip: "마디선 고치기",
  align_audio: "음원에 맞추기",
  build_score: "악보 PDF 만들기",
  save_result: "저장",
  report: "정리",
  Skill: "작업 방법 읽기",
};

/**
 * AI 악보: 악보가 나오는 연주 영상으로 악보 PDF + 송 맵 새 버전을 만든다 (agent/).
 * 버튼과 진행 상황을 같이 보여준다. 끝나면 onChanged 로 곡 정보를 다시 받는다.
 */
export function AiScore({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { canEdit } = useMe();
  const [run, setRun] = useState<AiRun | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const jobRef = useRef(job.id);
  jobRef.current = job.id;
  const lastPhase = useRef<string | null>(null);

  const poll = async (id: string) => {
    window.clearTimeout(timer.current);
    try {
      const r = await api.aiStatus(id);
      if (jobRef.current !== id) return;
      setRun(r);
      if (lastPhase.current && lastPhase.current !== r.phase && r.phase === "done") onChanged();
      lastPhase.current = r.phase;
      if (r.phase === "queued" || r.phase === "running") timer.current = window.setTimeout(() => poll(id), 2000);
    } catch (e) {
      if (jobRef.current !== id) return;
      if (!(e instanceof ApiError && e.status === 404)) setErr((e as Error).message);
      setRun(null);
    }
  };

  useEffect(() => {
    setRun(null);
    setErr("");
    lastPhase.current = null;
    void poll(job.id);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  async function start() {
    setErr("");
    const url = await ask({
      title: "AI 로 악보 만들기",
      message:
        "이 곡의 드럼 악보가 화면에 나오는 연주 영상(YouTube) 주소를 넣으세요. AI 가 악보 띠를 모아 악보 PDF 를 만들고, " +
        "이 곡 음원에 맞춘 송 맵을 새 버전('AI 악보')으로 저장합니다. 지금 송 맵 버전은 그대로 남습니다.",
      value: job.score_src ?? run?.score_url ?? "",
      placeholder: "https://www.youtube.com/watch?v=…",
      okText: "시작",
    });
    if (!url?.trim()) return;
    const hasScore = job.files.some((f) => f.rel === "score.pdf");
    let overwrite = false;
    if (hasScore) {
      overwrite = await confirmBox({
        title: "이미 악보가 있습니다",
        message: "지금 연결된 악보 PDF 를 AI 가 만든 것으로 바꿉니다. 송 맵은 새 버전으로 저장되니 기존 버전은 남습니다.",
        okText: "바꾸기",
        danger: true,
      });
      if (!overwrite) return;
    }
    try {
      const r = await api.aiStart(job.id, url.trim(), overwrite);
      setRun(r);
      setOpen(true);
      lastPhase.current = r.phase;
      void poll(job.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const busy = run?.phase === "queued" || run?.phase === "running";
  const step = run ? STEP[run.state] ?? run.state : "";
  return (
    <div className="aiscore">
      <div className="actions" style={{ marginTop: 0 }}>
        {canEdit && (
          <button className="ghost" onClick={() => void start()} disabled={busy} title="연주 영상에 나오는 악보로 악보 PDF·송 맵 만들기">
            ✨ AI 악보
          </button>
        )}
        {run && (
          <button className="ghost aistatus" onClick={() => setOpen((v) => !v)} title="진행 기록 보기">
            <span className={`badge${run.phase === "done" ? " done" : run.phase === "failed" ? " error" : ""}`}>
              {LABEL[run.phase]}
            </span>{" "}
            {busy ? step : run.report?.summary?.slice(0, 60) ?? run.error ?? ""}
            {busy && <span className="dots" />}
          </button>
        )}
        {err && <span className="err">{err}</span>}
      </div>
      {run && open && (
        <div className="ailog">
          {run.report && <div className="aireport">{run.report.summary}</div>}
          {run.error && <div className="err">{run.error}</div>}
          <div className="meta">악보 영상: {run.score_url}</div>
          <ol>
            {run.log.map((l, i) => (
              <li key={i} className={`ai-${l.kind}`}>
                {l.kind === "tool" ? `▸ ${STEP[l.msg.split("(")[0]] ?? l.msg}` : l.msg}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
