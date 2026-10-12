# AI 악보 에이전트: Claude Agent SDK(OAuth 로그인) + 영상 처리.
# GPU 이미지(api)와 따로 둔다 — yt-dlp 를 자주 올려야 하고, node(유튜브 JS 런타임)·Claude CLI 가 필요하다.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg nodejs fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "claude-agent-sdk>=0.2" "yt-dlp[default]" pymupdf numpy pillow fastapi "uvicorn[standard]" httpx

# SDK 에 들어 있는 Claude Code CLI 를 PATH 에 — `claude setup-token` 으로 OAuth 토큰을 받을 때 쓴다
RUN ln -s "$(python -c 'import claude_agent_sdk,os;print(os.path.join(os.path.dirname(claude_agent_sdk.__file__),"_bundled","claude"))')" /usr/local/bin/claude

RUN useradd -m -u 1000 app
WORKDIR /srv
COPY app/scores.py app/scorebuild.py ./
COPY agent/*.py ./
COPY agent/workspace ./workspace
RUN mkdir -p /work /home/app/.claude && chown -R app /work /srv /home/app/.claude
USER app
ENV PYTHONUNBUFFERED=1 HOME=/home/app
EXPOSE 8090
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8090"]
