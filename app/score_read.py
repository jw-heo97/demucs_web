"""AI 악보(악보 PDF): 고른 악보 PDF 를 줄(보표 한 줄)마다 잘라 AI 가 읽고, 음표 악보를 통째로 채운다.

악보 편집에서 마디를 하나씩 열 때 읽는 것(/notation/read)을 곡 전체에 미리 해 두는 것.
- 한 줄의 마디들을 한 번에 보낸다 (줄 그림 하나 + 마디마다 박자) — 마디마다 따로 부르는 것보다 훨씬 빠르다
- 이미 고친 마디(edited)는 건드리지 않는다. 읽은 마디는 제안이라 edited 를 붙이지 않는다(원본 위 덮개 없음)
- 반복 기호로 펼친 악보(order)는 같은 악보 마디를 한 번만 읽고, 그 마디가 나오는 음원 마디에 모두 넣는다
- 다 읽은 뒤 한 번만 저장한다 (중간 저장마다 이력이 쌓이지 않게)
진행 상황은 메모리(STATUS)에 — 화면이 1~2초마다 본다.
"""
from __future__ import annotations

import base64
import threading
import time
from pathlib import Path
from typing import Callable

import notation
import scores

STATUS: dict[str, dict] = {}
_lock = threading.Lock()


def status(job_id: str) -> dict:
    return STATUS.get(job_id) or {"phase": "idle"}


def _empty(beats: int, unit: int) -> dict:
    steps = beats * 2 if unit == 8 else beats * 4
    return {"beats": beats, "unit": unit, "steps": steps, "lanes": {}}


def start(job_id: str, song: Path, bars: list[dict], recognize: Callable[[dict], dict]) -> dict:
    """bars: 송 맵 마디들 [{bar, beats_per_bar, beat_unit}] — 음표 악보 마디 수·박자의 기준."""
    with _lock:
        cur = STATUS.get(job_id)
        if cur and cur.get("phase") == "running":
            return cur
        data = scores.load(song)
        if not data or not data.get("measures") or not (song / scores.SCORE_PDF).exists():
            raise ValueError("이 곡에 악보 PDF 가 없습니다.")
        if not bars:
            raise ValueError("송 맵이 없어 마디를 모릅니다.")
        st = {"phase": "running", "done": 0, "total": 0, "measures": 0, "started": time.time(), "notes": [], "error": None}
        STATUS[job_id] = st
    threading.Thread(target=_run, args=(job_id, song, data, bars, recognize, st), daemon=True).start()
    return st


def _run(job_id: str, song: Path, data: dict, bars: list[dict], recognize: Callable[[dict], dict], st: dict) -> None:
    import pymupdf

    try:
        sms = data["measures"]
        order = data.get("order")
        n = len(bars)
        # 음원 마디 b(1부터) → 악보 마디 k(0부터)
        k_of = {b: ((order[b - 1] if order and b <= len(order) else b) - 1) for b in range(1, n + 1)}
        bars_of: dict[int, list[int]] = {}
        for b, k in k_of.items():
            if 0 <= k < len(sms):
                bars_of.setdefault(k, []).append(b)

        # 지금 음표 악보 (마디 수가 송 맵과 다르면 송 맵 마디로 새로 — 고친 마디는 같은 번호면 남긴다)
        old = notation.load(song) or {}
        olds = old.get("measures") or []
        ms = []
        for i, b in enumerate(bars):
            o = olds[i] if i < len(olds) else None
            if o and o.get("edited"):
                ms.append(o)
            else:
                m = _empty(int(b.get("beats_per_bar") or 4), int(b.get("beat_unit") or 4))
                if o and o.get("section"):
                    m["section"] = o["section"]
                ms.append(m)

        # 읽을 악보 마디: 그 마디가 나오는 음원 마디 중 하나라도 안 고친 것
        todo = sorted(k for k, bs in bars_of.items() if any(not ms[b - 1].get("edited") for b in bs))
        # 줄(쪽·보표 줄)마다 묶는다
        groups: list[list[int]] = []
        for k in todo:
            key = (sms[k]["page"], sms[k]["system"])
            if groups and (sms[groups[-1][-1]]["page"], sms[groups[-1][-1]]["system"]) == key and k == groups[-1][-1] + 1:
                groups[-1].append(k)
            else:
                groups.append([k])
        # 한 번에 8마디까지 (에이전트 한도)
        split: list[list[int]] = []
        for g in groups:
            for i in range(0, len(g), 8):
                split.append(g[i:i + 8])
        st["total"] = len(split)

        doc = pymupdf.open(song / scores.SCORE_PDF)
        for g in split:
            a, z = sms[g[0]], sms[g[-1]]
            sh = a["bot"] - a["top"]
            page = doc[a["page"]]
            clip = pymupdf.Rect(max(0, a["x0"] - sh * 0.3), max(0, a["y0"]), min(page.rect.width, z["x1"] + sh * 0.3),
                                min(page.rect.height, a["y1"]))
            png = page.get_pixmap(dpi=200, clip=clip).tobytes("png")
            meters = []
            for k in g:
                m = ms[bars_of[k][0] - 1]
                meters.append({"beats": m["beats"], "unit": m["unit"], "steps": m["steps"]})
            try:
                r = recognize({"image": base64.b64encode(png).decode(), "measures": meters,
                               "first_bar": bars_of[g[0]][0], "kind": "print"})
                got = r.get("measures") or []
                for k, gm in zip(g, got):
                    for b in bars_of[k]:
                        if ms[b - 1].get("edited"):
                            continue
                        keep = ms[b - 1].get("section")
                        ms[b - 1] = {"beats": gm["beats"], "unit": gm["unit"], "steps": gm["steps"], "lanes": gm.get("lanes") or {}}
                        if keep:
                            ms[b - 1]["section"] = keep
                        st["measures"] += 1
                if r.get("note"):
                    st["notes"].append(f"{bars_of[g[0]][0]}마디~: {r['note']}"[:300])
            except Exception as e:  # noqa: BLE001 — 한 줄이 실패해도 나머지는 읽는다
                st["notes"].append(f"{bars_of[g[0]][0]}마디~: 읽지 못함 ({e})"[:300])
            st["done"] += 1
        doc.close()

        doc_out = {"version": 1, "measures": ms}
        if old.get("tempo") or data.get("tempo"):
            doc_out["tempo"] = old.get("tempo") or data.get("tempo")
        notation.save(song, doc_out, "AI 악보 (악보 PDF)")
        st["phase"] = "done"
    except Exception as e:  # noqa: BLE001
        st["phase"] = "failed"
        st["error"] = str(e)[:300]
    finally:
        st["finished"] = time.time()
