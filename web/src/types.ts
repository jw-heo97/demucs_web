export interface JobFile {
  name: string;
  rel: string;
  size: number;
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
