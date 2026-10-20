"""키보드 악보 PDF 분석 (KeyboardScoreAnalyzer) — app/scores.py 의 ScoreAnalyzer 구현체.

한 줄이 여러 단 묶음이다: 멜로디(보컬) 단 + 피아노 큰보표(높은음·낮은음). 마디는 묶음마다 한 번 센다.
드럼 분석기(app/drum/scores.py)와 코드를 나눠 쓰지 않는다 — 서로 고쳐도 영향이 없다.

드럼 악보와 다른 점
- 위아래 보표를 잇는 세로선(줄 왼쪽의 묶음선, 큰보표 마디선)이 있으면 같은 묶음이다.
- 오선 다섯 줄 사이에 빔·덧줄 같은 가로선이 낀다 → 좌우 끝이 같은 줄끼리 다섯 줄을 고른다.
- 피아노 단의 화음 기둥은 보표 높이를 다 덮어 마디선처럼 보인다 → 묶음의 모든 단에 같은 자리로 있는 선만 마디선.
- 구간 표시는 Finale 연습 기호 글꼴(Rentaro)의 글자 하나('a' = 상자 친 A). 템포도 같은 글꼴('%=68', % 가 ♩).
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Iterator, Optional

import scores
from scores import RENDER_DPI, SCORE_DIR, ScoreAnalyzer

Line = tuple[float, float, float]   # 가로선 (y, x0, x1) / 세로선 (x, y0, y1)


class KeyboardScoreAnalyzer(ScoreAnalyzer):
    """키보드 악보: 한 줄 = 멜로디 + 피아노 큰보표 묶음."""
    instrument = "keyboard"

    #: Finale 연습 기호 글꼴 — 'a'..'z' 가 상자 친 A..Z
    REHEARSAL_FONTS = ("Rentaro",)
    _TEMPO = re.compile(r"=\s*(\d{2,3}(?:\.\d+)?)")

    # ---------------------------------------------------------------- 선
    @staticmethod
    def horizontal_lines(drawings) -> list[Line]:
        out = []
        for d in drawings:
            for it in d["items"]:
                if it[0] == "l":
                    p, q = it[1], it[2]
                    if abs(p.y - q.y) < 0.3 and abs(q.x - p.x) > 20:
                        out.append(((p.y + q.y) / 2, min(p.x, q.x), max(p.x, q.x)))
                elif it[0] == "re":
                    r = it[1]
                    if r.height < 1.2 and r.width > 20:
                        out.append(((r.y0 + r.y1) / 2, r.x0, r.x1))
        return out

    @staticmethod
    def vertical_lines(drawings) -> list[Line]:
        out = []
        for d in drawings:
            for it in d["items"]:
                if it[0] == "l":
                    p, q = it[1], it[2]
                    if abs(p.x - q.x) < 0.3:
                        out.append((p.x, min(p.y, q.y), max(p.y, q.y)))
                elif it[0] == "re":
                    r = it[1]
                    if r.width < 6 and r.height > r.width:
                        out.append(((r.x0 + r.x1) / 2, r.y0, r.y1))
        return out

    # ---------------------------------------------------------------- 보표·묶음·마디선
    def find_staves(self, drawings) -> list[dict]:
        """5줄 보표들. 좌우 끝이 같은 가로줄 다섯 개 (사이에 낀 빔·덧줄은 건너뛴다)."""
        lines: list[list[float]] = []
        for y, x0, x1 in sorted(self.horizontal_lines(drawings)):
            if lines and abs(y - lines[-1][0]) < 0.6:
                lines[-1][1] = min(lines[-1][1], x0)
                lines[-1][2] = max(lines[-1][2], x1)
            else:
                lines.append([y, x0, x1])
        lines = [ln for ln in lines if ln[2] - ln[1] > 40]
        staves, used = [], set()
        for i in range(len(lines)):
            if i in used:
                continue
            idx = [i]
            for j in range(i + 1, len(lines)):
                if len(idx) == 5 or lines[j][0] - lines[idx[-1]][0] > 12:
                    break
                if j not in used and abs(lines[j][1] - lines[i][1]) < 3 and abs(lines[j][2] - lines[i][2]) < 3:
                    idx.append(j)
            if len(idx) < 5:
                continue
            grp = [lines[k] for k in idx]
            gaps = [grp[k + 1][0] - grp[k][0] for k in range(4)]
            if 3.0 < min(gaps) and max(gaps) < 12 and max(gaps) - min(gaps) < 1.0:
                staves.append({"top": grp[0][0], "bot": grp[4][0], "x0": min(g[1] for g in grp),
                               "x1": max(g[2] for g in grp), "gap": sum(gaps) / 4})
                used.update(idx)
        if staves:
            med = sorted(x["gap"] for x in staves)[len(staves) // 2]
            staves = [x for x in staves if abs(x["gap"] - med) <= 0.25 * med]
        return staves

    @staticmethod
    def group_systems(vl: list[Line], staves: list[dict]) -> list[list[dict]]:
        """위아래 보표를 잇는 세로선이 있으면 같은 묶음 (멜로디 + 피아노 높은음·낮은음)."""
        if not staves:
            return []
        groups = [[staves[0]]]
        for st in staves[1:]:
            prev = groups[-1][-1]
            x0, x1 = max(prev["x0"], st["x0"]) - 3, min(prev["x1"], st["x1"]) + 3
            if any(x0 <= x <= x1 and y0 <= prev["bot"] + 1 and y1 >= st["top"] - 1 for x, y0, y1 in vl):
                groups[-1].append(st)
            else:
                groups.append([st])
        return groups

    @staticmethod
    def staff_bars(vl: list[Line], st: dict, span: tuple[float, float]) -> list[float]:
        """이 단을 위아래로 다 덮는 세로선의 x (묶음 안에서 끝나는 선만 — 페이지 테두리 같은 것은 뺀다)."""
        top, bot = st["top"], st["bot"]
        h = bot - top
        xs = sorted(x for x, y0, y1 in vl
                    if y0 <= top + 1 and y1 >= bot - 1
                    and ((y1 - y0) < h + 20 or (y0 >= span[0] - 1 and y1 <= span[1] + 1))
                    and st["x0"] - 2 <= x <= st["x1"] + 2)
        merged: list[float] = []
        for x in xs:   # 겹세로줄·끝세로줄은 하나의 경계
            if merged and x - merged[-1] < 6:
                merged[-1] = x
            else:
                merged.append(x)
        return [x for x in merged if x > st["x0"] + 8]

    def system_barlines(self, vl: list[Line], grp: list[dict]) -> list[float]:
        """묶음의 마디선: 모든 단에 같은 자리로 있는 세로선만 (화음 기둥은 한 단에만 있다)."""
        span = (grp[0]["top"], grp[-1]["bot"])
        per = [self.staff_bars(vl, g, span) for g in grp]
        return [x for x in per[0] if all(any(abs(x - y) < 2 for y in o) for o in per[1:])]

    # ---------------------------------------------------------------- 글자
    @staticmethod
    def spans(page) -> Iterator[dict]:
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                yield from ln.get("spans", [])

    def tempo_of(self, spans: list[dict]) -> Optional[float]:
        for sp in spans:
            m = self._TEMPO.search(sp["text"])
            if m and 30 <= float(m.group(1)) <= 300:
                return float(m.group(1))
        return None

    def rehearsal_letters(self, spans: list[dict]) -> list[dict]:
        return [sp for sp in spans if any(f in sp["font"] for f in self.REHEARSAL_FONTS)
                and re.fullmatch(r"[a-zA-Z]", sp["text"].strip())]

    # ---------------------------------------------------------------- 분석
    def analyze(self, pdf_path: Path, out_dir: Path) -> dict:
        import pymupdf

        img_dir = out_dir / SCORE_DIR
        if img_dir.exists():
            shutil.rmtree(img_dir, ignore_errors=True)
        img_dir.mkdir(parents=True, exist_ok=True)

        doc = pymupdf.open(pdf_path)
        pages, measures, marks = [], [], []
        tempo: Optional[float] = None
        for pi, page in enumerate(doc):
            name = f"page-{pi + 1}.png"
            page.get_pixmap(dpi=RENDER_DPI).save(str(img_dir / name))
            W, H = page.rect.width, page.rect.height
            pages.append({"w": W, "h": H, "img": name})

            drawings = page.get_drawings()
            vl = self.vertical_lines(drawings)
            spans = list(self.spans(page))
            rehearsal = [sp for sp in spans if any(f in sp["font"] for f in self.REHEARSAL_FONTS)]
            if tempo is None:
                tempo = self.tempo_of(rehearsal + spans)
            letters = self.rehearsal_letters(spans)

            systems = self.group_systems(vl, self.find_staves(drawings))
            for si, grp in enumerate(systems):
                top, bot, gap = grp[0]["top"], grp[-1]["bot"], grp[0]["gap"]
                x0, x1 = min(g["x0"] for g in grp), max(g["x1"] for g in grp)
                prev_bot = systems[si - 1][-1]["bot"] if si > 0 else None
                next_top = systems[si + 1][0]["top"] if si + 1 < len(systems) else None
                # 위는 코드 이름·구간 표시·템포, 아래는 페달·셈여림까지
                y0 = prev_bot + 0.4 * (top - prev_bot) if prev_bot is not None else top - 9 * gap
                y1 = bot + 0.5 * (next_top - bot) if next_top is not None else bot + 6 * gap
                y0 = max(0.0, min(y0, top - 2 * gap))
                y1 = min(H, max(y1, bot + 2 * gap))
                first = len(measures)
                left = x0
                staves = [[round(g["top"], 2), round(g["bot"], 2)] for g in grp]
                for x in self.system_barlines(vl, grp):
                    measures.append({"page": pi, "system": si, "x0": left, "x1": x, "y0": y0, "y1": y1,
                                     "top": top, "bot": bot, "sys_x0": x0, "sys_x1": x1,
                                     "staves": staves, "gap": round(gap, 2)})
                    left = x
                # 연습 기호(구간): 이 줄 위쪽의 글자 → 시작이 가장 가까운 마디
                for sp in letters:
                    bx0, _, _, by1 = sp["bbox"]
                    if y0 - 4 <= by1 <= top + gap and first < len(measures):
                        k = min(range(first, len(measures)), key=lambda k: abs(measures[k]["x0"] - bx0))
                        marks.append({"measure": k + 1, "text": sp["text"].strip().upper()})
        doc.close()

        seen, uniq = set(), []
        for m in marks:
            if m["measure"] not in seen:
                seen.add(m["measure"])
                uniq.append(m)
        for k, m in enumerate(measures):
            m["number"] = k + 1
            for key in ("x0", "x1", "y0", "y1", "top", "bot", "sys_x0", "sys_x1"):
                m[key] = round(m[key], 2)
        return {"version": 1, "kind": "keyboard", "pages": pages, "measures": measures,
                "marks": sorted(uniq, key=lambda m: m["measure"]), "tempo": tempo, "warnings": [],
                "repeats": {"starts": [], "ends": []}}


scores.register(KeyboardScoreAnalyzer())
