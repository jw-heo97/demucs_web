import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, JobFile } from "../types";
import { BASE } from "../api";

export interface Track {
  key: string;
  label: string;
  url: string;
  rel: string;
  mtime: number;
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
  const best = new Map<string, { file: JobFile; mp3: boolean }>();
  for (const f of job.files || []) {
    const m = /_(no_)?(drums|bass|vocals|other|click)\.(mp3|wav)$/i.exec(f.name);
    if (!m) continue;
    const key = (m[1] ? "no_" : "") + m[2].toLowerCase();
    const isMp3 = m[3].toLowerCase() === "mp3";
    const prev = best.get(key);
    // mp3 우선 — 용량이 작아 스트리밍이 빠르다
    if (!prev || (isMp3 && !prev.mp3)) best.set(key, { file: f, mp3: isMp3 });
  }
  const plain = ["drums", "bass", "vocals", "other"].filter((k) => best.has(k));
  let keys = plain.length >= 2 ? plain : [...best.keys()].filter((k) => k !== "click");
  if (best.has("click")) keys = [...keys, "click"];
  return keys.map((k) => {
    const f = best.get(k)!.file;
    return {
      key: k,
      label: LABEL[k] ?? k,
      // 메트로놈은 송 맵을 저장할 때마다 같은 이름으로 다시 구워진다. URL 이 같으면
      // <audio> 가 이미 받아둔 옛 데이터를 그대로 들려주므로 수정 시각을 붙여 구별한다.
      url: `${BASE}${f.url}?v=${f.mtime ?? 0}`,
      rel: f.rel,
      mtime: f.mtime ?? 0,
    };
  });
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
export function useAudioEngine(job: Job | null) {
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
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState<boolean[]>([]);
  const [solo, setSolo] = useState<boolean[]>([]);
  const [vol, setVol] = useState<number[]>([]);
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
    const resumeAt = j && prevJobId.current === j.id ? lastTime.current : 0;
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
    setMuted(ts.map(() => false));
    setSolo(ts.map(() => false));
    setVol(ts.map(() => 1));
    if (!ts.length) {
      setDuration(j?.duration ?? 0);
      return;
    }
    audiosRef.current = ts.map((t) => {
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
    m.addEventListener("loadedmetadata", onMeta);
    setDuration(j?.duration ?? 0);
    const created = audiosRef.current;
    return () => {
      m.removeEventListener("loadedmetadata", onMeta);
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

  const applyGains = useCallback(() => {
    const anySolo = solo.some(Boolean);
    audiosRef.current.forEach((a, i) => {
      a.muted = anySolo ? !solo[i] : muted[i];
      a.volume = vol[i] ?? 1;
    });
  }, [muted, solo, vol]);
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
    const t = as[0].currentTime;
    as.forEach((a) => {
      if (Math.abs(a.currentTime - t) > 0.05) a.currentTime = t;
    });
    // 한 트랙이 실패해도(파일 404, 브라우저의 자동재생 차단) 나머지는 재생한다.
    // 예전엔 Promise.all 이 바로 던져서 playing 이 false 로 남았고, 그러면 ▶ 표시가
    // 그대로인 채 소리는 나고 드리프트 보정·구간 반복도 돌지 않았다.
    const results = await Promise.allSettled(as.map((a) => a.play()));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === as.length) {
      setPlaying(false);
      const reason = failed[0].reason as { name?: string; message?: string } | undefined;
      throw new Error(
        reason?.name === "NotAllowedError"
          ? "브라우저가 재생을 막았습니다. 재생 버튼을 다시 눌러 주세요."
          : `재생할 수 없습니다: ${reason?.message ?? String(reason)}`,
      );
    }
    if (failed.length) console.warn("일부 트랙 재생 실패", failed.map((f) => f.reason));
    setPlaying(true);
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
  const audibleIndexes = () => {
    const anySolo = solo.some(Boolean);
    return tracks
      .map((_, i) => ((anySolo ? solo[i] : !muted[i]) && (vol[i] ?? 1) > 0 ? i : -1))
      .filter((i) => i >= 0);
  };

  return {
    tracks,
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
    audios: audiosRef,
  };
}
