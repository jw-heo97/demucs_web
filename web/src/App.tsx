import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { SearchTab } from "./components/SearchTab";
import { SongMapTab } from "./components/SongMapTab";
import { WorkTab } from "./components/WorkTab";
import type { Job } from "./types";

type TabKey = "work" | "map" | "tube";

export function App() {
  const [tab, setTab] = useState<TabKey>("work");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [info, setInfo] = useState<string>("");
  const [pick, setPick] = useState<{ videoId: string; title: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

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
  }, [refresh]);

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
    </div>
  );
}
