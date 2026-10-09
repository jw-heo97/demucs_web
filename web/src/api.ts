/**
 * API 클라이언트.
 *
 * 인증은 없다 — 접근 제어는 Tailscale 이 맡는다 (README 참고).
 */
import type { Job, JobTrack, MapPayload, MapVersion, Playlist, ScoreData, SearchItem, SongMap } from "./types";

/** 앱에서는 다른 오리진의 서버를 봐야 하므로 베이스 URL 을 바꿀 수 있게 한다. */
export const BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(BASE + path, { ...init, headers });

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

/** 등록 기기의 권한: 보기만(재생·다운로드) / 수정 가능 */
export type AccessRole = "view" | "edit";

export interface AccessDevice {
  id: string;
  name: string;
  role: AccessRole;
  ua: string;
  created: number;
  last: number;
  last_ip: string;
  blocked: boolean;
}

export interface AccessInvite {
  id: string;
  name: string;
  role: AccessRole;
  created: number;
  expires: number;
}

export interface AccessClient {
  via: "funnel" | "tailnet" | "proxy" | "direct";
  ip: string;
  login: string;
  name: string;
  ua: string;
  first: number;
  last: number;
  requests: number;
  denied: number;
  last_path: string;
  last_status: number;
  device: string | null;
  device_id: string | null;
}

export const api = {
  // --- 접속자 관리 ---
  me: () =>
    get<{ via: string; login: string; admin: boolean; can_edit: boolean; key: string; device: string | null }>("/api/me"),
  access: () =>
    get<{
      devices: AccessDevice[];
      invites: AccessInvite[];
      clients: AccessClient[];
      allow_users: string[];
      invite_days: number;
    }>("/api/admin/access"),
  /** 1회용 초대 링크. url 은 이 응답에서만 받을 수 있다 (서버엔 해시만 남는다). */
  createInvite: (name: string, role: AccessRole) =>
    post<AccessInvite & { url: string }>("/api/admin/invites", { name, role }),
  cancelInvite: (id: string) => del(`/api/admin/invites/${id}`),
  updateDevice: (id: string, body: { name?: string; blocked?: boolean; role?: AccessRole }) =>
    patch<AccessDevice>(`/api/admin/devices/${id}`, body),
  deleteDevice: (id: string) => del(`/api/admin/devices/${id}`),

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
      live: boolean;
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
  alignMap: (id: string, map: SongMap) =>
    post<{
      map: SongMap;
      groups: { from_bar: number; offset: number | null; confidence: number; beats: number }[];
      source: string;
    }>(`/api/jobs/${id}/map/align`, { map }),
  createVersion: (id: string, name: string, map?: SongMap) =>
    post(`/api/jobs/${id}/map/versions`, { name, map }),
  activateVersion: (id: string, vid: string) =>
    post(`/api/jobs/${id}/map/versions/${vid}/activate`),
  renameVersion: (id: string, vid: string, name: string) =>
    patch(`/api/jobs/${id}/map/versions/${vid}`, { name }),
  deleteVersion: (id: string, vid: string) => del(`/api/jobs/${id}/map/versions/${vid}`),
  /** 잠그기 {locked:true, pin?} / 풀기 {locked:false, pin?} */
  lockVersion: (id: string, vid: string, body: { locked: boolean; pin?: string }) =>
    post<{ version: MapVersion; job: Job }>(`/api/jobs/${id}/map/versions/${vid}/lock`, body),
  restoreMap: (id: string, index: number) => post(`/api/jobs/${id}/map/restore`, { index }),

  // --- 파형 ---
  peaks: (id: string, stem = "drums", buckets = 12000) =>
    get<{ stem: string; buckets: number; duration: number; peaks: number[] }>(
      `/api/jobs/${id}/peaks?stem=${stem}&buckets=${buckets}`,
    ),

  // --- 믹스다운 ---
  mixdown: (
    id: string,
    body: {
      stems: string[];
      gains?: Record<string, number>;
      format?: string;
      count_in?: number;
      /** 1 = 4비트, 2 = 8비트(메트로놈 박 사이 클릭 포함) */
      subdiv?: 1 | 2;
    },
  ) =>
    post<{ file: { name: string; url: string; size: number }; normalized: boolean; count_in: number }>(
      `/api/jobs/${id}/mixdown`,
      body,
    ),

  // --- 악보 ---
  score: (id: string) => get<ScoreData>(`/api/jobs/${id}/score`),
  uploadScore: (id: string, pdf: Blob) =>
    request<ScoreData>(`/api/jobs/${id}/score`, {
      method: "PUT",
      body: pdf,
      headers: { "Content-Type": "application/pdf" },
    }),
  deleteScore: (id: string) => del(`/api/jobs/${id}/score`),

  // --- 사용자 트랙 (녹음·반주) ---
  uploadTrack: (id: string, audio: Blob, name: string, offsetMs: number) =>
    request<{ track: JobTrack; job: Job }>(
      `/api/jobs/${id}/tracks?name=${encodeURIComponent(name)}&offset_ms=${Math.round(offsetMs)}`,
      { method: "POST", body: audio, headers: { "Content-Type": audio.type || "application/octet-stream" } },
    ),
  updateTrack: (id: string, tid: string, body: { name?: string; offset_ms?: number }) =>
    patch<{ track: JobTrack; job: Job }>(`/api/jobs/${id}/tracks/${tid}`, body),
  deleteTrack: (id: string, tid: string) => del<{ job: Job }>(`/api/jobs/${id}/tracks/${tid}`),

  // --- 플레이리스트 ---
  playlists: () => get<{ playlists: Playlist[] }>("/api/playlists"),
  createPlaylist: (name: string, items: string[] = []) =>
    post<Playlist>("/api/playlists", { name, items }),
  updatePlaylist: (id: string, body: { name?: string; items?: string[] }) =>
    put<Playlist>(`/api/playlists/${id}`, body),
  deletePlaylist: (id: string) => del(`/api/playlists/${id}`),

  fileUrl: (u: string, download = false) => BASE + u + (download ? "?download=1" : ""),
};
