"""악보 띠(스트립) 프로젝트 → 벡터 PDF.

연주 영상에서 잘라 낸 악보 띠 그림들을 위아래로 이어 붙여 PDF 를 만든다. 그림만 있는 PDF 는
scores.py 가 마디를 못 찾으므로(스캔본과 같다), 그림 위에 **보이지 않는** 보표 가로줄·마디선·
마디 번호·구간 상자·템포 글자를 겹쳐 넣는다. 그러면 scores.analyze 가 MuseScore PDF 처럼 읽는다.

프로젝트는 곡 폴더의 _score_src/ 에 둔다 (AI 가 만들고, 송 맵의 악보 편집이 고친다):

    _score_src/project.json
    _score_src/strip-000.png …

project.json:
    {"version": 1, "source": "https://youtube…", "tempo": 150,
     "strips": [{"img": "strip-000.png", "t0": 12.3, "t1": 19.1,
                 "staves": [{"top": 98, "bot": 152, "gap": 13.5, "x0": 60, "x1": 1880,
                             "lines": [98, 111.5, …], "bars": [430, 820, 1210, 1600]}],
                 "marks": [{"measure": 0, "text": "Aメロ"}],   # 이 띠 안 마디 번호(0부터)
                 "repeat": 1}]}                                # 같은 띠가 연달아 몇 번 나오나

여기 함수들은 numpy·Pillow·pymupdf 만 쓴다 (api·agent 컨테이너 둘 다에서 돈다).
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Optional

SRC_DIR = "_score_src"
PROJECT = "project.json"
# PDF 에 놓을 때 그림 1px = SCALE pt. 1080p 영상의 보표 줄 간격(12~15px)이 5~6pt 가 되게.
SCALE = 0.4


# ---------------------------------------------------------------- 그림 분석

def ink_mask(rgb):
    """검은·회색 잉크(악보 글씨·보표)만. 색이 있는 것(진행 커서·강조 상자·컬러 자막)은 뺀다.
    영상의 보표 가로줄은 얇아서 회색(밝기 130~160)으로 뭉개지므로 160 까지 본다."""
    import numpy as np
    a = rgb.astype(np.int16)
    mx, mn = a.max(axis=2), a.min(axis=2)
    return (mx < 160) & ((mx - mn) < 60)


def paper_mask(rgb):
    """흰 종이(악보 바탕)."""
    import numpy as np
    return rgb.min(axis=2) > 200


def _group_rows(rows) -> list[list[int]]:
    out: list[list[int]] = []
    for r in rows:
        if out and r - out[-1][-1] <= 1:
            out[-1].append(int(r))
        else:
            out.append([int(r)])
    return out


def find_staves(ink, paper=None) -> list[dict]:
    """5줄 보표들을 찾는다. 가로로 길게 이어진 잉크 줄 다섯 개가 고른 간격이고, 줄 사이가
    흰 종이면 보표 (영상의 어두운 배경 줄무늬를 보표로 착각하지 않게)."""
    import numpy as np
    H, W = ink.shape
    frac = ink.mean(axis=1)
    # 보표 가로줄은 폭의 대부분(영상에서 0.85 이상)을 덮는다. 빔·음표가 몰린 줄(0.3~0.45)은 빼고,
    # 두꺼운 덩어리(영상의 어두운 배경)도 뺀다
    rows = np.where(frac > 0.5)[0]
    groups = [g for g in _group_rows(rows) if len(g) <= 5]
    ys = [float(np.mean(g)) for g in groups]
    staves = []
    i = 0
    while i + 4 < len(ys):
        five = ys[i:i + 5]
        gaps = np.diff(five)
        if gaps.min() > 4 and gaps.max() < 40 and gaps.max() - gaps.min() < max(2.0, 0.15 * gaps.mean()):
            top_g, bot_g = groups[i], groups[i + 4]
            # 가로줄의 실제 범위: 다섯 줄 중 셋 이상에 잉크가 있는 열 (줄 하나만 보면 음표 머리·흐린 선 때문에
            # 끊긴 조각을 범위로 잡는다 — 라시사 띠가 447~679px 로 잡혀 마디선을 전부 놓쳤다)
            rows5 = [int(round(y)) for y in five]
            on = np.zeros(W, int)
            for y in rows5:
                on += ink[max(0, y - 1):y + 2].any(axis=0)
            cols = np.where(on >= 3)[0]
            if len(cols):
                splits = np.where(np.diff(cols) > 8)[0]
                segs = np.split(cols, splits + 1)
                seg = max(segs, key=len)
                x0, x1 = int(seg[0]), int(seg[-1])
            else:
                x0, x1 = 0, W - 1
            if paper is not None:
                mids = [int(round((five[j] + five[j + 1]) / 2)) for j in range(4)]
                # 네 칸 중 둘 이상이 흰 종이면 보표 — 한 칸이 음표로 꽉 찰 수 있다 (라시사의 스네어 16분 필인)
                if sorted(paper[m, x0:x1 + 1].mean() for m in mids)[2] < 0.5:
                    i += 1
                    continue
            staves.append({"top": int(min(top_g)), "bot": int(max(bot_g)), "gap": float(gaps.mean()),
                           "x0": x0, "x1": x1, "lines": [round(y, 1) for y in five]})
            i += 5
        else:
            i += 1
    return staves


def find_barlines(ink, st: dict) -> list[int]:
    """보표 맨 윗줄~맨 아랫줄을 꼭 맞게 잇는 세로선 = 마디선.
    음표 기둥은 보표 밖으로 한 칸 넘게 이어지고, 음자리표(‖)는 가운데만 있어 걸러진다.
    바로 위를 지나는 붙임줄·숫자는 떨어져 있으므로 '이어진 길이'만 본다."""
    import numpy as np
    top, bot, g = st["top"], st["bot"], st["gap"]
    H = ink.shape[0]
    # 영상에서는 1px 마디선이 두 열에 걸쳐 회색으로 번진다 — 옆 열과 합쳐 보고, 한두 점 빠져도 봐준다
    ink = ink.copy()
    ink[:, :-1] |= ink[:, 1:]
    full = ink[top:bot + 1].mean(axis=0) >= 0.93
    lim = int(round(0.7 * g))

    def ext(x: int, start: int, step: int) -> int:
        n, y = 0, start
        while 0 <= y < H and n <= lim and ink[y, x]:
            n += 1
            y += step
        return n

    W = ink.shape[1]
    side = max(4, int(round(0.8 * g)))
    probe_rows = [int(round(top + 0.5 * g)), int(round(bot - 0.5 * g)),
                  int(round(top - 0.5 * g)), int(round(bot + 0.5 * g))]

    def bare(x: int) -> bool:
        """음표 기둥은 끝에 음표 머리가 붙어 있다 — 마디선은 맨 윗칸·맨 아랫칸·바로 바깥 칸에서
        양옆이 비어 있다."""
        for r in probe_rows:
            if not 0 <= r < H:
                continue
            # 겹세로줄·끝세로줄(가는 줄 + 굵은 줄)의 옆 줄은 음표 머리가 아니다 — 세로줄 열은 빼고 본다
            row = ink[r] & ~full
            l = row[max(0, x - side):max(0, x - 2)]
            rr = row[min(W, x + 3):min(W, x + side + 1)]
            if (l.size and l.mean() > 0.3) or (rr.size and rr.mean() > 0.3):
                return False
        return True

    xs = [int(x) for x in np.where(full)[0]
          if ext(int(x), top - 1, -1) <= lim and ext(int(x), bot + 1, 1) <= lim and bare(int(x))]
    bars: list[list[int]] = []
    for x in xs:
        if bars and x - bars[-1][-1] <= max(3, int(g)):
            bars[-1].append(x)
        else:
            bars.append([x])
    out = [b[-1] for b in bars if b[-1] > st["x0"] + 1.5 * g]
    # 너무 좁은 '마디'는 마디가 아니다 — 줄 첫머리의 반복 시작(‖:)·음자리표, 겹세로줄 사이.
    # 첫 마디면 그 선을 지우고(뒤 마디에 합침), 중간이면 앞 선을 지운다.
    edges = [st["x0"]] + out
    k = 1
    while k < len(edges):
        # 줄 첫머리는 음자리표 + ‖: 가 3~4칸을 차지한다 (역광 실측 3.8칸) — 첫 마디만 기준을 넉넉히
        if edges[k] - edges[k - 1] < (4.5 if k == 1 else 3) * g:
            del edges[k if k == 1 else k - 1]
        else:
            k += 1
    out = edges[1:]
    # 줄 끝에 마디선이 없으면(그림 가장자리에서 잘림) 보표 끝을 마디 끝으로 본다
    if not out or st["x1"] - out[-1] > 3 * g:
        out.append(st["x1"])
    return out


def analyze_strip(rgb) -> dict:
    import numpy as np
    # 보표·마디선은 얇아서 회색으로 뭉개진다 — 밝기 200 미만의 무채색까지 잉크로 본다
    a = rgb.astype(np.int16)
    mx, mn = a.max(axis=2), a.min(axis=2)
    ink = (mx < 200) & ((mx - mn) < 50)
    staves = find_staves(ink, paper_mask(rgb))
    for st in staves:
        st["bars"] = find_barlines(ink, st)
    return {"staves": staves, "w": int(rgb.shape[1]), "h": int(rgb.shape[0])}


def measures_of(strip: dict) -> int:
    return sum(len(st.get("bars", [])) for st in strip.get("staves", []))


# ---------------------------------------------------------------- 프로젝트

def load_project(song_dir: Path) -> Optional[dict]:
    try:
        return json.loads((song_dir / SRC_DIR / PROJECT).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_project(song_dir: Path, proj: dict) -> None:
    d = song_dir / SRC_DIR
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (PROJECT + ".tmp")
    tmp.write_text(json.dumps(proj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, d / PROJECT)


def expanded(proj: dict) -> list[dict]:
    """repeat 를 펼친 연주 순서의 띠들 (같은 띠가 연달아 여러 번 나오는 경우)."""
    out = []
    for s in proj.get("strips", []):
        if s.get("skip"):
            continue
        for _ in range(max(1, int(s.get("repeat", 1)))):
            out.append(s)
    return out


def total_measures(proj: dict) -> int:
    return sum(measures_of(s) for s in expanded(proj))


# ---------------------------------------------------------------- PDF

def build_pdf(src_dir: Path, proj: dict, out_pdf: Path, title: str = "") -> dict:
    """프로젝트 → PDF. 쪽마다 띠를 위에서부터 쌓는다. 돌려주는 값: {pages, measures}"""
    import pymupdf
    from PIL import Image

    strips = expanded(proj)
    if not strips:
        raise ValueError("띠가 없습니다")
    W_px = max(Image.open(src_dir / s["img"]).size[0] for s in strips)
    page_w = W_px * SCALE
    page_h = page_w * 1.414          # A4 비율
    margin_top, gap_y = 46.0, 10.0

    doc = pymupdf.open()
    page = None
    y = 0.0
    bar_no = 1
    tempo_done = False
    for si, s in enumerate(strips):
        img_path = src_dir / s["img"]
        w_px, h_px = Image.open(img_path).size
        h = h_px * SCALE
        if page is None or y + h > page_h - 20:
            page = doc.new_page(width=page_w, height=page_h)
            y = margin_top
            if not doc.page_count - 1 and title:
                # 제목은 보이게 (첫 쪽 위)
                page.insert_text((page_w / 2 - len(title) * 6, 28), title, fontsize=14, fontname=_font_for(title))
        oy = y
        page.insert_image(pymupdf.Rect(0, oy, w_px * SCALE, oy + h), filename=str(img_path))
        sh = page.new_shape()
        for st in s.get("staves", []):
            for ly in st["lines"]:
                sh.draw_line((st["x0"] * SCALE, oy + ly * SCALE), (st["x1"] * SCALE, oy + ly * SCALE))
            for bx in st.get("bars", []):
                sh.draw_line((bx * SCALE, oy + st["top"] * SCALE), (bx * SCALE, oy + st["bot"] * SCALE))
        sh.finish(color=(0, 0, 0), width=0.3, stroke_opacity=0)
        sh.commit()
        # 마디 번호·구간 상자·템포: 안 보이는 글자 (render_mode=3)
        first_in_strip = bar_no
        k = 0
        for st in s.get("staves", []):
            top = oy + st["top"] * SCALE
            page.insert_text((st["x0"] * SCALE, top - 2), str(bar_no + 0), fontsize=7, render_mode=3)
            left = st["x0"]
            for bx in st.get("bars", []):
                for mk in s.get("marks", []):
                    if mk.get("measure") == k and mk.get("text"):
                        bx0 = left * SCALE + 2
                        rect = pymupdf.Rect(bx0, top - 3.2 * st["gap"] * SCALE - 12, bx0 + 8 + 6 * len(mk["text"]), top - 3.2 * st["gap"] * SCALE)
                        b = page.new_shape()
                        b.draw_rect(rect)
                        b.finish(color=(0, 0, 0), width=0.5, stroke_opacity=0)
                        b.commit()
                        page.insert_text((rect.x0 + 2, rect.y1 - 3), mk["text"], fontsize=8, render_mode=3,
                                         fontname=_font_for(mk["text"]))
                left = bx
                k += 1
                bar_no += 1
        if not tempo_done and proj.get("tempo"):
            page.insert_text((80, margin_top - 8), f"= {proj['tempo']:g}", fontsize=11, render_mode=3)
            tempo_done = True
        y = oy + h + gap_y
        s.setdefault("_first", first_in_strip)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_pdf.with_suffix(".pdf.tmp")
    # 띠 그림은 압축 없이 들어간다 — 1080p 띠 23개면 36MB 라 서버 한도(30MB)를 넘었다 (압축하면 2.5MB)
    doc.save(str(tmp), deflate=True, garbage=3)
    pages = doc.page_count
    doc.close()
    os.replace(tmp, out_pdf)
    return {"pages": pages, "measures": bar_no - 1}


def _font_for(text: str) -> str:
    """pymupdf 내장 글꼴: 한글은 korea, 그 밖의 한중일 글자는 japan, 나머지는 helv."""
    if any("가" <= c <= "힣" or "ㄱ" <= c <= "ㆎ" for c in text):
        return "korea"
    return "helv" if text.isascii() else "japan"


def strip_png_bytes(rgb) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "PNG")
    return buf.getvalue()


def overlay(rgb, strip: dict, first_bar: int = 1):
    """확인용 그림: 찾은 보표(파랑)·마디선(빨강)·마디 번호를 그려 넣는다."""
    from PIL import Image, ImageDraw
    im = Image.fromarray(rgb).convert("RGB")
    d = ImageDraw.Draw(im)
    n = first_bar
    for st in strip.get("staves", []):
        for ly in st["lines"]:
            d.line([(st["x0"], ly), (st["x1"], ly)], fill=(60, 120, 255), width=1)
        left = st["x0"]
        for bx in st.get("bars", []):
            d.line([(bx, st["top"] - 8), (bx, st["bot"] + 8)], fill=(230, 30, 30), width=3)
            d.text((left + 4, st["bot"] + 4), str(n), fill=(230, 30, 30))
            left = bx
            n += 1
    return im

