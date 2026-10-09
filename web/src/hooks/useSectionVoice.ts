import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bar } from "../types";
import type { useAudioEngine } from "./useAudioEngine";

type Engine = ReturnType<typeof useAudioEngine>;

interface Section {
  name: string;
  /** 구간 첫 마디 시각(초) */
  start: number;
  /** 이 시각을 지나면 이름을 읽는다 — 보통 한 마디 전 */
  cue: number;
}

const LS_KEY = "voice.sections";
/** 한 마디가 이보다 짧으면(빠른 곡) 두 마디 전에 읽는다. 말할 틈이 있어야 한다. */
const MIN_LEAD = 1.2;

const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

function speak(text: string) {
  if (!canSpeak()) return;
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  // 한글이 있으면 한국어 음성, 아니면(Verse, Chorus…) 영어 음성 — 한국어 음성이 영어를 읽으면 어색하다
  const lang = /[가-힣]/.test(text) ? "ko-KR" : "en-US";
  u.lang = lang;
  const voice = synth.getVoices().find((v) => v.lang.replace("_", "-").startsWith(lang));
  if (voice) u.voice = voice;
  u.rate = 1.1;
  // 앞 안내가 아직 말하는 중이면 끊고 새 것을 말한다 — 늦은 안내는 틀린 안내다
  synth.cancel();
  synth.speak(u);
}

/** 구간 이름이 바뀌는 마디들 */
function sectionsOf(bars: Bar[]): Section[] {
  const out: Section[] = [];
  bars.forEach((b, i) => {
    if (!b.name || (i > 0 && bars[i - 1].name === b.name)) return;
    const prev = bars[i - 1];
    let lead = prev ? b.start - prev.start : (60 / b.bpm) * (4 / b.beat_unit) * b.beats_per_bar;
    if (lead < MIN_LEAD && i > 1) lead = b.start - bars[i - 2].start;
    out.push({ name: b.name, start: b.start, cue: b.start - lead });
  });
  return out;
}

/**
 * 송 맵의 구간 이름(Intro, Verse, 후렴…)을 그 구간이 오기 한 마디 전에 소리 내어 읽는다.
 * 브라우저 내장 음성 합성(Web Speech API)을 쓴다 — 서버나 외부 서비스가 필요 없다.
 *
 * 메트로놈처럼 <audio> 재생 위치를 직접 지켜본다(화면 갱신 주기에 기대지 않는다).
 */
export function useSectionVoice(engine: Engine, bars: Bar[]) {
  const [enabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem(LS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const sections = useMemo(() => sectionsOf(bars), [bars]);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  // 이번 재생에서 이미 읽은 구간 (탐색하거나 멈추면 비운다)
  const said = useRef(new Set<number>());

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      localStorage.setItem(LS_KEY, on ? "1" : "0");
    } catch {
      /* 기억만 못 할 뿐 */
    }
    // 켜는 순간(사용자 제스처 안)에 한 번 말해 둬야 iOS 가 이후의 음성을 허락한다
    if (on) speak("구간 안내");
    else if (canSpeak()) window.speechSynthesis.cancel();
  }, []);

  /** 재생 버튼을 누른 순간(제스처 안) 호출 — iOS 음성 잠금을 풀어둔다 */
  const prime = useCallback(() => {
    if (!enabled || !canSpeak()) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }, [enabled]);

  /**
   * 예비박을 시작할 때 부른다. pos 에서 곧 시작하는 구간(곡 맨 앞 Intro, 반복 구간 등)은
   * 읽지 않고 읽은 것으로 쳐 둔다 — 예비박 동안 읽으면 클릭과 겹쳐 박을 세기 어렵다.
   * 어느 구간에서 시작하는지는 누른 사람이 이미 안다.
   */
  const cueAt = useCallback(
    (pos: number, within: number) => {
      if (!enabled) return;
      const ss = sectionsRef.current;
      const i = ss.findIndex((s) => s.start >= pos - 0.05);
      if (i < 0 || ss[i].start - pos > within) return;
      said.current.add(i);
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled || !canSpeak()) return;
    let last: number | null = null;
    let wasPlaying = false;
    let startedAt = 0;
    const id = window.setInterval(() => {
      const a = engine.audios.current[0];
      if (!a || a.paused) {
        if (wasPlaying) said.current.clear();
        wasPlaying = false;
        last = a ? a.currentTime : null;
        return;
      }
      const t = a.currentTime;
      const ss = sectionsRef.current;
      if (!wasPlaying) {
        // 막 재생을 시작했다: 지금 위치가 어느 구간의 '안내 시점 ~ 시작' 사이면 그 구간은
        // 읽지 않는다 — 재생 직후(예비박 끝)에 읽으면 첫 박과 겹친다. 다음 구간부터 읽는다.
        wasPlaying = true;
        startedAt = performance.now();
        const from = last ?? t;
        ss.forEach((s, i) => {
          if (from >= s.cue && from < s.start - 0.3) said.current.add(i);
        });
      } else if (performance.now() - startedAt < 1000 && last !== null && (t < last || t - last > 1)) {
        // 재생 직후 위치가 자리 잡는 중 — 합친 재생은 예비박 파일로 바꿔 끼우는 순간 위치가 잠깐
        // 곡 0초보다 앞(-10초)을 가리켰다가 돌아온다. 이걸 '이동' 으로 보고 지우면 첫 구간(예비박과
        // 겹쳐서 일부러 건너뛴 것)을 다시 읽었다. 새 위치 기준으로 시작 판단만 다시 한다.
        ss.forEach((s, i) => {
          if (t >= s.cue && t < s.start - 0.3) said.current.add(i);
        });
      } else if (last !== null && (t < last || t - last > 1)) {
        // 탐색·구간 반복: 다시 읽을 수 있게 비운다
        said.current.clear();
      } else if (last !== null) {
        ss.forEach((s, i) => {
          if (last! < s.cue && t >= s.cue && !said.current.has(i)) {
            said.current.add(i);
            speak(s.name);
          }
        });
      }
      last = t;
    }, 50);
    return () => window.clearInterval(id);
  }, [enabled, engine.audios]);

  // 곡이 바뀌면 처음부터
  useEffect(() => {
    said.current.clear();
  }, [sections]);

  return { enabled, setEnabled, available: canSpeak() && sections.length > 0, prime, cueAt };
}
