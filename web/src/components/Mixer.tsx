import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { useAudioEngine } from "../hooks/useAudioEngine";
import { OFFSET_LIMIT, useClickOffset, useLiveMetronome, useSubdiv } from "../hooks/useLiveMetronome";
import { useSectionVoice } from "../hooks/useSectionVoice";
import { roomPosition, useTogether, type RoomState } from "../hooks/useTogether";
import { audioCtx, scheduleClick } from "../lib/audioCtx";
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
function useDeviceDelay(): [number, (ms: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const n = Number(localStorage.getItem(LS_DEVICE));
      return Number.isFinite(n) ? Math.max(0, Math.min(500, n)) : 0;
    } catch {
      return 0;
    }
  });
  const set = (ms: number) => {
    const n = Math.max(0, Math.min(500, Math.round(ms) || 0));
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
  const timers = useRef<{ t?: number; i?: number; oscs: OscillatorNode[] }>({ oscs: [] });
  // 메트로놈 트랙은 파일이 아니라 송 맵에서 즉석으로 울린다 (편집이 바로 들린다)
  const [subdiv, setSubdiv] = useSubdiv();
  const hasMetronome = tracks.some((t) => t.virtual);
  const [clickOffset, setClickOffset] = useClickOffset();
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
  const tg = useTogether(jobId, (s) => applyRoomState(s));

  function applyRoomState(s: RoomState) {
    cancelCount();
    if (Math.abs(s.rate - (rate || 1)) > 1e-3) engine.setRate(s.rate);
    engine.setLoop(s.loop);
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

  // 재생 중 어긋남 보정 + 내 상태 알리기. 소리가 튀지 않게 60ms 넘게 벌어졌을 때만 맞춘다.
  const { send, serverNow, state: roomRef } = tg;
  const rttRef = useRef(tg.rtt);
  rttRef.current = tg.rtt;
  useEffect(() => {
    if (!tg.joined) return;
    let lastFix = 0;
    let tick = 0;
    const id = window.setInterval(() => {
      const s = roomRef.current;
      const a = engine.audios.current[0];
      if (!s) return;
      let err: number | null = null;
      if (s.playing && a && !a.paused && !a.seeking && !countingRef.current) {
        const expected = roomPosition(s, serverNow() + deviceMsRef.current);
        err = a.currentTime - expected;
        if (Math.abs(err) > 0.06 && performance.now() - lastFix > 2500) {
          lastFix = performance.now();
          engine.seek(expected);
        }
      }
      if (++tick % 2 === 0)
        send({ t: "report", err: err == null ? null : Math.round(err * 1000), rtt: rttRef.current, ready: !!a && a.readyState >= 3 });
    }, 1000);
    return () => window.clearInterval(id);
    // tg 는 매 렌더 새 객체라 의존성에 두면 1초 타이머가 계속 다시 걸린다 — 쓰는 것은 모두 안정적이다
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
    const top = Math.max(0, ...idx.filter((i) => !tracks[i].virtual).map((i) => vol[i] ?? 1));
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

  // 다음 곡 자동 시작. 새 곡의 트랙이 실제로 올라온 뒤에만 누른다.
  const startedFor = useRef(autoStart);
  useEffect(() => {
    if (autoStart === undefined || autoStart === startedFor.current) return;
    if (engine.loadedId !== jobId || !tracks.length) return;
    startedFor.current = autoStart;
    void handlePlay({ force: true });
    // handlePlay 는 매 렌더 새로 만들어지지만 여기서는 시작 신호만 보면 된다
  }, [autoStart, engine.loadedId, jobId, tracks]);

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

  if (control) control.current = { playFrom: (pos, loop) => void handlePlay({ force: true, from: pos, loop }) };

  /**
   * force: 재생 중이어도 멈추지 않고 처음부터 다시 시작하며, 위치와 상관없이 예비박을 넣는다.
   * from/loop: 시작 위치와 반복 구간 (안 주면 지금 위치·지금 반복 구간).
   */
  async function handlePlay(opts: { force?: boolean; from?: number; loop?: Region | null } = {}) {
    // iOS 는 사용자 제스처 안에서만 AudioContext 를 깨울 수 있다. 메트로놈·예비박 모두 여기에 의존한다.
    try {
      void audioCtx().resume();
    } catch {
      /* Web Audio 미지원 — 음악만 재생된다 */
    }
    if (tg.joined) {
      // 함께 연습: 방에 알리기만 하고, 실제 재생은 방에서 돌아온 상태로 모두가 같이 한다
      engine.prime();
      voice.prime();
      if ((playing || counting) && !opts.force) {
        tg.send({ t: "pause" });
        return;
      }
      let pos = opts.from ?? time;
      const lp = opts.loop !== undefined ? opts.loop : loopButton?.region ?? null;
      if (lp) pos = lp.start;
      const withCount = !!countIn && (pos <= 0.25 || !!lp || !!opts.force);
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
    if (!countIn || (pos > 0.25 && !lp && !opts.force)) {
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
        scheduleClick(ctx, when, (nCount - k) % bpb === 0 ? 1500 : 1000, ctx.destination),
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

  return (
    <div className="mixer">
      <div className="transport">
        <button className="playbtn" onClick={() => void handlePlay()}>
          {counting ? counting : playing ? "❚❚" : "▶"}
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
        {showRate && bars[0]?.bpm ? (
          <BpmControl base={bars[0].bpm} rate={rate} onRate={setRateShared} />
        ) : null}
        <button
          className={`ghost${tg.joined ? " on" : ""}`}
          onClick={() => (tg.joined ? tg.leave() : joinTogether())}
          title="같은 곡을 연 다른 기기들과 같은 순간에 재생합니다. 누가 재생·멈춤·이동해도 모두 따라갑니다. 볼륨·음소거는 각자 따로입니다."
        >
          {tg.joined ? "함께 연습 중" : "함께 연습"}
        </button>
        <select
          style={{ width: 112 }}
          value={String(countIn)}
          onChange={(e) => onCountInChange(Number(e.target.value))}
        >
          <option value="0">예비박 없음</option>
          <option value="2">예비박 2박</option>
          <option value="4">예비박 4박</option>
          <option value="8">예비박 8박</option>
        </select>
        {voice.available && (
          <button
            className={`ghost${voice.enabled ? " on" : ""}`}
            onClick={() => voice.setEnabled(!voice.enabled)}
            title="송 맵의 구간 이름을 그 구간이 오기 한 마디 전에 소리 내어 읽습니다."
          >
            구간 안내
          </button>
        )}
        {hasMetronome && (
          <select
            style={{ width: 104 }}
            value={String(subdiv)}
            onChange={(e) => setSubdiv(Number(e.target.value) as 1 | 2)}
            title="메트로놈 클릭 간격. 8비트는 박 사이에 작은 클릭이 들어갑니다. 재생 중에도 바로 바뀝니다."
          >
            <option value="1">클릭 4비트</option>
            <option value="2">클릭 8비트</option>
          </select>
        )}
        {(hasMetronome || countIn > 0) && (
          <label
            className="meta"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: 0 }}
            title={
              "클릭 지연 보정 (이 기기에만 저장). 클릭이 음악보다 늦게 들리면 −, 빠르게 들리면 + 로. " +
              "블루투스 이어폰·폰은 수십~수백 ms 차이가 날 수 있습니다. 재생 중에 바꿔도 바로 들립니다."
            }
          >
            클릭
            <input
              type="number"
              style={{ width: 72 }}
              min={-OFFSET_LIMIT}
              max={OFFSET_LIMIT}
              step={5}
              value={clickOffset}
              onChange={(e) => setClickOffset(Number(e.target.value))}
            />
            ms
          </label>
        )}
        <button
          className="ghost"
          onClick={downloadMix}
          disabled={mixing || !tracks.length}
          title="지금 들리는 트랙만 합쳐 mp3 로 받습니다. 예비박 설정이 있으면 앞에 함께 들어갑니다."
        >
          {mixing ? "믹스 만드는 중…" : "믹스 받기"}
        </button>
        {hint && <span className="err">{hint}</span>}
        {!hint && note && <span className="meta">{note}</span>}
      </div>

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
                  {m.err != null && (
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
              <label
                className="meta"
                title="내 기기 소리가 늦게 나오는 만큼(블루투스 이어폰은 100~200ms) 앞서 재생해 다른 사람과 맞춥니다. 이 기기에 기억."
              >
                내 기기 지연
                <input
                  type="number"
                  min={0}
                  max={500}
                  step={10}
                  style={{ width: 64 }}
                  value={deviceMs}
                  onChange={(e) => setDeviceMs(Number(e.target.value))}
                />
                ms
              </label>
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
            max={100}
            value={Math.round((vol[i] ?? 1) * 100)}
            onChange={(e) => engine.setVolume(i, Number(e.target.value) / 100)}
          />
          <span className="pct">{Math.round((vol[i] ?? 1) * 100)}</span>
        </div>
      ))}
    </div>
  );
}

function beatOf(b: Bar, t: number) {
  const step = stepOf(b.bpm, b.beat_unit);
  return Math.min(b.beats_per_bar, Math.floor((t - b.start) / step) + 1);
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
