/**
 * API 클라이언트.
 *
 * 인증은 없다 — 접근 제어는 Tailscale 이 맡는다 (README 참고).
 */
import { instQuery } from "./lib/instrument";
import type { Notation } from "./lib/notation";
import type { AiRun, InkDoc, Job, JobTrack, MapPayload, MapVersion, Playlist, ScoreData, SearchItem, SongMap } from "./types";

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
  /** 등록에 쓴 접속 링크 id (예전 1회용 초대로 등록했으면 없음) */
  link?: string;
}

export interface AccessLink {
  id: string;
  code: string;
  url: string;
  label: string;
  role: AccessRole;
  created: number;
  /** 이 링크로 등록한 횟수 */
  uses: number;
  /** 지금 이 링크로 등록되어 있는 기기 수 */
  devices: number;
  /** 관리자가 이 링크에 공유한 곡 수 */
  songs: number;
  /** 이 링크 사람들이 만든 곡 수 */
  own_songs: number;
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
    get<{
      via: string;
      login: string;
      admin: boolean;
      can_edit: boolean;
      key: string;
      device: string | null;
      links: { id: string; label: string }[];
    }>("/api/me"),
  access: () =>
    get<{
      devices: AccessDevice[];
      links: AccessLink[];
      clients: AccessClient[];
      allow_users: string[];
    }>("/api/admin/access"),
  /** 접속 링크 (여러 사람이 같이 쓴다). 들어올 때 이름과 비밀번호를 넣는다 */
  createLink: (label: string, password: string, role: AccessRole) =>
    post<AccessLink>("/api/admin/links", { label, password, role }),
  updateLink: (id: string, body: { label?: string; password?: string; role?: AccessRole }) =>
    patch<AccessLink>(`/api/admin/links/${id}`, body),
  deleteLink: (id: string) => del(`/api/admin/links/${id}`),
  /** 이 링크에 공유할 곡을 통째로 정한다 */
  setLinkSongs: (id: string, jobs: string[]) => put(`/api/admin/links/${id}/songs`, { jobs }),
  /** 이 곡을 볼 수 있는 링크를 통째로 정한다 */
  shareJob: (id: string, links: string[]) => put(`/api/admin/jobs/${id}/share`, { links }),
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
      build?: string;
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
    /** 악보가 나오는 연주 영상 — 분리가 끝나면 AI 가 악보·송 맵을 만든다 */
    score_url?: string;
  }) => post<Job>("/api/jobs", body),

  // --- AI 악보 ---
  aiHealth: () =>
    get<{ available: boolean; auth?: { ready: boolean }; detail?: string }>("/api/ai/health"),
  aiStart: (id: string, score_url: string, overwrite = false) =>
    post<AiRun>(`/api/jobs/${id}/ai-score${instQuery()}`, { score_url, overwrite }),
  /** 곡에 이미 있는 악보 PDF 로 음표 악보·송 맵 만들기 */
  aiFromPdf: (id: string) => post<AiRun>(`/api/jobs/${id}/ai-score${instQuery()}`, { mode: "pdf" }),
  aiStatus: (id: string) => get<AiRun>(`/api/jobs/${id}/ai-score`),

  // --- 음표 악보 (편집 가능) ---
  notation: (id: string) => get<Notation>(`/api/jobs/${id}/notation${instQuery()}`),
  saveNotation: (id: string, notation: Notation, note = "") =>
    put<Notation>(`/api/jobs/${id}/notation${instQuery()}`, { notation, note }),
  notationHistory: (id: string) =>
    get<{ history: { at: number; note: string; measures: number }[] }>(`/api/jobs/${id}/notation/history${instQuery()}`),
  restoreNotation: (id: string, index: number) => post<Notation>(`/api/jobs/${id}/notation/restore${instQuery()}`, { index }),
  /** 원본 악보 위 펜 필기 */
  scoreInk: (id: string) => get<InkDoc>(`/api/jobs/${id}/score/ink${instQuery()}`),
  saveScoreInk: (id: string, doc: InkDoc) => put<InkDoc>(`/api/jobs/${id}/score/ink${instQuery()}`, doc),
  /** 손으로 그린 마디(PNG) → 칸 (저장은 안 한다) */
  recognizeDrawing: (
    id: string,
    body: { image: string; first_bar: number; measures: { beats: number; unit: number; steps: number }[] },
  ) => post<{ measures: Notation["measures"]; note?: string; seconds?: number }>(`/api/jobs/${id}/notation/recognize`, body),
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
  lockVersion: (id: string, vid: string, body: { locked: boolean; pin?: string; click_offset_ms?: number }) =>
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
  score: (id: string) => get<ScoreData>(`/api/jobs/${id}/score${instQuery()}`),
  uploadScore: (id: string, pdf: Blob) =>
    request<ScoreData>(`/api/jobs/${id}/score${instQuery()}`, {
      method: "PUT",
      body: pdf,
      headers: { "Content-Type": "application/pdf" },
    }),
  deleteScore: (id: string) => del(`/api/jobs/${id}/score${instQuery()}`),

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
