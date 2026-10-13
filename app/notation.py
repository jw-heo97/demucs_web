"""드럼 악보 (음표 수준) — 곡 폴더의 _notation.json.

마디마다 악기별 '칸 문자열'로 적는다. 드러머가 생각하는 방식이고, AI 가 쓰기 쉽고, 편집 화면(칸 누르기)과
그대로 맞는다. 오선 악보는 브라우저(web/src/lib/notation.ts, VexFlow)가 여기서 그린다.

    {"version": 1, "tempo": 150, "source": "https://youtube…",
     "measures": [
       {"beats": 4, "unit": 4, "steps": 16, "section": "Aメロ",
        "lanes": {"hh": "x-x-x-x-x-x-x-x-", "sn": "----x-------x---", "bd": "x-------x-x-----"}},
       {"beats": 4, "unit": 4, "steps": 16, "simile": true, "lanes": {…앞 마디와 같음…}}
     ]}

- 음원 n 번째 마디 = measures[n-1] (송 맵 마디와 1:1).
- steps: 마디를 몇 칸으로 나누나. 4/4 에서 16 = 16분, 12 = 8분 셋잇단, 24 = 16분 셋잇단, 48 = 둘 다.
- 칸 기호: '-' 없음, 'x' 침, '>' 악센트, 'g' 고스트, 'f' 플램, 'o' 열린 하이햇(hh 만).
- simile: 화면에 '%'(앞 마디 반복)로 그린다. lanes 에는 실제 내용을 그대로 둔다 (소리 대조·편집용).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

FILE = "_notation.json"
HISTORY = "_notation_history.json"
HISTORY_MAX = 20

# 악기 칸. 손(기둥 위) / 발(기둥 아래)
LANES = {
    "cr": "크래시", "cr2": "크래시2", "spl": "스플래시", "chn": "차이나", "rd": "라이드", "rb": "라이드 벨",
    "hh": "하이햇", "t1": "하이 탐", "t2": "미드 탐", "sn": "스네어", "rim": "크로스 스틱", "ft": "플로어 탐",
    "cb": "카우벨", "bd": "베이스 드럼", "hhp": "하이햇 페달",
}
FEET = {"bd", "hhp"}
SYMBOLS = set("-x>gfo")
# 한 박(♩)을 48 틱으로 — 16분(12)·32분(6)·8분 셋잇단(16)·16분 셋잇단(8) 이 모두 정수
TPQ = 48
MAX_MEASURES = 1000


class NotationError(ValueError):
    pass


def measure_ticks(beats: int, unit: int) -> int:
    return beats * TPQ * 4 // unit


def normalize(data: Any) -> dict:
    """검사하고 정리한다. 틀리면 NotationError (어느 마디가 왜인지)."""
    if not isinstance(data, dict):
        raise NotationError("악보 형식이 아닙니다")
    ms = data.get("measures")
    if not isinstance(ms, list) or not ms:
        raise NotationError("마디가 없습니다")
    if len(ms) > MAX_MEASURES:
        raise NotationError(f"마디는 {MAX_MEASURES}개까지입니다")
    out = []
    for i, m in enumerate(ms, 1):
        if not isinstance(m, dict):
            raise NotationError(f"{i}마디: 형식이 아닙니다")
        beats = int(m.get("beats") or 4)
        unit = int(m.get("unit") or 4)
        if not 1 <= beats <= 16 or unit not in (2, 4, 8, 16):
            raise NotationError(f"{i}마디: 박자 {beats}/{unit} 은 쓸 수 없습니다")
        steps = int(m.get("steps") or 16)
        ticks = measure_ticks(beats, unit)
        if steps < 1 or steps > 192 or ticks % steps:
            raise NotationError(f"{i}마디: {beats}/{unit} 마디를 {steps}칸으로 나눌 수 없습니다")
        lanes = {}
        for k, v in (m.get("lanes") or {}).items():
            if k not in LANES:
                raise NotationError(f"{i}마디: 모르는 악기 '{k}'")
            v = str(v).replace(" ", "").replace("|", "")
            if len(v) != steps:
                raise NotationError(f"{i}마디 {k}: 칸 {len(v)}개 (마디는 {steps}칸)")
            if set(v) - SYMBOLS:
                raise NotationError(f"{i}마디 {k}: 모르는 기호 {''.join(sorted(set(v) - SYMBOLS))}")
            if "o" in v and k != "hh":
                raise NotationError(f"{i}마디 {k}: 'o'(열림)는 하이햇에만 씁니다")
            if v.strip("-"):
                lanes[k] = v
        item = {"beats": beats, "unit": unit, "steps": steps, "lanes": lanes}
        sec = (m.get("section") or "").strip()
        if sec:
            item["section"] = sec[:40]
        if m.get("simile"):
            item["simile"] = True
        out.append(item)
    res = {"version": 1, "measures": out}
    if data.get("tempo"):
        res["tempo"] = float(data["tempo"])
    if data.get("source"):
        res["source"] = str(data["source"])[:300]
    return res


def load(song_dir: Path) -> Optional[dict]:
    try:
        return json.loads((song_dir / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(song_dir: Path, data: dict, note: str = "") -> dict:
    """정리해서 저장한다. 바로 전 것은 이력(최근 20개)에 남긴다 — 손으로 고친 악보가 덮어쓰기 한 번에 날아가지 않게."""
    data = normalize(data)
    old = load(song_dir)
    if old is not None:
        hist_p = song_dir / HISTORY
        try:
            hist = json.loads(hist_p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            hist = []
        hist.insert(0, {"at": time.time(), "note": note, "data": old})
        _write(hist_p, hist[:HISTORY_MAX])
    _write(song_dir / FILE, data)
    return data


def history(song_dir: Path) -> list[dict]:
    try:
        hist = json.loads((song_dir / HISTORY).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [{"at": h.get("at"), "note": h.get("note", ""), "measures": len(h.get("data", {}).get("measures", []))}
            for h in hist]


def restore(song_dir: Path, index: int) -> dict:
    hist = json.loads((song_dir / HISTORY).read_text(encoding="utf-8"))
    if not 0 <= index < len(hist):
        raise NotationError("그 이력이 없습니다")
    return save(song_dir, hist[index]["data"], note="이력에서 되돌림")


def remove(song_dir: Path) -> None:
    p = song_dir / FILE
    if p.exists():
        old = load(song_dir)
        if old:
            save(song_dir, old, note="지우기 전")   # 이력에 남기고
        p.unlink(missing_ok=True)


def _write(p: Path, obj: Any) -> None:
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def hits(m: dict) -> list[tuple[int, str, str]]:
    """마디 안 타격들: (틱, 악기, 기호). 소리 대조(agent)에서 쓴다."""
    step = measure_ticks(m["beats"], m["unit"]) // m["steps"]
    out = []
    for k, v in m.get("lanes", {}).items():
        for i, c in enumerate(v):
            if c != "-":
                out.append((i * step, k, c))
    return sorted(out)
