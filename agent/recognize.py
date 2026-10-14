"""손으로 그린 드럼 악보(아이패드 펜) → 마디별 악기 칸. 송 맵의 악보 편집에서 부른다.

그림 한 장(오선 + 마디선 + 박 구분선이 앱이 그려 준 바탕 위에 사용자가 음표를 그린 것)과
마디들의 박자를 받아, 짧은 에이전트 한 번(도구 2개: 그림 보기, 답 내기)으로 받아 적는다.
인증은 AI 악보와 같은 OAuth.
"""
from __future__ import annotations

import base64
import io
import json
import os
import time
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, create_sdk_mcp_server, tool
from PIL import Image

import notation as nota
from tools import S, _err, _img, _ok

WORKSPACE = Path(__file__).parent / "workspace"
TRANSCRIBE = WORKSPACE / ".claude" / "skills" / "drum-score-video" / "transcribe.md"


def _lane_guide() -> str:
    """transcribe.md 의 칸 형식·기호·보표 자리 부분 (받아 적기 규칙을 한 곳에서만 고치게)."""
    try:
        s = TRANSCRIBE.read_text(encoding="utf-8")
    except OSError:
        return ""
    end = s.find("## 순서")
    return s[: end if end > 0 else len(s)]


SYSTEM = """너는 드럼 악보 받아 적기 담당이다. 사용자가 아이패드 펜으로 손으로 그린 드럼 악보를 칸 형식으로 옮긴다.

바탕(오선 5줄, 마디선, 마디 번호, 박마다 옅은 점선, 왼쪽의 악기 자리 표시)은 앱이 그린 것이다. 그 위의 손글씨만 음표다.
손글씨는 삐뚤다 — 음표 머리의 높이는 가장 가까운 줄/칸으로, 가로 위치는 박 점선을 기준으로 가장 가까운 칸으로 맞춘다.
머리 모양: x(가위표) = 심벌류(크래시·하이햇·라이드), 동그라미/점 = 북(스네어·탐·킥). 기둥의 사선은 더블 스트로크(1·2·3),
기둥에 z 는 버즈, > 는 악센트, 괄호는 고스트, 작은 앞꾸밈음은 플램. 쉼표는 비운다.
기둥·빔이 없어도 머리 위치만으로 타이밍을 정한다 (빔이 있으면 빔 수로 8분·16분을 확인).

순서: drawing 으로 그림을 보고 → answer 로 마디마다 칸을 낸다. answer 가 오류를 돌려주면 고쳐서 다시 낸다.
확신 없는 곳은 answer 의 note 에 한국어로 짧게 적는다.

""" + _lane_guide()


async def recognize(png_b64: str, measures: list[dict], first_bar: int = 1) -> dict:
    """measures: [{beats, unit, steps?}] (그림 왼쪽부터). 돌려줌: {measures: [{beats, unit, steps, lanes}], note}"""
    if not measures or len(measures) > 8:
        raise ValueError("마디는 1~8개")
    raw = base64.b64decode(png_b64.split(",")[-1])
    im = Image.open(io.BytesIO(raw))
    if im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, "white")
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    meters = []
    for i, m in enumerate(measures):
        beats, unit = int(m.get("beats") or 4), int(m.get("unit") or 4)
        meters.append({"bar": first_bar + i, "beats": beats, "unit": unit,
                       "steps_hint": int(m.get("steps") or (beats * 2 if unit == 8 else beats * 4))})
    out: dict = {}

    @tool("drawing", "사용자가 그린 악보 그림과 마디별 박자.", S())
    async def drawing(args):
        return _ok(json.dumps({"measures": meters}, ensure_ascii=False), _img(im, 1800))

    @tool("answer", "마디별 칸을 낸다. measures: [{beats, unit, steps, lanes: {칸이름: 문자열}}] (그림 왼쪽부터, 마디 수 그대로). "
                    "note: 확신 없는 곳 (한국어, 선택).",
          S(["measures"], measures="array", note="string"))
    async def answer(args):
        ms = args.get("measures")
        if isinstance(ms, str):
            try:
                ms = json.loads(ms)
            except ValueError:
                return _err("measures 는 배열이어야 합니다")
        if not isinstance(ms, list) or len(ms) != len(meters):
            return _err(f"마디 {len(meters)}개를 내야 합니다 (받은 것: {len(ms) if isinstance(ms, list) else 0})")
        for m, want in zip(ms, meters):
            if isinstance(m, dict):
                m.setdefault("beats", want["beats"])
                m.setdefault("unit", want["unit"])
        try:
            doc = nota.normalize({"measures": ms})
        except nota.NotationError as e:
            return _err(f"형식 오류: {e}. 예: {{\"beats\":4,\"unit\":4,\"steps\":16,\"lanes\":{{\"hh\":\"x-x-x-x-x-x-x-x-\",\"bd\":\"x-------x-------\"}}}}")
        for m, want in zip(doc["measures"], meters):
            if (m["beats"], m["unit"]) != (want["beats"], want["unit"]):
                return _err(f"{want['bar']}마디는 {want['beats']}/{want['unit']} 입니다")
        out["measures"] = doc["measures"]
        out["note"] = str(args.get("note") or "")[:500]
        return _ok("받았습니다. 끝내세요.")

    server = create_sdk_mcp_server("draw", "1.0.0", [drawing, answer])
    env = {}
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = os.environ["CLAUDE_CODE_OAUTH_TOKEN"]
    opts = ClaudeAgentOptions(
        system_prompt=SYSTEM,
        mcp_servers={"draw": server},
        allowed_tools=["mcp__draw__drawing", "mcp__draw__answer"],
        disallowed_tools=["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"],
        cwd=str(WORKSPACE),
        model=os.environ.get("DRAW_MODEL") or os.environ.get("AGENT_MODEL") or None,
        max_turns=8,
        permission_mode="bypassPermissions",
        max_buffer_size=16 * 1024 * 1024,
        env=env,
    )
    t0 = time.time()
    span = f"{first_bar}마디" if len(meters) == 1 else f"{first_bar}~{first_bar + len(meters) - 1}마디"
    async with ClaudeSDKClient(options=opts) as client:
        await client.query(f"{span}를 손으로 그린 악보입니다. drawing 으로 보고 answer 로 받아 적어 주세요.")
        async for msg in client.receive_response():
            if isinstance(msg, ResultMessage) and msg.is_error and not out:
                raise RuntimeError(str(msg.result)[:300])
    if "measures" not in out:
        raise RuntimeError("인식 결과를 받지 못했습니다")
    out["seconds"] = round(time.time() - t0, 1)
    return out
