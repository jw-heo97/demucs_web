import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { BASE } from "../api";
import { cachedUrl, download, removeFromDevice } from "../lib/audioCache";
import { audioCtx } from "../lib/audioCtx";
import { stemFilesOf } from "../lib/stems";
import { useSubdiv } from "./useLiveMetronome";
import { BufferTransport, decodePcm, type Pcm } from "../lib/bufferTransport";

export interface Track {
  key: string;
  label: string;
  url: string;
  rel: string;
  mtime: number;
  /**
   * 오디오 파일이 없는 트랙. 메트로놈은 파일을 재생하지 않고 useLiveMetronome 이 송 맵에서
   * 즉석으로 클릭을 만든다 — 맵을 고칠 때마다 파일을 다시 굽지 않아도 바로 들린다.
   * 음소거·솔로·볼륨은 다른 트랙과 똑같이 엔진이 들고 있다. 항상 목록 맨 끝에 둔다.
   */
  virtual?: boolean;
  /** 사용자 트랙(녹음·반주)이면 그 id. 이름 바꾸기·오프셋·삭제에 쓴다 */
  trackId?: string;
  /** 고정 오프셋(ms) — 확정(잠긴) 버전의 메트로놈 파일에 잠근 기기의 클릭 보정을 싣는다 */
  offsetMs?: number;
}

const LABEL: Record<string, string> = {
  drums: "드럼",
  bass: "베이스",
  vocals: "보컬",
  other: "기타",
  click: "메트로놈",
  no_drums: "드럼 제외",
  no_bass: "베이스 제외",
  no_vocals: "보컬 제외(MR)",
  no_other: "기타 제외",
  original: "원본",
};

export function tracksOf(job: Job, subdiv: 1 | 2 = 1): Track[] {
  const best = stemFilesOf(job);
  // 원본은 믹서에 올리지 않는다 — 스템과 겹쳐 소리가 두 배가 된다 (파형 표시용으로만 쓴다)
  const plain = ["drums", "bass", "vocals", "other"].filter((k) => best.has(k));
  const keys =
    plain.length >= 2 ? plain : [...best.keys()].filter((k) => k !== "click" && k !== "original");
  const tracks: Track[] = keys.map((k) => {
    const f = best.get(k)!;
    return {
      key: k,
      label: LABEL[k] ?? k,
      // 같은 이름으로 다시 구워진 파일(예전 메트로놈처럼)을 옛 데이터로 쓰지 않게 수정 시각을 붙여 구별한다
      url: `${BASE}${f.url}?v=${f.mtime ?? 0}`,
      rel: f.rel,
      mtime: f.mtime ?? 0,
    };
  });
  // 사용자 트랙(녹음·반주)은 스템 뒤에. 오프셋은 여기 넣지 않는다 — 바꿀 때마다 다시 불러오지 않게
  // 엔진이 job.tracks 에서 그때그때 읽는다.
  for (const t of job.tracks ?? []) {
    tracks.push({
      key: `trk:${t.id}`,
      label: t.name,
      url: `${BASE}${t.url}?v=${t.mtime ?? 0}`,
      rel: t.rel,
      mtime: t.mtime ?? 0,
      trackId: t.id,
    });
  }
  // 메트로놈.
  //  - 확정(잠긴) 버전: 서버가 그 버전으로 구운 클릭 파일을 스템과 똑같은 트랙으로 재생한다.
  //    잠근 기기의 클릭 보정은 트랙 오프셋으로 싣는다.
  //  - 그 밖: 송 맵에서 즉석으로 만든다 (고치면 저장 전에도 바로 들린다)
  const active = job.map_versions?.find((v) => v.id === job.map_active);
  const click4 = best.get("click");
  // 8비트: 서버가 같이 구워 둔 `{곡}_click8.mp3` (없는 예전 곡은 4비트 파일)
  const click8 =
    subdiv === 2 && click4 ? job.files.find((f) => f.name === `${job.folder}_click8.mp3`) : undefined;
  const clickFile = click8 ?? click4;
  if (active?.locked && clickFile) {
    tracks.push({
      key: "click",
      label: `${LABEL.click} (확정${click8 ? " · 8비트" : ""})`,
      url: `${BASE}${clickFile.url}?v=${clickFile.mtime ?? 0}`,
      rel: clickFile.rel,
      mtime: clickFile.mtime ?? 0,
      offsetMs: typeof active.click_offset_ms === "number" ? active.click_offset_ms : 0,
    });
    return tracks;
  }
  const hasMap = !!(job.songmap as { ranges?: unknown[] } | undefined)?.ranges?.length;
  if (hasMap || clickFile) {
    tracks.push({ key: "click", label: LABEL.click, url: "", rel: "", mtime: 0, virtual: true });
  }
  return tracks;
}

/**
 * 살아 있는 엔진들. 두 곳(보관함·송 맵)에서 동시에 소리가 나는 것을 막는다.
 */
const liveEngines = new Set<{ stop: () => void }>();

/**
 * 여러 스템을 동시에 재생하는 엔진.
 *
 * <audio> 는 쓰지 않는다. 곡을 기기에 저장(통째로 받기)한 뒤 트랙을 풀어 재생기(lib/bufferTransport —
 * 워클릿)에 넘긴다. 모든 소리가 AudioContext 시계 하나에서 나와 트랙끼리·메트로놈·예비박이 샘플 단위로
 * 맞고, 속도는 워클릿이 음정을 유지한 채 늘린다. 저장 안 된 곡에서 ▶ 를 누르면 먼저 받고 바로 시작한다.
 */
export interface EngineOptions {
  /** 곡 끝까지 재생됐을 때 (플레이리스트의 자동 다음 곡) */
  onEnded?: () => void;
  /**
   * 곡이 바뀌어도 음소거·솔로·볼륨을 트랙 이름(드럼, 베이스…)별로 이어간다.
   * 플레이리스트에서 드럼을 끄고 연습하는데 곡마다 다시 끄지 않아도 되게.
   * 같은 곡의 파일만 바뀐 경우(메트로놈 재생성)에는 이 값과 상관없이 항상 이어간다.
   */
  carryMix?: boolean;
}

/** 스템 트랙의 처음 볼륨 (0~1) */
const DEFAULT_STEM_VOL = 0.5;

/** 한 곡의 재생 자원: 받은 파일 → 풀어 둔 PCM → 재생기 */
interface Loaded {
  real: Track[];
  /** 트랙별 blob: 주소 (기기에 저장된 것). 다 받기 전엔 null */
  urls: (string | null)[];
  tp: BufferTransport | null;
  building: Promise<BufferTransport | null> | null;
  alive: boolean;
}

export function useAudioEngine(job: Job | null, opts: EngineOptions = {}) {
  /**
   * 작업 목록은 1~8초마다 폴링돼 **매번 새 객체**로 온다.
   * `job` 을 그대로 의존성에 두면 폴링할 때마다 재생기를 파괴하고 다시 만들어 재생이 끊긴다.
   * 그래서 실제로 재생할 트랙(파일·수정 시각)이 바뀔 때만 도는 키를 쓴다.
   */
  // 기기 저장을 지우면 이 값을 올려 트랙을 다시 불러온다
  const [reloadTick, setReloadTick] = useState(0);
  // 4/8비트 — 확정 버전의 메트로놈 파일이 바뀐다 (바꾸면 트랙을 다시 불러온다)
  const [subdiv] = useSubdiv();
  const subdivRef = useRef(subdiv);
  subdivRef.current = subdiv;
  const key = job
    ? `${job.id}:${tracksOf(job, subdiv).map((t) => `${t.rel}@${t.mtime}`).join("|")}#${reloadTick}`
    : "";
  const jobRef = useRef(job);
  jobRef.current = job;
  // 같은 곡의 트랙만 바뀐 경우(메트로놈 재생성) 재생 위치를 이어가기 위한 기억
  const prevJobId = useRef<string | null>(null);
  const lastTime = useRef(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  // tracks 가 어느 곡의 것인지. 곡을 바꾼 직후 한 번은 이전 곡 트랙이 남아 있어서,
  // 자동 재생이 엉뚱한 곡을 틀지 않도록 확인하는 데 쓴다.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState<boolean[]>([]);
  const [solo, setSolo] = useState<boolean[]>([]);
  const [vol, setVol] = useState<number[]>([]);
  /** 기기 저장 상태: 확인 중 / 저장 안 함 / 받는 중(pct) / 저장됨 / 받기 실패 */
  const [cache, setCache] = useState<{
    state: "checking" | "none" | "downloading" | "cached" | "stream";
    pct: number;
  }>({ state: "checking", pct: 0 });
  /** 트랙을 푸는 중이면 진척 (done/total) */
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;
  const carryRef = useRef(!!opts.carryMix);
  carryRef.current = !!opts.carryMix;
  // 트랙이 바뀌는 순간 직전 믹스 상태를 읽기 위한 사본
  const mixStateRef = useRef({ tracks, muted, solo, vol });
  mixStateRef.current = { tracks, muted, solo, vol };
  /**
   * 지금 재생을 맡은 것: 재생기 하나 ([tp]) 또는 아직 없음 ([]).
   * 메트로놈·구간 안내·녹음은 [0] 의 currentTime 을 '곡 위치' 로 읽는다 (예전 <audio> 와 같은 이름).
   */
  const audiosRef = useRef<HTMLAudioElement[]>([]);
  const loadedRef = useRef<Loaded | null>(null);
  /** 트랙 i 의 오프셋(초): 트랙의 0초가 곡의 몇 초인지. 스템은 0. job.tracks 에서 그때그때 읽는다 */
  const offOf = (i: number) => {
    const real = loadedRef.current?.real ?? [];
    const fixed = real[i]?.offsetMs;
    if (typeof fixed === "number") return fixed / 1000;
    const id = real[i]?.trackId;
    if (!id) return 0;
    const t = jobRef.current?.tracks?.find((x) => x.id === id);
    return (t?.offset_ms ?? 0) / 1000;
  };
  const selfRef = useRef<{ stop: () => void }>({ stop: () => {} });
  selfRef.current.stop = () => {
    audiosRef.current.forEach((a) => a.pause());
    setPlaying(false);
  };

  // 마운트되어 있는 동안만 등록해 둔다
  useEffect(() => {
    const me = selfRef.current;
    liveEngines.add(me);
    return () => {
      liveEngines.delete(me);
      // 화면을 떠나면 소리도 멈춘다
      me.stop();
    };
  }, []);
  const rafRef = useRef(0);
  const loopRef = useRef<{ start: number; end: number } | null>(null);
  // 지금 곡을 기기에 저장하기 시작 (트랙을 불러올 때 만들어진다). 다 받으면 끝나는 Promise
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const loopEndRef = useRef<((lp: { start: number; end: number }) => void) | null>(null);
  // 곡이 끝났을 때 (트랙을 불러올 때 정해진다 — 재생기가 나중에 만들어져도 같은 처리를 쓰게)
  const endedRef = useRef<() => void>(() => {});
  /** 트랙 i 가 지금 들리는지(음소거·솔로 반영)와 볼륨. 가상 트랙(메트로놈)도 같은 규칙. */
  const mixOf = useCallback(
    (i: number) => {
      const anySolo = solo.some(Boolean);
      return { on: anySolo ? !!solo[i] : !muted[i], vol: vol[i] ?? 1 };
    },
    [muted, solo, vol],
  );
  // 재생기가 '지금 설정' 을 읽는 곳 (콜백들이 첫 렌더 것을 쥐고 있어도 최신 값을 보게)
  const mixOfLatest = useRef(mixOf);
  mixOfLatest.current = mixOf;
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    const j = jobRef.current;
    // 같은 곡인데 파일만 바뀐 경우(송 맵 저장 → 메트로놈 재생성)에는 듣던 자리를 유지한다.
    // 곡이 바뀌면 처음부터.
    const sameJob = !!j && prevJobId.current === j.id;
    const resumeAt = sameJob ? lastTime.current : 0;
    const prevMix = new Map<string, { muted: boolean; solo: boolean; vol: number }>();
    if (sameJob || carryRef.current) {
      const m = mixStateRef.current;
      m.tracks.forEach((t, i) =>
        prevMix.set(t.key, { muted: !!m.muted[i], solo: !!m.solo[i], vol: m.vol[i] ?? 1 }),
      );
    }
    prevJobId.current = j?.id ?? null;
    audiosRef.current.forEach((a) => a.pause());
    audiosRef.current = [];
    setPlaying(false);
    setTime(resumeAt);
    lastTime.current = resumeAt;

    const ts = j ? tracksOf(j, subdivRef.current) : [];
    setTracks(ts);
    setLoadedId(j?.id ?? null);
    setMuted(ts.map((t) => prevMix.get(t.key)?.muted ?? false));
    setSolo(ts.map((t) => prevMix.get(t.key)?.solo ?? false));
    // 스템은 50 에서 시작한다 — 4개를 다 켜면 메트로놈 클릭이 묻힌다. 메트로놈은 100.
    setVol(ts.map((t) => prevMix.get(t.key)?.vol ?? (t.key === "click" ? 1 : DEFAULT_STEM_VOL)));
    const real = ts.filter((t) => !t.virtual);
    setDuration(j?.duration ?? 0);
    setPreparing(null);
    const loaded: Loaded = { real, urls: real.map(() => null), tp: null, building: null, alive: true };
    loadedRef.current = loaded;
    if (!real.length) {
      setCache({ state: "none", pct: 0 });
      return;
    }
    const onEnded = () => {
      audiosRef.current.forEach((a) => a.pause());
      setPlaying(false);
      onEndedRef.current?.();
    };
    endedRef.current = onEnded;

    // 기기에 받아 둔 파일이 있는지 본다. 없으면 '기기에 저장' 을 누르거나 ▶ 를 누를 때 받는다.
    const abort = new AbortController();
    // 확정 메트로놈은 4비트·8비트 파일이 따로라, 안 쓰는 쪽도 받아 둔다 (바꿔도 다시 안 받게)
    const prefetchAltClick = async () => {
      if (!j) return;
      const mine = real.find((t) => t.key === "click")?.url;
      const other = tracksOf(j, subdivRef.current === 2 ? 1 : 2).find((t) => t.key === "click" && !t.virtual);
      if (!other || other.url === mine || !loaded.alive) return;
      if (await cachedUrl(other.url)) return;
      try {
        await download(other.url, undefined, abort.signal, "low");
      } catch {
        /* 다음에 다시 */
      }
    };
    let saving: Promise<boolean> | null = null;
    // 한 번에 하나씩, 낮은 우선순위로 — 원격(LTE·Tailscale)에서 4개를 한꺼번에 받으면 다른 요청이 멈춘다
    const save = () => {
      if (saving) return saving;
      saving = (async () => {
        const n = real.length;
        try {
          for (let i = 0; i < n; i++) {
            if (!loaded.alive) return false;
            if (loaded.urls[i]) continue;
            setCache({ state: "downloading", pct: Math.min(99, Math.floor((i / n) * 100)) });
            loaded.urls[i] = await download(
              real[i].url,
              (g, tot) =>
                loaded.alive &&
                setCache({ state: "downloading", pct: Math.min(99, Math.floor(((i + (tot ? g / tot : 0)) / n) * 100)) }),
              abort.signal,
              "low",
            );
          }
          if (!loaded.alive) return false;
          setCache({ state: "cached", pct: 100 });
          void prefetchAltClick();
          return true;
        } catch {
          // 받기에 실패해도 버튼으로 다시 시도할 수 있게
          if (loaded.alive) setCache({ state: "stream", pct: 0 });
          return false;
        } finally {
          saving = null;
        }
      })();
      return saving;
    };
    saveRef.current = save;
    setCache({ state: "checking", pct: 0 });
    void (async () => {
      const hits = await Promise.all(real.map((t) => cachedUrl(t.url)));
      if (!loaded.alive) return;
      hits.forEach((h, i) => (loaded.urls[i] = h));
      if (hits.every(Boolean)) {
        setCache({ state: "cached", pct: 100 });
        void prefetchAltClick();
      } else {
        setCache({ state: "none", pct: Math.floor((hits.filter(Boolean).length / real.length) * 100) });
        // 이미 일부를 저장해 둔 곡이면(예: 확정 메트로놈이 파일 트랙이 되면서 한 개가 새로 생겼다)
        // 버튼을 다시 누르지 않아도 빠진 것만 이어 받는다
        if (hits.some(Boolean)) void save();
      }
    })();

    return () => {
      loaded.alive = false;
      saveRef.current = null;
      abort.abort();
      // 재생기를 지우면 위치가 사라지므로 그 전에 기억해 둔다
      lastTime.current = Math.max(0, loaded.tp?.currentTime ?? lastTime.current);
      loaded.tp?.dispose();
      loaded.tp = null;
      if (loadedRef.current === loaded) loadedRef.current = null;
      audiosRef.current = [];
      setPlaying(false);
    };
  }, [key]);

  // 볼륨·음소거·솔로 → 재생기 게인 (바로 먹는다)
  useEffect(() => {
    const tp = loadedRef.current?.tp;
    if (!tp) return;
    (loadedRef.current?.real ?? []).forEach((_, i) => {
      const m = mixOf(i);
      tp.setGain(i, m.on ? m.vol : 0);
    });
  }, [mixOf]);

  // 속도 → 재생기 (음정은 유지, 같은 자리에서 이어진다)
  useEffect(() => {
    const tp = loadedRef.current?.tp;
    if (tp) tp.playbackRate = rate;
  }, [rate, tracks]);

  /**
   * 재생 준비: 기기에 저장(없으면 받는다) → 트랙을 풀어 재생기를 만든다 (이미 있으면 그대로).
   * 곡이 바뀌면 null. 처음 한 번은 받기·풀기에 몇 초 걸린다 (cache / preparing 으로 보인다).
   */
  const prepare = useCallback(async (): Promise<BufferTransport | null> => {
    const l = loadedRef.current;
    if (!l || !l.real.length) return null;
    if (l.tp) return l.tp;
    if (l.building) return l.building;
    const job = (async () => {
      if (l.urls.some((u) => !u)) {
        const ok = await (saveRef.current?.() ?? Promise.resolve(false));
        if (!ok || !l.alive) return null;
      }
      const ctx = audioCtx();
      const total = l.real.length;
      setPreparing({ done: 0, total });
      const pcms: Pcm[] = [];
      // 한 번에 하나씩 — 푸는 순간엔 float32 전체가 잠깐 살아서 (5분 ~115MB) 동시에 풀면 아이패드가 버겁다
      for (let i = 0; i < total; i++) {
        pcms.push(await decodePcm(ctx, l.urls[i]!));
        if (!l.alive) return null;
        setPreparing({ done: i + 1, total });
      }
      const tp = await BufferTransport.create(
        ctx,
        pcms.map((pcm, i) => ({ pcm, offset: offOf(i) })),
        ctx.destination,
      );
      if (!l.alive) {
        tp.dispose();
        return null;
      }
      tp.addEventListener("ended", () => endedRef.current());
      pcms.forEach((_, i) => {
        const m = mixOfLatest.current(i);
        tp.setGain(i, m.on ? m.vol : 0);
      });
      tp.playbackRate = rateRef.current;
      tp.currentTime = lastTime.current;
      l.tp = tp;
      audiosRef.current = [tp as unknown as HTMLAudioElement];
      return tp;
    })();
    l.building = job;
    try {
      return await job;
    } catch (e) {
      console.warn("재생 준비 실패", e);
      return null;
    } finally {
      if (l.building === job) l.building = null;
      if (loadedRef.current === l) setPreparing(null);
    }
  }, []);

  // 기기에 저장된 곡을 열면 잠시 뒤 뒤에서 미리 풀어 둔다 — 첫 ▶ 를 기다리지 않게
  useEffect(() => {
    if (cache.state !== "cached" || !loadedId) return;
    const t = window.setTimeout(() => void prepare(), 1500);
    return () => window.clearTimeout(t);
  }, [cache.state, loadedId, prepare]);

  // 시간 추적 + 구간 반복
  const lastPush = useRef(0);
  useEffect(() => {
    const tick = () => {
      const as = audiosRef.current;
      if (as.length) {
        const t = as[0].currentTime;
        // 상태 갱신은 ~30fps 로 제한한다. 매 프레임 올리면 마디표까지 통째로
        // 다시 그려져 무거워진다 (재생 위치 표시에는 이 정도면 충분).
        const now = performance.now();
        if (now - lastPush.current > 33) {
          lastPush.current = now;
          setTime(Math.max(0, t)); // 예비박 동안은 곡 0초 앞일 수 있다
        }
        if (playing && !as[0].paused) {
          lastTime.current = Math.max(0, t);
          const lp = loopRef.current;
          if (lp && t >= lp.end) {
            const onEnd = loopEndRef.current;
            if (onEnd) {
              // 반복 끝: 멈추고 알린다 — 믹서가 예비박부터 다시 시작한다
              as.forEach((a) => a.pause());
              setPlaying(false);
              onEnd(lp);
            } else as.forEach((a) => (a.currentTime = lp.start));
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  const seek = useCallback((t: number) => {
    const tp = loadedRef.current?.tp;
    if (tp) tp.currentTime = Math.max(0, t); // 오프셋은 재생기가 트랙별로 안다
    lastTime.current = Math.max(0, t);
    setTime(Math.max(0, t));
  }, []);

  // 오프셋을 바꾸면(±10ms) 다시 불러오지 않고 그 자리에서 맞춘다
  const offsetKey = (job?.tracks ?? []).map((t) => `${t.id}:${t.offset_ms}`).join("|");
  useEffect(() => {
    const l = loadedRef.current;
    if (!l?.tp) return;
    l.real.forEach((_, i) => l.tp!.setOffset(i, offOf(i)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsetKey]);

  const play = useCallback(async () => {
    // 소리가 Web Audio 로 나가므로 AudioContext 가 깨어 있어야 들린다 (재생 버튼이 제스처)
    try {
      void audioCtx().resume();
    } catch {
      /* Web Audio 미지원 — 재생할 수 없다 */
    }
    const tp = await prepare();
    if (!tp) throw new Error("재생할 트랙을 준비하지 못했습니다. 기기에 저장을 다시 시도해 주세요.");
    // 한 번에 한 곳에서만 소리가 나게 한다
    liveEngines.forEach((e) => {
      if (e !== selfRef.current) e.stop();
    });
    await tp.play();
    setPlaying(true);
  }, []);

  /**
   * AudioContext 시각 when 에 곡 위치 pos 가 소리 나게 시작한다 (예비박 뒤 진입).
   * 재생기가 준비돼 있어야 한다 (prepare). 성공하면 true.
   */
  const playAt = useCallback((pos: number, when: number): boolean => {
    const tp = loadedRef.current?.tp;
    if (!tp) return false;
    liveEngines.forEach((e) => {
      if (e !== selfRef.current) e.stop();
    });
    tp.startAt(when, pos);
    setPlaying(true);
    return true;
  }, []);

  const pause = useCallback(() => {
    audiosRef.current.forEach((a) => a.pause());
    setPlaying(false);
  }, []);

  const setLoop = useCallback((r: { start: number; end: number } | null) => {
    loopRef.current = r && r.end - r.start > 0.2 ? r : null;
  }, []);

  /** 반복 구간 끝에서 할 일. 주면 그 자리에서 멈추고 부르고, 없으면 반복 시작으로 바로 돌아간다. */
  const setLoopEnd = useCallback((fn: ((lp: { start: number; end: number }) => void) | null) => {
    loopEndRef.current = fn;
  }, []);

  const toggleMute = (i: number) => setMuted((m) => m.map((v2, k) => (k === i ? !v2 : v2)));
  const toggleSolo = (i: number) => setSolo((s) => s.map((v2, k) => (k === i ? !v2 : v2)));
  const setVolume = (i: number, v2: number) => setVol((a) => a.map((x, k) => (k === i ? v2 : x)));

  /** 지금 들리는 트랙 인덱스 (믹스다운에 쓴다) */
  const audibleIndexes = () =>
    tracks.map((_, i) => (mixOf(i).on && mixOf(i).vol > 0 ? i : -1)).filter((i) => i >= 0);

  return {
    tracks,
    loadedId,
    playing,
    time,
    duration,
    rate,
    muted,
    solo,
    vol,
    cache,
    /** 사용자 트랙 목록 (이름·오프셋). 믹서의 트랙 줄 조작에 쓴다 */
    jobTracks: job?.tracks ?? [],
    /** 지금 곡의 스템을 기기에 저장 (받아 두면 다음부터 바로 재생된다) */
    saveToDevice: () => void saveRef.current?.(),
    /** 지금 곡의 기기 저장을 지운다. 재생 위치는 그대로 둔다. */
    removeFromDevice: async () => {
      // 지금 트랙 + 확정 메트로놈의 다른 쪽(4/8비트) 파일까지
      const urls = [
        ...new Set(
          [...(job ? [...tracksOf(job, 1), ...tracksOf(job, 2)] : tracks)].filter((t) => !t.virtual).map((t) => t.url),
        ),
      ];
      audiosRef.current.forEach((a) => a.pause());
      setPlaying(false);
      await removeFromDevice(urls);
      setReloadTick((n) => n + 1);
    },
    setRate,
    play,
    pause,
    seek,
    setLoop,
    setLoopEnd,
    toggleMute,
    toggleSolo,
    setVolume,
    audibleIndexes,
    mixOf,
    audios: audiosRef,
    /** 지금 불러온 곡 (활성 송 맵 버전의 잠금·기준 클릭 보정을 읽는다) */
    job,
    /** 트랙을 푸는 중인가 (done/total) */
    preparing,
    /** 재생 준비 (받기 → 풀기). 준비되면 true. 예비박처럼 시작 시각을 정해 틀 때 먼저 부른다 */
    prepare: async () => !!(await prepare()),
    playAt,
  };
}
