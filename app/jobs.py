"""작업 큐.

웹에서 쓰려면 요청 스레드에서 바로 분리를 돌릴 수 없다 (곡당 수십 초~수 분).
그리고 VRAM 8GB 에서 htdemucs 를 동시에 두 건 돌리면 OOM 이 나므로
워커 스레드를 정확히 1개만 둬서 GPU 사용을 직렬화한다.

출력 폴더는 작업 ID(해시)가 아니라 **곡 제목**으로 만든다. 나중에 탐색기에서
찾기 쉬워야 하기 때문. 제목은 사용자가 직접 지정할 수 있고, 비워두면 YouTube 제목을 쓴다.
"""
from __future__ import annotations

import copy
import json
import os
import queue
import re
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import numpy as np

import audio_io
import downloader
import separator
import tracks as user_tracks
from config import (
    BEATS_PER_BAR,
    CLICK_LEVEL,
    JOB_RETENTION_SEC,
    MAX_DURATION_SEC,
    MAX_QUEUE,
    OUTPUT_DIR,
    WORK_DIR,
)

STEMS = ("drums", "bass", "vocals", "other")
FORMATS = ("wav", "mp3", "both")
MAX_TITLE_LEN = 100

# 결과 폴더마다 남기는 메타데이터. 재시작 후 목록을 복원하는 근거가 된다.
# (작업 목록이 메모리에만 있으면 컨테이너를 한 번만 재시작해도 라이브러리가 통째로 사라진다)
META_FILE = "_meta.json"
# 구성표를 저장할 때마다 직전 버전을 여기에 쌓는다. 손으로 오래 잡은 작업이라
# 한 번의 덮어쓰기로 날아가면 안 된다.
MAP_HISTORY_FILE = "_map_history.json"
MAP_HISTORY_KEEP = 20
# 파형 표시용 피크. 원본 wav 를 브라우저에서 디코딩하면(곡당 50MB) 멈추므로
# 서버가 구간별 최대진폭만 뽑아 캐시해 둔다 — 트랙당 수십 KB 면 충분하다.
PEAKS_FILE = "_peaks.json"

# 경로 구분자/윈도우 금지문자/제어문자. 한글·일본어는 그대로 살린다.
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# Windows 예약 파일명
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def safe_name(title: str, fallback: str) -> str:
    """파일시스템에 안전한 이름.

    원본 separate.py 의 isalnum() 필터는 기호만 있는 제목에서 빈 문자열이 됐고,
    한글/일본어가 살아남는 것도 우연에 가까웠다. 여기서는 위험 문자만 제거한다.
    사용자 입력이 그대로 경로가 되므로 '.', '..', 예약어까지 막는다.
    """
    name = _UNSAFE.sub("", (title or "").strip())
    name = re.sub(r"\s+", " ", name)
    name = name.strip(" .")           # 앞뒤 공백/점 제거 → '.', '..' 자동 차단
    name = name[:MAX_TITLE_LEN].strip(" .")
    if not name or name.upper() in _RESERVED:
        return fallback
    return name


@dataclass
class Job:
    id: str
    url: str
    fmt: str = "both"
    target: str = "all"
    save_original: bool = True
    # 사용자가 직접 지정한 제목. 비어 있으면 YouTube 제목을 쓴다.
    title_override: Optional[str] = None
    # 박자 위치에 클릭을 찍은 메트로놈 트랙을 함께 저장할지
    metronome: bool = True
    # '_no_보컬' 같은 제외 믹스도 파일로 구울지. 믹스다운으로 언제든 만들 수 있어 기본은 끔.
    minus_mixes: bool = False

    status: str = "queued"       # queued|downloading|separating|encoding|done|error
    stage: str = "대기 중"
    progress: float = 0.0        # 0.0 ~ 1.0 (전체 기준)
    error: Optional[str] = None

    title: Optional[str] = None      # YouTube 원본 제목 (표시용)
    folder: Optional[str] = None     # 실제 출력 폴더명 (= 파일 접두사)
    video_id: Optional[str] = None
    duration: float = 0.0
    bpm: Optional[float] = None
    raw_bpm: Optional[float] = None        # 옥타브 보정 전 값 (진단용)
    octave_note: Optional[str] = None      # 보정 내역 설명
    bpm_manual: bool = False               # 사용자가 직접 지정한 BPM 인지
    # 곡 구성표. 이게 박자·마디·메트로놈·예비박의 단일 원천이다.
    # {"anchor": 1마디1박 시각, "bpm": ♩, "ranges": [...], "markers": [...]}
    songmap: dict = field(default_factory=dict)        # 활성 버전의 구성표
    # 이름 붙인 구성표 버전들. 연습용/원곡용처럼 여러 벌을 두고 오갈 수 있다.
    map_versions: list[dict] = field(default_factory=list)
    map_active: Optional[str] = None
    beats: list[float] = field(default_factory=list)   # 구성표에서 파생된 박자 위치(초)
    accents: list[bool] = field(default_factory=list)  # 각 박자가 마디 첫 박인지
    sounds: list[bool] = field(default_factory=list)   # 그 박에서 클릭이 울리는지
    bars: list[dict] = field(default_factory=list)     # 마디별 시작 시각·박자표
    files: list[dict[str, Any]] = field(default_factory=list)

    # 누가 만든 곡인가 (access.owner_key / owner_name). 없으면 관리자 것(예전 곡).
    owner: Optional[str] = None
    owner_name: Optional[str] = None
    # 만든 기기가 들어온 접속 링크 — 같은 링크 사람들끼리 이 곡을 본다
    owner_link: Optional[str] = None
    # 관리자가 이 곡을 공유한 접속 링크들
    shared_links: list[str] = field(default_factory=list)

    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    @property
    def out_dir(self) -> Optional[Path]:
        return (OUTPUT_DIR / self.folder) if self.folder else None

    def track_entries(self) -> list[dict]:
        out = []
        d = self.out_dir
        if not d:
            return out
        for t in user_tracks.load(d):
            p = d / t["file"]
            try:
                st = p.stat()
            except OSError:
                continue
            out.append({"id": t["id"], "name": t["name"], "offset_ms": int(t.get("offset_ms", 0)),
                        "duration": t.get("duration"), "rel": t["file"], "size": st.st_size,
                        "mtime": int(st.st_mtime * 1000),
                        "url": f"/api/jobs/{self.id}/files/{quote(t['file'], safe='/')}"})
        return out

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "url": self.url,
            "format": self.fmt,
            "target": self.target,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "error": self.error,
            "title": self.title,
            "title_override": self.title_override,
            "folder": self.folder,
            "video_id": self.video_id,
            "duration": self.duration,
            "bpm": self.bpm,
            "raw_bpm": self.raw_bpm,
            "octave_note": self.octave_note,
            "bpm_manual": self.bpm_manual,
            "metronome": self.metronome,
            "songmap": self.songmap,
            "map_versions": [JobStore.version_view(v) for v in self.map_versions],
            "locked_versions": sum(1 for v in self.map_versions if v.get("locked")),
            "map_active": self.map_active,
            "bar_count": len(self.bars),
            "beat_count": len(self.beats),
            "files": self.files,
            # 사용자 트랙(녹음·반주). 믹서가 스템 뒤에 붙인다 (app/tracks.py)
            "tracks": self.track_entries(),
            "owner": self.owner,
            "owner_name": self.owner_name,
            "owner_link": self.owner_link,
            "shared_links": list(self.shared_links),
            "created_at": self.created_at,
            "elapsed": round((self.finished_at or time.time()) - (self.started_at or self.created_at), 1),
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: "queue.Queue[str]" = queue.Queue(maxsize=MAX_QUEUE)
        self._worker: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # --- 조회 ---
    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in jobs]

    def all_jobs(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def set_shared(self, job: Job, links: list[str]) -> None:
        """이 곡을 볼 수 있는 접속 링크(관리자가 고른 것)를 통째로 바꾼다."""
        job.shared_links = sorted(set(links))
        self._save_meta(job)

    def queue_depth(self) -> int:
        return self._queue.qsize()

    # --- 등록 ---
    def submit(self, url: str, fmt: str, target: str, save_original: bool,
               title_override: Optional[str] = None, metronome: bool = True,
               minus_mixes: bool = False, owner: Optional[str] = None,
               owner_name: Optional[str] = None, owner_link: Optional[str] = None) -> Job:
        if fmt not in FORMATS:
            raise ValueError(f"format 은 {FORMATS} 중 하나여야 합니다.")
        if target != "all" and target not in STEMS:
            raise ValueError(f"target 은 'all' 또는 {STEMS} 중 하나여야 합니다.")

        title_override = (title_override or "").strip() or None
        if title_override:
            if len(title_override) > MAX_TITLE_LEN:
                raise ValueError(f"제목은 {MAX_TITLE_LEN}자 이하로 입력하세요.")
            if safe_name(title_override, "") == "":
                raise ValueError("사용할 수 없는 제목입니다. 다른 이름을 입력하세요.")

        video_id = downloader.extract_video_id(url)   # 여기서 미리 검증해 즉시 400 을 낸다

        # 다운로드 전에 길이와 라이브 여부를 확인한다. 이 검사가 다운로드 뒤에만 있으면
        # 라이브 방송 URL 하나가 유일한 워커를 방송이 끝날 때까지 붙잡아 뒤의 작업이 전부 멈춘다.
        # (제목 가져오기 버튼이 같은 조회를 하므로 보통 캐시에서 바로 온다)
        meta = downloader.probe_metadata(video_id)
        if meta.get("live"):
            raise ValueError("라이브 방송은 분리할 수 없습니다. 방송이 끝나 VOD 로 올라온 뒤 다시 시도하세요.")
        duration = float(meta.get("duration") or 0.0)
        if MAX_DURATION_SEC and duration > MAX_DURATION_SEC:
            raise ValueError(
                f"길이 제한 초과: {duration:.0f}초 (허용 {MAX_DURATION_SEC}초). "
                "MAX_DURATION_SEC 환경변수로 조정할 수 있습니다."
            )

        job = Job(id=uuid.uuid4().hex[:12], url=url, fmt=fmt, target=target,
                  save_original=save_original, title_override=title_override,
                  metronome=metronome, minus_mixes=minus_mixes, video_id=video_id,
                  # 대기 중에도 목록에 제목·길이가 보이게 미리 채운다
                  title=meta.get("title"), duration=duration,
                  owner=owner, owner_name=owner_name, owner_link=owner_link)
        with self._lock:
            self._jobs[job.id] = job
        try:
            self._queue.put_nowait(job.id)
        except queue.Full:
            with self._lock:
                self._jobs.pop(job.id, None)
            raise RuntimeError("대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.")
        return job

    def delete(self, job_id: str) -> bool:
        """완료/실패한 작업만 삭제한다.

        진행 중인 작업을 지우면 워커는 계속 돌면서 파일을 쓰는데 추적 주체만 사라져
        고아 폴더가 남는다. 그래서 아예 거부한다.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False
            if job.status not in ("done", "error"):
                raise RuntimeError("진행 중인 작업은 삭제할 수 없습니다. 완료 후 삭제하세요.")
            self._jobs.pop(job_id, None)
        if job.out_dir:
            shutil.rmtree(job.out_dir, ignore_errors=True)
        return True

    # --- 디스크 복원 ---
    def restore_from_disk(self) -> int:
        """data/output 을 훑어 기존 결과를 목록에 되살린다.

        컨테이너 재시작/재빌드 후에도 라이브러리가 유지되게 하는 핵심.
        _meta.json 이 없는 폴더(수동 생성이나 구버전)도 파일만 있으면 살려낸다.
        """
        if not OUTPUT_DIR.exists():
            return 0

        restored = 0
        for d in sorted(OUTPUT_DIR.iterdir()):
            if not d.is_dir():
                continue
            try:
                job = self._job_from_dir(d)
            except Exception as e:
                print(f"[restore] {d.name} 건너뜀: {e}", flush=True)
                continue
            if not job or not job.files:
                continue
            with self._lock:
                if job.id in self._jobs:          # ID 충돌 시 새로 발급
                    job.id = uuid.uuid4().hex[:12]
                    job.files = self._scan_files(job, d)
                self._jobs[job.id] = job
            restored += 1

        if restored:
            print(f"[restore] 기존 결과 {restored}건 복원", flush=True)
        return restored

    @staticmethod
    def _parse_info_txt(d: Path) -> dict:
        """_meta.json 이 없는 예전 폴더용 폴백. info.txt 에서 BPM/길이를 건져낸다."""
        p = d / "info.txt"
        if not p.exists():
            return {}
        out: dict = {}
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                key, _, val = line.partition(":")
                key, val = key.strip().lower(), val.strip()
                if key == "bpm" and val not in ("", "None"):
                    out["bpm"] = float(val)
                elif key == "duration":
                    out["duration"] = float(val.rstrip("s") or 0)
                elif key == "video id" and val != "None":
                    out["video_id"] = val
                elif key == "youtube title" and val != "None":
                    out["title"] = val
        except (OSError, ValueError):
            return {}
        return out

    def _job_from_dir(self, d: Path) -> Optional[Job]:
        meta_path = d / META_FILE
        data: dict = {}
        if meta_path.exists():
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        else:
            data = self._parse_info_txt(d)

        job = Job(
            id=data.get("id") or uuid.uuid4().hex[:12],
            url=data.get("url") or "",
            fmt=data.get("format", "both"),
            target=data.get("target", "all"),
            title_override=data.get("title_override"),
            title=data.get("title") or d.name,
            folder=d.name,
            video_id=data.get("video_id"),
            duration=float(data.get("duration") or 0.0),
            bpm=data.get("bpm"),
            raw_bpm=data.get("raw_bpm"),
            octave_note=data.get("octave_note"),
            bpm_manual=bool(data.get("bpm_manual")),
            songmap=dict(data.get("songmap") or {}),
            map_versions=list(data.get("map_versions") or []),
            map_active=data.get("map_active"),
            metronome=bool(data.get("metronome", False)),
            minus_mixes=bool(data.get("minus_mixes", False)),
            owner=data.get("owner"),
            owner_name=data.get("owner_name"),
            owner_link=data.get("owner_link"),
            shared_links=[x for x in data.get("shared_links") or [] if isinstance(x, str)],
            status="done",
            stage="완료",
            progress=1.0,
        )
        # 시간 정보가 없으면 폴더 수정 시각으로 대체
        mtime = d.stat().st_mtime
        job.created_at = float(data.get("created_at") or mtime)
        job.started_at = float(data.get("started_at") or job.created_at)
        job.finished_at = float(data.get("finished_at") or mtime)
        job.files = self._scan_files(job, d)

        # 구성표가 있으면 박자를 다시 파생시킨다 (메타에 박자 배열을 저장하지 않는다).
        # 구버전 폴더처럼 구성표가 없으면 bpm 만으로 임시 구성표를 만든다.
        if not job.songmap:
            # 구버전 폴더 이관: 시간 기반 sections 나 bpm 만 있던 것을 마디 기반으로 옮긴다
            old = data.get("sections") or []
            if old:
                job.songmap = self.default_map(
                    old[0].get("bpm") or job.bpm, [old[0].get("start", 0.0)], job.duration)
            elif job.bpm:
                job.songmap = self.default_map(job.bpm, data.get("beats") or [], job.duration)
        if job.songmap:
            self.sync_beats(job)
        # 예전 메타에는 버전 내용이 저장되지 않았다. 활성 버전은 지금 구성표와 같으니 채우고,
        # 나머지는 내용 없음(None)으로 둔다 — 전환하려 하면 이력에서 되살리라고 알린다.
        for v in job.map_versions:
            if "map" not in v:
                v["map"] = copy.deepcopy(job.songmap) if v["id"] == job.map_active and job.songmap else None
        return job

    @staticmethod
    def _scan_files(job: Job, d: Path) -> list[dict]:
        out = []
        for p in sorted(d.rglob("*")):
            if not p.is_file() or p.name in (META_FILE, MAP_HISTORY_FILE, PEAKS_FILE, "_score.json",
                                             user_tracks.TRACKS_FILE):
                continue
            # 악보 분석 결과(페이지 이미지)는 내려받을 파일이 아니다
            if "_score" in p.relative_to(d).parts[:-1]:
                continue
            out.append(JobStore._file_entry(job, d, p))
        return out

    def _save_meta(self, job: Job) -> None:
        if not job.out_dir:
            return
        data = job.to_dict()
        data.pop("files", None)          # 파일 목록은 디스크에서 다시 읽는다
        data.pop("elapsed", None)
        data.pop("beat_count", None)
        data["started_at"] = job.started_at
        data["finished_at"] = job.finished_at
        data["minus_mixes"] = job.minus_mixes
        # 버전의 구성표 내용까지 저장한다. to_dict 는 목록 폴링용이라 이름만 싣는데,
        # 예전엔 그걸 그대로 저장해서 활성이 아닌 버전의 내용이 재시작하면 사라졌다.
        data["map_versions"] = [dict(v) for v in job.map_versions]
        data.pop("locked_versions", None)
        # 박자 배열은 저장하지 않는다 — 구성표에서 언제든 다시 만들 수 있고,
        # 곡당 수백~수천 개라 메타 파일만 커진다.
        # 임시 파일에 쓰고 교체한다 — 쓰는 도중 죽어도 파일이 깨지지 않는다.
        # 구성표·버전이 전부 여기 있어서, 깨지면 손으로 오래 잡은 작업이 통째로 날아간다.
        path = job.out_dir / META_FILE
        try:
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as e:
            print(f"[{job.id}] 메타 저장 실패(무시): {e}", flush=True)

    # --- 워커 ---
    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._stop.clear()
        self._worker = threading.Thread(target=self._loop, name="demucs-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._queue.put_nowait("")   # 블로킹 해제용 센티널
        except queue.Full:
            pass

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = self._queue.get(timeout=1.0)
            except queue.Empty:
                self._cleanup_expired()
                continue
            if not job_id:
                continue
            job = self.get(job_id)
            if job:
                try:
                    self._run(job)
                except Exception as e:               # 워커는 절대 죽으면 안 된다
                    job.status = "error"
                    job.stage = "실패"
                    job.error = f"{type(e).__name__}: {e}"
                    job.finished_at = time.time()
                    traceback.print_exc()
            self._queue.task_done()

    def _cleanup_expired(self) -> None:
        if JOB_RETENTION_SEC <= 0:      # 기본값: 자동 삭제 안 함
            return
        cutoff = time.time() - JOB_RETENTION_SEC
        with self._lock:
            stale = [j for j in self._jobs.values()
                     if j.status in ("done", "error") and (j.finished_at or j.created_at) < cutoff]
            for j in stale:
                self._jobs.pop(j.id, None)
        for j in stale:
            if j.out_dir:
                shutil.rmtree(j.out_dir, ignore_errors=True)

    def _allocate_dir(self, base: str) -> Path:
        """제목으로 폴더를 만든다. 같은 이름이 있으면 -2, -3 ... 을 붙인다.

        워커가 1개라 경쟁 상태는 없다. 심볼릭 링크/경로 탈출 방지를 위해
        최종 경로가 OUTPUT_DIR 아래인지 반드시 확인한다.
        """
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        root = OUTPUT_DIR.resolve()
        for n in range(1, 1000):
            name = base if n == 1 else f"{base}-{n}"
            candidate = (root / name)
            try:
                candidate.resolve().relative_to(root)
            except ValueError:
                raise ValueError(f"허용되지 않는 폴더 이름입니다: {base!r}")
            if not candidate.exists():
                candidate.mkdir(parents=True)
                return candidate
        raise ValueError(f"같은 이름의 폴더가 너무 많습니다: {base!r}")

    # --- 실제 파이프라인 ---
    def _run(self, job: Job) -> None:
        job.started_at = time.time()
        work = WORK_DIR / job.id
        out_dir: Optional[Path] = None
        src_path: Optional[Path] = None

        try:
            # 1) 다운로드 ─ 전체 진행률의 0 ~ 10%
            job.status = "downloading"
            job.stage = "YouTube 다운로드 중"

            def dl_progress(frac: float, label: str) -> None:
                job.progress = 0.10 * frac
                job.stage = label

            meta = downloader.download_audio(job.video_id, work, progress_cb=dl_progress)
            src_path = meta["path"]
            job.title = meta["title"]
            job.duration = meta["duration"]

            info = audio_io.probe(src_path)
            if not job.duration:
                job.duration = info["duration"]
            if MAX_DURATION_SEC and job.duration > MAX_DURATION_SEC:
                raise ValueError(
                    f"길이 제한 초과: {job.duration:.0f}초 (허용 {MAX_DURATION_SEC}초). "
                    "MAX_DURATION_SEC 환경변수로 조정할 수 있습니다."
                )

            # 폴더 이름 확정: 지정 제목 > YouTube 제목 > video_id
            base = safe_name(job.title_override or job.title or "", job.video_id or job.id)
            out_dir = self._allocate_dir(base)
            job.folder = out_dir.name

            # 2) 디코딩 ─ 10 ~ 15%
            job.stage = "오디오 디코딩 중"
            job.progress = 0.10
            sr = separator.get_loaded_model().samplerate
            audio = audio_io.decode(src_path, sample_rate=sr)
            job.progress = 0.15

            # 3) 분리 ─ 15 ~ 80%
            job.status = "separating"
            job.stage = "음원 분리 중 (Demucs)"

            def sep_progress(frac: float) -> None:
                job.progress = 0.15 + 0.65 * frac

            stems = separator.separate(audio, progress_cb=sep_progress)
            job.progress = 0.80

            # 4) BPM + 박자 위치 ─ 80 ~ 85%
            job.stage = "BPM · 박자 분석 중"
            click = None
            try:
                analysis = separator.analyze_beats(stems["drums"], sr)
                job.raw_bpm = analysis["raw_bpm"]
                job.octave_note = analysis["octave_note"]
                # 검출 결과로 기본 구성표를 만들고, 박자는 거기서 파생시킨다.
                # 이후 사용자가 송 맵 탭에서 구간·BPM·박자표를 직접 잡는다.
                job.songmap = self.default_map(
                    analysis["bpm"], analysis["beats"], job.duration)
                self.sync_beats(job)
                if job.metronome and job.beats:
                    click = separator.render_metronome(
                        np.asarray(job.beats), sr, audio.shape[-1],
                        level=CLICK_LEVEL, accents=np.asarray(job.accents, dtype=bool))
            except Exception as e:
                job.bpm = None
                print(f"[{job.id}] BPM/박자 분석 실패(무시): {e}")
            job.progress = 0.85

            # 5) 저장 ─ 85 ~ 100%
            job.status = "encoding"
            job.stage = "파일 저장 중"
            self._write_outputs(job, stems, audio, sr, out_dir, job.folder, click=click)

            # 재생용 mp3 — 'wav 만' 으로 분리해도 기기에 받아 두는 크기를 1/4 로 (믹스는 wav 원본으로)
            job.stage = "재생용 mp3 만드는 중"
            self.ensure_playback_mp3(job)

            job.progress = 1.0
            job.status = "done"
            job.stage = "완료"
            job.finished_at = time.time()
            self._save_meta(job)      # 재시작 후 복원용

        except Exception:
            # 실패한 작업의 폴더는 통째로 지운다. 파일이 일부만 남으면 재시작 때
            # restore_from_disk 가 그 폴더를 '완료'로 되살려 반쪽 결과가 보관함에 들어온다.
            if out_dir and out_dir.exists():
                shutil.rmtree(out_dir, ignore_errors=True)
            job.folder = None
            job.files = []
            raise
        finally:
            job.finished_at = time.time()
            shutil.rmtree(work, ignore_errors=True)

    def _write_outputs(self, job: Job, stems: dict, original: Any, sr: int,
                       out_dir: Path, base: str, click: Any = None) -> None:
        model_sources = list(stems.keys())

        # 저장할 (파일명, 오디오) 목록을 먼저 만든다.
        # '_no_*' (해당 스템만 뺀 믹스) 는 나머지 스템의 합일 뿐이라 언제든 믹스다운으로
        # 만들 수 있다. 기본으로 굽지 않는다 — 전체 모드에서 파일 수가 2배가 되고
        # 용량도 그만큼 늘기 때문. 필요하면 minus_mixes 로 켠다.
        items: list[tuple[str, Any]] = []
        if job.target == "all":
            for name in model_sources:
                items.append((f"{base}_{name}", stems[name]))
            if job.minus_mixes:
                for name in model_sources:
                    mix = sum(stems[o] for o in model_sources if o != name)
                    items.append((f"{base}_no_{name}", mix))
        else:
            items.append((f"{base}_{job.target}", stems[job.target]))
            if job.minus_mixes:
                mix = sum(stems[o] for o in model_sources if o != job.target)
                items.append((f"{base}_no_{job.target}", mix))

        if job.save_original:
            items.append((f"{base}_original", original))
        if click is not None:
            items.append((f"{base}_click", click))

        want_wav = job.fmt in ("wav", "both")
        want_mp3 = job.fmt in ("mp3", "both")
        total = len(items) * (int(want_wav) + int(want_mp3))
        done = 0

        for name, data in items:
            if want_wav:
                p = audio_io.save_wav(out_dir / "wav" / f"{name}.wav", data, sr)
                job.files.append(self._file_entry(job, out_dir, p))
                done += 1
                job.progress = 0.85 + 0.15 * (done / max(total, 1))
            if want_mp3:
                p = audio_io.save_mp3(out_dir / "mp3" / f"{name}.mp3", data, sr)
                job.files.append(self._file_entry(job, out_dir, p))
                done += 1
                job.progress = 0.85 + 0.15 * (done / max(total, 1))

        meta_path = out_dir / "info.txt"
        meta_path.write_text(
            f"Title: {base}\n"
            f"YouTube Title: {job.title}\n"
            f"Video ID: {job.video_id}\n"
            f"URL: https://www.youtube.com/watch?v={job.video_id}\n"
            f"Duration: {job.duration:.1f}s\n"
            f"BPM: {job.bpm}"
            f"{' (' + job.octave_note + ')' if job.octave_note else ''}\n"
            f"Model: {separator.MODEL_NAME}\n",
            encoding="utf-8",
        )
        job.files.append(self._file_entry(job, out_dir, meta_path))

    # --- 곡 구성표 (song map) ---
    # 타이밍 뼈대는 **마디 기반**이다: 기준 시각은 '1마디 1박' 하나뿐이고,
    # 박자표/템포 변화는 "31마디부터 3/4" 처럼 마디 번호로 지정한다.
    # 초 단위로 구간을 잡으면 3/4 마디가 끼는 순간 뒤쪽이 전부 어긋나지만,
    # 마디 기반은 앞 마디 길이를 쌓아가므로 저절로 맞는다.
    #
    # 구간 이름(Intro/Verse/Chorus)은 들으면서 시간으로 찍되 가장 가까운 마디에
    # 스냅해서 마디 번호로 저장한다 — 나중에 BPM 을 고쳐도 이름이 따라 움직인다.
    #
    # {"anchor": 초, "bpm": ♩, "ranges": [{from_bar, beats_per_bar, beat_unit, bpm?}],
    #  "markers": [{bar, name}]}

    @staticmethod
    def normalize_map(raw: Any, duration: float) -> dict:
        if not isinstance(raw, dict):
            raise ValueError("구성표 형식이 올바르지 않습니다.")

        try:
            anchor = float(raw.get("anchor", 0.0) or 0.0)
            bpm = float(raw.get("bpm", 0) or 0)
        except (TypeError, ValueError):
            raise ValueError("기준 위치나 BPM 값이 올바르지 않습니다.")

        if not (anchor == anchor) or anchor < 0:
            raise ValueError("1마디 1박 위치가 올바르지 않습니다.")
        if duration and anchor >= duration:
            raise ValueError(f"1마디 1박 위치가 곡 길이({duration:.1f}초)를 벗어납니다.")
        if not (20 <= bpm <= 400):
            raise ValueError("기본 BPM 은 20~400 사이여야 합니다.")

        raw_ranges = raw.get("ranges")
        if raw_ranges is None or raw_ranges == []:
            # 박자 변화 지정이 없으면 = 곡 전체 4/4. 에러가 아니라 기본값이다.
            raw_ranges = [{"from_bar": 1, "name": "", "beats_per_bar": 4, "beat_unit": 4}]
        if not isinstance(raw_ranges, list):
            raise ValueError("박자 구간 형식이 올바르지 않습니다.")
        if len(raw_ranges) > 300:
            raise ValueError("박자 구간은 300개까지만 지정할 수 있습니다.")

        ranges = []
        for i, r in enumerate(raw_ranges, 1):
            if not isinstance(r, dict):
                raise ValueError(f"{i}번째 박자 구간 형식이 올바르지 않습니다.")
            try:
                from_bar = int(r.get("from_bar", 1) or 1)
                bpb = int(r.get("beats_per_bar", 4) or 4)
                unit = int(r.get("beat_unit", 4) or 4)
                r_bpm = r.get("bpm")
                r_bpm = float(r_bpm) if r_bpm not in (None, "", 0) else None
            except (TypeError, ValueError):
                raise ValueError(f"{i}번째 박자 구간의 숫자 값이 올바르지 않습니다.")

            if not (1 <= from_bar <= separator.MAX_BARS):
                raise ValueError(f"{i}번째 박자 구간의 시작 마디가 범위를 벗어납니다.")
            if not (1 <= bpb <= 16):
                raise ValueError(f"{i}번째 박자 구간의 박자 수는 1~16 사이여야 합니다.")
            if unit not in (1, 2, 4, 8, 16):
                raise ValueError(f"{i}번째 박자 구간의 박자 단위는 1·2·4·8·16 중 하나여야 합니다.")
            if r_bpm is not None and not (20 <= r_bpm <= 400):
                raise ValueError(f"{i}번째 박자 구간의 BPM 은 20~400 사이여야 합니다.")

            # click_beats: 이 구간에서 소리 낼 박 번호(1부터).
            #   None = 지정 없음(전부 울림),  [] = 전부 끔.
            #   전부 켠 것과 같으면 None 으로 정규화한다.
            cb_raw = r.get("click_beats")
            click_beats = None
            if isinstance(cb_raw, (list, tuple)):
                try:
                    picked = sorted({int(x) for x in cb_raw})
                except (TypeError, ValueError):
                    raise ValueError(f"{i}번째 마디의 클릭 박 번호가 올바르지 않습니다.")
                bad = [x for x in picked if not (1 <= x <= bpb)]
                if bad:
                    raise ValueError(
                        f"{i}번째 마디의 클릭 박 {bad} 은(는) 1~{bpb} 범위를 벗어납니다.")
                click_beats = None if len(picked) == bpb else picked

            # anchor: 이 마디를 절대 시각에 고정한다(재고정). 없으면 앞에서 누적.
            ra = r.get("anchor")
            r_anchor = None
            if ra is not None and ra != "":
                try:
                    r_anchor = float(ra)
                except (TypeError, ValueError):
                    raise ValueError(f"{i}번째 마디의 고정 시각이 올바르지 않습니다.")
                if not (r_anchor == r_anchor) or r_anchor < 0:
                    raise ValueError(f"{i}번째 마디의 고정 시각이 올바르지 않습니다.")
                if duration and r_anchor >= duration:
                    raise ValueError(
                        f"{i}번째 마디의 고정 시각이 곡 길이({duration:.1f}초)를 벗어납니다.")
                r_anchor = round(r_anchor, 4)

            ranges.append({"from_bar": from_bar,
                           "name": str(r.get("name") or "").strip()[:40],
                           "beats_per_bar": bpb, "beat_unit": unit,
                           "bpm": round(r_bpm, 3) if r_bpm else None,
                           "click_beats": click_beats,
                           "anchor": r_anchor})

        ranges.sort(key=lambda r: r["from_bar"])
        seen = set()
        for r in ranges:
            if r["from_bar"] in seen:
                raise ValueError(f"{r['from_bar']}마디에 박자 구간이 중복 지정되었습니다.")
            seen.add(r["from_bar"])
        # 1마디부터 적용되는 구간이 반드시 있어야 한다
        if ranges[0]["from_bar"] != 1:
            ranges.insert(0, {"from_bar": 1, "name": "", "beats_per_bar": 4,
                              "beat_unit": 4, "bpm": None, "click_beats": None})

        # 구버전 markers(별도 목록)는 ranges 로 흡수한다.
        # 이제 한 항목이 "이 마디부터" 하나를 뜻하고, 이름과 박자를 함께 갖는다.
        by_bar = {r["from_bar"]: r for r in ranges}
        for m in raw.get("markers") or []:
            if not isinstance(m, dict):
                continue
            try:
                bar = int(m.get("bar", 1) or 1)
            except (TypeError, ValueError):
                continue
            name = str(m.get("name") or "").strip()[:40]
            if not name or not (1 <= bar <= separator.MAX_BARS):
                continue
            if bar in by_bar:
                by_bar[bar]["name"] = by_bar[bar]["name"] or name
            else:
                prev = [r for r in ranges if r["from_bar"] <= bar]
                base = prev[-1] if prev else ranges[0]
                item = {"from_bar": bar, "name": name,
                        "beats_per_bar": base["beats_per_bar"],
                        "beat_unit": base["beat_unit"], "bpm": None,
                        "click_beats": base.get("click_beats")}
                ranges.append(item)
                by_bar[bar] = item
        ranges.sort(key=lambda r: r["from_bar"])

        return {"anchor": round(anchor, 4), "bpm": round(bpm, 3), "ranges": ranges}

    @staticmethod
    def default_map(bpm: float, beats: Any, duration: float) -> dict:
        """검출 결과로 기본 구성표를 만든다. 전 구간 4/4, 이름 없음.

        박자는 드럼 스템에서 뽑기 때문에 드럼이 늦게 들어오는 곡은 첫 박이 한참 뒤다
        (라일락 13.148초). 그대로 두면 앞부분에 박자가 없으므로 격자를 곡 시작 쪽으로
        되짚어 앵커를 잡는다.
        """
        bpm = float(bpm or 0)
        if bpm <= 0:
            return {}
        step = 60.0 / bpm
        first = float(beats[0]) if len(beats) else 0.0
        anchor = first % step if first > step else first
        return {"anchor": round(anchor, 4), "bpm": round(bpm, 3),
                "ranges": [{"from_bar": 1, "name": "", "beats_per_bar": 4,
                            "beat_unit": 4, "bpm": None, "click_beats": None}]}

    def sync_beats(self, job: Job) -> None:
        """구성표에서 박자·강세·마디를 다시 계산한다."""
        beats, accents, sounds, bars = separator.beats_from_map(job.songmap, job.duration)
        job.beats = [round(float(b), 4) for b in beats]
        job.accents = [bool(a) for a in accents]
        job.sounds = [bool(x) for x in sounds]
        job.bars = bars
        if job.songmap:
            job.bpm = round(float(job.songmap.get("bpm") or 0), 2) or job.bpm

    def marker_times(self, job: Job) -> list[dict]:
        """이름이 붙은 마디를 실제 시각으로 풀어낸다 (재생 중 구간 예고용)."""
        by_bar = {b["bar"]: b for b in (job.bars or [])}
        out = []
        for r in (job.songmap or {}).get("ranges", []):
            if not r.get("name"):
                continue
            bar = by_bar.get(r["from_bar"])
            if bar:
                out.append({"bar": r["from_bar"], "name": r["name"], "start": bar["start"]})
        return out

    # --- 파형 피크 ---
    def peaks(self, job: Job, stem: str = "drums", buckets: int = 1600) -> dict:
        """구간별 최대진폭 배열. 파형 그리기에 쓴다.

        같은 (스템, 해상도) 조합은 파일로 캐시해 두 번 계산하지 않는다.
        """
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            raise ValueError("결과 폴더가 없습니다.")
        # 확대했을 때 뭉개지지 않으려면 해상도가 필요하다.
        # 20000 이면 5분 곡에 15ms 해상도, JSON 150KB — 캐시되므로 한 번만 계산한다.
        buckets = max(200, min(int(buckets), 20000))
        key = f"{stem}:{buckets}"

        cache_path = out_dir / PEAKS_FILE
        cache = {}
        if cache_path.exists():
            try:
                cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cache = {}
        if key in cache:
            return cache[key]

        src = self._find_stem(out_dir, stem)
        if src is None:
            # 요청한 스템이 없으면 있는 것 아무거나 (원본 우선)
            for alt in ("original", "drums", "vocals", "bass", "other"):
                src = self._find_stem(out_dir, alt)
                if src:
                    stem = alt
                    key = f"{stem}:{buckets}"
                    break
        if src is None:
            raise ValueError("파형을 만들 오디오가 없습니다.")

        sr = separator.get_loaded_model().samplerate
        audio = audio_io.decode(src, sample_rate=sr)
        mono = np.abs(audio.mean(axis=0))
        n = mono.size
        if n == 0:
            raise ValueError("오디오가 비어 있습니다.")

        # 구간별 최대값 — 남는 샘플을 버리지 않도록 인덱스로 자른다
        edges = np.linspace(0, n, buckets + 1, dtype=np.int64)
        vals = np.zeros(buckets, dtype=np.float32)
        for i in range(buckets):
            a, b = edges[i], edges[i + 1]
            if b > a:
                vals[i] = mono[a:b].max()
        peak = float(vals.max()) or 1.0

        data = {"stem": stem, "buckets": buckets,
                "duration": round(n / sr, 4),
                "peaks": [round(float(v) / peak, 4) for v in vals]}

        cache[key] = data
        try:
            tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
            tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, cache_path)
        except OSError as e:
            print(f"[{job.id}] 피크 캐시 저장 실패(무시): {e}", flush=True)
        return data

    # --- 구성표 버전 ---
    # 이력(_map_history)이 "실수로 덮어쓴 것 되돌리기"라면,
    # 버전은 "연습용 / 원곡용" 처럼 의도적으로 여러 벌을 두고 오가는 용도다.
    MAX_VERSIONS = 20

    # 버전 이름은 `{곡}_click_{이름}.wav` 파일 이름에 들어간다. 스템 이름과 같으면
    # `곡_click_drums.wav` 가 생겨 스템을 찾을 때 걸리므로 처음부터 막는다.
    _RESERVED_TAGS = {*STEMS, "original", "click", *(f"no_{s}" for s in STEMS)}

    @classmethod
    def _version_name(cls, name: Any) -> str:
        n = (str(name or "").strip() or "이름 없음")[:40]
        if safe_name(n, "v").lower() in cls._RESERVED_TAGS:
            raise ValueError(f"'{n}' 은(는) 스템 이름과 겹쳐 버전 이름으로 쓸 수 없습니다.")
        return n

    @classmethod
    def _make_version(cls, name: str, songmap: dict, owner: Optional[str] = None,
                      owner_name: Optional[str] = None) -> dict:
        return {"id": uuid.uuid4().hex[:8],
                "name": cls._version_name(name),
                "map": songmap,
                "updated": round(time.time(), 3),
                # 만든 사람(access.owner_key). 없으면 관리자 것(예전 버전).
                "owner": owner, "owner_name": owner_name,
                # 잠금: 덮어쓰기·이름 변경·삭제·재검출·이력 복원을 막는다. PIN 은 scrypt 해시 (app/lock.py)
                "locked": False, "pin_hash": None}

    @staticmethod
    def version_view(v: dict) -> dict:
        """화면에 내려보내는 버전 정보 (구성표 내용·PIN 해시는 뺀다)."""
        return {"id": v["id"], "name": v["name"], "updated": v.get("updated"),
                "owner": v.get("owner"), "owner_name": v.get("owner_name"),
                "locked": bool(v.get("locked")), "has_pin": bool(v.get("pin_hash"))}

    def _active_locked(self, job: Job) -> bool:
        v = self._active_version(job)
        return bool(v and v.get("locked"))

    def ensure_versions(self, job: Job) -> None:
        """버전 목록이 없으면 현재 구성표를 '기본' 버전으로 만든다 (구버전 이관)."""
        if job.map_versions or not job.songmap:
            return
        v = self._make_version("기본", copy.deepcopy(job.songmap))
        job.map_versions = [v]
        job.map_active = v["id"]

    def _active_version(self, job: Job) -> Optional[dict]:
        for v in job.map_versions:
            if v["id"] == job.map_active:
                return v
        return job.map_versions[0] if job.map_versions else None

    def create_version(self, job: Job, name: str, songmap: Any = None,
                       owner: Optional[str] = None, owner_name: Optional[str] = None) -> dict:
        """새 버전을 만들고 활성화한다. songmap 을 생략하면 현재 것을 복사한다."""
        if job.status != "done":
            raise ValueError("완료된 작업에만 버전을 만들 수 있습니다.")
        self.ensure_versions(job)
        if len(job.map_versions) >= self.MAX_VERSIONS:
            raise ValueError(f"버전은 {self.MAX_VERSIONS}개까지만 만들 수 있습니다.")
        base = songmap if songmap is not None else copy.deepcopy(job.songmap)
        normalized = self.normalize_map(base, job.duration)
        v = self._make_version(name, normalized, owner, owner_name)
        job.map_versions.append(v)
        job.map_active = v["id"]
        job.songmap = copy.deepcopy(normalized)
        self.sync_beats(job)
        self._render_all_clicks(job)
        self._save_meta(job)
        return v

    def activate_version(self, job: Job, vid: str) -> dict:
        self.ensure_versions(job)
        v = next((x for x in job.map_versions if x["id"] == vid), None)
        if not v:
            raise ValueError("그 버전을 찾을 수 없습니다.")
        if not v.get("map"):
            raise ValueError(f"'{v['name']}' 버전의 내용이 저장돼 있지 않습니다 (예전 버그). "
                             "이력에서 되살린 뒤 다시 저장해 주세요.")
        self._push_map_history(job, job.songmap)
        job.map_active = vid
        job.songmap = copy.deepcopy(v["map"])
        self.sync_beats(job)
        self._render_all_clicks(job)
        self._save_meta(job)
        return v

    def rename_version(self, job: Job, vid: str, name: str) -> dict:
        v = next((x for x in job.map_versions if x["id"] == vid), None)
        if not v:
            raise ValueError("그 버전을 찾을 수 없습니다.")
        old = v["name"]
        v["name"] = self._version_name(name)
        if old != v["name"]:
            self._remove_version_files(job, old)
            if job.map_active == vid:
                self._render_click_files(job, suffix=v["name"])
            job.files = self._scan_files(job, job.out_dir) if job.out_dir else job.files
        self._save_meta(job)
        return v

    def delete_version(self, job: Job, vid: str) -> None:
        if len(job.map_versions) <= 1:
            raise ValueError("마지막 버전은 삭제할 수 없습니다.")
        v = next((x for x in job.map_versions if x["id"] == vid), None)
        if not v:
            raise ValueError("그 버전을 찾을 수 없습니다.")
        self._remove_version_files(job, v.get("name", ""))
        job.map_versions = [x for x in job.map_versions if x["id"] != vid]
        if job.out_dir:
            job.files = self._scan_files(job, job.out_dir)
        if job.map_active == vid:
            # 내용이 남아 있는 버전으로 옮긴다. 없으면(예전 버그로 내용이 사라진 버전뿐이면)
            # 지우는 버전의 구성표를 넘겨받아 화면이 빈 채로 남지 않게 한다.
            nxt = next((x for x in job.map_versions if x.get("map")), job.map_versions[0])
            if not nxt.get("map"):
                nxt["map"] = copy.deepcopy(job.songmap)
            self.activate_version(job, nxt["id"])
        else:
            self._save_meta(job)

    # --- 구성표 이력 ---
    def _push_map_history(self, job: Job, previous: Optional[dict]) -> None:
        """덮어쓰기 전 구성표를 보관한다. 같은 내용이면 쌓지 않는다."""
        if not previous or not previous.get("ranges") or not job.out_dir:
            return
        path = job.out_dir / MAP_HISTORY_FILE
        try:
            hist = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
            if not isinstance(hist, list):
                hist = []
        except (OSError, ValueError):
            hist = []
        if hist and hist[0].get("map") == previous:
            return
        hist.insert(0, {"ts": round(time.time(), 3), "map": previous})
        del hist[MAP_HISTORY_KEEP:]
        try:
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as e:
            print(f"[{job.id}] 구성표 이력 저장 실패(무시): {e}", flush=True)

    def map_history(self, job: Job) -> list[dict]:
        if not job.out_dir:
            return []
        path = job.out_dir / MAP_HISTORY_FILE
        if not path.exists():
            return []
        try:
            hist = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        out = []
        for i, h in enumerate(hist if isinstance(hist, list) else []):
            m = h.get("map") or {}
            rs = m.get("ranges") or []
            out.append({
                "index": i,
                "ts": h.get("ts"),
                "bpm": m.get("bpm"),
                "anchor": m.get("anchor"),
                "ranges": len(rs),
                "names": [r.get("name") for r in rs if r.get("name")][:6],
            })
        return out

    def restore_map(self, job: Job, index: int) -> dict:
        hist_path = job.out_dir / MAP_HISTORY_FILE if job.out_dir else None
        if not hist_path or not hist_path.exists():
            raise ValueError("보관된 이전 버전이 없습니다.")
        try:
            hist = json.loads(hist_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ValueError("이력 파일을 읽지 못했습니다.")
        if not (0 <= index < len(hist)):
            raise ValueError("그 버전을 찾을 수 없습니다.")
        return self.apply_map(job, hist[index].get("map"))

    def apply_map(self, job: Job, songmap: Any) -> dict:
        """구성표를 저장하고 메트로놈 트랙을 다시 만든다."""
        if job.status != "done":
            raise ValueError("완료된 작업에만 구성표를 적용할 수 있습니다.")
        self._push_map_history(job, job.songmap)     # 덮어쓰기 전 보관
        job.songmap = self.normalize_map(songmap, job.duration)
        job.bpm_manual = True
        job.octave_note = "구성표 지정"
        self.ensure_versions(job)
        active = self._active_version(job)
        if active:
            active["map"] = copy.deepcopy(job.songmap)
            active["updated"] = round(time.time(), 3)
            job.map_active = active["id"]
        else:
            v = self._make_version("기본", copy.deepcopy(job.songmap))
            job.map_versions = [v]
            job.map_active = v["id"]
        self.sync_beats(job)
        self._render_all_clicks(job)
        self._save_meta(job)
        return {"map": job.songmap, "bpm": job.bpm, "beats": len(job.beats),
                "bars": len(job.bars), "active": job.map_active,
                "versions": [self.version_view(v) for v in job.map_versions]}

    def _render_all_clicks(self, job: Job) -> None:
        """활성 버전 파일(`_click`)과 그 버전 이름이 붙은 파일을 함께 굽는다.

        믹서는 `_click` 을 집고, `_click_연습용` 처럼 이름이 붙은 파일은 버전별로
        남아 나중에 비교하거나 따로 받아갈 수 있다.
        """
        self._render_click_files(job)
        v = self._active_version(job)
        if v and v.get("name"):
            self._render_click_files(job, suffix=v["name"])

    def _remove_version_files(self, job: Job, name: str) -> None:
        if not job.out_dir or not name:
            return
        base = job.folder or job.id
        tag = safe_name(name, "v")
        for sub, ext in (("wav", ".wav"), ("mp3", ".mp3")):
            p = job.out_dir / sub / f"{base}_click_{tag}{ext}"
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass

    def _render_click_files(self, job: Job, suffix: str = "") -> None:
        """현재 구성표대로 클릭 파일을 쓴다.

        suffix 를 주면 `{곡}_click_{suffix}.wav` 로 버전별 파일을 만든다.
        비우면 활성 버전용 `{곡}_click.wav` — 믹서가 이 파일을 집는다.
        """
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            raise ValueError("결과 폴더가 없습니다.")
        if not job.beats:
            raise ValueError("구성표에서 박자를 만들지 못했습니다.")

        sr = separator.get_loaded_model().samplerate
        n = int(round(job.duration * sr)) if job.duration else 0
        if n <= 0:
            src = self._find_stem(out_dir, "drums") or self._find_stem(out_dir, "vocals")
            if src is None:
                raise ValueError("길이를 알 수 없습니다.")
            n = audio_io.decode(src, sample_rate=sr).shape[-1]

        # 소리 나는 박만 골라 찍는다 (특정 마디의 특정 박만 울리게 할 수 있다)
        mask = np.asarray(job.sounds, dtype=bool) if job.sounds \
            else np.ones(len(job.beats), dtype=bool)
        times = np.asarray(job.beats)[mask]
        accs = np.asarray(job.accents, dtype=bool)[mask]
        # 전부 꺼둔 경우에는 무음 트랙을 쓴다 — 믹서가 기대하는 파일은 있어야 하고,
        # "메트로놈 없는 버전" 도 정상적인 상태이기 때문.
        if times.size == 0:
            click = np.zeros((2, n), dtype=np.float32)
        else:
            click = separator.render_metronome(times, sr, n,
                                               level=CLICK_LEVEL, accents=accs)
        if click is None:
            raise ValueError("메트로놈을 만들지 못했습니다.")

        base = job.folder or job.id
        tag = f"_{safe_name(suffix, 'v')}" if suffix else ""
        for sub, ext in (("wav", ".wav"), ("mp3", ".mp3")):
            if sub == "wav" and job.fmt not in ("wav", "both"):
                continue
            if sub == "mp3" and job.fmt not in ("mp3", "both"):
                continue
            path = out_dir / sub / f"{base}_click{tag}{ext}"
            if ext == ".wav":
                audio_io.save_wav(path, click, sr)
            else:
                audio_io.save_mp3(path, click, sr)

        job.metronome = True
        job.files = self._scan_files(job, out_dir)

    def align_map(self, job: Job, songmap: Any) -> dict:
        """편집 중인 구성표의 기준 시각들을 실제 타격 위치에 맞춰 돌려준다 (저장은 안 함).

        템포·마디 구성은 그대로 두고 1마디 1박과 고정 마디 시각만 옮긴다.
        사용자가 들어 보고 저장하도록 화면에만 반영한다.
        """
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            raise ValueError("결과 폴더가 없습니다.")
        m = self.normalize_map(songmap, job.duration)
        # 드럼이 타격 위치가 가장 또렷하다. 없으면 원곡으로 물러선다.
        src = self._find_stem(out_dir, "drums") or self._find_stem(out_dir, "original")
        if src is None:
            raise ValueError("드럼 스템이나 원곡 파일이 없어 맞출 수 없습니다.")
        sr = separator.get_loaded_model().samplerate
        audio = audio_io.decode(src, sample_rate=sr)
        duration = job.duration or audio.shape[-1] / sr
        groups = separator.align_map(m, audio, sr, duration)

        for g in groups:
            off = g["offset"]
            if off is None:
                continue
            if g["from_bar"] == 1:
                m["anchor"] = round(max(0.0, m["anchor"] + off), 4)
                continue
            for r in m["ranges"]:
                if int(r.get("from_bar", 0)) == g["from_bar"] and r.get("anchor") is not None:
                    r["anchor"] = round(max(0.0, float(r["anchor"]) + off), 4)
        return {"map": m, "groups": groups, "source": src.stem.rsplit("_", 1)[-1]}

    def redetect_map(self, job: Job) -> dict:
        """드럼 스템을 다시 분석해 기본 구성표를 만든다 (사용자 편집 전 출발점)."""
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            raise ValueError("결과 폴더가 없습니다.")
        src = self._find_stem(out_dir, "drums")
        if src is None:
            raise ValueError("드럼 스템이 없어 박자를 분석할 수 없습니다. "
                             "(분리 대상을 'drums' 또는 '전체'로 다시 실행해야 합니다)")

        sr = separator.get_loaded_model().samplerate
        drums = audio_io.decode(src, sample_rate=sr)
        if not job.duration:
            job.duration = drums.shape[-1] / sr
        analysis = separator.analyze_beats(drums, sr)
        job.raw_bpm = analysis["raw_bpm"]
        job.octave_note = analysis["octave_note"]
        job.bpm_manual = False
        self._push_map_history(job, job.songmap)     # 자동 재검출도 덮어쓰기다
        job.songmap = self.default_map(analysis["bpm"], analysis["beats"], job.duration)
        self.sync_beats(job)
        self._render_click_files(job)
        self._save_meta(job)
        return {"map": job.songmap, "bpm": job.bpm, "beats": len(job.beats),
                "bars": len(job.bars),
                "octave_note": job.octave_note, "raw_bpm": job.raw_bpm}

    # --- 선택 트랙 믹스다운 ---
    def _prepend_count_in(self, job: Job, mix: np.ndarray, sr: int,
                          count_in: int, beats_per_bar: int) -> tuple[np.ndarray, dict]:
        """믹스 앞에 예비박을 붙인다.

        브라우저 재생용 예비박은 Web Audio 로 즉석에서 만들지만, 내려받은 파일에는
        소리가 박혀 있어야 한다. 곡 앞에 무음을 덧대고 그 구간에 클릭을 찍되,
        **마지막 클릭이 곡의 첫 박보다 정확히 한 박 앞** 에 오도록 맞춘다.
        """
        info = {"count_in": 0}
        # 예비박 간격은 첫 구간의 클릭 간격을 따른다 (분모가 8이면 8분음표 간격).
        # 예비박 간격·마디 길이는 1마디의 박자표를 따른다 (분모가 8이면 8분음표 간격)
        bar1 = job.bars[0] if job.bars else None
        step = 0.0
        if bar1:
            step = (60.0 / float(bar1["bpm"])) * (4.0 / int(bar1["beat_unit"]))
            beats_per_bar = int(bar1["beats_per_bar"])
        if count_in <= 0 or step <= 0:
            return mix, info

        first = float(job.beats[0]) if job.beats else 0.0
        # 드럼이 늦게 들어와 첫 박자가 한참 뒤인 경우, 격자를 곡 시작 쪽으로 되짚는다
        if first > 2 * step:
            first = first % step

        lead = 0.25                                  # 첫 클릭이 파일 맨 앞에 딱 붙지 않게
        pre = max(0.0, count_in * step - first) + lead
        n_pre = int(round(pre * sr))
        mix = np.pad(mix, ((0, 0), (n_pre, 0)))

        times = np.array([pre + first - k * step for k in range(count_in, 0, -1)])
        times = times[times >= 0]
        click = separator.render_metronome(times, sr, mix.shape[-1],
                                           beats_per_bar=beats_per_bar, level=CLICK_LEVEL)
        if click is not None:
            mix = mix + click
        info = {"count_in": int(times.size), "pre_roll": round(pre, 3)}
        return mix, info

    @staticmethod
    def _offbeat_times(job: Job) -> np.ndarray:
        """소리 나는 박마다 다음 박과의 한가운데. 마지막 박은 직전 간격을 쓴다."""
        beats = np.asarray(job.beats, dtype=np.float64)
        if beats.size < 2:
            return np.zeros(0)
        gaps = np.append(np.diff(beats), beats[-1] - beats[-2])
        mids = beats + gaps / 2
        if job.sounds and len(job.sounds) == beats.size:
            mids = mids[np.asarray(job.sounds, dtype=bool)]
        return mids

    def mixdown(self, job: Job, keys: list[str], fmt: str = "mp3",
                gains: Optional[dict] = None, count_in: int = 0,
                beats_per_bar: int = BEATS_PER_BAR, subdiv: int = 1) -> dict:
        """지정한 스템들을 합쳐 한 파일로 만든다.

        믹서에서 '들리는 트랙만' 받아쓰기 위한 것. 합성은 서버에서 한다 —
        브라우저에는 mp3 인코더가 없고, 여기서 wav 원본을 쓰면 재인코딩 손실이 없다.
        """
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            raise ValueError("결과 폴더가 없습니다.")
        if fmt not in ("wav", "mp3"):
            raise ValueError("format 은 wav 또는 mp3 여야 합니다.")
        if not keys:
            raise ValueError("트랙을 하나 이상 선택하세요.")

        gains = gains or {}
        sr = separator.get_loaded_model().samplerate
        mix = None
        used: list[str] = []

        for key in keys:
            src = self._find_stem(out_dir, key)
            if src is None:
                continue
            data = audio_io.decode(src, sample_rate=sr)
            g = float(gains.get(key, 1.0))
            if g <= 0:
                continue
            data = data * g
            if mix is None:
                mix = data
            else:
                # 스템 길이가 1~2 샘플 다를 수 있으므로 긴 쪽에 맞춰 패딩
                if data.shape[-1] != mix.shape[-1]:
                    n = max(data.shape[-1], mix.shape[-1])
                    mix = np.pad(mix, ((0, 0), (0, n - mix.shape[-1])))
                    data = np.pad(data, ((0, 0), (0, n - data.shape[-1])))
                mix = mix + data
            used.append(key)

        if mix is None:
            raise ValueError("선택한 트랙의 파일을 찾지 못했습니다.")

        # 8비트: 메트로놈을 넣었으면 박 사이 클릭을 메트로놈 볼륨으로 얹는다.
        # 파일로 따로 굽지 않는다 — 브라우저에서는 실시간으로 울리고, 여기서만 필요하다.
        eight = subdiv == 2 and "click" in used and len(job.beats) >= 2
        if eight:
            off = separator.render_offbeats(self._offbeat_times(job), sr, mix.shape[-1],
                                            level=CLICK_LEVEL * 0.45)
            mix = mix + off * float(gains.get("click", 1.0))

        mix, ci = self._prepend_count_in(job, mix, sr, count_in, beats_per_bar)

        # 합치면 1.0 을 넘길 수 있다. 잘라내면 왜곡되므로 전체 레벨을 낮춘다.
        peak = float(np.max(np.abs(mix))) if mix.size else 0.0
        normalized = peak > 1.0
        if normalized:
            mix = mix / peak * 0.99

        base = job.folder or job.id
        suffix = ("_8beat" if eight else "") + (f"_count{ci['count_in']}" if ci["count_in"] else "")
        name = f"{base}_mix_{'+'.join(used)}{suffix}"[:120]
        path = out_dir / "mix" / f"{name}.{fmt}"
        if fmt == "wav":
            audio_io.save_wav(path, mix, sr)
        else:
            audio_io.save_mp3(path, mix, sr)

        job.files = self._scan_files(job, out_dir)
        entry = next((f for f in job.files if f["rel"] == f"mix/{path.name}"), None)
        return {"file": entry, "stems": used, "normalized": normalized, **ci}

    # --- 재생용 mp3 ---
    PLAYBACK_KEYS = ("drums", "bass", "vocals", "other")

    def ensure_playback_mp3(self, job: Job) -> int:
        """스템 wav 만 있고 mp3 가 없으면 mp3 를 만들어 둔다. 만든 개수를 돌려준다.

        믹서는 기기(브라우저 저장소)에 스템을 통째로 받아 두고 재생한다. wav 는 곡당
        170~200MB 라 폰·LTE 에서 부담이 커서, 재생은 mp3(1/4 크기)로 한다. 믹스 받기는
        _find_stem 이 wav 를 우선하므로 음질 손해가 없다.
        """
        out_dir = job.out_dir
        if not out_dir or not out_dir.exists():
            return 0
        base = job.folder or out_dir.name
        made = 0
        for key in self.PLAYBACK_KEYS:
            wav = out_dir / "wav" / f"{base}_{key}.wav"
            mp3 = out_dir / "mp3" / f"{base}_{key}.mp3"
            if wav.exists() and not mp3.exists():
                try:
                    audio_io.transcode_mp3(wav, mp3)
                    made += 1
                except Exception as e:
                    print(f"[{job.id}] 재생용 mp3 실패 {wav.name}: {e}", flush=True)
        if made:
            job.files = self._scan_files(job, out_dir)
        return made

    def backfill_playback_mp3(self) -> None:
        """기동 때 예전 곡들의 재생용 mp3 를 뒤에서 채운다 (한 번 만들면 다음엔 건너뛴다)."""
        for job in list(self._jobs.values()):
            if self._stop.is_set():
                return
            if job.status != "done":
                continue
            t = time.time()
            n = self.ensure_playback_mp3(job)
            if n:
                print(f"[mp3] {job.folder}: 재생용 mp3 {n}개 ({time.time() - t:.1f}초)", flush=True)

    @staticmethod
    def _find_stem(out_dir: Path, key: str) -> Optional[Path]:
        """스템 파일을 찾는다. 믹스 품질을 위해 wav 를 우선한다
        (mp3 를 디코딩해 다시 인코딩하면 손실이 두 번 쌓인다).

        파일은 `{폴더명}_{키}.{ext}` 로 굽기 때문에 그 이름을 먼저 본다. glob 으로만
        찾으면 버전별 메트로놈 `곡_click_drums.wav` 가 정렬상 `곡_drums.wav` 보다 앞에 와서
        드럼으로 잡힌다. 폴더 이름을 탐색기에서 바꾼 경우에만 glob 으로 물러선다.
        """
        for sub, ext in (("wav", ".wav"), ("mp3", ".mp3")):
            d = out_dir / sub
            if not d.exists():
                continue
            exact = d / f"{out_dir.name}_{key}{ext}"
            if exact.is_file():
                return exact
            hits = sorted(d.glob(f"*_{key}{ext}"))
            # '_no_vocals' 를 '_vocals' 로 잘못 잡지 않도록 거른다
            if not key.startswith("no_"):
                hits = [h for h in hits if not h.stem.endswith(f"_no_{key}")]
            # 버전별 메트로놈 파일 제외
            hits = [h for h in hits if "_click_" not in h.stem]
            if hits:
                return hits[0]
        return None

    @staticmethod
    def _file_entry(job: Job, out_dir: Path, path: Path) -> dict:
        rel = path.relative_to(out_dir).as_posix()
        st = path.stat()
        return {
            "name": path.name,
            "rel": rel,
            "size": st.st_size,
            # 수정 시각(ms). 같은 이름으로 덮어쓰는 파일(메트로놈 재생성)을 브라우저가
            # 캐시된 옛 데이터로 재생하지 않도록 프론트가 URL 과 트랙 키에 섞어 쓴다.
            "mtime": int(st.st_mtime * 1000),
            # 폴더명이 한글/일본어라 URL 에는 안전한 작업 ID 를 쓴다 (서버가 folder 로 변환).
            # rel 은 인코딩한다 — 제목에 '#' 이 있으면 브라우저가 뒤를 프래그먼트로 잘라내고
            # '%' 는 이스케이프로 풀려서 404 가 난다.
            "url": f"/api/jobs/{job.id}/files/{quote(rel, safe='/')}",
        }


store = JobStore()
