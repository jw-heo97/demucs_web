export interface JobFile {
  name: string;
  rel: string;
  size: number;
  /** 수정 시각(ms). 같은 이름으로 다시 구운 파일을 구별하는 데 쓴다. */
  mtime: number;
  url: string;
}

export interface MapRange {
  from_bar: number;
  name: string;
  beats_per_bar: number;
  beat_unit: number;
  bpm: number | null;
  /** null = 전부 울림, [] = 전부 끔, [1,3] = 그 박만 */
  click_beats: number[] | null;
  /** 이 마디를 절대 시각에 고정. 녹음물은 박자가 미세하게 움직여서 필요하다. */
  anchor: number | null;
}

export interface SongMap {
  anchor: number;
  bpm: number;
  ranges: MapRange[];
}

export interface Bar {
  bar: number;
  start: number;
  beats_per_bar: number;
  beat_unit: number;
  bpm: number;
  name: string;
  click_beats: number[] | null;
  anchored: boolean;
}

export interface MapVersion {
  id: string;
  name: string;
  updated?: number;
  /** 만든 사람 (Me.key 와 비교). 없으면 관리자 것(예전 버전) */
  owner?: string | null;
  owner_name?: string | null;
  /** 잠김: 덮어쓰기·이름 변경·삭제·재검출·이력 복원이 막힌다 */
  locked?: boolean;
  /** 풀 때 PIN 이 필요한가 */
  has_pin?: boolean;
  /** 잠근 기기의 클릭 보정(ms). 잠긴 동안 모든 기기가 이 값으로 클릭을 낸다 */
  click_offset_ms?: number | null;
}

export interface MapPayload {
  map: SongMap;
  beats: number[];
  accents: boolean[];
  sounds: boolean[];
  bars: Bar[];
  markers: { bar: number; name: string; start: number }[];
  versions: MapVersion[];
  active: string | null;
  history: { index: number; ts: number; bpm: number; ranges: number; names: string[] }[];
  bpm: number | null;
  duration: number;
  raw_bpm: number | null;
  octave_note: string | null;
}

/** 사용자가 올린 트랙(녹음·반주). offset_ms: 트랙의 0초가 곡의 몇 ms 인지 (음수 가능) */
export interface JobTrack {
  id: string;
  name: string;
  offset_ms: number;
  duration: number | null;
  rel: string;
  size: number;
  mtime: number;
  url: string;
}

export interface Job {
  id: string;
  url: string;
  format: "wav" | "mp3" | "both";
  target: string;
  status: "queued" | "downloading" | "separating" | "encoding" | "done" | "error";
  stage: string;
  progress: number;
  error: string | null;
  title: string | null;
  title_override: string | null;
  folder: string | null;
  video_id: string | null;
  duration: number;
  bpm: number | null;
  raw_bpm: number | null;
  octave_note: string | null;
  bpm_manual: boolean;
  metronome: boolean;
  songmap: SongMap | Record<string, never>;
  map_versions: MapVersion[];
  map_active: string | null;
  bar_count: number;
  beat_count: number;
  files: JobFile[];
  tracks?: JobTrack[];
  /** 만든 사람 (access.owner_key). 없으면 관리자 것 */
  owner?: string | null;
  owner_name?: string | null;
  /** 만든 기기가 들어온 접속 링크 — 같은 링크 사람들끼리 본다 */
  owner_link?: string | null;
  /** 관리자가 이 곡을 공유한 접속 링크 (관리자에게만 채워진다) */
  shared_links?: string[];
  /** 잠긴 송 맵 버전 수 (하나라도 있으면 곡을 지울 수 없다) */
  locked_versions?: number;
  created_at: number;
  elapsed: number;
}

export interface SearchItem {
  video_id: string;
  title: string;
  channel: string | null;
  duration: number;
  view_count: number | null;
  live: boolean;
  thumbnail: string;
}

export interface Playlist {
  id: string;
  name: string;
  /** 보관함 작업 id, 재생 순서대로 */
  items: string[];
  created_at: number;
  updated_at: number;
  /** 다른 사람(관리자)이 만든 것이라 바꿀 수 없다 */
  readonly?: boolean;
}

/** 악보 한 마디의 위치 (PDF 포인트 단위, 페이지 기준) */
export interface ScoreMeasure {
  number: number;
  page: number;
  system: number;
  x0: number;
  x1: number;
  /** 잘라 보여줄 줄 범위 */
  y0: number;
  y1: number;
  /** 보표 맨 윗줄·아랫줄 */
  top: number;
  bot: number;
  sys_x0: number;
  sys_x1: number;
}

export interface ScoreData {
  version: number;
  pages: { w: number; h: number; img: string }[];
  page_urls: string[];
  measures: ScoreMeasure[];
  /** 구간 표시 — measure 는 악보 마디 번호(1부터) */
  marks: { measure: number; text: string }[];
  tempo: number | null;
  warnings: string[];
  /** 음원 n번째 마디 = 악보 order[n-1] 번째 마디 (반복 기호가 있는 악보) */
  order?: number[];
}
