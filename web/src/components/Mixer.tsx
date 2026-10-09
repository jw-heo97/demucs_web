import { useEffect, useRef, useState } from "react";
import { ask, confirmBox } from "../lib/dialog";
import { useMe } from "../lib/me";
import { api } from "../api";
import type { Track, useAudioEngine } from "../hooks/useAudioEngine";
import { OFFSET_LIMIT, useClickOffset, useLiveMetronome, useSubdiv } from "../hooks/useLiveMetronome";
import { useSectionVoice } from "../hooks/useSectionVoice";
import { roomPosition, useTogether, type RoomState } from "../hooks/useTogether";
import {
  CLICK_SOUNDS,
  audioCtx,
  getClickSound,
  metroOut,
  scheduleClick,
  setClickSound,
  type ClickHandle,
  type ClickSound,
} from "../lib/audioCtx";
import { ScrollDial } from "./ScrollDial";
import { measureDeviceLatency, readDeviceLatency, type DeviceLatency } from "../lib/deviceLatency";
import type { Bar } from "../types";
import { barAtTime, stepOf } from "../lib/songmap";
import { clock } from "../lib/time";

type Engine = ReturnType<typeof useAudioEngine>;

type Region = { start: number; end: number };

/** 바깥(송 맵 구성표)에서 '여기서부터 재생'을 시킬 때 쓴다. 클릭 처리 안에서 바로 불러야 iOS 가 재생을 허락한다. */
export interface MixerControl {
  /** pos 에서 예비박부터 재생한다(재생 중이었으면 멈추고 다시). loop 를 주면 그 반복 시작에서. */
  playFrom: (pos: number, loop?: Region | null) => void;
}

/**
 * play() 를 부른 뒤 소리가 실제로 나기까지 걸리는 시간(초). 예비박 뒤 음악을 이만큼
 * 미리 시작해야 1마디 1박이 예비박 박자 그대로 들어온다. 기기마다 달라서 재생할
 * 때마다 재서 고쳐 가고 브라우저에 기억한다.
 */
const LS_LATENCY = "audio.startLatency";
let startLatency = (() => {
  try {
    const v = Number(localStorage.getItem(LS_LATENCY));
    return Number.isFinite(v) && v > 0 && v < 0.4 ? v : 0.06;
  } catch {
    return 0.06;
  }
})();
function learnLatency(lag: number) {
  // 한 번에 다 믿지 않는다 — 측정값도 몇 ms 씩 흔들린다
  startLatency = Math.min(0.4, Math.max(0, startLatency + lag * 0.7));
  try {
    localStorage.setItem(LS_LATENCY, startLatency.toFixed(4));
  } catch {
    /* 기억만 못 할 뿐 */
  }
}

/**
 * 함께 연습할 때 내 기기 소리가 늦게 나오는 정도(ms). 블루투스 이어폰은 100~200ms 늦다.
 * 이만큼 앞서 재생해서 다른 사람과 귀에 들리는 순간을 맞춘다. 기기의 성질이라 브라우저에 기억한다.
 */
const LS_DEVICE = "together.deviceMs";
/** 반복 구간 끝에서 반복 시작으로 돌아와 예비박을 시작하기 전 쉬는 시간(초) */
const LOOP_GAP = 0.5;
/** 함께 연습 버튼 — 아직 다듬는 중이라 숨겨 둔다 (서버도 TOGETHER=1 일 때만 연다) */
const TOGETHER_ENABLED = false;
/** 플레이리스트에서 다음 곡으로 넘어가 자동으로 시작하기 전에 쉬는 시간(초) */
const AUTO_START_DELAY = 1.5;
function useDeviceDelay(): [number, (ms: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(localStorage.getItem(LS_DEVICE));
      return Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
    } catch {
      return 0;
    }
  });
  const set = (ms: number) => {
    const n = Math.max(-100, Math.min(100, Math.round(ms) || 0));
    setV(n);
    try {
      localStorage.setItem(LS_DEVICE, String(n));
    } catch {
      /* 기억만 못 할 뿐 */
    }
  };
  return [v, set];
}

interface Props {
  engine: Engine;
  bars: Bar[];
  /** 믹스 다운로드 요청에 쓴다 */
  jobId: string;
  /** 믹스 파일이 생기면 작업 목록을 다시 받아오게 한다 */
  onChanged?: () => void;
  /** BPM 으로 재생 속도를 고르는 칸을 보일지 */
  showRate?: boolean;
  /**
   * 재생 버튼 옆 '구간 반복' (송 맵에서만). on 이면 누를 때 해제한다.
   * region 이 있으면 재생을 누를 때 반복 시작으로 가서 예비박부터 시작한다.
   */
  loopButton?: {
    on: boolean;
    title: string;
    onToggle: () => void;
    region: Region | null;
  };
  control?: { current: MixerControl | null };
  countIn: number;
  onCountInChange: (n: number) => void;
  /**
   * 값이 바뀌면 이 곡을 재생 버튼을 누른 것처럼 시작한다(예비박 포함).
   * 플레이리스트가 다음 곡으로 넘어갈 때 쓴다.
   */
  autoStart?: number;
}

/**
 * 트랜스포트 + 트랙 볼륨/음소거/솔로 + 예비박.
 *
 * 예비박은 파일에 굽지 않고 Web Audio 로 즉석에서 만든다. 파일에 넣으려면 모든 스템 앞에
 * 같은 길이의 무음을 붙여 전부 재인코딩해야 하고, 곡 중간부터 연습할 때는 쓸 수 없다.
 */
export function Mixer({ engine, bars, jobId, onChanged, showRate, loopButton, control, countIn, onCountInChange, autoStart }: Props) {
  const { tracks, playing, time, duration, rate, muted, solo, vol } = engine;
  const [counting, setCounting] = useState(0);
  const [hint, setHint] = useState("");
  const [note, setNote] = useState("");
  const [mixing, setMixing] = useState(false);
  const { canEdit } = useMe();

  // ---------------- 사용자 트랙 (MTR): 파일 올리기 · 녹음 ----------------
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadTrack = async (blob: Blob, name: string, offsetMs: number) => {
    setUploading(true);
    setHint("");
    setNote(`${name} 올리는 중…`);
    try {
      await api.uploadTrack(jobId, blob, name, offsetMs);
      onChanged?.();
      setNote(`${name} 트랙을 추가했습니다. 박이 어긋나면 트랙 줄의 ±ms 로 맞추세요.`);
    } catch (e) {
      setNote("");
      setHint((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const customOf = (t: Track) => (t.trackId ? engineJobTracks.find((x) => x.id === t.trackId) : undefined);
  const engineJobTracks = engine.jobTracks;
  const nudgeTrack = async (tid: string, delta: number, cur: number) => {
    try {
      await api.updateTrack(jobId, tid, { offset_ms: cur + delta });
      onChanged?.();
    } catch (e) {
      setHint((e as Error).message);
    }
  };

  /**
   * 녹음: 마이크를 열고 녹음을 시작한 뒤 곡을 (예비박부터) 튼다. 음악이 실제로 나기 시작한
   * 순간의 곡 위치와 그때까지 녹음된 길이로 "녹음의 0초 = 곡의 몇 초" (오프셋)를 잰다.
   * 마이크 입력 지연은 기기마다 달라 ±ms 로 맞춘다. 헤드폰 없이 하면 스피커 소리가 같이 녹음된다.
   */
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; startPerf: number; offset: number | null; onPlaying: () => void } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => rec.current && setRecSec(Math.floor((performance.now() - rec.current.startPerf) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [recording]);
  const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  async function startRecording() {
    setHint("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setHint("마이크를 쓸 수 없습니다. 브라우저의 마이크 권한을 확인해 주세요.");
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""].find((m) => !m || MediaRecorder.isTypeSupported(m)) ?? "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r = { mr, stream, chunks: [] as Blob[], startPerf: 0, offset: null as number | null, onPlaying: () => {} };
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    const master = engine.audios.current[0];
    r.onPlaying = () => {
      // 음악이 실제로 나기 시작: 녹음은 그보다 (지금까지 녹음된 길이)만큼 먼저 시작했다
      if (r.offset === null && master) r.offset = master.currentTime - (performance.now() - r.startPerf) / 1000;
    };
    master?.addEventListener("playing", r.onPlaying);
    rec.current = r;
    mr.start(250);
    r.startPerf = performance.now();
    setRecording(true);
    setRecSec(0);
    setNote("녹음 중 — 헤드폰을 쓰세요. 멈추면 트랙으로 올라갑니다.");
    void handlePlay({ force: true });
  }
  async function stopRecording() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setRecording(false);
    engine.audios.current[0]?.removeEventListener("playing", r.onPlaying);
    cancelCount();
    engine.pause();
    const done = new Promise<void>((res) => (r.mr.onstop = () => res()));
    r.mr.stop();
    await done;
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || "audio/webm" });
    if (blob.size < 1000) {
      setNote("");
      setHint("녹음된 소리가 없습니다.");
      return;
    }
    const n = (engineJobTracks.length ?? 0) + 1;
    if (r.offset === null) setHint("음악이 시작되기 전에 멈춰서 시작 위치를 재지 못했습니다 — ±ms 로 맞춰 주세요.");
    await uploadTrack(blob, `녹음 ${n}`, Math.round((r.offset ?? 0) * 1000));
  }
  useEffect(() => () => {
    // 화면을 떠나면 녹음도 끝낸다 (올리지 않는다)
    const r = rec.current;
    if (r) {
      r.mr.stop();
      r.stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
    }
  }, []);
  const timers = useRef<{ t?: number; i?: number; oscs: ClickHandle[] }>({ oscs: [] });
  // 메트로놈 트랙은 파일이 아니라 송 맵에서 즉석으로 울린다 (편집이 바로 들린다)
  const [subdiv, setSubdiv] = useSubdiv();
  const [clickSound, setClickSoundState] = useState<ClickSound>(getClickSound);
  const metroIdx = tracks.findIndex((t) => t.key === "click");
  const metroVol = metroIdx >= 0 ? (vol[metroIdx] ?? 1) : 1;
  const hasMetronome = tracks.some((t) => t.virtual);
  const [localOffset, setClickOffset] = useClickOffset();
  // 활성 송 맵 버전이 잠겨 있고 잠근 기기의 보정이 저장돼 있으면 그 값을 쓴다 (잠근 기기에서 들린 대로)
  const activeVer = engine.job?.map_versions?.find((v) => v.id === engine.job?.map_active);
  const lockedOffset =
    activeVer?.locked && typeof activeVer.click_offset_ms === "number" ? activeVer.click_offset_ms : null;
  // 내가 정한 값(잠긴 버전이면 잠근 기기의 값) + 이 기기의 자동 측정값(재생 위치가 실제 소리보다
  // 뒤처지는 만큼 — 아이패드 약 0.1초). 칸에는 앞의 것만 보인다
  const userOffset = lockedOffset ?? localOffset;
  const [devLat, setDevLat] = useState<DeviceLatency | null>(readDeviceLatency);
  const clickOffset = userOffset + (devLat?.ms ?? 0);
  const measuringRef = useRef(false);
  /** 기기 측정 (제스처 안에서 부른다). 처음 재생할 때 자동으로, 또는 버튼으로 다시 */
  const measureDevice = (announce: boolean) => {
    if (measuringRef.current) return;
    measuringRef.current = true;
    void measureDeviceLatency()
      .then((r) => {
        if (r) {
          setDevLat(r);
          if (announce) setHint(`이 기기 보정 ${r.ms > 0 ? "+" : ""}${r.ms}ms 로 맞췄습니다 (클릭 ${r.n}개, 흔들림 ${r.spread}ms).`);
        } else if (announce) setHint("기기 보정을 재지 못했습니다. 다시 눌러 주세요.");
      })
      .finally(() => (measuringRef.current = false));
  };
  const metro = useLiveMetronome(engine, bars, subdiv, clickOffset);
  // 구간 이름을 한 마디 전에 읽어 준다 (음성 합성)
  const voice = useSectionVoice(engine, bars);

  // ---------------- 함께 연습 ----------------
  // 방의 재생 상태를 받으면 그대로 따라 한다. 내가 누른 재생도 방을 한 바퀴 돌아와서 시작한다
  // — 그래야 모든 기기가 같은 서버 시각에 들어간다.
  const [deviceMs, setDeviceMs] = useDeviceDelay();
  const deviceMsRef = useRef(deviceMs);
  deviceMsRef.current = deviceMs;
  const countingRef = useRef(0);
  countingRef.current = counting;
  // 소리로 맞춤 확인 중이면 첫 클릭의 서버 시각 (null = 꺼짐)
  const [beepAt, setBeepAt] = useState<number | null>(null);
  const tg = useTogether(
    jobId,
    (s) => applyRoomState(s),
    (at, by) => {
      setBeepAt(at);
      if (at != null)
        setHint(
          `${by ? by + " 님이 " : ""}맞춤 확인 중 — 클릭이 '딱' 한 번이면 맞은 것, '따닥' 이면 내 기기 지연을 조절하며 들어 보세요.`,
        );
      else setHint("");
    },
  );

  /**
   * 소리로 맞춤 확인: 서버 시각 beepAt 부터 1초마다 클릭, 끌 때까지. 음악 시작과 같은 계산(서버 시각 →
   * 이 기기 시각, 내 기기 지연만큼 앞당김)이라 모두가 '딱' 이면 음악도 맞는다. 클릭은 0.3초 앞만
   * 예약하므로 내 기기 지연을 돌리면 다음 클릭부터 바로 들린다.
   */
  useEffect(() => {
    if (beepAt == null || !tg.joined) return;
    let ctx: AudioContext;
    try {
      ctx = audioCtx();
      void ctx.resume();
    } catch {
      return;
    }
    let k = Math.max(0, Math.ceil((tg.serverNow() + deviceMsRef.current - beepAt) / 1000));
    const id = window.setInterval(() => {
      const mine = tg.serverNow() + deviceMsRef.current;
      while (beepAt + k * 1000 - mine < 300) {
        const when = ctx.currentTime + (beepAt + k * 1000 - mine) / 1000;
        if (when > ctx.currentTime + 0.005) scheduleClick(ctx, when, k % 4 === 0 ? 1500 : 1000, metroOut(ctx));
        k++;
      }
    }, 50);
    return () => window.clearInterval(id);
    // tg 는 매 렌더 새 객체 — serverNow 는 안정적이다
  }, [beepAt, tg.joined]);
  useEffect(() => {
    if (!tg.joined) setBeepAt(null);
  }, [tg.joined]);

  const [preparing, setPreparing] = useState(false);
  const prepRef = useRef("");

  function applyRoomState(s: RoomState) {
    cancelCount();
    if (Math.abs(s.rate - (rate || 1)) > 1e-3) engine.setRate(s.rate);
    engine.setLoop(s.loop);
    prepRef.current = s.prepare?.id ?? "";
    setPreparing(!!s.prepare);
    if (s.prepare) {
      void prepareLocal(s.prepare.id, s.prepare.pos);
      return;
    }
    if (!s.playing) {
      engine.pause();
      engine.seek(s.pos);
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = audioCtx();
      void ctx.resume();
    } catch {
      engine.seek(roomPosition(s, tg.serverNow() + deviceMsRef.current));
      void startPlay();
      return;
    }
    engine.pause();
    // 내 기기 소리가 늦게 나오는 만큼(블루투스 등) 앞서 간다
    const mine = tg.serverNow() + deviceMsRef.current;
    const delay = (s.at - mine) / 1000;
    if (delay > 0.08) {
      engine.seek(s.pos);
      scheduleStart(ctx, s.pos, ctx.currentTime + delay, s.count_in, s.rate);
    } else {
      // 이미 시작했다(늦게 들어왔거나 메시지가 늦었다) — 지금 위치로 바로 합류
      const lead = Math.max(0.2, startLatency + 0.08);
      const p = roomPosition(s, mine + lead * 1000);
      engine.seek(p);
      scheduleStart(ctx, p, ctx.currentTime + lead, 0, s.rate);
    }
  }

  /**
   * '맞추고 시작' 준비: 그 위치로 가서 모든 트랙이 재생할 만큼 받아질 때까지 기다리고, 시계를
   * 다시 잰 뒤 준비됐다고 알린다. 모두 준비되면 서버가 시작 시각을 정해 보낸다.
   */
  async function prepareLocal(id: string, pos: number) {
    engine.pause();
    engine.seek(pos);
    const t0 = performance.now();
    await tg.resync();
    // 받아 두기: 모든 트랙이 그 자리에서 바로 재생할 수 있을 때까지 (최대 9초)
    while (performance.now() - t0 < 9000) {
      if (prepRef.current !== id) return; // 그새 다른 명령이 왔다
      const as = engine.audios.current;
      if (as.length && as.every((a) => !a.seeking && a.readyState >= 3)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (prepRef.current === id) tg.send({ t: "ready", id });
  }

  // 내 기기 지연을 재생 중에 바꾸면, 조절을 멈추고 0.5초 뒤 그 값으로 한 번 다시 맞춰 시작한다
  // (자동 보정이 아니라 사용자가 바꾼 것 — 이 순간만 잠깐 끊긴다)
  const firstDevice = useRef(true);
  useEffect(() => {
    if (firstDevice.current) {
      firstDevice.current = false;
      return;
    }
    const s = tg.state.current;
    if (!tg.joined || !s?.playing || s.prepare) return;
    const t = window.setTimeout(() => {
      const now = tg.state.current;
      if (now?.playing && !now.prepare) applyRoomState(now);
    }, 500);
    return () => window.clearTimeout(t);
  }, [deviceMs]);

  // 내 상태 알리기 (어긋남 표시만). 재생 중에는 보정하지 않는다 — 시작만 같은 순간에 맞추고
  // 그다음은 각 기기가 그대로 재생한다. 예전엔 어긋나면 속도를 바꾸거나(±3~5%) 위치를 옮겨
  // 따라잡았는데, 그게 오히려 소리를 널뛰게 해서 같이 듣기가 안 됐다.
  const { send, serverNow, state: roomRef } = tg;
  const rttRef = useRef(tg.rtt);
  rttRef.current = tg.rtt;
  useEffect(() => {
    if (!tg.joined) return;
    let win: number[] = [];
    const id = window.setInterval(() => {
      const s = roomRef.current;
      const a = engine.audios.current[0];
      if (!s) return;
      let med: number | null = null;
      if (s.playing && !s.prepare && a && !a.paused && !a.seeking && !countingRef.current) {
        win.push(a.currentTime - roomPosition(s, serverNow() + deviceMsRef.current));
        if (win.length > 5) win.shift();
        if (win.length >= 3) med = [...win].sort((x, y) => x - y)[Math.floor(win.length / 2)];
      } else win = [];
      send({ t: "report", err: med == null ? null : Math.round(med * 1000), rtt: rttRef.current, ready: !!a && a.readyState >= 3 });
    }, 2000);
    return () => window.clearInterval(id);
    // tg 는 매 렌더 새 객체라 의존성에 두면 타이머가 계속 다시 걸린다 — 쓰는 것은 모두 안정적이다
  }, [tg.joined, engine.audios, send, serverNow, roomRef]);

  // 송 맵의 구간 반복을 켜고 끄면 방에도 알린다 (다른 사람도 같은 구간을 돈다)
  const loopKey = loopButton?.region ? `${loopButton.region.start}-${loopButton.region.end}` : "";
  useEffect(() => {
    if (!tg.connected) return;
    const s = tg.state.current;
    const cur = s?.loop ? `${s.loop.start}-${s.loop.end}` : "";
    if (cur !== loopKey) tg.send({ t: "loop", loop: loopButton?.region ?? null });
    // loopKey 가 바뀔 때만 (방 상태가 바뀌어 다시 도는 것은 아니다)
  }, [loopKey, tg.connected]);

  // 반복 구간 끝: 멈췄다가 예비박부터 다시. 이어 붙이면(바로 처음으로 점프) 박을 놓치기 쉽고
  // 함께 연습에서는 기기마다 점프 순간이 달라 엉켰다. 함께 연습이면 방(서버)이 끝나는 순간을
  // 알고 있어 모두를 멈추고 맞추고 시작을 다시 돌리므로, 여기서는 멈추기만 한다.
  const loopEndFn = useRef<(lp: Region) => void>(() => {});
  // 반복 시작으로 돌아오면 LOOP_GAP 만큼 쉬었다가 예비박을 시작한다 — 바로 붙으면 박을 세고
  // 들어갈 준비를 할 틈이 없다. 쉬는 동안 ▶/❚❚ 를 누르면 반복을 멈춘다.
  const loopGap = useRef(0);
  loopEndFn.current = (lp) => {
    if (tg.joined) return;
    engine.seek(lp.start);
    loopGap.current = window.setTimeout(() => {
      loopGap.current = 0;
      void handlePlay({ force: true, from: lp.start, loop: lp });
    }, LOOP_GAP * 1000);
  };
  useEffect(() => () => clearTimeout(loopGap.current), []);
  const setLoopEnd = engine.setLoopEnd;
  useEffect(() => {
    setLoopEnd((lp) => loopEndFn.current(lp));
    return () => setLoopEnd(null);
  }, [setLoopEnd]);

  // 함께 연습 중에 기기 저장을 지우면 나간다 (스트리밍으로는 시작을 맞출 수 없다)
  const cacheState = engine.cache.state;
  useEffect(() => {
    // 'checking' 은 목록이 갱신될 때 잠깐 지나가는 상태라 보지 않는다 — 정말 지웠을 때만
    if (tg.joined && (cacheState === "none" || cacheState === "stream")) {
      tg.leave();
      setHint("기기 저장을 지워 함께 연습에서 나왔습니다.");
    }
    // tg 는 매 렌더 새 객체 — 저장 상태가 바뀔 때만 본다
  }, [cacheState]);

  function joinTogether() {
    // 참여 버튼이 사용자 제스처라 여기서 소리를 풀어 둔다 — 이후 방 신호로 재생이 시작된다 (iOS)
    try {
      void audioCtx().resume();
    } catch {
      /* Web Audio 미지원 */
    }
    engine.prime();
    voice.prime();
    tg.join();
  }

  const seekTo = (t: number) => (tg.joined ? tg.send({ t: "seek", pos: t }) : engine.seek(t));
  const setRateShared = (r: number) => (tg.joined ? tg.send({ t: "rate", rate: r }) : engine.setRate(r));

  /**
   * 지금 들리는 트랙(음소거·솔로·볼륨 반영)만 서버에서 합쳐 한 파일로 받는다.
   * 예비박 설정이 있으면 파일 앞에도 그만큼 클릭이 들어간다.
   */
  async function downloadMix() {
    const idx = engine.audibleIndexes();
    if (!idx.length) {
      setHint("들리는 트랙이 없습니다. 음소거를 풀거나 볼륨을 올려 주세요.");
      return;
    }
    const stems = idx.map((i) => tracks[i].key);
    // 스템은 기본 볼륨이 50 이라 그대로 넘기면 파일이 작게 나온다. 들리는 균형은 그대로 두고
    // 가장 큰 스템이 100 이 되게 키운다 (넘치면 서버가 전체를 낮춘다).
    const top = Math.max(0, ...idx.filter((i) => tracks[i].key !== "click").map((i) => vol[i] ?? 1));
    const scale = top > 0 ? 1 / top : 1;
    const gains: Record<string, number> = {};
    idx.forEach((i) => (gains[tracks[i].key] = (vol[i] ?? 1) * scale));
    setMixing(true);
    setHint("");
    setNote("믹스 만드는 중…");
    try {
      const r = await api.mixdown(jobId, { stems, gains, format: "mp3", count_in: countIn, subdiv });
      if (!r.file) throw new Error("믹스 파일을 만들지 못했습니다.");
      const a = document.createElement("a");
      a.href = api.fileUrl(r.file.url, true);
      a.download = r.file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      onChanged?.();
      setNote(
        `${r.file.name} 저장` +
          (r.normalized ? " · 합치면 음량이 넘쳐 전체 레벨을 낮췄습니다" : "") +
          (r.count_in ? ` · 예비박 ${r.count_in}박 포함` : ""),
      );
    } catch (e) {
      setNote("");
      setHint((e as Error).message);
    } finally {
      setMixing(false);
    }
  }

  /** 재생 실패(자동재생 차단, 파일 없음)를 버튼 옆에 보여준다. 조용히 삼키면 ▶ 만 남는다. */
  async function startPlay() {
    try {
      setHint("");
      await engine.play();
    } catch (e) {
      setHint((e as Error).message);
    }
  }

  useEffect(() => () => cancelCount(), []);
  // 곡이 바뀌면 원곡 속도로 (목표 BPM 은 곡마다 다르다)
  const setRate = engine.setRate;
  useEffect(() => {
    if (showRate) setRate(1);
  }, [jobId, showRate, setRate]);

  // 곡이 바뀌면 진행 중이던 예비박을 버린다 (안 그러면 타이머가 새 곡을 엉뚱한 위치에서 튼다)
  useEffect(() => cancelCount(), [jobId]);

  // 다음 곡 자동 시작(플레이리스트의 자동 넘김·다음/이전·▶). 새 곡의 트랙이 실제로 올라온 뒤
  // AUTO_START_DELAY 만큼 쉬었다가 누른다 — 곡을 바꾸자마자 틀면 새 트랙이 아직 준비되는 중이라
  // 첫 박이 밀리거나 예비박과 어긋났다. 기다리는 동안 ▶ 를 누르면 그때 바로 시작한다.
  const startedFor = useRef(autoStart);
  const autoTimer = useRef<{ id: number; job: string } | null>(null);
  const [autoPending, setAutoPending] = useState(false);
  const handlePlayRef = useRef(handlePlay);
  handlePlayRef.current = handlePlay;
  const cancelAuto = () => {
    if (autoTimer.current) clearTimeout(autoTimer.current.id);
    autoTimer.current = null;
    setAutoPending(false);
  };
  useEffect(() => {
    if (autoStart === undefined || autoStart === startedFor.current) return;
    if (engine.loadedId !== jobId || !tracks.length) return;
    startedFor.current = autoStart;
    cancelAuto();
    setAutoPending(true);
    autoTimer.current = {
      job: jobId,
      id: window.setTimeout(() => {
        const t = autoTimer.current;
        autoTimer.current = null;
        setAutoPending(false);
        if (t?.job === jobId) void handlePlayRef.current({ force: true });
      }, AUTO_START_DELAY * 1000),
    };
    // 트랙 배열이 다시 만들어져도 타이머는 그대로 둔다 (정리는 곡이 바뀔 때·화면을 떠날 때)
  }, [autoStart, engine.loadedId, jobId, tracks]);
  // 기다리는 중에 다른 곡으로 옮기면(재생 없이 고르기) 그 곡을 틀지 않는다
  useEffect(() => {
    if (autoTimer.current && autoTimer.current.job !== jobId) cancelAuto();
  }, [jobId]);
  useEffect(() => () => cancelAuto(), []);

  // 스페이스바 = 재생/일시정지. 입력칸에 있을 때는 원래 동작(공백 입력)을 살린다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      e.preventDefault();
      void handlePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function cancelCount() {
    if (timers.current.t) clearTimeout(timers.current.t);
    if (timers.current.i) clearInterval(timers.current.i);
    timers.current.oscs.forEach((o) => {
      try {
        o.stop();
      } catch {
        /* 이미 끝난 경우 */
      }
    });
    timers.current = { oscs: [] };
    metro.cancel();
    setCounting(0);
  }

  const cur = barAtTime(bars, time);
  const next = cur ? bars.find((b) => b.bar === cur.bar + 1) : bars[0];
  const lastBar = bars.length ? bars[bars.length - 1].bar : 0;
  /** n 마디 첫 박으로 (재생 중이면 그대로 이어서, 함께 연습이면 방에 알린다) */
  const gotoBar = (n: number) => {
    if (!bars.length) return;
    const b = bars.find((x) => x.bar === Math.max(1, Math.min(lastBar, Math.round(n))));
    if (b) seekTo(b.start);
  };

  if (control) control.current = { playFrom: (pos, loop) => void handlePlay({ force: true, from: pos, loop }) };

  /**
   * force: 재생 중이어도 멈추지 않고 처음부터 다시 시작하며, 위치와 상관없이 예비박을 넣는다.
   * from/loop: 시작 위치와 반복 구간 (안 주면 지금 위치·지금 반복 구간).
   */
  async function handlePlay(opts: { force?: boolean; from?: number; loop?: Region | null } = {}) {
    // 자동 시작을 기다리는 중에 ▶ 를 누르면 기다리지 않고 지금 시작한다
    if (autoTimer.current) {
      cancelAuto();
      opts = { ...opts, force: true };
    }
    // iOS 는 사용자 제스처 안에서만 AudioContext 를 깨울 수 있다. 메트로놈·예비박 모두 여기에 의존한다.
    try {
      void audioCtx().resume();
    } catch {
      /* Web Audio 미지원 — 음악만 재생된다 */
    }
    // 이 기기를 아직 안 쟀으면 첫 재생 때 소리 없이 잰다 (제스처 안이어야 해서 여기서)
    if (!devLat) measureDevice(false);
    if (loopGap.current) {
      // 반복 사이 쉬는 중에 누르면 반복을 멈춘다
      clearTimeout(loopGap.current);
      loopGap.current = 0;
      if (!opts.force) return;
    }
    if (tg.joined) {
      // 함께 연습: 방에 알리기만 하고, 실제 재생은 방에서 돌아온 상태로 모두가 같이 한다
      if ((playing || counting || preparing) && !opts.force) {
        // 내 기기는 방의 답을 기다리지 않고 바로 멈춘다 (늦게 오거나 끊겨도 소리가 남지 않게)
        cancelCount();
        engine.pause();
        tg.send({ t: "pause" });
        return;
      }
      // 재생 준비 — prime 은 트랙을 play()·pause() 하므로 재생 중에 부르면 안 된다
      engine.prime();
      voice.prime();
      let pos = opts.from ?? time;
      const lp = opts.loop !== undefined ? opts.loop : loopButton?.region ?? null;
      if (lp) pos = lp.start;
      const withCount = !!countIn && (atSongStart(bars, pos) || !!lp || !!opts.force);
      const r = rate || 1;
      const b = barAtTime(bars, pos) ?? bars[0];
      const step = (b ? stepOf(b.bpm, b.beat_unit) : 0.5) / r;
      const toBeat = (nextBeatAfter(bars, pos) - pos) / r;
      // 예비박이 다 들어갈 만큼 + 네트워크 여유. 음악은 그 뒤 '지금+lead' 에 모두 함께 들어간다.
      const lead = 0.8 + (withCount ? Math.max(0, countIn * step - toBeat) : 0) + Math.max(0, -clickOffset / 1000);
      tg.send({ t: "play", pos, count_in: withCount ? countIn : 0, rate: r, loop: lp, lead });
      return;
    }
    if (playing || counting) {
      cancelCount();
      engine.pause();
      if (!opts.force) return;
    }
    voice.prime();
    let pos = opts.from ?? time;
    // 구간 반복 중이면 반복 시작(구간 2마디 전)으로 가서 예비박부터 들어간다.
    // 반복이 한 바퀴 돌아 처음으로 돌아갈 때는 예비박 없이 바로 이어진다.
    const lp = opts.loop !== undefined ? opts.loop : loopButton?.region ?? null;
    if (lp) pos = lp.start;
    if (lp || opts.from !== undefined) engine.seek(pos);
    // 예비박은 곡 처음·반복 시작·구성표에서 고른 구간에서 시작할 때만.
    // 중간에서 이어 들을 때마다 붙으면 방해가 된다.
    if (!countIn || (!atSongStart(bars, pos) && !lp && !opts.force)) {
      await startPlay();
      return;
    }
    const b = barAtTime(bars, pos) ?? bars[0];
    const stepRaw = b ? stepOf(b.bpm, b.beat_unit) : 0.5;
    const step = stepRaw / (rate || 1);

    // 실제 재생은 예비박이 끝난 뒤 타이머에서 시작한다. iOS 는 사용자 제스처 밖의 play()
    // 를 거부하므로, 제스처 안(첫 await 전)에서 트랙들을 미리 풀어둔다.
    engine.prime();

    let ctx: AudioContext;
    try {
      ctx = audioCtx();
      await ctx.resume();
    } catch {
      await startPlay();
      return;
    }

    // 마지막 클릭과 "곡의 다음 박자" 사이가 정확히 한 박이 되도록 맞춘다.
    // 이걸 안 하면 클릭은 일정한데 음악 진입만 최대 한 박까지 어긋난다.
    //
    // 다음 박자가 예비박 전체 길이보다 멀리 있으면(드럼이 늦게 들어오는 인트로) 음악을
    // 먼저 시작하고 클릭을 인트로 위에 얹는다. 예전처럼 시작 시각을 '지금'으로 잘라내면
    // 클릭이 끝나고도 1마디 1박이 한참 뒤에 와서 예비박의 의미가 없어진다.
    const nextBeat = nextBeatAfter(bars, pos);
    // 클릭 지연 보정: 예비박도 실시간 메트로놈과 같은 만큼 옮긴다. 앞당기면 그만큼 여유를 더 둔다.
    const off = clickOffset / 1000;
    const margin = 0.15 + Math.max(0, -off);
    const toBeat = (nextBeat - pos) / (rate || 1); // 재생 속도를 반영한 실제 시간
    const tBeat = ctx.currentTime + margin + Math.max(countIn * step, toBeat);
    scheduleStart(ctx, pos, tBeat - toBeat, countIn, rate || 1);
  }

  /**
   * 곡 위치 pos 가 AudioContext 시각 startAt 에 소리 나도록 음악을 시작한다. countIn 이 있으면
   * 마지막 클릭과 '곡의 다음 박' 사이가 정확히 한 박이 되게 그 앞에 클릭을 찍는다(이미 지난
   * 클릭은 건너뛴다). 혼자 재생과 함께 연습(서버가 정한 시각)이 같이 쓴다.
   */
  function scheduleStart(ctx: AudioContext, pos: number, startAt: number, nCount: number, r: number) {
    const b = barAtTime(bars, pos) ?? bars[0];
    const stepRaw = b ? stepOf(b.bpm, b.beat_unit) : 0.5;
    const step = stepRaw / r;
    const bpb = b?.beats_per_bar ?? 4;
    const nextBeat = nextBeatAfter(bars, pos);
    const off = clickOffset / 1000;
    const tBeat = startAt + (nextBeat - pos) / r;

    // 곧 시작하는 구간(곡 맨 앞 Intro 등)은 읽지 않는다 — 예비박과 겹친다
    voice.cueAt(pos, Math.max(nCount * stepRaw, nextBeat - pos) + 0.1);

    timers.current.oscs = [];
    for (let k = nCount; k >= 1; k--) {
      const when = tBeat - k * step + off;
      if (when < ctx.currentTime) continue;
      timers.current.oscs.push(
        // 예비박은 메트로놈을 음소거해도 울리되, 메트로놈 볼륨을 100% 넘게 올렸으면 그만큼 키운다
        scheduleClick(ctx, when, (nCount - k) % bpb === 0 ? 1500 : 1000, metroOut(ctx), {
          peak: 0.9 * Math.max(1, metroVol),
        }),
      );
    }

    // 메트로놈이 예비박과 같은 시계로 이어 세게 한다 — 마지막 예비박과 1마디 1박 사이가 정확히 한 박
    metro.expect(startAt, pos, learnLatency);
    // 음악은 시작 지연만큼 미리 재생을 건다 (그래야 startAt 에 실제로 소리가 난다)
    const playAt = startAt - startLatency;
    if (nCount) {
      setCounting(nCount);
      timers.current.i = window.setInterval(() => {
        const left = Math.ceil((tBeat - ctx.currentTime) / step);
        setCounting(Math.max(0, Math.min(left, nCount)));
      }, 60);
    }
    timers.current.t = window.setTimeout(
      async () => {
        if (timers.current.i) clearInterval(timers.current.i);
        setCounting(0);
        // 타이머가 늦게 깼으면 그만큼 앞에서 시작해 박을 맞춘다
        const late = Math.max(0, ctx.currentTime - playAt) * r;
        engine.seek(pos + late);
        await startPlay();
      },
      Math.max(0, (playAt - ctx.currentTime) * 1000),
    );
  }

  const pct = duration ? (time / duration) * 1000 : 0;

  // 재생 줄이 화면에서 벗어났는지 — 벗어나면 아래 미니 바를 띄운다
  const transportRef = useRef<HTMLDivElement | null>(null);
  const [transportHidden, setTransportHidden] = useState(false);
  useEffect(() => {
    const el = transportRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([en]) => setTransportHidden(!en.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="mixer">
      <div className="transport" ref={transportRef}>
        <button className="playbtn" onClick={() => void handlePlay()}>
          {counting ? counting : preparing || autoPending ? "…" : playing ? "❚❚" : "▶"}
        </button>
        {loopButton && (
          <button
            className={`ghost${loopButton.on ? " on" : ""}`}
            onClick={loopButton.onToggle}
            title={loopButton.title}
          >
            구간 반복
          </button>
        )}
        <input
          className="seek"
          type="range"
          min={0}
          max={1000}
          value={Math.round(pct)}
          onChange={(e) => duration && seekTo((Number(e.target.value) / 1000) * duration)}
        />
        <span className="time">
          {clock(time)} / {clock(duration)}
        </span>
        {bars.length > 0 && <BarJump cur={cur?.bar ?? 0} last={lastBar} onGo={gotoBar} />}
        {showRate && bars[0]?.bpm ? (
          <BpmControl base={bars[0].bpm} rate={rate} onRate={setRateShared} />
        ) : null}
        {hint && <span className="err">{hint}</span>}
        {!hint && note && <span className="meta">{note}</span>}
      </div>

      <div className="transport-opts">
        <select
          style={{ width: 128 }}
          value={String(countIn)}
          onChange={(e) => onCountInChange(Number(e.target.value))}
        >
          <option value="0">예비박 없음</option>
          <option value="2">예비박 2박</option>
          <option value="4">예비박 4박</option>
          <option value="8">예비박 8박</option>
        </select>
        {hasMetronome && (
          <select
            style={{ width: 118 }}
            value={String(subdiv)}
            onChange={(e) => setSubdiv(Number(e.target.value) as 1 | 2)}
            title="메트로놈 클릭 간격. 8비트는 박 사이에 작은 클릭이 들어갑니다. 재생 중에도 바로 바뀝니다."
          >
            <option value="1">클릭 4비트</option>
            <option value="2">클릭 8비트</option>
          </select>
        )}
        {(hasMetronome || countIn > 0) && (
          <select
            style={{ width: 128 }}
            value={clickSound}
            onChange={(e) => {
              const v = e.target.value as ClickSound;
              setClickSound(v);
              setClickSoundState(v);
              // 고르면 한 번 들려준다 (첫 박 소리)
              try {
                const ctx = audioCtx();
                void ctx.resume();
                scheduleClick(ctx, ctx.currentTime + 0.03, 1500, metroOut(ctx), { peak: 0.9 * Math.max(1, metroVol) });
              } catch {
                /* Web Audio 미지원 */
              }
            }}
            title="메트로놈·예비박 소리. 이 기기에 기억합니다. 재생 중에도 바로 바뀝니다."
          >
            {CLICK_SOUNDS.map((s) => (
              <option key={s.value} value={s.value}>
                소리: {s.label}
              </option>
            ))}
          </select>
        )}
        {(hasMetronome || countIn > 0) && (
          <label
            className="meta nudge"
            title={
              lockedOffset != null
                ? `잠긴 송 맵 — 잠근 기기에서 맞춘 클릭 보정(${lockedOffset}ms)을 모든 기기가 그대로 씁니다. 바꾸려면 잠금을 푸세요.`
                : "클릭 지연 보정 (이 기기에만 저장). 클릭이 음악보다 늦게 들리면 −, 빠르게 들리면 + 로. " +
                  "재생 중에 바꿔도 바로 들립니다. 잠그면 이 값이 송 맵과 함께 저장됩니다."
            }
          >
            {lockedOffset != null ? "🔒 클릭" : "클릭"}
            <button
              className="ghost"
              onClick={() => setClickOffset(userOffset - 5)}
              disabled={lockedOffset != null || userOffset <= -OFFSET_LIMIT}
              aria-label="클릭 5ms 앞당기기"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={-OFFSET_LIMIT}
              max={OFFSET_LIMIT}
              step={5}
              value={userOffset}
              disabled={lockedOffset != null}
              onChange={(e) => setClickOffset(Number(e.target.value))}
            />
            <button
              className="ghost"
              onClick={() => setClickOffset(userOffset + 5)}
              disabled={lockedOffset != null || userOffset >= OFFSET_LIMIT}
              aria-label="클릭 5ms 늦추기"
            >
              +
            </button>
            ms
          </label>
        )}
        {(hasMetronome || countIn > 0) && (
          <button
            className="ghost"
            onClick={() => measureDevice(true)}
            title={
              "이 기기의 재생 위치가 실제 소리보다 얼마나 뒤처지는지 소리 없이 재서 클릭에 더합니다 " +
              "(아이패드 약 0.1초). 처음 재생할 때 자동으로 재고, 이 기기에 기억합니다. 누르면 다시 잽니다." +
              (devLat ? ` 지금 ${devLat.ms}ms (클릭 ${devLat.n}개, 흔들림 ${devLat.spread}ms).` : "")
            }
          >
            기기 {devLat ? `${devLat.ms > 0 ? "+" : ""}${devLat.ms}ms` : "측정"}
          </button>
        )}
        {voice.available && (
          <button
            className={`ghost${voice.enabled ? " on" : ""}`}
            onClick={() => voice.setEnabled(!voice.enabled)}
            title="송 맵의 구간 이름을 그 구간이 오기 한 마디 전에 소리 내어 읽습니다."
          >
            구간 안내
          </button>
        )}
        {TOGETHER_ENABLED && (
          <button
            className={`ghost${tg.joined ? " on" : ""}`}
            onClick={() =>
              tg.joined
                ? tg.leave()
                : engine.cache.state === "cached"
                  ? joinTogether()
                  : setHint("함께 연습은 이 기기에 저장한 곡만 할 수 있습니다. 오른쪽 '기기에 저장' 을 먼저 눌러 주세요.")
            }
            aria-disabled={!tg.joined && engine.cache.state !== "cached"}
            style={!tg.joined && engine.cache.state !== "cached" ? { opacity: 0.5 } : undefined}
            title={
              engine.cache.state === "cached"
                ? "같은 곡을 연 다른 기기들과 같은 순간에 재생합니다. 누가 재생·멈춤·이동해도 모두 따라갑니다. 볼륨·음소거는 각자 따로입니다."
                : "기기에 저장한 곡만 함께 연습할 수 있습니다 — 서버에서 받아 가며 재생하면 기기마다 시작이 들쭉날쭉해 맞출 수 없습니다."
            }
          >
            {tg.joined ? "함께 연습 중" : "함께 연습"}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {(engine.cache.state === "none" || engine.cache.state === "stream") && (
          <button
            className="ghost"
            onClick={engine.saveToDevice}
            title="이 곡의 스템을 이 기기에 저장합니다. 저장하면 정지·이동·재생 때 서버에서 다시 받지 않아 끊김이 줄어듭니다. 재생 중에는 쉬었다가 멈추면 이어서 받습니다. 메트로놈은 저장과 상관없이 송 맵대로 바로 울립니다."
          >
            {engine.cache.state === "stream" ? "기기에 저장 (다시 시도)" : engine.cache.pct > 0 ? `기기에 저장 (${engine.cache.pct}%)` : "기기에 저장"}
          </button>
        )}
        {engine.cache.state === "downloading" && (
          <span className="meta" title="다 받으면 이 기기에 저장해 두고, 이후로는 정지·이동·재생 때 서버에서 다시 받지 않습니다.">
            기기에 저장 중 {engine.cache.pct}%
          </span>
        )}
        {engine.cache.state === "waiting" && (
          <span className="meta" title="재생하는 동안에는 회선을 재생에 양보합니다. 멈추면 이어서 기기에 저장합니다.">
            재생 중 — 멈추면 이어서 저장 ({engine.cache.pct}%)
          </span>
        )}
        {engine.cache.state === "cached" && (
          <>
            <span className="meta" title="이 곡은 기기에 저장돼 있어 네트워크 없이 재생·이동합니다.">
              기기에 저장됨
            </span>
            <button
              className="ghost"
              onClick={async () => {
                if (
                  await confirmBox({
                    title: "기기 저장 삭제",
                    message: "이 곡을 이 기기에서 지웁니다. 이후로는 서버에서 스트리밍합니다 (다시 저장할 수 있습니다).",
                    okText: "지우기",
                  })
                )
                  void engine.removeFromDevice();
              }}
              title="이 곡의 스템을 이 기기에서 지웁니다."
            >
              저장 삭제
            </button>
          </>
        )}
        {canEdit && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/webm,video/mp4"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void uploadTrack(f, f.name.replace(/\.[^.]+$/, "").slice(0, 40) || "트랙", 0);
              }}
            />
            <button
              className="ghost"
              disabled={uploading || !tracks.length}
              onClick={() => fileRef.current?.click()}
              title="내 녹음·반주 같은 오디오 파일을 이 곡의 트랙으로 올립니다 (MTR). 올린 뒤 ±ms 로 박을 맞추세요."
            >
              트랙 추가
            </button>
            {canRecord && (
              <button
                className={`ghost${recording ? " on" : ""}`}
                disabled={uploading || !tracks.length}
                onClick={() => (recording ? void stopRecording() : void startRecording())}
                title="마이크로 녹음하면서 곡을 (예비박부터) 틉니다. 멈추면 녹음이 트랙으로 올라가고 시작 위치가 자동으로 맞춰집니다. 헤드폰을 쓰세요."
              >
                {recording ? `■ 녹음 중지 ${Math.floor(recSec / 60)}:${String(recSec % 60).padStart(2, "0")}` : "● 녹음"}
              </button>
            )}
          </>
        )}
        <button
          className="ghost"
          onClick={downloadMix}
          disabled={mixing || !tracks.length}
          title="지금 들리는 트랙만 합쳐 mp3 로 받습니다. 예비박 설정이 있으면 앞에 함께 들어갑니다."
        >
          {mixing ? "믹스 만드는 중…" : "믹스 받기"}
        </button>
      </div>

      {/* 재생 줄이 화면 밖(위)으로 나가면 아래에 붙는 미니 바 — 긴 구성표·악보를 보면서 재생/멈춤 */}
      {transportHidden && tracks.length > 0 && (
        <div className="minibar">
          <button className="playbtn" onClick={() => void handlePlay()}>
            {counting ? counting : preparing || autoPending ? "…" : playing ? "❚❚" : "▶"}
          </button>
          {bars.length > 0 ? (
            <BarJump cur={cur?.bar ?? 0} last={lastBar} onGo={gotoBar} name={cur?.name} />
          ) : (
            <span className="nowsec">1마디 전</span>
          )}
          <input
            className="seek"
            type="range"
            min={0}
            max={1000}
            value={Math.round(pct)}
            onChange={(e) => duration && seekTo((Number(e.target.value) / 1000) * duration)}
          />
          <span className="time">
            {clock(time)} / {clock(duration)}
          </span>
          <button
            className="ghost"
            onClick={() => transportRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            title="재생 조작으로 올라가기"
            aria-label="재생 조작으로 올라가기"
          >
            ▲
          </button>
        </div>
      )}

      {(tg.joined || tg.error) && (
        <div className="together">
          {tg.error && <span className="err">{tg.error}</span>}
          {tg.joined && (
            <>
              <span className="meta">{tg.connected ? `함께 연습 · ${tg.members.length}명` : "연결 중…"}</span>
              {tg.members.map((m) => (
                <span
                  key={m.id}
                  className={`member${m.id === tg.me ? " me" : ""}`}
                  title={m.rtt != null ? `왕복 ${m.rtt}ms` : undefined}
                >
                  {m.name}
                  {m.id === tg.me && " (나)"}
                  {preparing && <span className={m.preparing ? "warn" : "ok"}>{m.preparing ? " 준비 중" : " 준비됨"}</span>}
                  {!preparing && m.err != null && (
                    <span className={Math.abs(m.err) < 30 ? "ok" : Math.abs(m.err) < 80 ? "warn" : "err"}>
                      {" "}
                      {m.err > 0 ? "+" : ""}
                      {m.err}ms
                    </span>
                  )}
                </span>
              ))}
              <label className="meta" title="같이 들을 때 보이는 이름 (이 기기에 기억)">
                이름
                <input
                  defaultValue={tg.name}
                  style={{ width: 96 }}
                  onBlur={(e) => e.target.value.trim() !== tg.name && tg.setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              </label>
              <span className="meta" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                내 기기 지연
                <ScrollDial
                  value={deviceMs}
                  onChange={setDeviceMs}
                  min={-100}
                  max={100}
                  unit="ms"
                  title="위아래로 끌거나 휠을 굴려 조절 (−100~+100ms, 두 번 누르면 0). + 는 내 기기를 앞서, − 는 늦게 재생합니다. 내 소리가 늦게 들리면 + 로. 재생 중에 바꾸면 손을 뗀 뒤 그 값으로 다시 맞춰 시작합니다. 이 기기에 기억."
                />
              </span>
              <button
                className={`ghost${beepAt != null ? " on" : ""}`}
                onClick={() => tg.send({ t: "beep", on: beepAt == null })}
                title="누르면 모든 기기가 같은 순간에 1초마다 클릭을 냅니다(한 번 더 누르면 멈춤). 한 번에 '딱' 들리면 맞은 것, '따닥' 이면 들으면서 '내 기기 지연' 을 조절하세요."
              >
                {beepAt != null ? "■ 맞춤 확인 멈추기" : "▶ 소리로 맞춤 확인"}
              </button>
              {tg.state.current?.by && <span className="meta">마지막 조작: {tg.state.current.by}</span>}
            </>
          )}
        </div>
      )}

      <div className="sectbar">
        {cur ? (
          <>
            <span className="nowsec">
              {cur.bar}마디 · {beatOf(cur, time)}박
            </span>
            <span className="meta">
              {cur.beats_per_bar}/{cur.beat_unit} · ♩={cur.bpm}
            </span>
            {cur.name && <span className="meta">{cur.name}</span>}
            {next?.name && next.name !== cur.name && (
              <span className={next.start - time <= 8 ? "nowsec" : "meta"}>
                → {next.name} {(next.start - time).toFixed(1)}초 후
              </span>
            )}
          </>
        ) : (
          <span className="meta">{bars.length ? "1마디 전" : "구성표 없음"}</span>
        )}
      </div>

      {tracks.map((t, i) => (
        <div className="trk" key={t.key}>
          <span className="nm">{t.label}</span>
          <span className="tog">
            <button
              className={`ghost${muted[i] ? " on" : ""}`}
              onClick={() => engine.toggleMute(i)}
            >
              음소거
            </button>
            <button className={`ghost${solo[i] ? " on" : ""}`} onClick={() => engine.toggleSolo(i)}>
              솔로
            </button>
          </span>
          <input
            type="range"
            min={0}
            // 메트로놈은 600% 까지 (리미터가 찌그러짐을 막는다). 스템은 100% 까지
            max={t.key === "click" ? 600 : 100}
            value={Math.round((vol[i] ?? 1) * 100)}
            onChange={(e) => engine.setVolume(i, Number(e.target.value) / 100)}
            title={
              t.key === "click"
                ? (t.virtual ? "" : "확정(잠긴) 버전 — 서버가 구운 클릭 파일을 스템처럼 재생합니다. ") +
                  "메트로놈 볼륨 — 음악에 묻히면 100 넘게(최대 600) 올리세요"
                : undefined
            }
          />
          <span className="pct">{Math.round((vol[i] ?? 1) * 100)}</span>
          {t.trackId && (() => {
            const c = customOf(t);
            if (!c) return null;
            return (
              <div className="trkopts">
                <span className="meta" title="트랙의 0초가 곡의 몇 ms 인지. 녹음이 늦게 들리면 −, 빠르면 + (내 연주를 곡에 맞춥니다)">
                  시작
                </span>
                {canEdit && (
                  <button className="ghost" onClick={() => void nudgeTrack(c.id, -100, c.offset_ms)} title="−100ms">
                    −100
                  </button>
                )}
                {canEdit && (
                  <button className="ghost" onClick={() => void nudgeTrack(c.id, -10, c.offset_ms)} title="−10ms">
                    −10
                  </button>
                )}
                <span className="meta" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {c.offset_ms > 0 ? "+" : ""}
                  {c.offset_ms}ms
                </span>
                {canEdit && (
                  <button className="ghost" onClick={() => void nudgeTrack(c.id, 10, c.offset_ms)} title="+10ms">
                    +10
                  </button>
                )}
                {canEdit && (
                  <button className="ghost" onClick={() => void nudgeTrack(c.id, 100, c.offset_ms)} title="+100ms">
                    +100
                  </button>
                )}
                {canEdit && (
                  <button
                    className="ghost"
                    onClick={async () => {
                      const name = await ask({ title: "트랙 이름", value: c.name, okText: "바꾸기" });
                      if (name && name.trim() && name !== c.name)
                        void api.updateTrack(jobId, c.id, { name: name.trim() }).then(() => onChanged?.(), (e) => setHint((e as Error).message));
                    }}
                  >
                    이름
                  </button>
                )}
                {canEdit && (
                  <button
                    className="ghost"
                    onClick={async () => {
                      if (await confirmBox({ title: `'${c.name}' 트랙 삭제`, message: "트랙 파일도 지워집니다.", okText: "삭제", danger: true }))
                        void api.deleteTrack(jobId, c.id).then(() => onChanged?.(), (e) => setHint((e as Error).message));
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

/**
 * 마디 이동: 지금 마디를 보여 주고 ◀ ▶ 로 한 마디씩, 번호를 쳐서 바로 그 마디로.
 * 연습하다 "몇 마디 전으로" 돌아갈 때 파형을 더듬지 않아도 되게.
 * 번호는 치는 동안 재생 위치가 바뀌어도 덮이지 않게 따로 들고, Enter/포커스 해제 때 이동한다.
 */
function BarJump({ cur, last, onGo, name }: { cur: number; last: number; onGo: (n: number) => void; name?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const n = parseInt(draft, 10);
      if (Number.isFinite(n)) onGo(n);
    }
    setDraft(null);
  };
  return (
    <span className="barjump" title="지금 마디. ◀ ▶ 로 한 마디씩, 번호를 치고 Enter 로 그 마디 첫 박으로 이동">
      <button className="ghost" onClick={() => onGo(cur - 1)} disabled={cur <= 1} aria-label="한 마디 앞으로">
        ◀
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={last}
        value={draft ?? (cur || "")}
        placeholder="마디"
        onFocus={(e) => {
          setDraft(String(cur || ""));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="meta">마디{name ? ` · ${name}` : ""}</span>
      <button className="ghost" onClick={() => onGo(cur + 1)} disabled={cur >= last} aria-label="한 마디 뒤로">
        ▶
      </button>
    </span>
  );
}

function beatOf(b: Bar, t: number) {
  const step = stepOf(b.bpm, b.beat_unit);
  // 마디 첫 박에 딱 서면 t 가 start 보다 아주 조금 작을 수 있다 (0박으로 보이던 것) → 1박
  return Math.max(1, Math.min(b.beats_per_bar, Math.floor((t - b.start) / step) + 1));
}

/** 곡 처음에서 시작하는가: 0:00 이거나 1마디 1박(그 앞 못갖춘마디 안 포함) — 예비박을 붙인다 */
function atSongStart(bars: Bar[], pos: number) {
  return pos <= 0.25 || (!!bars.length && pos <= bars[0].start + 0.05);
}

function nextBeatAfter(bars: Bar[], pos: number) {
  for (const b of bars) {
    const step = stepOf(b.bpm, b.beat_unit);
    for (let k = 0; k < b.beats_per_bar; k++) {
      const t = b.start + k * step;
      if (t >= pos - 0.005) return t;
    }
  }
  return pos;
}

/** 재생 속도가 이 범위를 벗어나면 음질이 크게 나빠진다 */
const MIN_RATE = 0.5;
const MAX_RATE = 1.5;

/**
 * 재생 속도를 BPM 으로 고른다. 연습은 120 → 130 → 140 처럼 템포로 올려가므로 배수보다
 * 목표 BPM 이 자연스럽다. 속도 = 목표 / 원곡(송 맵 기본 BPM). 음정은 유지된다.
 */
function BpmControl({ base, rate, onRate }: { base: number; rate: number; onRate: (r: number) => void }) {
  const cur = Math.round(base * rate);
  const [draft, setDraft] = useState(String(cur));
  useEffect(() => setDraft(String(cur)), [cur]);
  const apply = (bpm: number) => {
    if (!Number.isFinite(bpm) || bpm <= 0) return setDraft(String(cur));
    const r = Math.min(MAX_RATE, Math.max(MIN_RATE, bpm / base));
    onRate(Math.abs(r - 1) < 0.002 ? 1 : r);
    setDraft(String(Math.round(base * r)));
  };
  // 5 단위로 맞춰 올리고 내린다 (143 에서 +5 → 145)
  const step = (d: number) => apply(d > 0 ? Math.floor(cur / 5) * 5 + 5 : Math.ceil(cur / 5) * 5 - 5);
  const off = Math.abs(rate - 1) >= 0.002;
  return (
    <span className="bpmctl" title={`원곡 ♩=${Math.round(base * 100) / 100} 기준. 음정은 그대로입니다.`}>
      <span className="meta">♩</span>
      <button className="ghost" onClick={() => step(-1)} disabled={rate <= MIN_RATE + 1e-3}>
        −5
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => apply(Number(draft))}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <button className="ghost" onClick={() => step(1)} disabled={rate >= MAX_RATE - 1e-3}>
        +5
      </button>
      <button className={`ghost${off ? "" : " on"}`} onClick={() => onRate(1)} title="원곡 속도로">
        원곡
      </button>
      {off && <span className="meta">{Math.round(rate * 100)}%</span>}
    </span>
  );
}
