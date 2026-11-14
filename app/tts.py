"""구간 안내 음성: 짧은 글자(구간 이름)를 소리 파일(wav)로.

브라우저 음성 합성(speechSynthesis)은 아이패드·아이폰에서 말하는 동안 재생 중인 곡 소리를 OS 가
줄였다가 다시 키운다(더킹). 앱이 끌 수 없어서, 서버(espeak-ng)가 소리 파일로 만들고 화면의 재생기가
곡 위에 그대로 얹는다. 같은 글자는 다시 만들지 않는다(컨테이너 /tmp 캐시).
"""
from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

CACHE = Path("/tmp/tts")
MAX_LEN = 40


class TTSError(RuntimeError):
    pass


def voice_for(text: str) -> str:
    """한글이 있으면 한국어, 아니면(Verse, Chorus …) 영어 — 한국어 음성이 영어를 읽으면 어색하다."""
    return "ko" if re.search(r"[가-힣]", text) else "en-us"


def wav(text: str) -> Path:
    text = " ".join((text or "").split())[:MAX_LEN]
    if not text:
        raise TTSError("읽을 글자가 없습니다.")
    v = voice_for(text)
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / (hashlib.sha1(f"{v}|{text}".encode()).hexdigest()[:16] + ".wav")
    if out.exists() and out.stat().st_size > 44:
        return out
    tmp = out.with_suffix(".tmp.wav")
    # -s 말 속도(분당 단어), -a 크기(0~200), -g 단어 사이 쉼(10ms 단위)
    r = subprocess.run(["espeak-ng", "-v", v, "-s", "165", "-a", "190", "-g", "2", "-w", str(tmp), text],
                       capture_output=True, timeout=10)
    if r.returncode != 0 or not tmp.exists():
        raise TTSError(f"음성을 만들지 못했습니다: {r.stderr.decode('utf-8', 'replace')[:200]}")
    tmp.replace(out)
    return out
