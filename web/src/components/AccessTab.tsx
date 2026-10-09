import { useCallback, useEffect, useState } from "react";
import { ask, confirmBox } from "../lib/dialog";
import { api, type AccessClient, type AccessDevice, type AccessLink, type AccessRole } from "../api";

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
 * - 접속 링크: funnel(공개 주소)로 들어올 기기를 등록하는 링크 + 비밀번호. 여러 사람이 같이 쓰고,
 *   링크를 연 사람이 자기 이름과 비밀번호를 넣으면 그 기기가 그 이름으로 등록된다.
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

  // 새 접속 링크 입력
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccessRole>("view");
  const [justMade, setJustMade] = useState<string | null>(null);

  // 이 PC 에서 직접 열었으면 서버가 공개 주소를 모르므로 지금 주소를 붙인다
  const fullUrl = (l: AccessLink) => (l.url.startsWith("/") ? location.origin + l.url : l.url);

  const copy = async (l: AccessLink) => {
    try {
      await navigator.clipboard.writeText(fullUrl(l));
      setMsg(`'${l.label}' 링크를 복사했습니다. 비밀번호는 따로 알려 주세요.`);
    } catch {
      setMsg("복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  };

  const createLink = async () => {
    if (!label.trim()) return setMsg("링크 이름을 넣어 주세요 (예: 밴드 친구들).");
    if (password.trim().length < 4) return setMsg("비밀번호는 4자 이상이어야 합니다.");
    setBusy(true);
    try {
      const l = await api.createLink(label.trim(), password.trim(), role);
      setJustMade(l.id);
      setLabel("");
      setPassword("");
      setMsg(`'${l.label}' 링크를 만들었습니다. 링크와 비밀번호를 보내 주세요.`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (l: AccessLink) => {
    const pw = await ask({
      title: `'${l.label}' 비밀번호 바꾸기`,
      message: "이미 등록한 기기는 그대로 들어옵니다. 새로 등록할 때만 새 비밀번호가 필요합니다.",
      kind: "pin",
      okText: "바꾸기",
    });
    if (pw === null) return;
    if (pw.trim().length < 4) return setMsg("비밀번호는 4자 이상이어야 합니다.");
    void act(() => api.updateLink(l.id, { password: pw.trim() }), `'${l.label}' 비밀번호를 바꿨습니다.`);
  };

  const renameLink = async (l: AccessLink) => {
    const v = await ask({ title: "링크 이름", value: l.label, okText: "바꾸기" });
    if (v && v.trim() && v !== l.label)
      void act(() => api.updateLink(l.id, { label: v.trim() }), "링크 이름을 바꿨습니다.");
  };

  const rename = async (d: AccessDevice) => {
    const name = await ask({ title: "기기 이름", value: d.name, okText: "바꾸기" });
    if (name && name.trim() && name !== d.name)
      void act(() => api.updateDevice(d.id, { name: name.trim() }), "이름을 바꿨습니다.");
  };

  if (!data) return <div className="panel meta">{msg || "불러오는 중…"}</div>;
  const linkName = new Map(data.links.map((l) => [l.id, l.label]));

  return (
    <>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>접속 링크 (공개 주소로 들어올 사람)</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          링크와 비밀번호를 만들어 보내세요. 받은 사람이 링크를 열고 <b>자기 이름</b>과 <b>비밀번호</b>를 넣으면 그
          기기가 그 이름으로 등록됩니다. 링크 하나를 여러 사람·여러 기기가 같이 써도 됩니다. 링크가 새도
          비밀번호를 모르면 못 들어옵니다 (5번 틀리면 5분 막힘).
          한 번 들어온 기기는 이 링크를 열면 바로 앱으로 들어가니, 즐겨찾기나 홈 화면 아이콘으로 쓰게 하세요.
        </p>
        <form
          className="linkform"
          onSubmit={(e) => {
            e.preventDefault();
            void createLink();
          }}
        >
          <input
            placeholder="링크 이름 (예: 밴드 친구들)"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            placeholder="비밀번호 (4자 이상)"
            value={password}
            maxLength={64}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as AccessRole)}
            title="이 링크로 등록되는 기기의 권한. 보기만: 재생·믹스 받기·다운로드. 수정 가능: 송 맵 저장·분리 등록·삭제까지. 등록된 뒤에도 아래 표에서 기기별로 바꿀 수 있습니다."
          >
            <option value="view">보기만</option>
            <option value="edit">수정 가능</option>
          </select>
          <button disabled={busy}>링크 만들기</button>
        </form>
        {msg && <p className="meta">{msg}</p>}

        {data.links.length > 0 && (
          <div className="linklist">
            {data.links.map((l) => (
              <div key={l.id} className={"linkitem" + (l.id === justMade ? " fresh" : "")}>
                <div className="linkhead">
                  <b>{l.label}</b>
                  <span className="meta">
                    {ROLE[l.role]} · 기기 {l.devices}대 · {when(l.created)} 만듦
                  </span>
                </div>
                <div className="linkrow">
                  <input readOnly value={fullUrl(l)} onFocus={(e) => e.target.select()} />
                  <button className="ghost" onClick={() => void copy(l)}>
                    복사
                  </button>
                </div>
                <div className="rowbtns">
                  <button className="ghost" disabled={busy} onClick={() => void changePassword(l)}>
                    비밀번호 바꾸기
                  </button>
                  <button className="ghost" disabled={busy} onClick={() => void renameLink(l)}>
                    이름
                  </button>
                  <select
                    value={l.role}
                    disabled={busy}
                    style={{ width: 118 }}
                    title="앞으로 이 링크로 등록할 기기의 권한 (이미 등록한 기기는 아래 표에서)"
                    onChange={(e) =>
                      void act(
                        () => api.updateLink(l.id, { role: e.target.value as AccessRole }),
                        `'${l.label}': 앞으로 등록하는 기기는 ${ROLE[e.target.value as AccessRole]}`,
                      )
                    }
                  >
                    <option value="view">보기만</option>
                    <option value="edit">수정 가능</option>
                  </select>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirmBox({
                          title: `'${l.label}' 링크 지우기`,
                          message:
                            "이 링크로는 더 이상 새로 들어올 수 없습니다. 이미 등록한 기기는 그대로 들어오니, 끊으려면 아래 표에서 기기를 해제하세요.",
                          okText: "지우기",
                          danger: true,
                        })
                      )
                        void act(() => api.deleteLink(l.id), `'${l.label}' 링크를 지웠습니다.`);
                    }}
                  >
                    지우기
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>등록 기기 {data.devices.length}대</h2>
        {data.devices.length === 0 ? (
          <p className="meta">아직 접속 링크로 등록한 기기가 없습니다.</p>
        ) : (
          <div className="tblwrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>링크</th>
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
                    <td className="meta">{(d.link && linkName.get(d.link)) || "—"}</td>
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
                        <button className="ghost" disabled={busy} onClick={() => void rename(d)}>
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
                          onClick={async () => {
                            if (
                              await confirmBox({
                                title: `${d.name} 등록 해제`,
                                message: "다시 들어오려면 접속 링크에서 이름과 비밀번호를 다시 넣어야 합니다.",
                                okText: "해제",
                                danger: true,
                              })
                            )
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
