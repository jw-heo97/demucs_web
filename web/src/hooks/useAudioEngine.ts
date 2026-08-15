import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { BASE } from "../api";

export interface Track {
  key: string;
  label: string;
  url: string;
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
  const best = new Map<string, { url: string; mp3: boolean }>();
  for (const f of job.files || []) {
    const m = /_(no_)?(drums|bass|vocals|other|click)\.(mp3|wav)$/i.exec(f.name);
    if (!m) continue;
    const key = (m[1] ? "no_" : "") + m[2].toLowerCase();
    const isMp3 = m[3].toLowerCase() === "mp3";
    const prev = best.get(key);
    // mp3 우선 — 용량이 작아 스트리밍이 빠르다
    if (!prev || (isMp3 && !prev.mp3)) best.set(key, { url: f.url, mp3: isMp3 });
  }
  const plain = ["drums", "bass", "vocals", "other"].filter((k) => best.has(k));
  let keys = plain.length >= 2 ? plain : [...best.keys()].filter((k) => k !== "click");
  if (best.has("click")) keys = [...keys, "click"];
  return keys.map((k) => ({ key: k, label: LABEL[k] ?? k, url: BASE + best.get(k)!.url }));
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
   * 재생이 끊긴다. 그래서 실제로 트랙 구성이 바뀔 때만 도는 키를 쓴다.
   */
  const key = job ? `${job.id}:${(job.files ?? []).map((f) => f.rel).join("|")}` : "";
  const jobRef = useRef(job);
  jobRef.current = job;
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
    audiosRef.current.forEach((a) => {
      a.pause();
      a.removeAttribute("src");
      a.load();
    });
    audiosRef.current = [];
    setPlaying(false);
    setTime(0);

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
      // 같은 오리진일 때 crossOrigin 을 켜면 불필요하게 CORS 모드로 요청돼
      // 인증 쿠키가 안 실려 재생이 막힌다. 다른 오리진(앱)일 때만 켠다.
      if (BASE) a.crossOrigin = "use-credentials";
      a.src = t.url;
      return a;
    });
    const m = audiosRef.current[0];
    const onMeta = () => setDuration(m.duration || j?.duration || 0);
    m.addEventListener("loadedmetadata", onMeta);
    setDuration(j?.duration ?? 0);
    const created = audiosRef.current;
    return () => {
      m.removeEventListener("loadedmetadata", onMeta);
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
    await Promise.all(as.map((a) => a.play()));
    setPlaying(true);
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
