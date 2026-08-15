"""오디오 입출력.

원래 separate.py 는 torchaudio.load(backend="soundfile") / torchaudio.save(format="mp3") 를
썼는데, torchaudio 는 2.9 부터 유지보수 모드로 들어가면서 backend 인자가 제거됐고
load/save 는 TorchCodec 별칭이 되었다. 그래서 여기서는 torchaudio 를 아예 쓰지 않고
디코딩/mp3 인코딩은 ffmpeg, wav 쓰기는 soundfile 로 직접 처리한다.

배열 규약: 전 구간 float32, shape = (channels, samples). demucs 와 동일.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from config import FFMPEG_BIN, FFPROBE_BIN, MP3_BITRATE, WAV_SUBTYPE


class AudioError(RuntimeError):
    pass


def probe(path: Path) -> dict:
    """ffprobe 로 길이/코덱 확인. 다운로드 직후 길이 제한 검사에 쓴다."""
    cmd = [
        FFPROBE_BIN, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", "-select_streams", "a:0", str(path),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise AudioError(f"ffprobe 실패: {p.stderr.strip()[:500]}")
    info = json.loads(p.stdout or "{}")
    fmt = info.get("format", {})
    streams = info.get("streams", [])
    duration = fmt.get("duration") or (streams[0].get("duration") if streams else None)
    return {
        "duration": float(duration) if duration else 0.0,
        "codec": streams[0].get("codec_name") if streams else None,
        "sample_rate": int(streams[0]["sample_rate"]) if streams and streams[0].get("sample_rate") else None,
    }


def decode(path: Path, sample_rate: int, channels: int = 2) -> np.ndarray:
    """어떤 컨테이너든(webm/m4a/opus/wav...) ffmpeg 로 디코딩해서 (ch, n) float32 로 돌려준다.

    ffmpeg 가 리샘플링까지 해주므로 torchaudio.transforms.Resample 이 필요 없다.
    """
    cmd = [
        FFMPEG_BIN, "-nostdin", "-v", "error",
        "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", str(channels), "-ar", str(sample_rate),
        "pipe:1",
    ]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise AudioError(f"디코딩 실패: {p.stderr.decode('utf-8', 'replace').strip()[:500]}")

    flat = np.frombuffer(p.stdout, dtype="<f4")
    if flat.size < channels:
        raise AudioError("디코딩 결과가 비어 있습니다 (오디오 트랙 없음?)")

    n = flat.size // channels
    # frombuffer 는 읽기 전용 뷰라서 copy 필요
    return np.ascontiguousarray(flat[: n * channels].reshape(n, channels).T, dtype=np.float32)


def _to_interleaved(audio: np.ndarray) -> np.ndarray:
    """(ch, n) -> (n, ch), [-1, 1] 클리핑."""
    if audio.ndim == 1:
        audio = audio[None, :]
    return np.clip(audio.T, -1.0, 1.0).astype(np.float32, copy=False)


def save_wav(path: Path, audio: np.ndarray, sample_rate: int, subtype: str = WAV_SUBTYPE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), _to_interleaved(audio), sample_rate, subtype=subtype)
    return path


def save_mp3(path: Path, audio: np.ndarray, sample_rate: int, bitrate: str = MP3_BITRATE) -> Path:
    """raw f32le 를 ffmpeg stdin 으로 밀어넣어 인코딩. 중간 wav 파일을 안 만든다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = _to_interleaved(audio)
    channels = data.shape[1]
    cmd = [
        FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
        "-f", "f32le", "-ar", str(sample_rate), "-ac", str(channels),
        "-i", "pipe:0",
        "-c:a", "libmp3lame", "-b:a", bitrate,
        str(path),
    ]
    p = subprocess.run(cmd, input=data.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise AudioError(f"mp3 인코딩 실패: {p.stderr.decode('utf-8', 'replace').strip()[:500]}")
    return path
