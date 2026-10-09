import { useEffect, useState } from "react";
import { parseTime, showTime } from "../lib/time";

interface Props {
  value: number;
  onChange: (v: number) => void;
  className?: string;
}

/**
 * `m:ss.mmm` 시각 입력란.
 *
 * 값(초)을 그대로 입력란에 묶으면 글자를 칠 때마다 다시 포맷돼 타이핑이 안 된다
 * ("1" 을 치면 바로 "0:01.000" 이 된다). 그래서 글자는 따로 들고 있다가
 * 포커스를 떠날 때(또는 Enter) 해석해서 올려보내고, 바깥에서 값이 바뀌면 그때 글자를 맞춘다.
 */
export function TimeInput({ value, onChange, className }: Props) {
  const [text, setText] = useState(() => showTime(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(showTime(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const v = parseTime(text);
    if (Number.isFinite(v) && v >= 0) onChange(+v.toFixed(3));
    else setText(showTime(value));
  };

  return (
    <input
      type="text"
      className={className}
      inputMode="decimal"
      value={text}
      placeholder="0:00.000"
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(showTime(value));
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
