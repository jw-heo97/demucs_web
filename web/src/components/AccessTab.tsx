import { useCallback, useEffect, useState } from "react";
import { api, type AccessClient, type AccessDevice } from "../api";

const VIA: Record<AccessClient["via"], string> = {
  tailnet: "Tailscale",
  funnel: "공개 링크",
  proxy: "Tailscale(태그)",
  direct: "이 PC",
};

function ago(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function when(ts: number) {
  return new Date(ts * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

/** User-Agent 를 짧게 (기기 · 브라우저) */
function shortUa(ua: string) {
  const u = ua.toLowerCase();
  const dev = u.includes("ipad") ? "iPad" : u.includes("iphone") ? "iPhone" : u.includes("android") ? "Android"
    : u.includes("macintosh") ? "Mac" : u.includes("windows") ? "Windows" : u.includes("curl") ? "curl" : "";
  const br = u.includes("edg/") ? "Edge" : u.includes("chrome/") || u.includes("crios/") ? "Chrome"
    : u.includes("firefox/") ? "Firefox" : u.includes("safari/") ? "Safari" : "";
  return [dev, br].filter(Boolean).join(" · ") || ua.slice(0, 40);
}

/**
 * 접속자 관리. 내 Tailscale 계정 기기(와 이 PC)에서만 탭이 보이고, 서버도 /api/admin/* 를
 * 그 밖의 접속에는 403 으로 막는다.
 *
 * - 초대 링크: funnel(공개 주소)로 들어올 기기를 등록하는 링크. 새로 만들면 이전 링크는 무효,
 *   이미 등록된 기기는 그대로.
 * - 등록 기기: 링크로 등록한 브라우저들. 이름 변경·차단·등록 해제.
 * - 최근 접속: 서버가 켜진 뒤 들어온 접속 (Tailscale 계정·공개 링크 기기·이 PC).
 */
export function AccessTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.access>> | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.access());
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(note);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("초대 링크를 복사했습니다. 등록할 기기의 브라우저에서 한 번 열면 됩니다.");
    } catch {
      setMsg("복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  };

  const rename = (d: AccessDevice) => {
    const name = prompt("기기 이름", d.name);
    if (name && name.trim() && name !== d.name)
      void act(() => api.updateDevice(d.id, { name: name.trim() }), "이름을 바꿨습니다.");
  };

  if (!data) return <div className="panel meta">{msg || "불러오는 중…"}</div>;

  return (
    <>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>초대 링크 (공개 주소로 들어올 기기 등록)</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          Tailscale 을 쓰지 않는 기기는 이 링크를 브라우저에서 <b>한 번</b> 열면 등록되고, 그 뒤로는
          공개 주소(funnel)로 들어올 수 있습니다. 링크는 비밀번호와 같으니 들일 사람에게만 보내세요.
          새 링크를 만들면 이전 링크로는 더 등록할 수 없고, 이미 등록된 기기는 그대로입니다.
        </p>
        {data.invite_enabled && data.invite_url ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input readOnly value={data.invite_url} style={{ flex: 1, minWidth: 220 }} onFocus={(e) => e.target.select()} />
            <button className="ghost" onClick={() => void copy(data.invite_url!)}>
              복사
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm("새 초대 링크를 만들까요? 지금 링크로는 더 이상 등록할 수 없습니다."))
                  void act(() => api.setInvite(true), "새 초대 링크를 만들었습니다.");
              }}
            >
              새 링크
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => void act(() => api.setInvite(false), "초대를 껐습니다. 등록된 기기는 그대로입니다.")}
            >
              초대 끄기
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="meta">초대가 꺼져 있습니다 — 새 기기를 등록할 수 없습니다.</span>
            <button className="ghost" disabled={busy} onClick={() => void act(() => api.setInvite(true), "초대 링크를 만들었습니다.")}>
              초대 링크 만들기
            </button>
          </div>
        )}
        {data.invite_url?.startsWith("/") && (
          <p className="meta">
            이 PC 에서 직접 열어서 공개 주소를 모릅니다. 실제 링크는 <code>https://&lt;기기&gt;.&lt;tailnet&gt;.ts.net</code> 뒤에
            위 경로를 붙인 것입니다.
          </p>
        )}
        {msg && <p className="meta">{msg}</p>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>등록 기기 {data.devices.length}대</h2>
        {data.devices.length === 0 ? (
          <p className="meta">아직 초대 링크로 등록한 기기가 없습니다.</p>
        ) : (
          <div className="tblwrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>브라우저</th>
                  <th>등록</th>
                  <th>마지막 접속</th>
                  <th>IP</th>
                  <th>상태</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.devices.map((d) => (
                  <tr key={d.id} className={d.blocked ? "dup" : undefined}>
                    <td>{d.name}</td>
                    <td className="meta" title={d.ua}>
                      {shortUa(d.ua)}
                    </td>
                    <td className="meta">{when(d.created)}</td>
                    <td className="meta" title={when(d.last)}>
                      {ago(d.last)}
                    </td>
                    <td className="meta">{d.last_ip}</td>
                    <td>{d.blocked ? <span className="err">차단됨</span> : "허용"}</td>
                    <td>
                      <div className="rowbtns">
                        <button className="ghost" disabled={busy} onClick={() => rename(d)}>
                          이름
                        </button>
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api.updateDevice(d.id, { blocked: !d.blocked }),
                              d.blocked ? `${d.name} 차단을 풀었습니다.` : `${d.name} 을(를) 차단했습니다.`,
                            )
                          }
                        >
                          {d.blocked ? "허용" : "차단"}
                        </button>
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`${d.name} 의 등록을 해제할까요? 다시 들어오려면 초대 링크가 필요합니다.`))
                              void act(() => api.deleteDevice(d.id), `${d.name} 등록을 해제했습니다.`);
                          }}
                        >
                          해제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>최근 접속 {data.clients.length}</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          서버가 켜진 뒤 들어온 접속입니다 (재시작하면 비워집니다).
          {data.allow_users.length > 0 && <> Tailscale 허용 계정: {data.allow_users.join(", ")}</>}
        </p>
        <div className="tblwrap">
          <table className="grid">
            <thead>
              <tr>
                <th>경로</th>
                <th>누구</th>
                <th>IP</th>
                <th>브라우저</th>
                <th>마지막</th>
                <th>요청</th>
                <th>마지막 요청</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={`${c.via}|${c.ip}|${c.login}|${c.device_id ?? ""}`} className={c.denied ? "dup" : undefined}>
                  <td>{VIA[c.via] ?? c.via}</td>
                  <td>{c.login || c.device || (c.via === "funnel" ? <span className="err">미등록</span> : "—")}</td>
                  <td className="meta">{c.ip}</td>
                  <td className="meta" title={c.ua}>
                    {shortUa(c.ua)}
                  </td>
                  <td className="meta" title={when(c.last)}>
                    {ago(c.last)}
                  </td>
                  <td className="meta">
                    {c.requests}
                    {c.denied > 0 && <span className="err"> (차단 {c.denied})</span>}
                  </td>
                  <td className="meta">
                    {c.last_path} → {c.last_status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
