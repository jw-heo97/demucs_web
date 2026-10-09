import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { BASE } from "../api";
import { cachedUrl, download, removeFromDevice } from "../lib/audioCache";
import { audioCtx } from "../lib/audioCtx";
import { stemFilesOf } from "../lib/stems";
import { useSubdiv } from "./useLiveMetronome";
import {
  PRE,
  makeCountInWav,
  makeFullWav,
  renderMix,
  silentWav,
  type CountInClick,
  type MixPcm,
} from "../lib/mixRender";

/**
 * 합친 재생용 <audio> 를 곡 시간으로 보이게 하는 대리 객체. 파일 시각 = 곡 시각 + PRE 라서
 * currentTime 을 읽고 쓸 때만 PRE 를 빼고 더한다. 나머지(이벤트·paused·play…)는 그대로 넘긴다 —
 * 메트로놈·구간 안내·녹음처럼 audios[0].currentTime 을 '곡 위치' 로 읽는 코드가 그대로 돈다.
 */
function songProxy(el: HTMLAudioElement): HTMLAudioElement {
  return new Proxy(el, {
    get(t, prop) {
      if (prop === "currentTime") return t.currentTime - PRE;
      if (prop === "duration") return Math.max(0, t.duration - PRE);
      const v = (t as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set(t, prop, v) {
      if (prop === "currentTime") t.currentTime = Math.max(0, (v as number) + PRE);
      else (t as unknown as Record<string | symbol, unknown>)[prop] = v;
      return true;
    },
  });
}

interface Mixed {
  el: HTMLAudioElement;
  proxy: HTMLAudioElement;
  nodes: AudioNode[];
  sig: string;
  data: MixPcm | null;
  fullUrl: string | null;
  segUrl: string | null;
  /** 지금 예비박 파일(segUrl)을 틀고 있나 */
  usingSeg: boolean;
  active: boolean;
  building: Promise<void> | null;
  buildingSig: string;
}

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
      // 같은 이름으로 다시 구워진 파일(예전 메트로놈처럼)을 <audio> 가 옛 데이터로
      // 들려주지 않게 수정 시각을 붙여 구별한다.
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
  //    같은 방식으로 같이 재생되므로 기기마다 클릭 타이밍이 달라질 일이 없다(즉석 클릭은 기기가
  //    알려주는 재생 위치를 보고 찍어서, 아이패드처럼 그 값이 늦은 기기에선 밀렸다).
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
 * 첫 트랙을 마스터 시계로 삼고, 0.15초 이상 벌어진 트랙만 맞춘다
 * (매 프레임 맞추면 오히려 소리가 튄다).
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

/** 재생 중 <audio> 위치를 옮길 때의 지연(초). 기기마다 달라 배운 값을 기억한다 */
const LS_SEEK_LAG = "audio.seekLag";
function loadSeekLag() {
  try {
    const v = Number(localStorage.getItem(LS_SEEK_LAG));
    return Number.isFinite(v) && v >= 0 && v <= 0.3 ? v : 0.08;
  } catch {
    return 0.08;
  }
}

export function useAudioEngine(job: Job | null, opts: EngineOptions = {}) {
  /**
   * 작업 목록은 1~8초마다 폴링돼 **매번 새 객체**로 온다.
   * `job` 을 그대로 의존성에 두면 폴링할 때마다 오디오 요소를 파괴하고 다시 만들어
   * 재생이 끊긴다. 그래서 실제로 재생할 트랙(파일·수정 시각)이 바뀔 때만 도는 키를 쓴다.
   * 믹스다운 결과처럼 트랙이 아닌 파일이 늘어나는 것은 재생에 영향을 주지 않는다.
   */
  // 기기 저장을 지우면 이 값을 올려 트랙을 다시 불러온다 (스트리밍으로 돌아간다)
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
  /** 기기 저장 상태: 확인 중 / 저장 안 함(스트리밍) / 받는 중(pct) / 재생 중이라 쉬는 중 / 저장됨 / 받기 실패 */
  const [cache, setCache] = useState<{
    state: "checking" | "none" | "downloading" | "waiting" | "cached" | "stream";
    pct: number;
  }>({
    state: "checking",
    pct: 0,
  });
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;
  const carryRef = useRef(!!opts.carryMix);
  carryRef.current = !!opts.carryMix;
  // 트랙이 바뀌는 순간 직전 믹스 상태를 읽기 위한 사본
  const mixStateRef = useRef({ tracks, muted, solo, vol });
  mixStateRef.current = { tracks, muted, solo, vol };
  const audiosRef = useRef<HTMLAudioElement[]>([]);
  /**
   * 트랙마다 Web Audio 게인 (audiosRef 와 같은 순서). 스템도 메트로놈 클릭과 같은 AudioContext 로
   * 내보낸다 — 예전엔 <audio> 가 직접 스피커로 나가고 클릭은 Web Audio 로 나가서, 두 길이 스피커에
   * 닿는 시간이 기기마다 달랐다(아이패드에서 클릭 타이밍이 컴퓨터와 다름). 같은 길이면 기기 차이가
   * 함께 움직인다. 덤으로 iOS 에서도 볼륨이 먹는다(iOS 는 <audio>.volume 을 무시한다).
   * Web Audio 를 못 쓰면 null — 그때는 예전처럼 <audio> 로 직접 낸다.
   */
  const gainsRef = useRef<(GainNode | null)[]>([]);
  /** 트랙별 <audio> (audiosRef 는 합친 재생으로 바뀌면 [합친 것] 하나가 된다) */
  const trackElsRef = useRef<HTMLAudioElement[]>([]);
  /** 합친 재생 (기기에 저장된 곡) — lib/mixRender 참고 */
  const mixRef = useRef<Mixed | null>(null);
  const [mixBusy, setMixBusy] = useState(false);
  const [mixOn, setMixOn] = useState(false);
  // audiosRef 와 같은 순서의 실제 트랙 (오프셋을 찾는 데 쓴다)
  const realRef = useRef<Track[]>([]);
  /** 트랙 i 의 오프셋(초): 트랙의 0초가 곡의 몇 초인지. 스템은 0. job.tracks 에서 그때그때 읽는다 */
  const offOf = (i: number) => {
    const fixed = realRef.current[i]?.offsetMs;
    if (typeof fixed === "number") return fixed / 1000;
    const id = realRef.current[i]?.trackId;
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
      // 화면을 떠나면 소리도 멈춘다 — 안 그러면 컴포넌트만 사라지고
      // <audio> 는 계속 재생돼 손댈 수 없는 소리가 남는다.
      me.stop();
    };
  }, []);
  const rafRef = useRef(0);
  const loopRef = useRef<{ start: number; end: number } | null>(null);
  // 지금 곡을 기기에 저장하기 시작 (트랙을 불러올 때 만들어진다)
  const saveRef = useRef<(() => void) | null>(null);
  const loopEndRef = useRef<((lp: { start: number; end: number }) => void) | null>(null);

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
    audiosRef.current.forEach((a) => {
      a.pause();
      a.removeAttribute("src");
      a.load();
    });
    audiosRef.current = [];
    setPlaying(false);
    setTime(resumeAt);

    const ts = j ? tracksOf(j, subdivRef.current) : [];
    setTracks(ts);
    setLoadedId(j?.id ?? null);
    setMuted(ts.map((t) => prevMix.get(t.key)?.muted ?? false));
    setSolo(ts.map((t) => prevMix.get(t.key)?.solo ?? false));
    // 스템은 50 에서 시작한다 — 4개를 다 켜면 메트로놈 클릭이 묻힌다. 메트로놈은 100.
    setVol(ts.map((t) => prevMix.get(t.key)?.vol ?? (t.key === "click" ? 1 : DEFAULT_STEM_VOL)));
    const real = ts.filter((t) => !t.virtual);
    realRef.current = real;
    if (!real.length) {
      setDuration(j?.duration ?? 0);
      return;
    }
    // 가상 트랙은 맨 끝이라 audiosRef 의 인덱스는 tracks 의 인덱스와 같다
    audiosRef.current = real.map(() => {
      const a = new Audio();
      a.preload = "auto"; // 예비박이 끝나는 순간 바로 소리가 나야 한다
      // 같은 오리진일 때 crossOrigin 을 켜면 불필요하게 CORS 모드로 요청된다.
      // 다른 오리진(앱에서 VITE_API_BASE 를 쓸 때)일 때만 켠다.
      if (BASE) a.crossOrigin = "anonymous";
      return a;
    });
    const created = audiosRef.current;
    trackElsRef.current = created;
    const nodes: AudioNode[] = [];
    // 합친 재생용 <audio> (기기에 저장된 곡에서 ▶ 를 누르면 처음 합쳐서 이걸로 바꾼다)
    {
      const el = new Audio();
      el.preload = "auto";
      const mn: AudioNode[] = [];
      try {
        const ctx = audioCtx();
        const src = ctx.createMediaElementSource(el);
        const g = ctx.createGain();
        src.connect(g).connect(ctx.destination);
        mn.push(src, g);
      } catch {
        /* Web Audio 가 없으면 합친 재생은 쓰지 않는다 */
      }
      mixRef.current = {
        el, proxy: songProxy(el), nodes: mn, sig: "", data: null, fullUrl: null, segUrl: null,
        usingSeg: false, active: false, building: null, buildingSig: "",
      };
      setMixOn(false);
      setMixBusy(false);
    }
    const mixed = mixRef.current!;
    gainsRef.current = created.map((a) => {
      try {
        const ctx = audioCtx();
        const src = ctx.createMediaElementSource(a);
        const g = ctx.createGain();
        src.connect(g).connect(ctx.destination);
        nodes.push(src, g);
        return g;
      } catch {
        return null;
      }
    });

    // 기기에 받아 둔 파일이 있으면 그걸로(정지·이동·재생 때 네트워크를 안 탄다), 없으면 일단
    // 서버에서 스트리밍하면서 뒤에서 통째로 받아 두고, 다 받으면 멈춰 있을 때 바꿔 끼운다.
    let alive = true;
    const abort = new AbortController();
    const swapTo: (string | null)[] = real.map(() => null);
    // 확정 메트로놈은 4비트·8비트 파일이 따로라, 저장할 때 안 쓰는 쪽도 받아 둔다 (바꿔도 다시 안 받게)
    const prefetchAltClick = async () => {
      if (!j) return;
      const mine = real.find((t) => t.key === "click")?.url;
      const other = tracksOf(j, subdivRef.current === 2 ? 1 : 2).find((t) => t.key === "click" && !t.virtual);
      if (!other || other.url === mine || !alive) return;
      if (await cachedUrl(other.url)) return;
      try {
        await download(other.url, undefined, abort.signal, "low");
      } catch {
        /* 다음에 다시 */
      }
    };
    const trySwap = () => {
      if (!alive || swapTo.some((u) => !u)) return;
      if (created.some((a) => !a.paused)) return; // 재생 중이면 다음에 멈출 때
      const at = created[0].currentTime;
      created.forEach((a, i) => {
        a.src = swapTo[i]!;
        a.currentTime = at;
      });
      setCache({ state: "cached", pct: 100 });
    };
    let onPlayEv: (() => void) | null = null;
    let onPauseEv: (() => void) | null = null;
    setCache({ state: "checking", pct: 0 });
    void (async () => {
      const hits = await Promise.all(real.map((t) => cachedUrl(t.url)));
      if (!alive) return;
      created.forEach((a, i) => {
        a.src = hits[i] ?? real[i].url;
        // 메타데이터가 오기 전에 정해도 브라우저가 기본 시작 위치로 기억해 둔다
        const at = resumeAt - offOf(i);
        if (at > 0) a.currentTime = at;
      });
      if (hits.every(Boolean)) {
        setCache({ state: "cached", pct: 100 });
        void prefetchAltClick();
        return;
      }
      hits.forEach((h, i) => {
        if (h) swapTo[i] = h;
      });

      // 기기에 저장은 믹서의 '기기에 저장' 을 눌렀을 때만 한다(saveToDevice). 평소에는 스트리밍.
      // 받는 동안에도 듣고 보는 게 먼저다 — 원격(LTE·Tailscale)에서 4개를 한꺼번에 최대 속도로
      // 받으면 회선을 다 차지해 재생 스트리밍·악보 이미지가 멈췄다.
      //  - 한 번에 하나씩, 브라우저에 낮은 우선순위로 요청한다
      //  - 재생 중에는 받기를 멈추고(스트리밍에 회선을 준다) 멈추면 받던 데부터 이어 받는다
      const queue = real.map((_, i) => i).filter((i) => !hits[i]);
      const n = real.length;
      let doneCount = n - queue.length;
      let cur: AbortController | null = null;
      let running = false;
      const show = (frac: number) => {
        if (!alive) return;
        const pct = Math.min(99, Math.floor(((doneCount + frac) / n) * 100));
        setCache({ state: created[0].paused ? "downloading" : "waiting", pct });
      };
      const run = async () => {
        if (running || !alive) return;
        running = true;
        try {
          while (alive && queue.length) {
            if (!created[0].paused) {
              show(0);
              return; // 재생 중 — 멈추면(onPause) 다시 시작한다
            }
            const i = queue[0];
            cur = new AbortController();
            const stop = () => cur?.abort();
            abort.signal.addEventListener("abort", stop);
            try {
              swapTo[i] = await download(real[i].url, (g, tot) => show(tot ? g / tot : 0), cur.signal, "low");
              queue.shift();
              doneCount += 1;
            } catch (e) {
              if (cur.signal.aborted) return; // 재생을 시작했거나 곡을 바꿨다
              throw e;
            } finally {
              abort.signal.removeEventListener("abort", stop);
              cur = null;
            }
          }
          if (alive && !queue.length) {
            trySwap();
            void prefetchAltClick();
          }
        } catch {
          // 받기에 실패해도 스트리밍으로는 계속 들을 수 있다 — 버튼으로 다시 시도할 수 있게
          if (alive) setCache({ state: "stream", pct: 0 });
          started = false;
        } finally {
          running = false;
        }
      };
      // 멈추고 3초가 지나야 다시 받는다 — 재생 버튼을 누르면 예비박 동안은 음악이 멈춰 있고
      // (iOS 잠금 풀기로 잠깐 재생·정지도 한다), 그 사이에 받기 시작하면 첫 재생과 회선을 다툰다.
      let resumeTimer = 0;
      onPlayEv = () => {
        clearTimeout(resumeTimer);
        cur?.abort();
        show(0);
      };
      onPauseEv = () => {
        clearTimeout(resumeTimer);
        if (!queue.length) return trySwap();
        resumeTimer = window.setTimeout(() => {
          if (created[0].paused) void run();
        }, 3000);
      };
      abort.signal.addEventListener("abort", () => clearTimeout(resumeTimer));
      let started = false;
      saveRef.current = () => {
        if (started || !alive) return;
        started = true;
        created[0].addEventListener("play", onPlayEv!);
        created[0].addEventListener("pause", onPauseEv!);
        if (created[0].paused) void run();
        else show(0); // 재생 중이면 멈춘 뒤에 받는다
      };
      setCache({ state: "none", pct: Math.floor((doneCount / n) * 100) });
      // 이미 일부를 저장해 둔 곡이면(예: 확정 메트로놈이 파일 트랙이 되면서 한 개가 새로 생겼다)
      // 버튼을 다시 누르지 않아도 빠진 것만 이어 받는다 — 예전엔 80% 저장됨에 머물렀다
      if (hits.some(Boolean)) saveRef.current?.();
    })().catch(() => {
      if (alive) setCache({ state: "stream", pct: 0 });
    });

    const m = audiosRef.current[0];
    const onMeta = () => setDuration(m.duration || j?.duration || 0);
    // 곡이 끝나면 멈춘 상태로 돌린다. 안 그러면 ❚❚ 가 그대로 남아 첫 누름이 헛되이 "일시정지"가 된다.
    const onEnded = () => {
      audiosRef.current.forEach((a) => a.pause());
      setPlaying(false);
      onEndedRef.current?.();
    };
    m.addEventListener("loadedmetadata", onMeta);
    m.addEventListener("ended", onEnded);
    mixed.el.addEventListener("ended", onEnded);
    setDuration(j?.duration ?? 0);
    return () => {
      alive = false;
      saveRef.current = null;
      abort.abort();
      if (onPlayEv) m.removeEventListener("play", onPlayEv);
      if (onPauseEv) m.removeEventListener("pause", onPauseEv);
      m.removeEventListener("loadedmetadata", onMeta);
      m.removeEventListener("ended", onEnded);
      mixed.el.removeEventListener("ended", onEnded);
      // src 를 비우면 currentTime 이 0 으로 돌아가므로 그 전에 기억해 둔다
      lastTime.current = Math.max(0, (mixed.active ? mixed.proxy.currentTime : created[0]?.currentTime) ?? 0);
      mixed.el.pause();
      mixed.el.removeAttribute("src");
      mixed.el.load();
      if (mixed.fullUrl) URL.revokeObjectURL(mixed.fullUrl);
      if (mixed.segUrl) URL.revokeObjectURL(mixed.segUrl);
      mixed.data = null;
      mixed.nodes.forEach((n) => n.disconnect());
      if (mixRef.current === mixed) mixRef.current = null;
      // 리스너만 떼면 <audio> 가 살아남아 계속 재생된다. 확실히 놓아준다.
      created.forEach((a) => {
        a.pause();
        a.removeAttribute("src");
        a.load();
      });
      nodes.forEach((n) => n.disconnect());
      setPlaying(false);
    };
  }, [key]);

  /** 트랙 i 가 지금 들리는지(음소거·솔로 반영)와 볼륨. 가상 트랙(메트로놈)도 같은 규칙. */
  const mixOf = useCallback(
    (i: number) => {
      const anySolo = solo.some(Boolean);
      return { on: anySolo ? !!solo[i] : !muted[i], vol: vol[i] ?? 1 };
    },
    [muted, solo, vol],
  );
  // 합친 재생이 '지금 설정' 을 읽는 곳 (콜백들이 첫 렌더 것을 쥐고 있어도 최신 값을 보게)
  const mixOfLatest = useRef(mixOf);
  mixOfLatest.current = mixOf;

  const applyGains = useCallback(() => {
    if (mixRef.current?.active) return; // 합친 재생 — 볼륨은 합칠 때 들어간다(아래에서 다시 합친다)
    audiosRef.current.forEach((a, i) => {
      const m = mixOf(i);
      const g = gainsRef.current[i];
      if (g) {
        a.muted = false;
        a.volume = 1;
        g.gain.setTargetAtTime(m.on ? m.vol : 0, g.context.currentTime, 0.01);
      } else {
        a.muted = !m.on;
        a.volume = Math.min(1, m.vol); // <audio> 는 1 을 넘을 수 없다 (메트로놈은 600% 까지)
      }
    });
  }, [mixOf]);
  useEffect(applyGains, [applyGains]);

  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    const els = [...trackElsRef.current, ...(mixRef.current ? [mixRef.current.el] : [])];
    els.forEach((a) => {
      // 음정을 유지한 채 속도만 바꾼다 (연습용이라 피치가 변하면 곤란하다)
      a.preservesPitch = true;
      a.playbackRate = rate;
    });
  }, [rate, tracks]);

  // 시간 추적 + 드리프트 보정 + 구간 반복
  const lastPush = useRef(0);
  // 트랙별로 마지막으로 위치를 맞춘 시각 (너무 자주 맞추면 소리가 튄다)
  const lastFix = useRef<number[]>([]);
  // 재생 중 위치를 옮길 때 생기는 지연(초)과, 옮긴 뒤 오차를 잴 시각
  const seekLag = useRef(loadSeekLag());
  const seekCheck = useRef<({ at: number } | undefined)[]>([]);
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
          setTime(Math.max(0, t)); // 합친 재생의 예비박 동안은 곡 0초 앞일 수 있다
        }
        // 마스터(첫 트랙)가 멈춰 있으면 나머지를 다시 틀지 않는다. 예전엔 일시정지 직후 화면이
        // 다시 그려지기 전 프레임(playing 이 아직 true)에서 '멈춘 트랙 = 다시 틀어야 할 트랙' 으로
        // 보고 마스터 외 트랙을 되살려, 일시정지했는데 소리가 계속 났다 (iPad).
        if (playing && !as[0].paused) {
          for (let i = 1; i < as.length; i++) {
            const want = t - offOf(i);
            const a = as[i];
            if (want < 0) {
              // 트랙이 시작되기 전 (녹음을 곡 중간부터 했거나 오프셋이 뒤에 있다)
              if (!a.paused) a.pause();
              continue;
            }
            const custom = !!realRef.current[i]?.trackId;
            // 재생 중인 <audio> 의 위치를 옮기거나 뒤늦게 play() 하면 디코더가 다시 준비되는 동안
            // (~80ms) 멈춰 있어 그만큼 늘 뒤처진다 — 스템끼리는 함께 play() 해서 지연이 같아 안 보인다.
            // 사용자 트랙(녹음)은 박을 맞추는 게 목적이라, 그 지연만큼 앞을 겨냥해 옮기고
            // 0.6초 뒤 실제 오차로 지연값을 배운다 (처음 값은 브라우저에 기억해 둔 것).
            const check = seekCheck.current[i];
            if (check && now >= check.at && !a.paused) {
              seekCheck.current[i] = undefined;
              const err = want - a.currentTime; // + 면 아직 뒤처져 있다 → 지연을 더 크게 본다
              if (Math.abs(err) < 0.5) {
                seekLag.current = Math.max(0, Math.min(0.3, seekLag.current + err * 0.7));
                try {
                  localStorage.setItem(LS_SEEK_LAG, seekLag.current.toFixed(4));
                } catch {
                  /* 기억만 못 할 뿐 */
                }
              }
            }
            if (a.paused && !a.ended) {
              a.currentTime = want + (custom ? seekLag.current : 0);
              a.play().catch(() => {});
              lastFix.current[i] = now;
              if (custom) seekCheck.current[i] = { at: now + 600 };
            } else {
              const tol = custom ? 0.04 : 0.15;
              if (Math.abs(a.currentTime - want) > tol && now - (lastFix.current[i] ?? 0) > 1000) {
                a.currentTime = want + (custom ? seekLag.current : 0);
                lastFix.current[i] = now;
                if (custom) seekCheck.current[i] = { at: now + 600 };
              }
            }
          }
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
    // 예비박 파일을 틀던 중이면 곡 전체 파일로 돌아가서 옮긴다 (예비박 파일은 그 위치 앞이 조용하다)
    const m = mixRef.current;
    if (m?.active && m.usingSeg && m.fullUrl) switchSrc(m, m.fullUrl, Math.max(0, t), false);
    audiosRef.current.forEach((a, i) => (a.currentTime = Math.max(0, t - offOf(i))));
    setTime(Math.max(0, t));
  }, []);

  // 오프셋을 바꾸면(±10ms) 다시 불러오지 않고 그 자리에서 맞춘다
  const offsetKey = (job?.tracks ?? []).map((t) => `${t.id}:${t.offset_ms}`).join("|");
  useEffect(() => {
    const as = audiosRef.current;
    if (!as.length) return;
    const t = as[0].currentTime;
    as.forEach((a, i) => {
      if (i === 0) return;
      const want = t - offOf(i);
      if (want >= 0) a.currentTime = want;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsetKey]);

  // ---------------- 합친 재생 ----------------
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const mixOfRef = mixOfLatest;
  /** 지금 설정으로 합칠 재료 (기기에 저장된 트랙만) */
  const mixSources = () =>
    trackElsRef.current.map((a, i) => {
      const m = mixOfRef.current(i);
      return { url: a.src, gain: m.on ? m.vol : 0, offsetSec: offOf(i) };
    });
  const canMix = () =>
    cacheRef.current.state === "cached" && !!mixRef.current?.nodes.length && trackElsRef.current.length > 0;

  /** 합친 재생으로 바꾼다 (트랙별 <audio> 는 멈추고, 같은 자리에서 이어간다) */
  const switchSrc = (m: Mixed, url: string, songPos: number, seg: boolean) => {
    m.el.src = url;
    m.el.preservesPitch = true;
    m.el.playbackRate = rateRef.current;
    m.proxy.currentTime = songPos;
    m.usingSeg = seg;
  };
  const activate = (m: Mixed) => {
    if (m.active || !m.fullUrl) return;
    const pos = trackElsRef.current[0]?.currentTime ?? 0;
    trackElsRef.current.forEach((a) => a.pause());
    switchSrc(m, m.fullUrl, pos, false);
    audiosRef.current = [m.proxy];
    m.active = true;
    setMixOn(true);
  };
  /** 지금 설정대로 합쳐 둔다 (같은 설정이면 그대로). 재생 중이면 다 합친 뒤 그 자리에서 바꿔 낀다 */
  const ensureMix = useCallback(async () => {
    const m = mixRef.current;
    if (!m) return;
    const src = mixSources();
    const sig = JSON.stringify(src.map((x) => [x.url, Math.round(x.gain * 1000), Math.round(x.offsetSec * 1e4)]));
    if (m.data && m.sig === sig) return;
    if (m.building && m.buildingSig === sig) return m.building;
    setMixBusy(true);
    const job = (async () => {
      const data = await renderMix(audioCtx(), src);
      if (mixRef.current !== m) return;
      const old = m.fullUrl;
      m.data = data;
      m.sig = sig;
      m.fullUrl = makeFullWav(data);
      if (m.active) {
        const pos = m.proxy.currentTime;
        const wasPlaying = !m.el.paused;
        switchSrc(m, m.fullUrl, pos, false);
        if (m.segUrl) URL.revokeObjectURL(m.segUrl);
        m.segUrl = null;
        if (wasPlaying) await m.el.play().catch(() => {});
      }
      if (old) URL.revokeObjectURL(old);
    })();
    m.building = job;
    m.buildingSig = sig;
    try {
      await job;
    } finally {
      if (m.building === job) {
        m.building = null;
        setMixBusy(false);
      }
    }
  }, []);

  // 기기에 저장된 곡을 열면 잠시 뒤 뒤에서 미리 합쳐 둔다 — 첫 ▶ 를 기다리지 않게
  useEffect(() => {
    if (cache.state !== "cached" || !loadedId) return;
    const t = window.setTimeout(() => {
      if (canMix()) void ensureMix().catch(() => {});
    }, 1500);
    return () => window.clearTimeout(t);
  }, [cache.state, loadedId, ensureMix]);

  // 합친 재생 중에 음소거·솔로·볼륨·오프셋을 바꾸면 손을 뗀 뒤 다시 합쳐 그 자리에서 바꿔 낀다
  useEffect(() => {
    if (!mixRef.current?.active) return;
    const t = window.setTimeout(() => void ensureMix(), 600);
    return () => window.clearTimeout(t);
  }, [mixOf, job?.tracks, ensureMix]);

  const play = useCallback(async () => {
    // 기기에 저장된 곡이면 합친 재생 — 처음 한 번 합치는 데 1~3초
    const m = mixRef.current;
    if (m && canMix()) {
      try {
        await ensureMix();
        activate(m);
        if (m.usingSeg && m.fullUrl) switchSrc(m, m.fullUrl, Math.max(0, m.proxy.currentTime), false);
      } catch (e) {
        console.warn("합친 재생 실패 — 트랙별로 재생합니다", e);
      }
    }
    return startPlaying();
  }, []);

  /**
   * 예비박부터: 곡 위치 pos 앞은 조용하고 예비박 클릭이 들어 있는 파일을 합친 재생으로 튼다.
   * 클릭과 음악이 한 파일이라 기기와 상관없이 마지막 클릭 → 1마디 1박이 정확히 한 박이다.
   */
  /** 예비박 파일을 만들어 끼워 둔다 (멈춘 채, 곡 위치 at 에). 성공하면 true */
  const prepareCountIn = useCallback(
    async (pos: number, clicks: CountInClick[], peak: number, at: number): Promise<boolean> => {
      const m = mixRef.current;
      if (!m || !canMix()) return false;
      await ensureMix();
      activate(m);
      if (!m.data) return false;
      const url = await makeCountInWav(m.data, pos, clicks, peak);
      if (m.segUrl) URL.revokeObjectURL(m.segUrl);
      m.segUrl = url;
      m.el.pause();
      switchSrc(m, url, at, true);
      return true;
    },
    [],
  );

  const playCountIn = useCallback(async (pos: number, clicks: CountInClick[], peak: number) => {
    const s0 = Math.min(pos, clicks.length ? clicks[0].t - 0.15 : pos);
    if (!(await prepareCountIn(pos, clicks, peak, s0))) return startPlaying();
    return startPlaying();
  }, []);

  const startPlaying = useCallback(async () => {
    const as = audiosRef.current;
    if (!as.length) return;
    // 한 번에 한 곳에서만 소리가 나게 한다
    liveEngines.forEach((e) => {
      if (e !== selfRef.current) e.stop();
    });
    // 소리가 Web Audio 로 나가므로 AudioContext 가 깨어 있어야 들린다 (재생 버튼이 제스처)
    try {
      void audioCtx().resume();
    } catch {
      /* Web Audio 미지원 — <audio> 로 직접 나간다 */
    }
    // 끝까지 들은 뒤 다시 누르면 처음부터
    if (as[0].ended) as.forEach((a) => (a.currentTime = 0));
    const t = as[0].currentTime;
    const ps: Promise<void>[] = [];
    as.forEach((a, i) => {
      const want = t - offOf(i);
      // 아직 시작 전인 트랙 — 때가 되면 tick 이 튼다. 마스터(0번)는 예외: 합친 재생의 예비박 동안은
      // 곡 위치가 0 보다 앞(음수)이라 이 규칙에 걸려 재생이 안 됐다
      if (want < 0 && i > 0) {
        a.pause();
        return;
      }
      if (Math.abs(a.currentTime - want) > 0.05) a.currentTime = want;
      ps.push(a.play());
    });
    // 한 트랙이 실패해도(파일 404, 브라우저의 자동재생 차단) 나머지는 재생한다.
    // 예전엔 Promise.all 이 바로 던져서 playing 이 false 로 남았고, 그러면 ▶ 표시가
    // 그대로인 채 소리는 나고 드리프트 보정·구간 반복도 돌지 않았다.
    // 한 트랙이라도 시작되면 재생 중이다. 전부를 기다리면 아직 받는 중인 트랙 하나(느린 회선,
    // 연결 수 한도) 때문에 ▶ 표시·반복·보정이 그 트랙이 올 때까지 멈춰 있었다.
    try {
      await Promise.any(ps);
    } catch (e) {
      setPlaying(false);
      const reason = ((e as AggregateError).errors?.[0] ?? e) as { name?: string; message?: string };
      throw new Error(
        reason?.name === "NotAllowedError"
          ? "브라우저가 재생을 막았습니다. 재생 버튼을 다시 눌러 주세요."
          : `재생할 수 없습니다: ${reason?.message ?? String(reason)}`,
      );
    }
    setPlaying(true);
    void Promise.allSettled(ps).then((rs) => {
      const failed = rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length) console.warn("일부 트랙 재생 실패", failed.map((f) => f.reason));
    });
  }, []);

  /**
   * iOS Safari 는 사용자 제스처 안에서 play() 가 한 번 불린 요소만 나중에(타이머 등에서)
   * 재생을 허용한다. 예비박은 setTimeout 뒤에 재생을 시작하므로, 버튼을 누른 그 순간에
   * 모든 트랙을 한 번 재생·정지해 미리 풀어둔다. 즉시 멈추므로 소리는 나지 않는다.
   */
  const prime = useCallback(() => {
    // 합친 재생용 요소도 제스처 안에서 한 번 풀어 둔다 (iOS — 합치는 데 시간이 걸려 재생은 나중에 된다)
    const m = mixRef.current;
    if (m && !m.el.src) {
      m.el.src = silentWav();
      const p = m.el.play();
      m.el.pause();
      p?.catch(() => {});
    }
    audiosRef.current.forEach((a) => {
      const p = a.play();
      a.pause();
      p?.catch(() => {
        /* pause() 로 끊어서 나는 AbortError — 의도한 것 */
      });
    });
  }, []);

  const pause = useCallback(() => {
    audiosRef.current.forEach((a) => a.pause());
    setPlaying(false);
    // 예비박 파일이었으면 같은 자리의 곡 전체 파일로 돌려 둔다 (다음 재생·앞으로 이동이 정상이게)
    const m = mixRef.current;
    if (m?.active && m.usingSeg && m.fullUrl) switchSrc(m, m.fullUrl, Math.max(0, m.proxy.currentTime), false);
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
    /** 지금 곡의 스템을 기기에 저장 (이후 정지·이동·재생 때 네트워크를 안 탄다) */
    saveToDevice: () => saveRef.current?.(),
    /** 지금 곡의 기기 저장을 지운다. 재생 위치는 그대로 두고 스트리밍으로 돌아간다. */
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
    prime,
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
    /** 합친 재생을 쓸 수 있나 (기기에 저장된 곡) / 지금 합친 재생 중인가 / 합치는 중인가 */
    canMix: cache.state === "cached" && !!mixRef.current?.nodes.length,
    mixOn,
    mixBusy,
    playCountIn,
  };
}
