import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DialogHost } from "./lib/dialog";
import { api } from "./api";
import { MeContext, type Me } from "./lib/me";
import { AccessTab } from "./components/AccessTab";
import { LibraryTab } from "./components/LibraryTab";
import { PlayerTab } from "./components/PlayerTab";
import { PlaylistTab } from "./components/PlaylistTab";
import { SearchTab } from "./components/SearchTab";
import { SongMapTab } from "./components/SongMapTab";
import { WorkTab } from "./components/WorkTab";
import { InstrumentPicker } from "./components/InstrumentPicker";
import { instrumentOf, saveInstrument, savedInstrument, setCurrentInstrument, type Instrument } from "./lib/instrument";
import type { Job } from "./types";

type TabKey = "work" | "library" | "play" | "playlist" | "map" | "tube" | "access";

export function App() {
  // 홈은 보관함 — 곡을 고르면 재생 창으로 간다
  const [tab, setTab] = useState<TabKey>("library");
  // 고른 곡 (n 은 같은 곡을 다시 골라도 재생 창·송 맵이 알아채게)
  const [playPick, setPlayPick] = useState<{ id: string; n: number } | null>(null);
  const [mapPick, setMapPick] = useState<{ id: string; n: number } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // 연습할 악기 — 접속하면 먼저 고른다 (이 기기에 기억)
  const [instrument, setInstrument] = useState<Instrument | null>(() => savedInstrument());
  // 악보 API·파일은 고른 악기 것을 쓴다 (탭들은 악기를 고른 뒤에 그려지므로 그리기 전에 맞춰 둔다)
  if (instrument) setCurrentInstrument(instrument.key);
  // 고른 악기의 곡만 (예전 곡은 드럼)
  const allJobs = jobs;
  const myJobs = useMemo(
    () => allJobs.filter((j) => (j.instrument ?? "drum") === (instrument?.key ?? "drum")),
    [allJobs, instrument],
  );
  const [info, setInfo] = useState<string>("");
  const [pick, setPick] = useState<{ videoId: string; title: string } | null>(null);
  // 내 권한: 접속자 관리 탭(관리자)·수정 가능 여부. 서버가 정하고 여기선 보여 주기만 한다.
  const [me, setMe] = useState<Me>({ admin: false, canEdit: true, key: "", links: [] });
  const admin = me.admin;
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

  // 새 버전(배포) 알림: 서버의 빌드 id 가 이 화면을 불러온 것과 다르면 띄운다
  const myBuild = useRef(
    (document.querySelector('script[type="module"][src*="assets/index-"]') as HTMLScriptElement | null)?.src
      .match(/index-[\w-]+\.js/)?.[0] ?? "",
  );
  const [newBuild, setNewBuild] = useState(false);
  const checkBuild = useCallback(() => {
    if (!myBuild.current) return; // 개발 서버(vite)에서는 비교하지 않는다
    api
      .info()
      .then((d) => d.build && d.build !== myBuild.current && setNewBuild(true))
      .catch(() => {});
  }, []);

  // iPad 에서 다른 앱을 쓰다 돌아오면 8초를 기다리지 않고 바로 갱신한다
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      checkBuild();
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    const id = window.setInterval(checkBuild, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
      window.clearInterval(id);
    };
  }, [refresh, checkBuild]);

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
    api
      .me()
      .then((d) => setMe({ admin: d.admin, canEdit: d.can_edit !== false, key: d.key ?? "", links: d.links ?? [] }))
      .catch(() => setMe({ admin: false, canEdit: true, key: "", links: [] }));
    return () => window.clearTimeout(timer.current);
  }, [refresh]);

  return (
    <MeContext.Provider value={me}>
    <div className="wrap">
      <div className="titlebar">
        <h1>Demucs Web</h1>
        {instrument && (
          <button className="ghost instrument-chip" onClick={() => setInstrument(null)} title="악기 바꾸기">
            {instrument.icon} {instrument.label}
          </button>
        )}
      </div>
      <div className="sub">{info}</div>
      {newBuild && (
        <div className="updatebar">
          새 버전이 있습니다.
          <button onClick={() => location.reload()}>새로고침</button>
        </div>
      )}
      {!me.canEdit && (
        <div className="viewonly" title="이 기기는 보기 전용으로 등록되어 있습니다. 수정 권한은 관리자가 접속자 관리에서 줍니다.">
          보기 전용 기기 — 재생·믹스 받기·다운로드만 할 수 있습니다
        </div>
      )}

      {!instrument ? (
        <InstrumentPicker
          onPick={(k) => {
            saveInstrument(k);
            setInstrument(instrumentOf(k));
          }}
        />
      ) : (
      <>
      <div className="tabs" role="tablist">
        {(
          [
            ["work", "분리 작업"],
            ["library", "보관함"],
            ["play", "재생"],
            ["playlist", "플레이리스트"],
            ["map", "송 맵"],
            ["tube", "YouTube 검색"],
            ...(admin ? ([["access", "접속자 관리"]] as [TabKey, string][]) : []),
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
        <WorkTab jobs={myJobs} onChanged={refresh} picked={pick} onPickedUsed={() => setPick(null)} instrument={instrument} />
      )}
      {tab === "library" && (
        <LibraryTab
          jobs={myJobs}
          onChanged={refresh}
          onOpen={(id) => {
            setPlayPick((p) => ({ id, n: (p?.n ?? 0) + 1 }));
            setTab("play");
          }}
        />
      )}
      {tab === "play" && (
        <PlayerTab
          jobs={myJobs}
          onChanged={refresh}
          pick={playPick}
          onOpenMap={(id) => {
            setMapPick((p) => ({ id, n: (p?.n ?? 0) + 1 }));
            setTab("map");
          }}
          onPickSong={(id) => setPlayPick((p) => ({ id, n: (p?.n ?? 0) + 1 }))}
        />
      )}
      {tab === "playlist" && <PlaylistTab jobs={myJobs} onChanged={refresh} />}
      {tab === "map" && <SongMapTab jobs={myJobs} onChanged={refresh} pick={mapPick} />}
      {tab === "access" && admin && <AccessTab />}
      {tab === "tube" && (
        <SearchTab
          onPick={(videoId, title) => {
            setPick({ videoId, title });
            setTab("work");
          }}
        />
      )}
      </>
      )}
      <DialogHost />
    </div>
    </MeContext.Provider>
  );
}
