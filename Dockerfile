# ---------------------------------------------------------------------------
# 1단계: React(Vite) 프론트엔드 빌드
# 결과물만 런타임 이미지로 옮기므로 node/npm 은 최종 이미지에 남지 않는다.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# 2단계: 런타임
# RTX 5060 Ti = Blackwell(sm_120). PyTorch 2.7.0 + CUDA 12.8 이상에서만 GPU 커널이 있다.
# 이 태그는 실제로 검증됨:  2.8.0+cu128 / True / NVIDIA GeForce RTX 5060 Ti / (12, 0)
# ---------------------------------------------------------------------------
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NUMBA_CACHE_DIR=/tmp/numba \
    # demucs 4.1.0 은 가중치를 huggingface_hub 로 받는다 (torch.hub 아님).
    # 두 캐시를 모두 /opt/cache 아래로 모아 비루트 사용자도 읽게 만든다.
    TORCH_HOME=/opt/cache/torch \
    HF_HOME=/opt/cache/huggingface

# ffmpeg: 베이스 이미지에 없음. 오디오 디코딩 + mp3 인코딩에 필수.
# tini: ffmpeg 자식 프로세스 좀비 수거 + SIGTERM 전달.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# yt-dlp 는 자주 갱신해야 하므로 별도 레이어. 갱신 시:
#   docker compose build --build-arg YTDLP_VERSION=2026.8.1 api
ARG YTDLP_VERSION=2026.7.4
RUN pip install "yt-dlp==${YTDLP_VERSION}"

# htdemucs 가중치(~320MB)를 이미지에 미리 굽는다.
# 이걸 안 하면 컨테이너를 새로 만들 때마다 매번 재다운로드한다.
# 캐시가 비어 있으면 여기서 빌드를 실패시켜, 런타임에 조용히 재다운로드되는 걸 막는다.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
 && du -sh /opt/cache/* \
 && test -n "$(find /opt/cache -type f -size +10M -print -quit)"

COPY app/ /app/

# 1단계에서 빌드한 React 번들을 정적 파일로 얹는다 (main.py 가 /ui 로 서빙)
COPY --from=webbuild /web/dist /app/static

# 비루트 실행. /data 는 compose 에서 마운트되므로 소유권을 미리 맞춰둔다.
RUN useradd -m -u 10001 -s /usr/sbin/nologin appuser \
 && mkdir -p /data/output /data/work \
 && chown -R appuser:appuser /app /data /opt/cache

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
# 워커 1개: 작업 큐(jobs.py)가 프로세스 메모리에 있어 여러 워커로 나누면 안 된다.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
