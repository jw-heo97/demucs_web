import { useEffect, useRef, useState } from "react";

/**
 * 앱 안에 뜨는 입력·확인 화면. 브라우저 기본 prompt/confirm/alert 를 쓰지 않는다 —
 * iPad 에서는 작고 Enter 로 확인이 안 되며, PIN 을 칠 때 숫자 키패드도 안 뜬다.
 *
 * 어디서든 `await ask({...})` / `await confirmBox({...})` / `await choose({...})` 로 부르고,
 * 화면은 App 에 한 번 둔 <DialogHost /> 가 그린다. Enter = 확인, Esc·바깥 누르기 = 취소.
 */

type Kind = "text" | "pin" | "number";

interface AskOpts {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  kind?: Kind;
  okText?: string;
  /** 빈 값으로도 확인할 수 있는가 (기본: 안 됨) */
  allowEmpty?: boolean;
}
interface ConfirmOpts {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  /** 지우기처럼 되돌릴 수 없는 일 — 확인 버튼을 빨갛게 */
  danger?: boolean;
}
interface ChooseOpts<T> {
  title: string;
  message?: string;
  items: { label: string; sub?: string; value: T }[];
}

type Req =
  | { type: "ask"; opts: AskOpts; resolve: (v: string | null) => void }
  | { type: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { type: "choose"; opts: ChooseOpts<unknown>; resolve: (v: unknown) => void }
  | { type: "notice"; opts: { title: string; message?: string }; resolve: () => void };

let push: ((r: Req) => void) | null = null;
const pending: Req[] = [];
const send = (r: Req) => (push ? push(r) : pending.push(r));

/** 글자 입력. 취소하면 null */
export const ask = (opts: AskOpts) => new Promise<string | null>((resolve) => send({ type: "ask", opts, resolve }));
/** 확인/취소 */
export const confirmBox = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => send({ type: "confirm", opts, resolve }));
/** 목록에서 하나 고르기. 취소하면 null */
export const choose = <T,>(opts: ChooseOpts<T>) =>
  new Promise<T | null>((resolve) => send({ type: "choose", opts: opts as ChooseOpts<unknown>, resolve: resolve as (v: unknown) => void }));
/** 알림 (확인 버튼 하나) */
export const notice = (title: string, message?: string) =>
  new Promise<void>((resolve) => send({ type: "notice", opts: { title, message }, resolve }));

/** App 에 한 번 둔다 */
export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    if (pending.length) setQueue((q) => [...q, ...pending.splice(0)]);
    return () => {
      push = null;
    };
  }, []);
  const cur = queue[0];
  const close = () => setQueue((q) => q.slice(1));
  if (!cur) return null;
  return <Dialog key={queue.length + ":" + cur.opts.title} req={cur} onDone={close} />;
}

function Dialog({ req, onDone }: { req: Req; onDone: () => void }) {
  const isAsk = req.type === "ask";
  const askOpts = isAsk ? req.opts : null;
  const [value, setValue] = useState(askOpts?.value ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);

  const cancel = () => {
    if (req.type === "ask") req.resolve(null);
    else if (req.type === "confirm") req.resolve(false);
    else if (req.type === "choose") req.resolve(null);
    else req.resolve();
    onDone();
  };
  const ok = () => {
    if (req.type === "ask") {
      if (!value.trim() && !req.opts.allowEmpty) return inputRef.current?.focus();
      req.resolve(value);
    } else if (req.type === "confirm") req.resolve(true);
    else if (req.type === "notice") req.resolve();
    else return;
    onDone();
  };

  // 열리면 입력칸(없으면 확인 버튼)에 포커스 — 바로 치고 Enter
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      } else okRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  // Esc 로 취소 (입력칸 밖에 포커스가 있어도)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const o = req.opts as { title: string; message?: string; okText?: string; cancelText?: string; danger?: boolean };
  const kind = askOpts?.kind ?? "text";

  return (
    <div className="dlg-back" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={o.title}
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <h3>{o.title}</h3>
        {o.message && <p className="dlg-msg">{o.message}</p>}

        {req.type === "ask" && (
          <input
            ref={inputRef}
            autoFocus
            className={kind === "pin" ? "dlg-pin" : undefined}
            type={kind === "pin" ? "password" : kind === "number" ? "number" : "text"}
            inputMode={kind === "pin" || kind === "number" ? "numeric" : undefined}
            autoComplete={kind === "pin" ? "one-time-code" : "off"}
            enterKeyHint="done"
            value={value}
            placeholder={req.opts.placeholder}
            maxLength={kind === "pin" ? 12 : 100}
            onChange={(e) => setValue(e.target.value)}
          />
        )}

        {req.type === "choose" && (
          <div className="dlg-list">
            {req.opts.items.map((it, i) => (
              <button
                key={i}
                type="button"
                className="ghost"
                onClick={() => {
                  req.resolve(it.value);
                  onDone();
                }}
              >
                <span>{it.label}</span>
                {it.sub && <span className="meta">{it.sub}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="dlg-btns">
          {req.type !== "notice" && (
            <button type="button" className="ghost" onClick={cancel}>
              {o.cancelText ?? "취소"}
            </button>
          )}
          {req.type !== "choose" && (
            <button ref={okRef} type="submit" className={o.danger ? "danger" : undefined}>
              {o.okText ?? "확인"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
