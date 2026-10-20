/**
 * 악기별 화면. 접속하면 먼저 악기를 고른다 — 고른 악기에 따라 분리 기본값(과 앞으로 악기별 기능)이 달라진다.
 * 지금 준비된 것은 드럼뿐이다 (키보드·기타·베이스는 각자 브랜치에서 만들고, 확정되면 ready 를 켠다).
 */
export type InstrumentKey = "drum" | "keyboard" | "guitar" | "bass";

export interface Instrument {
  key: InstrumentKey;
  label: string;
  icon: string;
  /** 쓸 수 있나 (아니면 고르는 화면에서 '준비 중') */
  ready: boolean;
  /** 분리 작업 기본값: 분리 대상, 그 대상을 뺀 반주(no_대상)도 만들지 */
  target: "all" | "drums" | "bass" | "other" | "vocals";
  minus: boolean;
  /** 기본값 설명 (분리 작업 화면에 보인다) */
  note: string;
}

export const INSTRUMENTS: Instrument[] = [
  { key: "drum", label: "드럼", icon: "🥁", ready: true, target: "drums", minus: true,
    note: "드럼만 분리 + 드럼 뺀 반주" },
  { key: "keyboard", label: "키보드", icon: "🎹", ready: false, target: "other", minus: true,
    note: "기타(멜로디 라인) 빼고" },
  { key: "guitar", label: "기타", icon: "🎸", ready: false, target: "other", minus: true,
    note: "기타만 빼고" },
  { key: "bass", label: "베이스", icon: "🎵", ready: false, target: "bass", minus: true,
    note: "베이스만 빼고" },
];

const KEY = "instrument";

export function instrumentOf(key: string | null | undefined): Instrument | null {
  const it = INSTRUMENTS.find((x) => x.key === key);
  return it && it.ready ? it : null;
}

/** 이 기기에서 고른 악기 (준비 안 된 악기면 없음으로) */
export function savedInstrument(): Instrument | null {
  try {
    return instrumentOf(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveInstrument(key: InstrumentKey | null): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    /* 저장 못 해도 이번 접속에는 쓴다 */
  }
}
