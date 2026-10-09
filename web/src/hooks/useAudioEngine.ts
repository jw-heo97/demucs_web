import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { BASE } from "../api";
import { stemFilesOf } from "../lib/stems";

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

export function tracksOf(job: Job): Track[] {
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
  // 메트로놈은 송 맵이 있으면 언제나 쓸 수 있다 (클릭 파일은 다운로드·믹스 받기용)
  const hasMap = !!(job.songmap as { ranges?: unknown[] } | undefined)?.ranges?.length;
  if (hasMap || best.has("click")) {
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

export function useAudioEngine(job: Job | null, opts: EngineOptions = {}) {
  /**
   * 작업 목록은 1~8초마다 폴링돼 **매번 새 객체**로 온다.
   * `job` 을 그대로 의존성에 두면 폴링할 때마다 오디오 요소를 파괴하고 다시 만들어
   * 재생이 끊긴다. 그래서 실제로 재생할 트랙(파일·수정 시각)이 바뀔 때만 도는 키를 쓴다.
   * 믹스다운 결과처럼 트랙이 아닌 파일이 늘어나는 것은 재생에 영향을 주지 않는다.
   */
  const key = job
    ? `${job.id}:${tracksOf(job).map((t) => `${t.rel}@${t.mtime}`).join("|")}`
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
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;
  const carryRef = useRef(!!opts.carryMix);
  carryRef.current = !!opts.carryMix;
  // 트랙이 바뀌는 순간 직전 믹스 상태를 읽기 위한 사본
  const mixRef = useRef({ tracks, muted, solo, vol });
  mixRef.current = { tracks, muted, solo, vol };
  const audiosRef = useRef<HTMLAudioElement[]>([]);
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

  useEffect(() => {
    const j = jobRef.current;
    // 같은 곡인데 파일만 바뀐 경우(송 맵 저장 → 메트로놈 재생성)에는 듣던 자리를 유지한다.
    // 곡이 바뀌면 처음부터.
    const sameJob = !!j && prevJobId.current === j.id;
    const resumeAt = sameJob ? lastTime.current : 0;
    const prevMix = new Map<string, { muted: boolean; solo: boolean; vol: number }>();
    if (sameJob || carryRef.current) {
      const m = mixRef.current;
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

    const ts = j ? tracksOf(j) : [];
    setTracks(ts);
    setLoadedId(j?.id ?? null);
    setMuted(ts.map((t) => prevMix.get(t.key)?.muted ?? false));
    setSolo(ts.map((t) => prevMix.get(t.key)?.solo ?? false));
    // 스템은 50 에서 시작한다 — 4개를 다 켜면 메트로놈 클릭이 묻힌다. 메트로놈은 100.
    setVol(ts.map((t) => prevMix.get(t.key)?.vol ?? (t.virtual ? 1 : DEFAULT_STEM_VOL)));
    const real = ts.filter((t) => !t.virtual);
    if (!real.length) {
      setDuration(j?.duration ?? 0);
      return;
    }
    // 가상 트랙은 맨 끝이라 audiosRef 의 인덱스는 tracks 의 인덱스와 같다
    audiosRef.current = real.map((t) => {
      const a = new Audio();
      a.preload = "auto"; // 예비박이 끝나는 순간 바로 소리가 나야 한다
      // 같은 오리진일 때 crossOrigin 을 켜면 불필요하게 CORS 모드로 요청된다.
      // 다른 오리진(앱에서 VITE_API_BASE 를 쓸 때)일 때만 켠다.
      if (BASE) a.crossOrigin = "anonymous";
      a.src = t.url;
      // 메타데이터가 오기 전에 정해도 브라우저가 기본 시작 위치로 기억해 둔다
      if (resumeAt > 0) a.currentTime = resumeAt;
      return a;
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
    setDuration(j?.duration ?? 0);
    const created = audiosRef.current;
    return () => {
      m.removeEventListener("loadedmetadata", onMeta);
      m.removeEventListener("ended", onEnded);
      // src 를 비우면 currentTime 이 0 으로 돌아가므로 그 전에 기억해 둔다
      lastTime.current = created[0]?.currentTime ?? 0;
      // 리스너만 떼면 <audio> 가 살아남아 계속 재생된다. 확실히 놓아준다.
      created.forEach((a) => {
        a.pause();
        a.removeAttribute("src");
        a.load();
      });
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

  const applyGains = useCallback(() => {
    audiosRef.current.forEach((a, i) => {
      const m = mixOf(i);
      a.muted = !m.on;
      a.volume = m.vol;
    });
  }, [mixOf]);
  useEffect(applyGains, [applyGains]);

  useEffect(() => {
    audiosRef.current.forEach((a) => {
      // 음정을 유지한 채 속도만 바꾼다 (연습용이라 피치가 변하면 곤란하다)
      a.preservesPitch = true;
      a.playbackRate = rate;
    });
  }, [rate, tracks]);

  // 시간 추적 + 드리프트 보정 + 구간 반복
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
          setTime(t);
        }
        if (playing) {
          for (let i = 1; i < as.length; i++) {
            if (Math.abs(as[i].currentTime - t) > 0.15) as[i].currentTime = t;
          }
          const lp = loopRef.current;
          if (lp && t >= lp.end) as.forEach((a) => (a.currentTime = lp.start));
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  const seek = useCallback((t: number) => {
    audiosRef.current.forEach((a) => (a.currentTime = Math.max(0, t)));
    setTime(Math.max(0, t));
  }, []);

  const play = useCallback(async () => {
    const as = audiosRef.current;
    if (!as.length) return;
    // 한 번에 한 곳에서만 소리가 나게 한다
    liveEngines.forEach((e) => {
      if (e !== selfRef.current) e.stop();
    });
    // 끝까지 들은 뒤 다시 누르면 처음부터
    if (as[0].ended) as.forEach((a) => (a.currentTime = 0));
    const t = as[0].currentTime;
    as.forEach((a) => {
      if (Math.abs(a.currentTime - t) > 0.05) a.currentTime = t;
    });
    // 한 트랙이 실패해도(파일 404, 브라우저의 자동재생 차단) 나머지는 재생한다.
    // 예전엔 Promise.all 이 바로 던져서 playing 이 false 로 남았고, 그러면 ▶ 표시가
    // 그대로인 채 소리는 나고 드리프트 보정·구간 반복도 돌지 않았다.
    const ps = as.map((a) => a.play());
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
  }, []);

  const setLoop = useCallback((r: { start: number; end: number } | null) => {
    loopRef.current = r && r.end - r.start > 0.2 ? r : null;
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
    setRate,
    play,
    prime,
    pause,
    seek,
    setLoop,
    toggleMute,
    toggleSolo,
    setVolume,
    audibleIndexes,
    mixOf,
    audios: audiosRef,
  };
}
