import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Job } from "../types";
import { useMe } from "../lib/me";
import { JobRow } from "./JobRow";

interface Props {
  jobs: Job[];
  onChanged: () => void;
  picked: { videoId: string; title: string } | null;
  onPickedUsed: () => void;
}

export function WorkTab({ jobs, onChanged, picked, onPickedUsed }: Props) {
  const { canEdit } = useMe();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("both");
  const [target, setTarget] = useState("all");
  const [saveOriginal, setSaveOriginal] = useState(true);
  const [metronome, setMetronome] = useState(true);
  const [minusMixes, setMinusMixes] = useState(false);
  const [hint, setHint] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!picked) return;
    setUrl(picked.videoId);
    setTitle(picked.title);
    onPickedUsed();
  }, [picked, onPickedUsed]);

  // 완료된 곡은 보관함 탭에서 본다. 여기는 대기·진행 중·실패한 작업만.
  const active = useMemo(() => jobs.filter((j) => j.status !== "done"), [jobs]);

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
          <button onClick={submit} disabled={!canEdit} title={canEdit ? undefined : "보기 전용 기기에서는 분리를 등록할 수 없습니다"}>
            분리 시작
          </button>
          <span className="meta">{hint}</span>
        </div>
      </div>

      <div className="actions" style={{ marginTop: 18 }}>
        <h2 style={{ margin: 0 }}>진행 중인 작업 <span className="meta">{active.length}건</span></h2>
      </div>

      {active.length === 0 && <div className="empty">진행 중인 작업이 없습니다. 완료된 곡은 보관함 탭에 있습니다.</div>}
      {active.map((j) => (
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

