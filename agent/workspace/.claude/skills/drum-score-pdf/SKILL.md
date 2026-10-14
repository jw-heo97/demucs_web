---
name: drum-score-pdf
description: 곡에 이미 붙어 있는 드럼 악보 PDF(MuseScore 등에서 내보낸 것, 글자가 그림으로 바뀐 PDF 포함)로 음표 악보(마디별 악기 칸)를 받아 적고, 구간 이름·박자·템포를 읽어 곡 음원에 맞춘 송 맵 새 버전을 저장한다. PDF 는 바꾸지 않는다. score 도구(get_job, pdf_overview, set_sections, audio_grid, set_timing, measure_images, write_measures, check_measures, refine_timing, save_result, report)와 함께 쓴다.
---

# 악보 PDF → 음표 악보 + 송 맵

앱은 PDF 를 이미 분석해 두었다 — 마디마다 쪽·줄·좌우 범위를 안다(벡터 PDF 의 보표선·마디선으로). 그래서 영상과 달리
마디를 찾는 일은 없다. 네 일은 **그림을 읽는 것**이다: 구간 이름, 템포, 박자, 그리고 음표.

글자를 그림(윤곽선)으로 바꿔 저장한 PDF(Windows 'Microsoft Print to PDF')는 분석기가 글자를 못 읽는다 — 구간이
'구간1, 구간2 …' 로, 템포가 없음으로 나온다. 그림으로는 또렷이 보이니 네가 읽어서 채운다. 이게 이 방식의 큰 몫이다.

## 순서

1. **get_job** — 곡 길이·검출 BPM·지금 송 맵(사용자가 손으로 맞춘 것일 수 있다).

2. **pdf_overview** — 쪽마다 앱이 찾은 마디(빨간 상자 + 음원 마디 번호)를 본다. 3쪽 넘으면 page 로 나머지도 본다.
   - 상자가 마디와 맞는지 (두 마디 반복 `𝄎` 은 두 마디, 끝세로줄 뒤에는 마디 없음)
   - **구간 상자 글자**(Intro1, A, Verse, サビ …)를 그 상자가 붙은 마디 번호와 함께 읽는다
   - **템포**: 첫 줄 위 `♩ = 138`
   - **박자표**: 첫머리 `4/4`, 중간에 바뀌는 곳
   - **못갖춘마디**: 첫 마디가 2박뿐(2분쉼표 하나, 필인 2박)이면 2/4
   마디 상자가 틀렸으면(마디선을 놓치거나 더 찾음) 이 방식으로는 고칠 수 없다 — report 에 적고 끝낸다.

3. **set_sections({마디: 이름})** — 읽은 구간 이름. 분석기가 이미 글자로 읽은 곳(구간N 이 아닌 것)은 그대로 둬도 되지만
   한꺼번에 다시 넣어도 된다. 반복으로 펼친 악보면 음원 마디 번호로.

4. **audio_grid(bpm)** — 악보 템포로. 곡 드럼에서 잰 BPM·첫 타격이 나온다. 1마디 1박 후보:
   - `first_beat_at_hit` (곡의 첫 타격 박). 첫 마디가 쉼표·못갖춘마디면 그 길이만큼 앞이다.
   - `current_map.anchor` (사용자가 지금 쓰는 값 — 손으로 맞춘 것일 수 있다)
   BPM 은 grid.bpm 이 악보 템포와 0.5 넘게 다르면 grid.bpm 을 쓴다.

5. **set_timing(anchor, bpm, beats)** 후 음표 받아 적기 — drum-score-video 스킬의 [transcribe.md](../drum-score-video/transcribe.md)
   를 읽고 그대로 따른다 (형식·보표 자리표·박 세는 법). measure_images 는 PDF 에서 200dpi 로 잘라 선명하다.
   - `%` (한 마디 반복)은 `"simile": true` + 앞 마디 내용, `𝄎` (두 마디 반복)은 두 마디 앞 내용 두 마디.
   - 반복 기호(‖: :‖)로 펼친 악보는 같은 악보 마디를 한 번만 적으면 다시 나오는 자리는 자동으로 채워진다.
   - 쉼표만 있는 마디는 lanes `{}`.

6. **refine_timing(anchor, bpm, beats)** — 받아 적은 킥·스네어로 1마디 1박을 한 박 단위로 검산. 10%p 넘게 나은 자리가
   있으면 그 값을 쓴다 (save_result 가 거절한다).

7. **save_result(anchor, bpm, beats)** — 송 맵 새 버전("AI 악보", 사용자 버전은 남는다)과 음표 악보를 저장한다.
   names 를 생략하면 set_sections 로 넣은 이름을 쓴다. PDF 는 건드리지 않는다.

8. **report** — 한국어로: 마디 수, 템포, 박자 예외, 구간 이름(읽은 것), 1마디 1박과 근거, 확신 없는 마디.
