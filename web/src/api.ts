/**
 * API 클라이언트.
 *
 * 웹에서는 HttpOnly 쿠키로 인증하고, 앱(Capacitor/Tauri)처럼 쿠키를 못 쓰는 환경에서는
 * 로그인 때 받은 토큰을 저장해 Authorization 헤더로 보낸다. 서버는 둘 다 받는다.
 */
import type {
  Job,
  LogEntry,
  MapPayload,
  Me,
  SearchItem,
  SongMap,
  TokenInfo,
  UserInfo,
} from "./types";

const TOKEN_KEY = "demucs.token";

/** 앱에서는 다른 오리진의 서버를 봐야 하므로 베이스 URL 을 바꿀 수 있게 한다. */
export const BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 사파리 프라이빗 모드 등 */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const tok = getToken();
  if (tok) headers.set("Authorization", `Bearer ${tok}`);

  const res = await fetch(BASE + path, { ...init, headers, credentials: "include" });

  if (res.status === 401) {
    setToken(null);
    onUnauthorized?.();
    throw new ApiError("인증이 필요합니다.", 401);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : null) ?? `요청 실패 (${res.status})`;
    throw new ApiError(detail, res.status);
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const get = <T,>(p: string) => request<T>(p);
const post = <T,>(p: string, body?: unknown) =>
  request<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T,>(p: string, body: unknown) =>
  request<T>(p, { method: "PUT", body: JSON.stringify(body) });
const patch = <T,>(p: string, body: unknown) =>
  request<T>(p, { method: "PATCH", body: JSON.stringify(body) });
const del = <T,>(p: string) => request<T>(p, { method: "DELETE" });

export const api = {
  // --- 인증 ---
  async login(username: string, password: string) {
    const r = await post<{ username: string; role: string; token: string }>(
      "/api/auth/login",
      { username, password },
    );
    if (r.token) setToken(r.token);
    return r;
  },
  async logout() {
    try {
      await post("/api/auth/logout");
    } finally {
      setToken(null);
    }
  },
  me: () => get<Me>("/api/auth/me"),
  changePassword: (oldPw: string, newPw: string) =>
    post<{ note: string }>("/api/auth/password", { old: oldPw, new: newPw }),

  tokens: () => get<{ current: string; tokens: TokenInfo[] }>("/api/auth/tokens"),
  createToken: (label: string) =>
    post<{ token: string; id: string; label: string }>("/api/auth/tokens", { label, days: 0 }),
  revokeToken: (id: string) => del(`/api/auth/tokens/${id}`),
  accessLog: (limit = 300) =>
    get<{ entries: LogEntry[]; ip_trustworthy: boolean }>(`/api/auth/log?limit=${limit}`),

  users: () => get<{ users: UserInfo[]; require_role: string }>("/api/auth/users"),
  createUser: (username: string, password: string, role: string) =>
    post("/api/auth/users", { username, password, role }),
  updateUser: (username: string, body: { role?: string; password?: string }) =>
    patch(`/api/auth/users/${encodeURIComponent(username)}`, body),
  deleteUser: (username: string) => del(`/api/auth/users/${encodeURIComponent(username)}`),

  // --- 정보 ---
  info: () =>
    get<{
      model: string;
      device: string;
      gpu?: string;
      capability?: number[];
      samplerate: number;
      max_duration_sec: number;
      queue: number;
    }>("/api/info"),

  // --- 작업 ---
  jobs: () => get<{ jobs: Job[]; queue: number }>("/api/jobs"),
  submit: (body: {
    url: string;
    title?: string;
    format?: string;
    target?: string;
    save_original?: boolean;
    metronome?: boolean;
    minus_mixes?: boolean;
  }) => post<Job>("/api/jobs", body),
  deleteJob: (id: string) => del(`/api/jobs/${id}`),

  // --- 검색 ---
  search: (q: string, limit = 12) =>
    get<{ items: SearchItem[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  resolve: (url: string) =>
    get<{
      video_id: string;
      title: string;
      channel: string;
      duration: number;
      thumbnail: string;
      playable_in_embed: boolean | null;
    }>(`/api/resolve?url=${encodeURIComponent(url)}`),

  // --- 곡 구성표 ---
  map: (id: string) => get<MapPayload>(`/api/jobs/${id}/map`),
  saveMap: (id: string, map: SongMap) => put<{ bpm: number; bars: number; beats: number }>(
    `/api/jobs/${id}/map`,
    { map },
  ),
  detectMap: (id: string) => post<{ bpm: number; bars: number; octave_note: string; raw_bpm: number }>(
    `/api/jobs/${id}/map/detect`,
  ),
  createVersion: (id: string, name: string, map?: SongMap) =>
    post(`/api/jobs/${id}/map/versions`, { name, map }),
  activateVersion: (id: string, vid: string) =>
    post(`/api/jobs/${id}/map/versions/${vid}/activate`),
  renameVersion: (id: string, vid: string, name: string) =>
    patch(`/api/jobs/${id}/map/versions/${vid}`, { name }),
  deleteVersion: (id: string, vid: string) => del(`/api/jobs/${id}/map/versions/${vid}`),
  restoreMap: (id: string, index: number) => post(`/api/jobs/${id}/map/restore`, { index }),

  // --- 파형 ---
  peaks: (id: string, stem = "drums", buckets = 12000) =>
    get<{ stem: string; buckets: number; duration: number; peaks: number[] }>(
      `/api/jobs/${id}/peaks?stem=${stem}&buckets=${buckets}`,
    ),

  // --- 믹스다운 ---
  mixdown: (
    id: string,
    body: { stems: string[]; gains?: Record<string, number>; format?: string; count_in?: number },
  ) =>
    post<{ file: { name: string; url: string; size: number }; normalized: boolean; count_in: number }>(
      `/api/jobs/${id}/mixdown`,
      body,
    ),

  fileUrl: (u: string, download = false) => BASE + u + (download ? "?download=1" : ""),
};
