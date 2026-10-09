import { useCallback, useEffect, useState } from "react";
import { api, type AccessClient, type AccessDevice, type AccessRole } from "../api";

const ROLE: Record<AccessRole, string> = { view: "보기만", edit: "수정 가능" };

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
 * - 초대 링크: funnel(공개 주소)로 들어올 기기를 등록하는 1회용 링크. 사람마다 이름을 붙여 만들고,
 *   처음 연 기기 한 대가 그 이름으로 등록되면 사라진다.
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

  // 방금 만든 초대 링크 — 서버엔 해시만 남아서 지금만 볼 수 있다
  const [fresh, setFresh] = useState<{ name: string; url: string } | null>(null);
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<AccessRole>("view");

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("초대 링크를 복사했습니다. 등록할 기기의 브라우저에서 한 번 열면 됩니다.");
    } catch {
      setMsg("복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  };

  const createInvite = async () => {
    const name = inviteName.trim();
    if (!name) {
      setMsg("누구에게 보낼 링크인지 이름을 넣어 주세요.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.createInvite(name, inviteRole);
      // 이 PC 에서 직접 열었으면 서버가 공개 주소를 모르므로 지금 주소를 붙인다
      const url = r.url.startsWith("/") ? location.origin + r.url : r.url;
      setFresh({ name: r.name, url });
      setInviteName("");
      setMsg("");
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
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
          사람마다 <b>1회용</b> 링크를 만들어 보내세요. 그 링크를 브라우저에서 처음 연 기기 한 대가 그 이름으로
          등록되고 링크는 사라집니다 — 남에게 넘겨도 다시 쓸 수 없습니다. {data.invite_days}일 안에 안 쓰면
          만료됩니다. 폰과 노트북처럼 기기가 여러 대면 링크도 여러 개 만드세요.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="누구에게? (예: 철수 폰)"
            value={inviteName}
            maxLength={40}
            style={{ flex: 1, minWidth: 180 }}
            onChange={(e) => setInviteName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createInvite()}
          />
          <select
            value={inviteRole}
            style={{ width: 130 }}
            onChange={(e) => setInviteRole(e.target.value as AccessRole)}
            title="보기만: 재생·믹스 받기·다운로드. 수정 가능: 송 맵 저장·분리 등록·삭제까지. 등록된 뒤에도 아래 표에서 바꿀 수 있습니다."
          >
            <option value="view">보기만</option>
            <option value="edit">수정 가능</option>
          </select>
          <button disabled={busy} onClick={() => void createInvite()}>
            링크 만들기
          </button>
        </div>
        {fresh && (
          <div style={{ marginTop: 10 }}>
            <label>{fresh.name} 에게 보낼 링크 — 지금만 볼 수 있습니다 (잃어버리면 취소하고 새로 만드세요)</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input readOnly value={fresh.url} style={{ flex: 1, minWidth: 220 }} onFocus={(e) => e.target.select()} />
              <button className="ghost" onClick={() => void copy(fresh.url)}>
                복사
              </button>
              <button className="ghost" onClick={() => setFresh(null)}>
                닫기
              </button>
            </div>
          </div>
        )}
        {data.invites.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <label>아직 안 쓴 초대 {data.invites.length}개</label>
            {data.invites.map((iv) => (
              <div key={iv.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0" }}>
                <span>{iv.name}</span>
                <span className="meta">{ROLE[iv.role ?? "edit"]}</span>
                <span className="meta">
                  {when(iv.created)} 만듦 · {when(iv.expires)} 만료
                </span>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => void act(() => api.cancelInvite(iv.id), `${iv.name} 초대를 취소했습니다.`)}
                >
                  취소
                </button>
              </div>
            ))}
          </div>
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
                  <th>권한</th>
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
                    <td>
                      <select
                        value={d.role ?? "edit"}
                        disabled={busy}
                        style={{ width: 118 }}
                        onChange={(e) =>
                          void act(
                            () => api.updateDevice(d.id, { role: e.target.value as AccessRole }),
                            `${d.name}: ${ROLE[e.target.value as AccessRole]}`,
                          )
                        }
                        title="보기만: 재생·믹스 받기·다운로드. 수정 가능: 송 맵 저장·분리 등록·삭제까지."
                      >
                        <option value="view">보기만</option>
                        <option value="edit">수정 가능</option>
                      </select>
                    </td>
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
