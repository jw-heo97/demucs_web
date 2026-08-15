import { useState } from "react";
import { api } from "../api";
import type { Me } from "../types";

export function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.login(u.trim(), p);
      onDone(await api.me());
    } catch (e2) {
      setErr((e2 as Error).message);
      setP("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap loginwrap">
      <form className="panel" onSubmit={submit}>
        <h1>Demucs Web</h1>
        <div className="sub" style={{ marginBottom: 16 }}>계속하려면 로그인하세요.</div>

        <label htmlFor="u">아이디</label>
        <input id="u" value={u} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" />

        <label htmlFor="p" style={{ marginTop: 12 }}>비밀번호</label>
        <input
          id="p"
          type="password"
          value={p}
          onChange={(e) => setP(e.target.value)}
          autoComplete="current-password"
        />

        <button style={{ width: "100%", marginTop: 16 }} disabled={busy}>
          로그인
        </button>
        {err && <div className="err" style={{ marginTop: 12, textAlign: "center" }}>{err}</div>}
      </form>
    </div>
  );
}
