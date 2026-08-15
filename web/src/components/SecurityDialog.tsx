import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fmtDate } from "../lib/time";
import type { LogEntry, Me, TokenInfo, UserInfo } from "../types";

const EV: Record<string, [string, string]> = {
  login_ok: ["로그인", "ok"],
  login_fail: ["로그인 실패", "bad"],
  login_locked: ["잠김", "bad"],
  login_forbidden: ["권한 없음", "bad"],
  forbidden: ["차단", "bad"],
  logout: ["로그아웃", ""],
  access: ["접근", ""],
  token_create: ["토큰 발급", ""],
  token_revoke: ["토큰 해제", ""],
  password_change: ["비밀번호 변경", "ok"],
  bootstrap: ["계정 생성", "ok"],
  user_create: ["계정 추가", "ok"],
  user_delete: ["계정 삭제", "bad"],
  user_role: ["역할 변경", ""],
  user_reset: ["비밀번호 초기화", ""],
};

export function SecurityDialog({ open, me, onClose }: { open: boolean; me: Me; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [current, setCurrent] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [requireRole, setRequireRole] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [msg, setMsg] = useState("");
  const [nu, setNu] = useState({ username: "", password: "", role: "user" });

  const load = useCallback(async () => {
    try {
      const t = await api.tokens();
      setTokens(t.tokens);
      setCurrent(t.current);
    } catch { /* noop */ }
    try {
      setLog((await api.accessLog(300)).entries);
    } catch { /* noop */ }
    if (me.is_admin) {
      try {
        const u = await api.users();
        setUsers(u.users);
        setRequireRole(u.require_role);
      } catch { /* noop */ }
    }
  }, [me.is_admin]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      load();
    }
    if (!open && d.open) d.close();
  }, [open, load]);

  return (
    <dialog ref={ref} onClose={onClose}>
      <div className="dlghead">
        <strong>보안</strong>
        <button className="ghost" onClick={onClose}>닫기</button>
      </div>
      <div className="dlgbody">
        {!me.ip_trustworthy && (
          <div className="warn">
            <b>접속 IP가 실제 주소가 아닙니다.</b> Docker Desktop for Windows는 포트 포워딩에서
            출발지 IP를 지웁니다. 현재 기록되는 값은 <code>{me.client_ip}</code> 입니다.
            Tailscale 같은 호스트 프록시를 두고 <code>TRUST_PROXY_HEADER=1</code> 을 켜면 실제 주소가 남습니다.
            <br />
            <b>사용자·기기(토큰)·시각 기록은 정확합니다.</b>
          </div>
        )}

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <label style={{ margin: 0 }}>접속 토큰</label>
            <button
              className="ghost"
              onClick={async () => {
                const label = prompt("토큰 이름", "API 토큰");
                if (label == null) return;
                const r = await api.createToken(label);
                setNewToken(r.token);
                load();
              }}
            >
              API 토큰 발급
            </button>
          </div>
          {newToken && (
            <div className="warn" style={{ background: "var(--accent-weak)", borderColor: "var(--accent)" }}>
              <div style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{newToken}</div>
              <div className="meta">이 값은 다시 볼 수 없습니다. 지금 복사하세요.</div>
            </div>
          )}
          {tokens.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: ".82rem" }}>
                  {t.label} {t.id === current && <span className="badge">현재 기기</span>}
                </div>
                <div className="meta" style={{ wordBreak: "break-all" }}>{t.ua || "-"}</div>
                <div className="meta">
                  발급 {fmtDate(t.created_at)} · 최근 {fmtDate(t.last_used)} · IP {t.last_ip || "-"}
                </div>
              </div>
              <button
                className="ghost"
                onClick={async () => {
                  if (!confirm("이 토큰을 해제하면 해당 기기는 즉시 로그아웃됩니다.")) return;
                  await api.revokeToken(t.id);
                  load();
                }}
              >
                해제
              </button>
            </div>
          ))}
        </div>

        {me.is_admin && (
          <div className="panel">
            <label style={{ marginBottom: 10 }}>
              계정 <span className="meta">(접근 가능 역할: {requireRole || "제한 없음"})</span>
            </label>
            {users.map((u) => (
              <div key={u.username} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                <span style={{ flex: 1, fontSize: ".85rem" }}>
                  {u.username} <span className="meta">{u.role}</span>
                </span>
                <select
                  style={{ width: 100 }}
                  value={u.role}
                  onChange={async (e) => {
                    try {
                      await api.updateUser(u.username, { role: e.target.value });
                      load();
                    } catch (err) {
                      alert((err as Error).message);
                    }
                  }}
                >
                  <option value="admin">admin</option>
                  <option value="user">user</option>
                </select>
                {u.username !== me.username && (
                  <button
                    className="ghost"
                    onClick={async () => {
                      if (!confirm(`${u.username} 계정을 삭제합니다.`)) return;
                      try {
                        await api.deleteUser(u.username);
                        load();
                      } catch (err) {
                        alert((err as Error).message);
                      }
                    }}
                  >
                    삭제
                  </button>
                )}
              </div>
            ))}
            <div className="row" style={{ marginTop: 12 }}>
              <input placeholder="새 아이디" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
              <input placeholder="비밀번호 (8자 이상)" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
              <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div className="actions">
              <button
                onClick={async () => {
                  try {
                    await api.createUser(nu.username, nu.password, nu.role);
                    setNu({ username: "", password: "", role: "user" });
                    setMsg("계정을 추가했습니다.");
                    load();
                  } catch (e) {
                    setMsg((e as Error).message);
                  }
                }}
              >
                계정 추가
              </button>
              <span className="meta">{msg}</span>
            </div>
          </div>
        )}

        <div className="panel">
          <label style={{ marginBottom: 10 }}>비밀번호 변경</label>
          <div className="row">
            <input type="password" placeholder="현재 비밀번호" value={pwOld} onChange={(e) => setPwOld(e.target.value)} />
            <input type="password" placeholder="새 비밀번호 (8자 이상)" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
          </div>
          <div className="actions">
            <button
              onClick={async () => {
                try {
                  const r = await api.changePassword(pwOld, pwNew);
                  setMsg(r.note);
                  setTimeout(() => location.reload(), 1500);
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            >
              변경
            </button>
            <span className="meta">{msg}</span>
          </div>
        </div>

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <label style={{ margin: 0 }}>접속 기록</label>
            <button className="ghost" onClick={load}>새로고침</button>
          </div>
          <div className="logwrap">
            <table className="log">
              <tbody>
                {log.map((e, i) => {
                  const [label, cls] = EV[e.event] ?? [e.event, ""];
                  const what = e.event === "access" ? `${e.method} ${e.path}${e.status ? ` → ${e.status}` : ""}` : e.detail || e.token || "";
                  return (
                    <tr key={i}>
                      <td>{fmtDate(e.ts)}</td>
                      <td><span className={`ev ${cls}`}>{label}</span></td>
                      <td>{e.user ?? "-"}</td>
                      <td>{e.ip ?? "-"}</td>
                      <td className="p">{what}</td>
                    </tr>
                  );
                })}
                {!log.length && <tr><td className="p">기록이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </dialog>
  );
}
