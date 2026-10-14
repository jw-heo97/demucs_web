"""메인 에이전트 한 번 돌리기: 스킬(drum-score-video) + score 도구 + 훅.

인증은 OAuth (Claude 구독 로그인). API 키를 쓰지 않는다:
  - CLAUDE_CODE_OAUTH_TOKEN 환경 변수 (`claude setup-token` 으로 받은 1년짜리 토큰), 또는
  - 컨테이너 안에서 `claude` → /login 한 자격 증명 (~/.claude, 볼륨에 남는다)
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, ResultMessage,
                              TextBlock, ToolUseBlock)

from tools import Run, build_server

WORKSPACE = Path(__file__).parent / "workspace"
SKILL = "drum-score-video"

SYSTEM = """너는 드럼 연습 앱(demucs-web)의 악보 담당 에이전트다.
분리가 끝난 곡 하나와, 그 곡의 드럼 악보가 화면에 나오는 연주 영상(YouTube) 하나를 받는다.
할 일: 영상에서 악보 띠를 뽑아 악보 PDF 를 만들고, 곡 음원에 맞춘 송 맵(1마디 1박·BPM·박자·구간 이름)을 저장한다.

규칙
- 반드시 drum-score-video 스킬을 먼저 읽고 그 순서를 따른다.
- score 도구만 쓴다. 파일·셸·웹 도구는 없다.
- 그림을 직접 보고 판단한다: 마디선이 맞는지, 구간 이름(상자 글자), 템포 표기(♩=), 박자표, 못갖춘마디.
- 추측한 값은 추측이라고 report 에 적는다. 사용자는 한국어를 쓴다 — report 요약은 한국어로.
- 끝낼 때는 반드시 report 를 부른다."""


def auth_status() -> dict:
    tok = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))
    cred = (Path.home() / ".claude" / ".credentials.json").exists()
    return {"ready": tok or cred, "token": tok, "login": cred}


def _hooks(run: Run, tool_names: list[str]):
    stops = {"n": 0}

    async def pre(inp, tool_use_id, ctx):
        name = inp.get("tool_name", "")
        # 스킬의 설명서(transcribe.md 등)는 읽게 한다 — 막으면 형식을 시행착오로 맞추느라 턴을 버린다
        if name == "Read" and str((inp.get("tool_input") or {}).get("file_path", "")).startswith(str(WORKSPACE / ".claude")):
            run.log(f"설명서 읽기: {Path(inp['tool_input']['file_path']).name}", "tool")
            return {}
        # 도구가 많으면 Claude Code 가 도구 설명을 미뤄 두고 ToolSearch 로 불러오게 한다 — 막으면 아무 도구도 못 쓴다
        if name == "ToolSearch":
            return {}
        if name in tool_names or name == "Skill":
            short = name.split("__")[-1]
            args = inp.get("tool_input") or {}
            brief = ", ".join(f"{k}={v}" for k, v in args.items() if k not in ("marks", "bars", "names", "beats"))[:120]
            run.log(f"{short}({brief})", "tool")
            run.state = short
            if name.endswith("save_result") and run.built and run.built["measures"] != run.built["expect"]:
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse", "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"PDF 분석 마디 수({run.built['measures']})가 띠 마디 수({run.built['expect']})와 다릅니다. "
                        "마디선을 고치고 build_score 를 다시 하세요.")}}
            return {}
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": "이 작업에서는 score 도구만 쓸 수 있습니다."}}

    async def post(inp, tool_use_id, ctx):
        name = inp.get("tool_name", "")
        extra = None
        if name.endswith("build_score") and run.built:
            b = run.built
            notes = []
            if b["measures"] != b["expect"]:
                notes.append(f"분석기가 읽은 마디 {b['measures']}개 ≠ 띠 마디 {b['expect']}개")
            if b["warnings"]:
                notes.append("경고: " + "; ".join(b["warnings"]))
            if notes:
                extra = "검산 실패 — " + " / ".join(notes) + ". 고친 뒤 다시 build_score."
        if name.endswith("extract_strips") and run.proj["strips"]:
            empty = [i for i, s in enumerate(run.proj["strips"]) if not s["staves"]]
            if empty:
                extra = f"보표를 못 찾은 띠: {empty}"
        if extra:
            run.log(extra, "warn")
            return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": extra}}
        return {}

    async def stop(inp, tool_use_id, ctx):
        stops["n"] += 1
        if stops["n"] > 3:
            return {}
        if run.reported is None:
            return {"decision": "block", "reason": "끝내기 전에 report 도구로 결과를 알리세요 (done 또는 failed)."}
        if run.reported["status"] == "done" and run.built:
            total = run.built["measures"]
            got = sum(1 for n in range(1, total + 1) if n in run.notes)
            if got < total and stops["n"] <= 2:
                return {"decision": "block",
                        "reason": f"음표를 {got}/{total}마디만 받아 적었습니다. 나머지를 write_measures 로 적고 "
                                  "save_result 를 다시 부르세요. 정말 못 하겠으면 report 에 이유를 적으세요."}
        if run.reported["status"] == "done" and not run.saved:
            return {"decision": "block",
                    "reason": "report 는 done 인데 save_result 를 하지 않았습니다. 저장하거나 failed 로 다시 report 하세요."}
        return {}

    return {"PreToolUse": [HookMatcher(hooks=[pre])],
            "PostToolUse": [HookMatcher(hooks=[post])],
            "Stop": [HookMatcher(hooks=[stop])]}


async def run_agent(run: Run) -> None:
    run.state = "시작"
    run.log(f"악보 영상: {run.score_url}")
    server, tool_names = build_server(run)
    env = {}
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = os.environ["CLAUDE_CODE_OAUTH_TOKEN"]
    opts = ClaudeAgentOptions(
        system_prompt=SYSTEM,
        mcp_servers={"score": server},
        allowed_tools=tool_names + ["Read", "ToolSearch"],
        disallowed_tools=["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"],
        skills=[SKILL],
        cwd=str(WORKSPACE),
        hooks=_hooks(run, tool_names),
        model=os.environ.get("AGENT_MODEL") or None,
        max_turns=int(os.environ.get("AGENT_MAX_TURNS") or 90),
        permission_mode="bypassPermissions",
        # 그림을 돌려주는 도구가 많다 — 기본 1MB 면 띠 여러 장을 한 번에 볼 때 넘친다 (라시사에서 실제로 멈춤)
        max_buffer_size=16 * 1024 * 1024,
        env=env,
    )
    prompt = (f"곡 id {run.job_id} 에 악보를 붙여 줘. 악보 영상: {run.score_url}\n"
              f"{'시험 실행이다 — save_result 는 파일만 남긴다.' if run.dry_run else ''}"
              f"{'이미 있는 악보를 덮어써도 된다.' if run.overwrite else ''}")
    t0 = time.time()
    async with ClaudeSDKClient(options=opts) as client:
        await client.query(prompt)
        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, TextBlock) and b.text.strip():
                        run.log(b.text.strip()[:600], "say")
                    elif isinstance(b, ToolUseBlock) and b.name == "Skill":
                        run.log(f"스킬 읽기: {json.dumps(b.input, ensure_ascii=False)[:80]}", "tool")
            elif isinstance(msg, ResultMessage):
                run.log(f"끝 — {msg.num_turns}턴, {time.time() - t0:.0f}초"
                        + (f", 오류: {msg.result}" if msg.is_error else ""), "info")
    run.state = "끝"
