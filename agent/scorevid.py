"""연주 영상 → 악보 띠 + 음원 맞춤. 에이전트 도구가 부르는 결정적 처리.

- download: yt-dlp(최신·JS 런타임 node)로 1080p 영상+소리를 받는다. 클라이언트를 바꿔 가며 재시도.
- contact_sheet / frame: 에이전트가 화면 구성을 눈으로 보게 하는 그림
- suggest_bands: 악보 띠가 있을 법한 가로 영역(흰 바탕 + 5줄 보표) 후보
- extract_strips: 그 영역을 초당 4장 보며 악보가 바뀌는 순간마다 한 장씩. 진행 커서처럼 움직이는
  색 표시는 바뀜으로 치지 않고, 대표 그림은 구간의 중앙값이라 커서가 지워진다.
- audio_offset: 영상 소리와 곡 소리를 맞대어 '곡 시각 = 영상 시각 − offset'
- fit_grid: 곡 드럼에서 박 간격·위상
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import scorebuild as sb

CLIENTS = ["", "android", "tv", "web_safari", "ios", "mweb"]


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def probe(path: Path) -> dict:
    r = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    d = json.loads(r.stdout or "{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    num, den = (v.get("r_frame_rate") or "30/1").split("/")
    return {"duration": float(d.get("format", {}).get("duration") or 0), "w": int(v.get("width") or 0),
            "h": int(v.get("height") or 0), "fps": float(num) / float(den or 1), "audio": a is not None}


def _decodes(path: Path, at: float) -> bool:
    r = _run(["ffmpeg", "-v", "error", "-ss", f"{at:.2f}", "-i", str(path), "-frames:v", "1", "-f", "null", "-"])
    return r.returncode == 0 and "Invalid" not in r.stderr


def download(url: str, out_dir: Path, log=print) -> Path:
    """영상(1080p 이하)+소리를 하나로 받는다. 깨진 파일(조각만 받힘)이면 다음 클라이언트로."""
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = json.loads(_run(["yt-dlp", "-J", "--no-download", "--no-warnings", "--js-runtimes", "node", url]).stdout or "{}")
    want = float(meta.get("duration") or 0)
    last = ""
    for c in CLIENTS:
        for f in out_dir.glob("video.*"):
            f.unlink()
        cmd = ["yt-dlp", "-q", "--no-warnings", "--js-runtimes", "node", "--no-playlist",
               "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mkv",
               "-o", str(out_dir / "video.%(ext)s"), url]
        if c:
            cmd[1:1] = ["--extractor-args", f"youtube:player_client={c}"]
        r = _run(cmd, timeout=900)
        got = next(iter(sorted(out_dir.glob("video.*"))), None)
        if got and got.suffix != ".part":
            p = probe(got)
            ok = p["w"] > 0 and (not want or p["duration"] > want - 3) and _decodes(got, min(30, p["duration"] / 2))
            if ok:
                log(f"영상 받음 ({c or 'default'}): {p['w']}x{p['h']} {p['duration']:.0f}초")
                return got
            last = f"{c or 'default'}: 파일이 깨졌습니다"
        else:
            last = f"{c or 'default'}: {r.stderr.strip()[-200:]}"
        log(f"다운로드 재시도 — {last}")
    raise RuntimeError(f"영상을 받지 못했습니다 ({last})")


def frame(path: Path, t: float, box: Optional[list[int]] = None, width: Optional[int] = None) -> Image.Image:
    vf = []
    if box:
        x0, y0, x1, y1 = box
        vf.append(f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0}")
    if width:
        vf.append(f"scale={width}:-2")
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1"]
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd += ["-f", "image2pipe", "-vcodec", "png", "-"]
    r = subprocess.run(cmd, capture_output=True)
    from io import BytesIO
    return Image.open(BytesIO(r.stdout)).convert("RGB")


def _font(size: int):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()


def contact_sheet(path: Path, times: list[float], cols: int = 4, width: int = 480) -> Image.Image:
    """시각이 적힌 축소 그림 묶음 — 화면 구성(악보 위치·자막·커서)을 한눈에 보게."""
    ims = [frame(path, t, width=width) for t in times]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows * h), "white")
    d = ImageDraw.Draw(sheet)
    f = _font(22)
    for i, (t, im) in enumerate(zip(times, ims)):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im, (x, y))
        d.rectangle([x, y, x + 92, y + 28], fill="black")
        d.text((x + 4, y + 2), f"{t:6.1f}s", fill="yellow", font=f)
    return sheet


def suggest_bands(path: Path, n: int = 24) -> list[dict]:
    """악보 띠 후보: 여러 장면에서 5줄 보표가 잡히는 가로 영역. 위·아래 여유를 붙여 돌려준다."""
    p = probe(path)
    times = np.linspace(p["duration"] * 0.1, p["duration"] * 0.9, n)
    hits: list[tuple[int, int]] = []
    for t in times:
        a = np.asarray(frame(path, float(t)))
        for st in sb.find_staves(sb.ink_mask(a), sb.paper_mask(a)):
            if st["x1"] - st["x0"] > 0.4 * a.shape[1]:
                hits.append((st["top"], st["bot"]))
    if not hits:
        return []
    # 비슷한 높이끼리 묶는다
    hits.sort()
    groups: list[list[tuple[int, int]]] = []
    for h in hits:
        if groups and abs(h[0] - groups[-1][-1][0]) < 60:
            groups[-1].append(h)
        else:
            groups.append([h])
    out = []
    for g in sorted(groups, key=len, reverse=True):
        top = int(np.median([x[0] for x in g]))
        bot = int(np.median([x[1] for x in g]))
        gap = (bot - top) / 4
        y0 = max(0, int(top - 7 * gap))
        y1 = min(p["h"], int(bot + 5.5 * gap))
        out.append({"box": [0, y0, p["w"], y1], "frames": len(g), "staff_top": top, "staff_bot": bot})
    return out


def _frames(path: Path, box: list[int], fps: float):
    """box 영역을 fps 로 하나씩 (시각, RGB 배열)"""
    x0, y0, x1, y1 = box
    # 크기가 홀수면 ffmpeg 가 짝수로 맞춰 버려 한 장씩 읽을 때 줄이 밀린다 (한 장마다 1줄씩 내려감)
    w, h = (x1 - x0) & ~1, (y1 - y0) & ~1
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={fps},crop={w}:{h}:{x0}:{y0}",
                             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    size = w * h * 3
    i = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        proc.stdout.close()
        proc.wait()


def _small(rgb) -> np.ndarray:
    """바뀜 비교용: 종이 줄(흰 바탕이 절반 넘는 가로줄)의 잉크만, 2×2 로 줄여서.
    띠 위아래로 비치는 영상(연주자)은 매 장면 바뀌므로 빼야 한다."""
    a = rgb.astype(np.int16)
    mx, mn = a.max(axis=2), a.min(axis=2)
    # 아주 검은 것(음표 머리·기둥·빔)만 — 얇은 회색 보표선은 압축 때문에 장면마다 깜빡인다
    ink = (mx < 100) & ((mx - mn) < 60)
    rows = sb.paper_mask(rgb).mean(axis=1) > 0.5
    ink = ink & rows[:, None]
    h, w = ink.shape
    return ink[: h - h % 4, : w - w % 4].reshape(h // 4, 4, w // 4, 4).any(axis=(1, 3))


def _diff(a, b) -> float:
    return float((a ^ b).sum()) / max(1.0, float(max(a.sum(), b.sum())))


def extract_strips(path: Path, box: list[int], out_dir: Path, fps: float = 4.0,
                   change: float = 0.4, min_hold: float = 0.6, log=print) -> list[dict]:
    """악보가 바뀌는 순간마다 띠 하나. 대표 그림 = 그 구간 그림들의 중앙값(움직이는 커서가 지워진다).
    돌려주는 값: [{img, t0, t1, staves…}] (보표가 없는 장면은 뺀다)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("strip-*.png"):
        f.unlink()
    segs: list[dict] = []
    cur: Optional[dict] = None

    def close(seg: dict, t_end: float):
        seg["t1"] = t_end
        if t_end - seg["t0"] < min_hold:
            return
        fr = seg["frames"]
        pick = [fr[i] for i in np.linspace(0, len(fr) - 1, min(len(fr), 9)).round().astype(int)]
        rep = np.median(np.stack(pick), axis=0).astype(np.uint8)
        segs.append({"t0": round(seg["t0"], 2), "t1": round(t_end, 2), "rgb": rep})

    t = 0.0
    for t, a in _frames(path, box, fps):
        sm = _small(a)
        if cur is None:
            cur = {"t0": t, "ref": sm, "frames": [a]}
            continue
        # 바로 앞 장면과 비교한다 (커서·압축 잡음은 0.1~0.3, 쪽 넘김은 0.45 이상)
        d = _diff(sm, cur["ref"])
        cur["ref"] = sm
        if d > change:
            close(cur, t)
            cur = {"t0": t, "ref": sm, "frames": [a]}
        else:
            if len(cur["frames"]) < 64:
                cur["frames"].append(a)
            elif len(cur["frames"]) % 2 == 0:
                cur["frames"] = cur["frames"][::2]
                cur["frames"].append(a)
    if cur is not None:
        close(cur, t + 1 / fps)

    strips: list[dict] = []
    no_staff = 0
    for s in segs:
        info = sb.analyze_strip(s["rgb"])
        if not info["staves"]:
            no_staff += 1
            continue
        # 앞 띠와 같은 그림이면(전환 중 깜빡임으로 쪼개진 것) 합친다
        if strips:
            prev = strips[-1]
            a = _small(s["rgb"])
            b = _small(prev["_rgb"])
            if a.shape == b.shape and _diff(a, b) < 0.3:
                prev["t1"] = s["t1"]
                continue
        strips.append({"t0": s["t0"], "t1": s["t1"], "_rgb": s["rgb"], **info})
    for i, s in enumerate(strips):
        name = f"strip-{i:03d}.png"
        Image.fromarray(s.pop("_rgb")).save(out_dir / name)
        s["img"] = name
        s["marks"] = []
        s["repeat"] = 1
    log(f"장면 {len(segs)}개 중 보표 없는 장면 {no_staff}개 → 악보 띠 {len(strips)}개 · "
        f"마디 {sum(sb.measures_of(s) for s in strips)}개")
    return strips


def strips_sheet(src: Path, strips: list[dict], start: int = 0, count: int = 8, width: int = 1400) -> Image.Image:
    """띠 확인용: 찾은 보표·마디선·마디 번호를 그려 넣은 띠들을 위아래로."""
    first = 1
    for s in strips[:start]:
        first += sb.measures_of(s) * max(1, s.get("repeat", 1))
    ims = []
    for i, s in enumerate(strips[start:start + count]):
        rgb = np.asarray(Image.open(src / s["img"]).convert("RGB"))
        im = sb.overlay(rgb, s, first)
        first += sb.measures_of(s) * max(1, s.get("repeat", 1))
        d = ImageDraw.Draw(im)
        tag = f"#{start + i}  {s['t0']:.1f}-{s['t1']:.1f}s" + (f"  x{s['repeat']}" if s.get("repeat", 1) > 1 else "")
        d.rectangle([0, 0, 330, 30], fill="black")
        d.text((4, 3), tag, fill="yellow", font=_font(22))
        ims.append(im.resize((width, int(im.size[1] * width / im.size[0]))))
    if not ims:
        return Image.new("RGB", (width, 40), "white")
    sheet = Image.new("RGB", (width, sum(i.size[1] + 6 for i in ims)), (90, 90, 90))
    y = 0
    for im in ims:
        sheet.paste(im, (0, y))
        y += im.size[1] + 6
    return sheet


# ---------------------------------------------------------------- 소리

SR = 11025
HOP = 110          # ≈ 10ms


def load_mono(path: Path, sr: int = SR) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, np.float32).copy()


def _stft_mag(y: np.ndarray, hop: int, n: int) -> np.ndarray:
    if len(y) < n:
        return np.zeros((1, n // 2 + 1))
    frames = np.lib.stride_tricks.sliding_window_view(y, n)[::hop]
    return np.abs(np.fft.rfft(frames * np.hanning(n), axis=1))


# 스펙트럼 플럭스는 소리가 창에 '들어오는' 순간 커진다 — 창 시작 시각으로 적으면 실제보다
# 70ms 쯤 이르다(うさぎラップ 드럼 첫 타격 실측). 창 길이의 0.7 만큼 뒤로 적는다.
ONSET_LAG = 0.7 * 1024 / SR


def onset_env(y: np.ndarray, hop: int = HOP, n: int = 1024) -> np.ndarray:
    """간단한 스펙트럼 플럭스 (10ms 단위). env[i] 의 시각 = i*hop/SR + ONSET_LAG"""
    spec = np.log1p(_stft_mag(y, hop, n) * 10)
    flux = np.maximum(0, np.diff(spec, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(50) / 50, mode="same")
    return np.maximum(flux, 0) / (flux.std() + 1e-9)


def chroma(y: np.ndarray, hop: int = 1102, n: int = 4096) -> np.ndarray:
    """음 높이 12칸 (100ms 단위). 코드·멜로디 흐름 — 타격과 달리 마디마다 되풀이되지 않아
    소리를 맞댈 때 한 마디 어긋난 자리에 붙지 않는다."""
    mag = _stft_mag(y, hop, n)
    f = np.fft.rfftfreq(n, 1 / SR)
    ok = (f > 55) & (f < 2000)
    pc = (np.round(12 * np.log2(f[ok] / 440.0)) % 12).astype(int)
    out = np.zeros((mag.shape[0], 12))
    for k in range(12):
        out[:, k] = mag[:, ok][:, pc == k].sum(axis=1)
    out = np.log1p(out)
    out -= out.mean(axis=1, keepdims=True)
    out /= np.linalg.norm(out, axis=1, keepdims=True) + 1e-9
    return out


def _xcorr(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, int]:
    """a 와 b 의 상호상관 (여러 열이면 열마다 더함). 돌려주는 lag: a[t] ≈ b[t - lag]"""
    if a.ndim == 1:
        a, b = a[:, None], b[:, None]
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    acc = np.zeros(n)
    for k in range(a.shape[1]):
        acc += np.fft.irfft(np.fft.rfft(a[:, k], n) * np.conj(np.fft.rfft(b[:, k], n)), n)
    return acc, n


def mix_tracks(paths: list[Path], out: Path) -> Path:
    """원곡 트랙이 없을 때 스템들을 더해 원곡 대신 쓴다."""
    if out.exists():
        return out
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for p in paths:
        cmd += ["-i", str(p)]
    cmd += ["-filter_complex", f"amix=inputs={len(paths)}:normalize=0", "-ac", "1", "-ar", str(SR), str(out)]
    subprocess.run(cmd, check=True)
    return out


def audio_offset(video: Path, song: Path) -> dict:
    """'곡 시각 = 영상 시각 − offset'. 연주 영상은 원곡 반주에 맞춰 치므로 소리를 맞대면 정확하다.
    1) 음 높이 흐름(크로마)으로 대략(±0.1초) — 마디 단위로 헷갈리지 않는다
    2) 그 근처 ±0.15초에서 타격(플럭스)으로 10ms 단위까지."""
    ya, yb = load_mono(video), load_mono(song)
    if len(ya) < SR or len(yb) < SR:
        raise ValueError("소리가 없습니다 (영상에 소리 트랙이 없거나 곡 파일이 비었습니다)")
    ca, cb = chroma(ya), chroma(yb)
    xc, n = _xcorr(ca, cb)
    lag = int(np.argmax(xc))
    peak = xc[lag]
    z = float((peak - xc.mean()) / (xc.std() + 1e-9))
    # 두 번째 봉우리(1초 이상 떨어진 곳)와의 비
    mask = np.ones(n, bool)
    for k in range(-10, 11):
        mask[(lag + k) % n] = False
    ratio = float(peak / max(xc[mask].max(), 1e-9))
    if lag > n // 2:
        lag -= n
    coarse = lag * 1102 / SR
    # 세밀하게: 타격
    ea, eb = onset_env(ya), onset_env(yb)
    xo, no = _xcorr(ea, eb)
    c = int(round(coarse * SR / HOP))
    w = int(round(0.15 * SR / HOP))
    cand = [(xo[(c + k) % no], c + k) for k in range(-w, w + 1)]
    fine = max(cand)[1] * HOP / SR
    return {"offset": round(fine, 3), "coarse": round(coarse, 2), "z": round(z, 1), "ratio": round(ratio, 2)}


def fit_grid(song_drums: Path, bpm_hint: float, span: float = 3.0) -> dict:
    """곡 드럼에서 박 간격(bpm)과 위상(첫 박 위치). 8분 격자에서 타격 세기 평균이 가장 큰 값을 찾고,
    정박/엇박(반 박 차이)은 4분 격자 세기로 가린다 — 킥·스네어는 정박에 몰려 있다."""
    env = onset_env(load_mono(song_drums))
    t = np.arange(len(env)) * HOP / SR + ONSET_LAG
    dur = t[-1]
    best = (-1.0, bpm_hint, 0.0)
    for bpm in np.arange(bpm_hint - span, bpm_hint + span + 1e-9, 0.02):
        beat = 60 / bpm
        for ph in np.arange(0, beat / 2, 0.004):
            g = np.arange(ph, dur, beat / 2)
            sc = float(np.interp(g, t, env).mean())
            if sc > best[0]:
                best = (sc, float(bpm), float(ph))
    sc, bpm, ph = best
    beat = 60 / bpm
    q0 = float(np.interp(np.arange(ph, dur, beat), t, env).mean())
    q1 = float(np.interp(np.arange(ph + beat / 2, dur, beat), t, env).mean())
    if q1 > q0:
        ph += beat / 2
    first_hit = float(t[np.argmax(env > 2.5)]) if (env > 2.5).any() else 0.0
    first_beat = ph + max(0, round((first_hit - ph) / beat)) * beat
    return {"bpm": round(bpm, 2), "phase": round(ph, 4), "beat": round(beat, 5),
            "first_hit": round(first_hit, 3), "first_beat_at_hit": round(first_beat, 4), "score": round(sc, 3),
            "onbeat_vs_offbeat": round(max(q0, q1) / max(min(q0, q1), 1e-9), 2)}


def estimate_anchor(strips: list[dict], offset: float, grid: dict, beats_per_measure: list[float]) -> dict:
    """띠가 나타난 시각(영상) → 곡 시각, 띠 첫 마디 앞의 박 수로 1마디 1박을 역산해 격자에 붙인다.
    beats_per_measure: 연주 순서 마디마다 박 수(♩ 기준)."""
    beat = grid["beat"]
    est = []
    m = 0
    cum = np.concatenate([[0], np.cumsum(beats_per_measure)])
    for s in strips:
        for _ in range(max(1, s.get("repeat", 1))):
            if m < len(cum) - 1:
                song_t = s["t0"] - offset
                est.append(song_t - cum[m] * beat)
            m += sb.measures_of(s)
    if not est:
        return {}
    a = float(np.median(est))
    n = round((a - grid["phase"]) / beat)
    anchor = grid["phase"] + n * beat
    lead = [round(e - anchor, 3) for e in est]      # 음수 = 띠가 마디보다 먼저 바뀜
    return {"anchor": round(anchor, 4), "raw_median": round(a, 3), "strip_lead_sec": lead}


# ---------------------------------------------------------------- 받아 적은 음표 ↔ 드럼 소리 대조

BANDS = {"bd": (30, 140), "sn": (150, 400), "hh": (6000, 11000)}


def drum_onsets(path: Path) -> dict[str, np.ndarray]:
    """드럼 스템에서 대역별 타격 시각 (킥 = 저음, 스네어 = 중저음 몸통, 하이햇 = 고음)."""
    sr = 22050
    y = load_mono(path, sr)
    hop, n = 220, 1024
    mag = _stft_mag(y, hop, n)
    f = np.fft.rfftfreq(n, 1 / sr)
    out = {}
    for k, (lo, hi) in BANDS.items():
        band = np.log1p(mag[:, (f >= lo) & (f < hi)].sum(axis=1) * 10)
        flux = np.maximum(0, np.diff(band, prepend=band[0]))
        thr = np.percentile(flux, 92)
        peaks = []
        last = -1e9
        for i in range(1, len(flux) - 1):
            if flux[i] > thr and flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]:
                t = i * hop / sr + 0.7 * n / sr
                if t - last > 0.06:
                    peaks.append(t)
                    last = t
        out[k] = np.array(peaks)
    return out


def check_measure(hits: list[tuple[float, str]], start: float, end: float, onsets: dict[str, np.ndarray],
                  tol: float = 0.045) -> dict:
    """한 마디: 악보의 킥·스네어 타격(초)과 소리의 타격을 맞춰 본다.
    돌려주는 값: 악기마다 {악보, 맞음, 소리에만 있음}."""
    res = {}
    for k in ("bd", "sn"):
        want = [t for t, lane in hits if lane == k]
        got = [t for t in onsets[k] if start - tol <= t < end - tol]
        matched = sum(1 for t in want if any(abs(t - g) <= tol for g in got))
        extra = sum(1 for g in got if not any(abs(t - g) <= tol for t in want))
        res[k] = {"score": len(want), "hit": matched, "extra": extra}
    return res
