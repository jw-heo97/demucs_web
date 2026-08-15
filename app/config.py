"""환경변수 기반 설정. 전부 compose 에서 덮어쓸 수 있다."""
import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


# --- 경로 ---
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/data/output"))
WORK_DIR = Path(os.getenv("WORK_DIR", "/data/work"))

# 다운로드가 403 으로 막히면 이 순서대로 플레이어 클라이언트를 바꿔가며 재시도한다.
# YouTube 가 기본(web) 클라이언트에 PO 토큰을 요구하면서 403 을 주는 일이 잦은데,
# android/tv 클라이언트는 아직 통과한다 (실측 확인). 빈 항목은 기본값.
YTDLP_CLIENTS = [
    c.strip()
    for c in os.getenv("YTDLP_CLIENTS", ",android,tv,web_safari,ios,mweb").split(",")
]

# yt-dlp 쿠키 파일 (로그인 세션 그 자체이므로 이미지에 굽지 말고 마운트할 것)
_cookies = os.getenv("COOKIES_FILE", "").strip()
COOKIES_FILE = Path(_cookies) if _cookies else None

# --- 모델 / 추론 ---
MODEL_NAME = os.getenv("DEMUCS_MODEL", "htdemucs")
DEVICE = os.getenv("DEVICE", "auto")          # auto | cuda | cpu
SHIFTS = _int("SHIFTS", 1)                     # 올리면 품질↑ 시간↑ (2~5)
OVERLAP = _float("OVERLAP", 0.25)
# VRAM 8GB 에서 htdemucs 기본 세그먼트로 충분. OOM 나면 5~7 정도로 낮출 것.
_seg = os.getenv("SEGMENT", "").strip()
SEGMENT = float(_seg) if _seg else None

# --- 인코딩 ---
MP3_BITRATE = os.getenv("MP3_BITRATE", "320k")
WAV_SUBTYPE = os.getenv("WAV_SUBTYPE", "PCM_16")   # PCM_16 | PCM_24 | FLOAT

# --- 메트로놈 ---
# 검출된 박자 위치에 클릭을 찍어 별도 트랙으로 저장한다. 믹서에서 켜고 끌 수 있다.
METRONOME_DEFAULT = os.getenv("METRONOME", "1").strip().lower() not in ("0", "false", "no", "off")
BEATS_PER_BAR = _int("BEATS_PER_BAR", 4)
CLICK_LEVEL = _float("CLICK_LEVEL", 0.7)
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

# --- 작업 제한 ---
# 8GB VRAM 보호 + 사용자가 실수로 3시간짜리 라이브를 넣는 것 방지
MAX_DURATION_SEC = _int("MAX_DURATION_SEC", 900)   # 15분
MAX_QUEUE = _int("MAX_QUEUE", 20)
# 0 = 자동 삭제 안 함(기본). 결과물을 라이브러리처럼 모아두는 용도라 자동 삭제는 위험하다.
# 양수로 주면 그 초 이상 지난 완료 작업의 폴더를 워커가 지운다.
JOB_RETENTION_SEC = _int("JOB_RETENTION_SEC", 0)


def _flag(name: str, default: bool = False) -> bool:
    v = os.getenv(name, "").strip().lower()
    if not v:
        return default
    return v not in ("0", "false", "no", "off")


# --- 인증 ---
AUTH_DIR = Path(os.getenv("AUTH_DIR", "/data/auth"))
# 첫 기동 때 계정이 없으면 이 값으로 관리자를 만든다.
# ADMIN_PASSWORD 가 비어 있으면 임의 비밀번호를 생성해 로그에 한 번 찍는다.
ADMIN_USER = os.getenv("ADMIN_USER", "admin").strip() or "admin"
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
SESSION_DAYS = _int("SESSION_DAYS", 30)
# 로그인 무차별 대입 방지
LOGIN_MAX_FAILS = _int("LOGIN_MAX_FAILS", 5)
LOGIN_LOCK_SEC = _int("LOGIN_LOCK_SEC", 300)
# 앱 전체 접근을 특정 역할로 제한하고 싶을 때만 채운다 (예: admin).
# 기본은 비어 있음 — 로그인한 사용자면 누구나 쓸 수 있고,
# 보안 화면(계정 관리·접속 기록)만 관리자로 따로 막는다.
REQUIRE_ROLE = os.getenv("REQUIRE_ROLE", "").strip()
# 앱(Capacitor/Tauri)에서 다른 오리진으로 호출할 때 허용할 목록. 쉼표 구분.
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

# --- 접속 IP 기록 ---
# Docker Desktop for Windows 는 출발지 IP 를 보존하지 않는다(실측 확인).
# 컨테이너는 모든 접속을 브리지 게이트웨이(172.x.0.1)로 본다.
# 진짜 IP 를 남기려면 Windows 쪽에 리버스 프록시를 두고 X-Forwarded-For 를 받아야 한다.
# 그 경우에만 아래를 켠다. PROXY_SECRET 을 함께 설정하면 헤더 위조를 막을 수 있다.
TRUST_PROXY_HEADER = _flag("TRUST_PROXY_HEADER", False)
PROXY_SECRET = os.getenv("PROXY_SECRET", "").strip()
ACCESS_LOG_MAX_MB = _int("ACCESS_LOG_MAX_MB", 5)
