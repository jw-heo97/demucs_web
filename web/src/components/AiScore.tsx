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
  pdf_overview: "악보 쪽 보기",
  set_sections: "구간 이름",
  audio_grid: "음원 박 재기",
  set_timing: "박 위치 기록",
  measure_images: "마디 보기",
  write_measures: "음표 받아 적기",
  check_measures: "소리와 대조",
  refine_timing: "1마디 1박 검산",
  add_strip: "띠 끼워 넣기",
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

  // 곡에 이미 있는 악보 PDF 로 (PDF 는 그대로, 음표 악보 + 송 맵 새 버전)
  async function fromPdf() {
    setErr("");
    const hasNotation = job.files.some((f) => f.rel === "_notation.json");
    if (
      !(await confirmBox({
        title: "악보 PDF 로 음표 악보 만들기",
        message:
          "AI 가 이 곡의 악보 PDF 를 마디마다 읽어 음표 악보(송 맵에서 음표를 고칠 수 있는 악보)를 받아 적고, " +
          "구간 이름·박자·템포를 읽어 송 맵 새 버전('AI 악보')을 만듭니다. PDF 와 지금 송 맵 버전은 그대로 남습니다." +
          (hasNotation ? " 지금 있는 음표 악보는 이력에 남기고 새로 씁니다." : ""),
        okText: "시작",
      }))
    )
      return;
    try {
      const r = await api.aiFromPdf(job.id);
      setRun(r);
      setOpen(true);
      lastPhase.current = r.phase;
      void poll(job.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const hasPdf = job.files.some((f) => f.rel === "score.pdf");
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
        {canEdit && hasPdf && (
          <button className="ghost" onClick={() => void fromPdf()} disabled={busy} title="곡에 있는 악보 PDF 로 음표 악보·송 맵 만들기">
            ✨ PDF → 음표 악보
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
          <div className="meta">{run.mode === "pdf" ? "기존 악보 PDF 에서" : `악보 영상: ${run.score_url}`}</div>
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
