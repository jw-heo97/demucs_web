import { INSTRUMENTS, type Instrument, type InstrumentKey } from "../lib/instrument";

/** 접속하면 먼저 보이는 악기 고르기. 준비 안 된 악기는 눌리지 않는다. */
export function InstrumentPicker({ onPick }: { onPick: (key: InstrumentKey) => void }) {
  return (
    <div className="instrument-pick">
      <h2>어떤 악기를 연습하나요?</h2>
      <div className="instrument-grid">
        {INSTRUMENTS.map((it: Instrument) => (
          <button
            key={it.key}
            className={`instrument-card${it.ready ? "" : " off"}`}
            disabled={!it.ready}
            onClick={() => onPick(it.key)}
            title={it.ready ? `${it.label} — ${it.note}` : `${it.label} — 준비 중`}
          >
            <span className="instrument-icon" aria-hidden>{it.icon}</span>
            <b>{it.label}</b>
            <span className="meta">{it.ready ? it.note : "준비 중"}</span>
          </button>
        ))}
      </div>
      <div className="meta">고른 악기는 이 기기에 기억됩니다. 위쪽 악기 이름을 눌러 바꿀 수 있습니다.</div>
    </div>
  );
}
