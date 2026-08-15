import { useCallback, useEffect, useRef, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { Login } from "./components/Login";
import { SecurityDialog } from "./components/SecurityDialog";
import { SearchTab } from "./components/SearchTab";
import { SongMapTab } from "./components/SongMapTab";
import { WorkTab } from "./components/WorkTab";
import type { Job, Me } from "./types";

type TabKey = "work" | "map" | "tube";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<TabKey>("work");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [info, setInfo] = useState<string>("");
  const [secOpen, setSecOpen] = useState(false);
  const [pick, setPick] = useState<{ videoId: string; title: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setBooting(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.jobs();
      setJobs(d.jobs);
      const busy = d.jobs.some((j) => !["done", "error"].includes(j.status));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, busy ? 1000 : 8000);
    } catch {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, 8000);
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    refresh();
    api
      .info()
      .then((d) =>
        setInfo(
          `모델 ${d.model} · ${d.device === "cuda" ? `${d.gpu} (sm_${(d.capability ?? []).join("")})` : "CPU"}` +
            ` · ${d.samplerate} Hz · 최대 ${Math.floor(d.max_duration_sec / 60)}분`,
        ),
      )
      .catch(() => setInfo(""));
    return () => window.clearTimeout(timer.current);
  }, [me, refresh]);

  if (booting) return <div className="wrap"><div className="empty">불러오는 중…</div></div>;
  if (!me) return <Login onDone={setMe} />;

  return (
    <div className="wrap">
      <h1>Demucs Web</h1>
      <div className="sub">{info}</div>

      <div className="tabs" role="tablist">
        {(
          [
            ["work", "분리 작업"],
            ["map", "송 맵"],
            ["tube", "YouTube 검색"],
          ] as [TabKey, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            className="tab"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span className="meta" style={{ marginRight: 8 }}>
          {me.username}
          {me.is_admin && " · 관리자"}
        </span>
        {/* 보안 화면은 계정 관리·전체 접속 기록을 다루므로 관리자에게만 보인다.
            서버에서도 해당 엔드포인트를 403 으로 막는다 (숨기기만 하면 안 된다). */}
        {me.is_admin && (
          <button className="ghost" onClick={() => setSecOpen(true)}>
            보안
          </button>
        )}
        <button
          className="ghost"
          onClick={async () => {
            await api.logout();
            setMe(null);
          }}
        >
          로그아웃
        </button>
      </div>

      {tab === "work" && (
        <WorkTab jobs={jobs} onChanged={refresh} picked={pick} onPickedUsed={() => setPick(null)} />
      )}
      {tab === "map" && <SongMapTab jobs={jobs} onChanged={refresh} />}
      {tab === "tube" && (
        <SearchTab
          onPick={(videoId, title) => {
            setPick({ videoId, title });
            setTab("work");
          }}
        />
      )}

      <SecurityDialog open={secOpen} me={me} onClose={() => setSecOpen(false)} />
    </div>
  );
}
