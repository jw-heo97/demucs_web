"""악보 PDF 분석 — 악기별 분석기의 추상 클래스와 공통 저장.

곡 폴더(악기마다 따로: 드럼은 곡 폴더, 나머지는 _inst/<악기>/)의 score.pdf 를 열어 페이지 이미지와
마디 위치를 뽑는다. 화면은 이걸로 지금 연주 중인 마디를 칠하고, 구간 표시·템포로 송 맵을 만든다.

악기마다 악보 모양이 달라 분석은 따로 한다 (ScoreAnalyzer 를 상속):

    drum      app/drum/scores.py      DrumScoreAnalyzer   (한 줄 = 보표 하나)
    keyboard  app/keyboard/scores.py  (keyboard 브랜치)   (한 줄 = 멜로디 + 피아노 큰보표 묶음)

구현이 없는 악기는 드럼 분석기(한 단씩 읽는다)를 쓴다.

결과 형식(모든 분석기가 같다 — 화면은 이 형식만 안다):
    {version, pages: [{w, h, img}], measures: [{page, system, x0, x1, y0, y1, top, bot, sys_x0, sys_x1, number}],
     marks: [{measure, text}], tempo, warnings, repeats, order?, order_auto?}
_score.json 과 _score/page-N.png 에 둔다.
"""
from __future__ import annotations

import json
import os
import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Optional

SCORE_PDF = "score.pdf"
SCORE_JSON = "_score.json"
SCORE_DIR = "_score"
# 페이지 이미지 해상도. 마디를 화면 폭에 잘라 보여주기에 충분하고 파일도 작다.
RENDER_DPI = 144


class ScoreAnalyzer(ABC):
    """악기 하나의 악보 분석기. analyze 만 구현하면 저장·다시 분석·지우기는 여기서 한다."""

    #: 이 분석기가 맡은 악기 (drum, keyboard, guitar, bass)
    instrument: str = ""

    @abstractmethod
    def analyze(self, pdf_path: Path, out_dir: Path) -> dict:
        """PDF 를 분석해 페이지 이미지(out_dir/_score/)를 쓰고 구조(위 형식)를 돌려준다. 저장은 하지 않는다."""

    # ---- 공통 (저장 형식이 같다)
    def load(self, out_dir: Path) -> Optional[dict]:
        return load(out_dir)

    def save(self, out_dir: Path, data: dict) -> None:
        save(out_dir, data)

    def rebuild(self, out_dir: Path) -> dict:
        """score.pdf 를 다시 분석한다. 손으로 넣은 order 는 남긴다 (자동으로 펼친 것은 새로)."""
        old = self.load(out_dir) or {}
        data = self.analyze(out_dir / SCORE_PDF, out_dir)
        if isinstance(old.get("order"), list) and not old.get("order_auto"):
            data["order"] = old["order"]
            data.pop("order_auto", None)
        self.save(out_dir, data)
        return data

    def remove(self, out_dir: Path) -> None:
        remove(out_dir)

    def song_map(self, data: dict, current: dict) -> Optional[dict]:
        """악보를 올렸을 때 자동으로 만들 송 맵 (구간·템포). 없으면 None — 송 맵을 만들지 않는다.
        current: 지금 활성 송 맵 (1마디 1박 등은 여기서 물려받는다). 드럼은 AI 악보가 송 맵을 만들어 None."""
        return None


_REGISTRY: dict[str, ScoreAnalyzer] = {}
DEFAULT = "drum"


def register(an: ScoreAnalyzer) -> ScoreAnalyzer:
    """악기 분석기를 등록한다 (구현 모듈이 불러질 때 스스로 등록)."""
    _REGISTRY[an.instrument] = an
    return an


def analyzer(instrument: Optional[str] = None) -> ScoreAnalyzer:
    """그 악기의 분석기. 구현이 없는 악기는 드럼 분석기."""
    return _REGISTRY.get(instrument or DEFAULT) or _REGISTRY[DEFAULT]


# ---- 공통 저장 (모든 악기가 같은 파일 이름·형식)
def load(out_dir: Path) -> Optional[dict]:
    p = out_dir / SCORE_JSON
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(out_dir: Path, data: dict) -> None:
    p = out_dir / SCORE_JSON
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def remove(out_dir: Path) -> None:
    for name in (SCORE_PDF, SCORE_JSON):
        try:
            (out_dir / name).unlink(missing_ok=True)
        except OSError:
            pass
    shutil.rmtree(out_dir / SCORE_DIR, ignore_errors=True)


def summary(data: Optional[dict]) -> Optional[dict[str, Any]]:
    if not data:
        return None
    return {"pages": len(data.get("pages", [])), "measures": len(data.get("measures", [])),
            "tempo": data.get("tempo")}


# ---- 예전 이름 (드럼 분석기) — AI 악보 에이전트·scorebuild 가 쓴다
def analyze(pdf_path: Path, out_dir: Path) -> dict:
    return analyzer(DEFAULT).analyze(pdf_path, out_dir)


def rebuild(out_dir: Path) -> dict:
    return analyzer(DEFAULT).rebuild(out_dir)


# 구현체 등록 (구현 모듈이 이 파일의 ScoreAnalyzer 를 상속하므로 맨 끝에서 불러온다)
from drum import scores as _drum_scores  # noqa: E402,F401
from keyboard import scores as _keyboard_scores  # noqa: E402,F401
