"""Demucs 분리 + BPM 검출.

원본 separate.py 대비 바뀐 점:
  - 모델을 매 실행마다 로드하지 않고 프로세스당 1회만 로드해 상주시킨다.
  - torchaudio 대신 numpy <-> torch 로만 주고받는다 (audio_io 가 ffmpeg/soundfile 담당).
  - apply_model 의 callback 을 써서 실제 진행률을 뽑는다 (tqdm 파싱 아님).
  - librosa 0.10.1+ 에서 beat_track 의 tempo 가 배열로 바뀐 것을 처리한다.
"""
from __future__ import annotations

import threading
from typing import Callable, Optional

import numpy as np
import torch

from config import DEVICE, MODEL_NAME, OVERLAP, SEGMENT, SHIFTS

_model = None
_model_lock = threading.Lock()


def resolve_device() -> str:
    if DEVICE == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return DEVICE


def get_loaded_model():
    """스레드 안전 싱글턴. 첫 호출에서만 가중치를 읽는다."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from demucs.pretrained import get_model

                m = get_model(name=MODEL_NAME)
                m.to(resolve_device())
                m.eval()
                _model = m
    return _model


def model_info() -> dict:
    m = get_loaded_model()
    device = resolve_device()
    info = {
        "model": MODEL_NAME,
        "sources": list(m.sources),
        "samplerate": int(m.samplerate),
        "device": device,
    }
    if device == "cuda" and torch.cuda.is_available():
        info["gpu"] = torch.cuda.get_device_name(0)
        info["capability"] = list(torch.cuda.get_device_capability(0))
    return info


def separate(
    audio: np.ndarray,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> dict[str, np.ndarray]:
    """(2, n) float32 를 받아 {stem 이름: (2, n) float32} 로 돌려준다.

    입력은 이미 모델 샘플레이트로 디코딩돼 있어야 한다 (audio_io.decode 가 처리).
    """
    from demucs.apply import apply_model

    model = get_loaded_model()
    device = resolve_device()

    if audio.ndim == 1:
        audio = audio[None, :]
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    elif audio.shape[0] > 2:
        audio = audio[:2]

    wav = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))

    # demucs 표준 정규화
    ref = wav.mean(0)
    std = ref.std()
    mean = ref.mean()
    if float(std) < 1e-8:
        raise ValueError("무음에 가까운 오디오입니다 (표준편차 ~0).")
    wav = (wav - mean) / std
    wav = wav[None].to(device)

    total_samples = max(int(wav.shape[-1]), 1)
    seen = {"frac": 0.0}

    def _cb(d: dict) -> None:
        if not progress_cb:
            return
        # demucs 4.1.0 은 세그먼트 처리 시작/끝마다 state 와 segment_offset(샘플)을 준다.
        if d.get("state") != "end":
            return
        frac = min(float(d.get("segment_offset", 0)) / total_samples, 1.0)
        if frac > seen["frac"]:      # shifts>1 이면 offset 이 되감기므로 단조 증가만 반영
            seen["frac"] = frac
            progress_cb(frac)

    with torch.no_grad():
        sources = apply_model(
            model,
            wav,
            shifts=SHIFTS,
            split=True,
            overlap=OVERLAP,
            segment=SEGMENT,
            progress=False,
            device=device,
            callback=_cb,
        )[0]

    sources = sources * std + mean

    out = {name: sources[i].cpu().numpy().astype(np.float32) for i, name in enumerate(model.sources)}

    if device == "cuda":
        del sources, wav
        torch.cuda.empty_cache()

    if progress_cb:
        progress_cb(1.0)
    return out


# hop 512 는 박자 시각이 11.6ms 단위로 양자화돼 템포 추정이 눈에 띄게 틀어진다
# (실측: 라일락 152.00 / 라시사 166.71 → 실제 150 / 165).
# 256 으로 낮추면 5.8ms 해상도가 되어 149.80 / 165.38 까지 좋아진다.
# 128 은 더 정확하지만 5분 곡에 165~241초가 걸려 실용적이지 않다.
_HOP = 256
# 대중음악에서 흔한 템포 범위. 이 밖으로 나오면 옥타브 오류를 의심한다.
_PREF_LO, _PREF_HI = 95.0, 190.0
# 2배(또는 1/2배) 후보의 템포그램 근거가 원래 값 대비 이 비율 이상일 때만 옮긴다.
# 단순히 "범위 밖이면 2배" 로 하면 진짜 느린 발라드를 망가뜨린다.
_OCTAVE_RATIO = 0.80


def _tempo_salience(onset_env: np.ndarray, sample_rate: int):
    """자기상관 템포그램을 시간축으로 평균 → 템포별 근거 강도 곡선."""
    import librosa

    tg = librosa.feature.tempogram(onset_envelope=onset_env, sr=sample_rate, hop_length=_HOP)
    freqs = librosa.tempo_frequencies(tg.shape[0], sr=sample_rate, hop_length=_HOP)
    sal = np.nanmean(tg, axis=1)
    ok = np.isfinite(freqs) & (freqs > 30) & (freqs < 320)
    return freqs[ok], sal[ok]


def _salience_at(freqs, sal, bpm: float) -> float:
    if bpm <= 0 or freqs.size == 0:
        return 0.0
    return float(sal[int(np.argmin(np.abs(freqs - bpm)))])


def _fix_octave(bpm: float, freqs, sal) -> tuple[float, str]:
    """librosa 의 고질적인 2배/절반 오류를 템포그램 근거로 바로잡는다.

    librosa 는 기본 템포 사전확률이 120 BPM 근처에 강하게 걸려 있어서 빠른 곡을 반으로 접는다.
    실측: 라일락(실제 150) → 74.9,  라시사(실제 165) → 82.03. 둘 다 정확히 절반이었다.
    """
    base = _salience_at(freqs, sal, bpm)
    if base <= 0:
        return bpm, "근거 없음"
    if bpm < _PREF_LO:
        cand = bpm * 2
        ratio = _salience_at(freqs, sal, cand) / base
        if cand <= 300 and ratio >= _OCTAVE_RATIO:
            return cand, f"2배 보정(근거비 {ratio:.2f})"
    elif bpm > _PREF_HI:
        cand = bpm / 2
        ratio = _salience_at(freqs, sal, cand) / base
        if cand >= 40 and ratio >= _OCTAVE_RATIO:
            return cand, f"1/2배 보정(근거비 {ratio:.2f})"
    return bpm, "보정 없음"


def analyze_beats(drums: np.ndarray, sample_rate: int) -> dict:
    """드럼 스템에서 템포와 **박자 위치(초)** 를 뽑는다.

    beat_track 은 어차피 박자 위치를 계산하는데 원래 코드는 그걸 버리고 BPM 만 썼다.
    메트로놈을 고정 그리드가 아니라 실제 연주에 맞춰 붙이려면 이 값이 필요하다.

    librosa 0.10.1 부터 tempo 가 스칼라가 아니라 배열로 오므로 풀어서 꺼낸다
    (원본의 float(tempo) 는 NumPy 2.x 에서 경고를 내고 향후 에러가 된다).
    """
    import librosa

    mono = np.ascontiguousarray(drums.mean(axis=0) if drums.ndim > 1 else drums)
    onset_env = librosa.onset.onset_strength(y=mono, sr=sample_rate, hop_length=_HOP)

    raw, _ = librosa.beat.beat_track(y=mono, sr=sample_rate, hop_length=_HOP, units="time")
    raw = float(np.atleast_1d(np.asarray(raw, dtype=np.float64)).ravel()[0])

    freqs, sal = _tempo_salience(onset_env, sample_rate)
    fixed, note = _fix_octave(raw, freqs, sal)

    # 보정된 템포를 시작점으로 다시 추적해야 박자 위치도 올바른 옥타브로 나온다
    _, beats = librosa.beat.beat_track(
        y=mono, sr=sample_rate, hop_length=_HOP, start_bpm=fixed, units="time")
    beats = np.asarray(beats, dtype=np.float64)

    # 보고 값은 템포그램 추정치(fixed)를 쓴다.
    # 박자 간격 중앙값으로 덮어쓰면 프레임 양자화 때문에 오히려 나빠진다
    # (실측: 라시사 165.38 → 164.06, 실제 165).
    tempo = fixed
    if beats.size > 2:
        med = 60.0 / float(np.median(np.diff(beats)))
        # 추적이 전혀 다른 템포에 물린 경우에만 중앙값을 신뢰한다
        if med > 0 and abs(med - fixed) / fixed > 0.10:
            tempo = med

    return {
        "bpm": round(tempo, 2),
        "beats": beats,
        "raw_bpm": round(raw, 2),
        "octave_note": note,
    }


def detect_bpm(drums: np.ndarray, sample_rate: int) -> float:
    return analyze_beats(drums, sample_rate)["bpm"]




def render_metronome(beat_times: np.ndarray, sample_rate: int, n_samples: int,
                     beats_per_bar: int = 4, level: float = 0.7,
                     accents: Optional[np.ndarray] = None) -> Optional[np.ndarray]:
    """박자 위치에 클릭을 찍어 (2, n) 스테레오 트랙을 만든다.

    마디 첫 박은 높은 음(1500Hz), 나머지는 낮은 음(1000Hz)으로 구분한다.
    accents 를 주면 그 불리언 배열이 강세 위치를 결정한다 — 곡 중간에 박자표가
    바뀌는 경우(4/4 → 3/4) beats_per_bar 하나로는 표현할 수 없기 때문이다.
    안 주면 첫 박자를 마디 시작으로 보고 beats_per_bar 마다 강세를 준다.
    """
    import librosa

    beat_times = np.asarray(beat_times, dtype=np.float64)
    if beat_times.size == 0 or n_samples <= 0:
        return None

    if accents is None:
        bpb = max(1, int(beats_per_bar))
        accents = np.zeros(beat_times.size, dtype=bool)
        accents[::bpb] = True
    else:
        accents = np.asarray(accents, dtype=bool)
        if accents.size != beat_times.size:
            accents = np.zeros(beat_times.size, dtype=bool)
            accents[::max(1, int(beats_per_bar))] = True

    # 오디오 길이를 넘어가는 박자는 버린다 (librosa.clicks 가 length 로 자르지만 명시적으로)
    keep = beat_times * sample_rate < n_samples
    beat_times, accents = beat_times[keep], accents[keep]
    if beat_times.size == 0:
        return None

    downs, others = beat_times[accents], beat_times[~accents]

    mono = np.zeros(n_samples, dtype=np.float64)
    if downs.size:
        mono = mono + librosa.clicks(times=downs, sr=sample_rate, length=n_samples,
                                     click_freq=1500.0, click_duration=0.055)
    if others.size:
        mono = mono + librosa.clicks(times=others, sr=sample_rate, length=n_samples,
                                     click_freq=1000.0, click_duration=0.045)

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > 0:
        mono = mono / peak * float(level)
    return np.stack([mono, mono]).astype(np.float32)


# --------------------------------------------------------------------------
# 곡 구성표(song map)
# --------------------------------------------------------------------------
# [{start, name, bpm, beats_per_bar, beat_unit}, ...] 형태.
# 구간마다 템포와 박자표가 다를 수 있다.
# 검출에 의존하지 않고 사용자가 첫 박 위치와 BPM 을 직접 잡으면
# 예비박 정렬·BPM 오차·박자표 변화가 한꺼번에 해결된다.


MAX_BARS = 5000


def beats_from_map(songmap: dict, duration: float):
    """구성표에서 박자·강세·마디 목록을 만든다.

    시간이 아니라 **마디 번호**로 박자표를 바꾼다. 기준 시각은 '1마디 1박' 하나뿐이고
    그 뒤 마디는 앞 마디 길이를 순서대로 쌓아 계산한다. 그래서 중간에 3/4 마디가
    끼어도 뒤쪽 마디가 저절로 맞는다 — 초 단위로 구간을 잡을 때처럼 어긋나지 않는다.

    반환: (beats, accents, sounds, bars)
      beats/accents 는 모든 박자 위치와 마디 첫 박 여부 (격자·예비박 정렬용),
      sounds 는 그 박에서 실제로 클릭이 울리는지 (구간별 click_beats 설정).
      bars 는 [{bar, start, beats_per_bar, beat_unit, bpm, name}] — 재생 중
      현재 마디/박 표시와 편집기 미리보기에 쓴다.
    """
    empty = (np.array([]), np.array([], dtype=bool), np.array([], dtype=bool), [])
    if not songmap or duration <= 0:
        return empty

    anchor = float(songmap.get("anchor", 0.0) or 0.0)
    base_bpm = float(songmap.get("bpm", 0) or 0)
    ranges = sorted((songmap.get("ranges") or []),
                    key=lambda r: int(r.get("from_bar", 1) or 1))
    if base_bpm <= 0 or not ranges:
        return empty

    beats: list[float] = []
    accents: list[bool] = []
    sounds: list[bool] = []
    bars: list[dict] = []

    t = anchor
    bar = 1
    ri = 0
    while t < duration and bar <= MAX_BARS:
        # 이 마디에 적용되는 구간으로 전진
        while ri + 1 < len(ranges) and int(ranges[ri + 1].get("from_bar", 1) or 1) <= bar:
            ri += 1
        r = ranges[ri]

        # 재고정(re-anchor): 그 구간의 첫 마디에 절대 시각이 지정돼 있으면
        # 앞에서 누적된 위치를 버리고 그 시각부터 다시 센다.
        # 곡에 4박이 아닌 마디가 하나 끼어 뒤쪽 마디가 통째로 밀렸을 때,
        # 원인을 몰라도 "이 마디는 여기서 시작" 으로 바로잡을 수 있다.
        if bar == int(r.get("from_bar", 1) or 1):
            ra = r.get("anchor")
            if ra is not None:
                try:
                    t = float(ra)
                except (TypeError, ValueError):
                    pass
        bpb = max(1, int(r.get("beats_per_bar", 4) or 4))
        unit = max(1, int(r.get("beat_unit", 4) or 4))
        bpm = float(r.get("bpm") or base_bpm)
        if bpm <= 0:
            break
        step = (60.0 / bpm) * (4.0 / unit)

        # click_beats: 이 마디에서 소리를 낼 박 번호(1부터).
        #   None  = 지정 없음 → 전부 울림
        #   []    = 명시적으로 전부 끔  ← 이 둘을 구분해야 "전체 끄기" 가 표현된다
        cb = r.get("click_beats")
        wanted = None
        if isinstance(cb, (list, tuple)):
            wanted = {int(x) for x in cb if str(x).lstrip("-").isdigit()}

        bars.append({"bar": bar, "start": round(t, 4), "beats_per_bar": bpb,
                     "beat_unit": unit, "bpm": round(bpm, 3),
                     "name": str(r.get("name") or ""),
                     "click_beats": sorted(wanted) if wanted is not None else None,
                     "anchored": bar == int(r.get("from_bar", 1) or 1)
                                 and r.get("anchor") is not None})

        for k in range(bpb):
            bt = t + k * step
            if bt >= duration:
                break
            if bt >= 0:
                beats.append(bt)
                accents.append(k == 0)
                sounds.append(True if wanted is None else (k + 1) in wanted)

        t += bpb * step
        bar += 1

    return (np.asarray(beats, dtype=np.float64),
            np.asarray(accents, dtype=bool),
            np.asarray(sounds, dtype=bool),
            bars)
