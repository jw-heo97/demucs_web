"""AI 악보 에이전트 서비스 (compose 안에서만 열린다 — api 가 대신 불러 준다).

POST /runs        {job_id, score_url, overwrite?, dry_run?}  → 대기열에 넣는다 (한 번에 하나씩)
GET  /runs/{id}   진행 상황 (상태·기록·결과)
GET  /health      인증(OAuth) 준비 여부
"""
from __future__ import annotations

import asyncio
import json
import time
import traceback
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException

from runner import auth_status, run_agent
from tools import WORK, Run

app = FastAPI(title="demucs-agent")
runs: dict[str, Run] = {}
queue: "asyncio.Queue[Run]" = asyncio.Queue()
meta: dict[str, dict] = {}


def _status_file(job_id: str) -> Path:
    return WORK / job_id / "status.json"


def view(run: Run) -> dict:
    m = meta.get(run.job_id, {})
    return {
        "job_id": run.job_id, "score_url": run.score_url, "phase": m.get("phase", "queued"),
        "state": run.state, "started": m.get("started"), "finished": m.get("finished"),
        "error": m.get("error"), "report": run.reported, "saved": run.saved,
        "log": run.log_lines[-120:], "dry_run": run.dry_run,
    }


def _persist(run: Run) -> None:
    try:
        p = _status_file(run.job_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(view(run), ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


async def worker() -> None:
    while True:
        run = await queue.get()
        meta[run.job_id].update(phase="running", started=time.time())
        try:
            await run_agent(run)
            meta[run.job_id]["phase"] = "done" if (run.reported or {}).get("status") == "done" else "failed"
        except Exception as e:  # noqa: BLE001
            run.log(f"실패: {e}", "error")
            traceback.print_exc()
            meta[run.job_id].update(phase="failed", error=str(e)[:500])
        finally:
            meta[run.job_id]["finished"] = time.time()
            _persist(run)
            queue.task_done()


@app.on_event("startup")
async def _start() -> None:
    asyncio.create_task(worker())

    async def persist_loop():
        while True:
            await asyncio.sleep(3)
            for r in list(runs.values()):
                if meta.get(r.job_id, {}).get("phase") == "running":
                    _persist(r)
    asyncio.create_task(persist_loop())


@app.get("/health")
def health():
    return {"ok": True, "auth": auth_status(), "queue": queue.qsize()}


@app.post("/runs", status_code=202)
async def start(payload: dict = Body(...)):
    job_id = str(payload.get("job_id") or "")
    url = str(payload.get("score_url") or "").strip()
    if not job_id or not url:
        raise HTTPException(400, "job_id 와 score_url 이 필요합니다.")
    if not auth_status()["ready"]:
        raise HTTPException(503, "Claude 로그인이 안 되어 있습니다. README 'AI 악보' 의 OAuth 설정을 해 주세요.")
    cur: Optional[Run] = runs.get(job_id)
    if cur and meta.get(job_id, {}).get("phase") in ("queued", "running"):
        raise HTTPException(409, "이 곡은 이미 AI 악보 작업 중입니다.")
    run = Run(job_id, url, overwrite=bool(payload.get("overwrite")), dry_run=bool(payload.get("dry_run")))
    runs[job_id] = run
    meta[job_id] = {"phase": "queued"}
    run.log("대기열에 들어갔습니다")
    await queue.put(run)
    return view(run)


@app.get("/runs/{job_id}")
def status(job_id: str):
    run = runs.get(job_id)
    if run:
        return view(run)
    p = _status_file(job_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    raise HTTPException(404, "AI 악보 작업 기록이 없습니다.")
