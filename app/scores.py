"""악보 PDF 분석.

곡 폴더의 score.pdf 를 열어 페이지 이미지와 마디 위치를 뽑는다. 화면은 이걸로
지금 연주 중인 8마디를 잘라 보여주고, 구간 표시·템포로 송 맵을 만든다.

MuseScore 같은 악보 프로그램이 만든 **벡터 PDF** 를 전제로 한다. 보표 가로줄과
마디선이 선(path)으로, 마디 번호·구간 이름·템포가 글자로 들어 있어서 그대로 읽힌다.
스캔본(이미지만 있는 PDF)은 마디를 찾지 못한다 — measures 가 비어 돌아간다.

결과는 {곡}/_score.json 과 {곡}/_score/page-N.png 에 둔다.
_score.json 의 order 는 손으로 넣는 값이다: 반복 기호(‖: :‖)처럼 음원의 마디 순서가
악보와 다를 때 "음원 n번째 마디 = 악보 몇 번째 마디(1부터)" 목록. 다시 분석해도 남긴다.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

SCORE_PDF = "score.pdf"
SCORE_JSON = "_score.json"
SCORE_DIR = "_score"
# 페이지 이미지 해상도. 8마디를 화면 폭에 잘라 보여주기에 충분하고 파일도 작다.
RENDER_DPI = 144

_NUM = re.compile(r"^\d{1,4}$")


def _horizontal_segments(drawings) -> list[tuple[float, float, float]]:
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


def find_staves(drawings) -> list[dict]:
    """5줄 보표들. 가로줄이 마디마다 끊겨 그려지는 악보도 있어 같은 높이끼리 합친다."""
    segs = sorted(_horizontal_segments(drawings))
    lines: list[list[float]] = []          # [y, x0, x1]
    for y, x0, x1 in segs:
        if lines and abs(y - lines[-1][0]) < 0.6:
            lines[-1][1] = min(lines[-1][1], x0)
            lines[-1][2] = max(lines[-1][2], x1)
        else:
            lines.append([y, x0, x1])
    # 어느 정도 긴 줄만 (글자 밑줄·꾸밈선 제외). 마지막 줄에 한 마디만 있는 경우도 있어 넉넉히.
    lines = [ln for ln in lines if ln[2] - ln[1] > 40]
    staves = []
    i = 0
    while i + 4 < len(lines):
        grp = lines[i:i + 5]
        gaps = [grp[k + 1][0] - grp[k][0] for k in range(4)]
        # 보표 줄 간격은 보통 5~8pt. 너무 촘촘한 평행선(장식·텍스트 밑줄 묶음)은 보표가 아니다.
        if 3.0 < min(gaps) and max(gaps) < 12 and max(gaps) - min(gaps) < 1.0:
            staves.append({
                "top": grp[0][0], "bot": grp[4][0],
                "x0": min(g[1] for g in grp), "x1": max(g[2] for g in grp),
                "gap": sum(gaps) / 4,
            })
            i += 5
        else:
            i += 1
    # 한 악보 안의 보표는 줄 간격이 같다. 크게 다른 것은 버린다.
    if staves:
        med = sorted(x["gap"] for x in staves)[len(staves) // 2]
        staves = [x for x in staves if abs(x["gap"] - med) <= 0.25 * med]
    return staves


def find_barlines(drawings, st: dict) -> list[float]:
    """보표 위아래를 정확히 잇는 세로선. 페이지 테두리처럼 훨씬 긴 선은 뺀다."""
    top, bot = st["top"], st["bot"]
    h = bot - top
    xs = []
    for d in drawings:
        for it in d["items"]:
            if it[0] == "l":
                p, q = it[1], it[2]
                y0, y1 = min(p.y, q.y), max(p.y, q.y)
                if abs(p.x - q.x) < 0.3 and y0 <= top + 1 and y1 >= bot - 1 and (y1 - y0) < h + 20:
                    xs.append(p.x)
            elif it[0] == "re":
                r = it[1]
                if r.width < 6 and r.y0 <= top + 1 and r.y1 >= bot - 1 and r.height < h + 20:
                    xs.append((r.x0 + r.x1) / 2)
    xs = sorted(x for x in xs if st["x0"] - 2 <= x <= st["x1"] + 2)
    merged: list[float] = []
    for x in xs:   # 겹세로줄·끝세로줄(가는 줄+굵은 줄)은 하나의 경계
        if merged and x - merged[-1] < 6:
            merged[-1] = x
        else:
            merged.append(x)
    # 보표 시작선은 마디 경계가 아니다
    xs = [x for x in merged if x > st["x0"] + 8]
    # 너무 좁은 '마디'는 마디가 아니다 — 줄 앞의 반복 시작 기호(‖:) 같은 것.
    # 줄 안 다른 마디들에 비해 눈에 띄게 좁으면 그 경계를 버리고 옆 마디와 합친다.
    edges = [st["x0"]] + xs
    while len(edges) > 2:
        widths = [edges[k + 1] - edges[k] for k in range(len(edges) - 1)]
        med = sorted(widths)[len(widths) // 2]
        k = min(range(len(widths)), key=widths.__getitem__)
        if widths[k] >= max(3 * st["gap"], 0.3 * med):
            break
        del edges[k + 1 if k + 1 < len(edges) - 1 else k]
    return edges[1:]


def _boxed_texts(words, drawings, area) -> list[dict]:
    """네모 상자 안의 글자 = 구간 표시(Intro, A, Verse A …)."""
    ax0, ay0, ax1, ay1 = area
    # 상자를 사각형 하나로 그리는 악보도, 선 네 개로 그리는 악보도 있어서 그림 요소의
    # 테두리 크기로 본다. 안에 글자가 들어 있어야 하므로 음표·빔이 섞여도 걸러진다.
    boxes = []
    for d in drawings:
        r = d["rect"]
        if d.get("color") is not None and 8 < r.width < 160 and 8 < r.height < 30 \
                and r.x1 > ax0 and r.x0 < ax1 and r.y1 > ay0 and r.y0 < ay1:
            boxes.append(r)
    out = []
    for r in boxes:
        inside = [w for w in words if w[0] >= r.x0 - 1 and w[2] <= r.x1 + 1
                  and w[1] >= r.y0 - 1 and w[3] <= r.y1 + 1]
        if inside:
            inside.sort(key=lambda w: w[0])
            out.append({"text": " ".join(w[4] for w in inside), "x": r.x0, "y": r.y0})
    # 같은 상자가 두 번 그려지는 경우
    uniq, seen = [], set()
    for b in out:
        k = (b["text"], round(b["x"]), round(b["y"]))
        if k not in seen:
            seen.add(k)
            uniq.append(b)
    return uniq


def _tempo(words) -> Optional[float]:
    for i, w in enumerate(words):
        if w[4].endswith("=") or w[4] == "=":
            # 같은 줄 오른쪽의 첫 숫자
            right = sorted((x for x in words if abs(x[1] - w[1]) < 4 and x[0] > w[0]), key=lambda x: x[0])
            for x in right[:2]:
                m = re.match(r"^(\d{2,3}(?:\.\d+)?)", x[4])
                if m:
                    return float(m.group(1))
        m = re.match(r"^=\s*(\d{2,3})$", w[4])
        if m:
            return float(m.group(1))
    return None


def analyze(pdf_path: Path, out_dir: Path) -> dict:
    """PDF 를 분석해 페이지 이미지를 쓰고 구조를 돌려준다 (저장은 호출한 쪽에서)."""
    import pymupdf

    img_dir = out_dir / SCORE_DIR
    if img_dir.exists():
        shutil.rmtree(img_dir, ignore_errors=True)
    img_dir.mkdir(parents=True, exist_ok=True)

    doc = pymupdf.open(pdf_path)
    pages, measures, marks = [], [], []
    tempo: Optional[float] = None
    for pi, page in enumerate(doc):
        pix = page.get_pixmap(dpi=RENDER_DPI)
        name = f"page-{pi + 1}.png"
        pix.save(str(img_dir / name))
        W, H = page.rect.width, page.rect.height
        pages.append({"w": W, "h": H, "img": name})

        drawings = page.get_drawings()
        words = page.get_text("words")
        if tempo is None:
            tempo = _tempo(words)
        # 마디 번호 후보: 작은 글씨의 숫자. 페이지 번호(큰 글씨)와 템포 숫자(= 옆)는 뺀다.
        small = set()
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                for sp in ln.get("spans", []):
                    if sp["size"] <= 9.5 and _NUM.match(sp["text"].strip()):
                        small.add((round(sp["bbox"][0]), round(sp["bbox"][1])))
        eq_rows = [w[1] for w in words if "=" in w[4]]
        staves = find_staves(drawings)
        for si, st in enumerate(staves):
            # 잘라 보여줄 세로 범위: 위아래 이웃 보표와의 가운데까지
            prev_bot = staves[si - 1]["bot"] if si > 0 else None
            next_top = staves[si + 1]["top"] if si + 1 < len(staves) else None
            # 첫 줄 위에는 구간 표시와 템포가 함께 있어 더 넓게 본다
            room = (9 if si == 0 else 6) * st["gap"]
            y0 = (prev_bot + st["top"]) / 2 if prev_bot is not None else st["top"] - room
            y1 = (st["bot"] + next_top) / 2 if next_top is not None else st["bot"] + room
            y0 = max(0.0, min(y0, st["top"] - 2 * st["gap"]))
            y1 = min(H, max(y1, st["bot"] + 2 * st["gap"]))

            nums = [w for w in words if _NUM.match(w[4]) and st["top"] - 25 < w[3] <= st["top"] + 1
                    and w[0] < st["x0"] + 40
                    and any(abs(round(w[0]) - x) <= 1 and abs(round(w[1]) - y) <= 1 for x, y in small)
                    and not any(abs(w[1] - ey) < 4 for ey in eq_rows)]
            number = int(nums[0][4]) if nums else None
            bounds = find_barlines(drawings, st)
            first = len(measures)
            left = st["x0"]
            for x in bounds:
                measures.append({"page": pi, "system": si, "x0": left, "x1": x,
                                 "y0": y0, "y1": y1, "top": st["top"], "bot": st["bot"],
                                 "sys_x0": st["x0"], "sys_x1": st["x1"]})
                left = x
            if number is not None and first < len(measures):
                measures[first]["number"] = number

            # 이 줄 위의 구간 표시 → 그 x 에 걸치는(가장 가까운) 마디에 붙인다
            for b in _boxed_texts(words, drawings, (0, y0, W, st["top"])):
                cand = [k for k in range(first, len(measures))]
                if not cand:
                    continue
                k = min(cand, key=lambda k: 0 if measures[k]["x0"] - 30 <= b["x"] < measures[k]["x1"]
                        else abs(measures[k]["x0"] - b["x"]))
                marks.append({"measure": k + 1, "text": b["text"]})
    doc.close()

    # 마디 번호와 개수 맞추기: 줄 첫 마디 번호가 있으면 마디선 수가 맞는지 확인한다
    warnings = []
    for k, m in enumerate(measures):
        if "number" in m and m["number"] != k + 1:
            warnings.append(f"악보 {m['number']}마디가 {k + 1}번째로 세어졌습니다 (p{m['page'] + 1})")
            break
    for k, m in enumerate(measures):
        m["number"] = k + 1
        for key in ("x0", "x1", "y0", "y1", "top", "bot", "sys_x0", "sys_x1"):
            m[key] = round(m[key], 2)

    return {
        "version": 1,
        "pages": pages,
        "measures": measures,
        "marks": marks,
        "tempo": tempo,
        "warnings": warnings,
    }


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


def rebuild(out_dir: Path) -> dict:
    """score.pdf 를 다시 분석한다. 손으로 넣은 order 는 남긴다."""
    old = load(out_dir) or {}
    data = analyze(out_dir / SCORE_PDF, out_dir)
    if isinstance(old.get("order"), list):
        data["order"] = old["order"]
    save(out_dir, data)
    return data


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
