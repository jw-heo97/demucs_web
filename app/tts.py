"""구간 안내 음성: 구간 이름을 영어 소리 파일(wav)로 (Piper, 가벼운 신경망 TTS).

브라우저 음성 합성(speechSynthesis)은 아이패드·아이폰에서 말하는 동안 재생 중인 곡 소리를 OS 가
줄였다가 다시 키운다(더킹). 앱이 끌 수 없어서, 서버가 소리 파일로 만들고 화면의 재생기가 곡 위에 그대로 얹는다.

영어만 읽는다. 자동으로 붙은 '구간N' 은 'Section N' 으로, 그 밖의 한글은 빼고, 남는 게 없으면 읽지 않는다
(화면의 web/src/hooks/useSectionVoice.ts 의 spoken() 과 같은 규칙). 같은 글자는 다시 만들지 않는다(/tmp 캐시).
"""
from __future__ import annotations

import hashlib
import os
import re
import threading
import wave
from pathlib import Path

CACHE = Path("/tmp/tts")
MAX_LEN = 40
MODEL = os.environ.get("PIPER_MODEL", "/opt/piper/en_US-lessac-medium.onnx")
# 조금 빠르게 (1 보다 작으면 빠르다) — 한 마디 앞에서 짧게 끝나야 한다
LENGTH_SCALE = 0.9

_voice = None
_lock = threading.Lock()


class TTSError(RuntimeError):
    pass


def spoken(text: str) -> str:
    """읽을 영어 글자. '구간3' → 'Section 3', 다른 한글은 뺀다."""
    t = re.sub(r"구간\s*(\d+)", r"Section \1", text or "")
    t = re.sub(r"[가-힣ㄱ-ㆎ]+", " ", t)
    return " ".join(t.split())[:MAX_LEN]


def wav(text: str) -> Path:
    global _voice
    t = spoken(text)
    if not re.search(r"[A-Za-z0-9]", t):
        raise TTSError("영어로 읽을 글자가 없습니다.")
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / (hashlib.sha1(f"piper|{t}".encode()).hexdigest()[:16] + ".wav")
    if out.exists() and out.stat().st_size > 44:
        return out
    with _lock:   # 모델은 처음 한 번 올리고, 한 번에 하나씩 만든다
        if _voice is None:
            from piper.voice import PiperVoice
            _voice = PiperVoice.load(MODEL)
        tmp = out.with_suffix(".tmp.wav")
        with wave.open(str(tmp), "wb") as w:
            _voice.synthesize(t, w, length_scale=LENGTH_SCALE)
    tmp.replace(out)
    return out
