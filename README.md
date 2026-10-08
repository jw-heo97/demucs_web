# Demucs Web

YouTube 음원을 스템(드럼·베이스·보컬·기타)으로 분리하고, 곡의 마디·박자를 잡아
**메트로놈과 함께 연습**하는 셀프호스팅 웹 앱.
Windows에서 직접 돌리기 어려운 조합(최신 GPU + CUDA + demucs)을 Docker로 해결한다.

## 무엇을 할 수 있나

- **음원 분리** — YouTube 주소를 넣으면 4스템으로 나눈다 (GPU 기준 5분 곡에 약 40초)
- **멀티트랙 믹서** — 스템을 동시 재생하며 볼륨·음소거·솔로. 보컬을 끄면 그 자리에서 MR
- **송 맵** — 파형에서 첫박을 직접 찍어 마디를 잡는다. 박자표(4/4·3/4·6/8) 변화,
  구간 이름(Intro·Verse·Chorus), 마디별로 소리 낼 박까지 지정
- **메트로놈** — 구성표대로 클릭 트랙 생성. 연습용·원곡용처럼 여러 버전 저장
- **믹스 다운로드** — 지금 들리는 조합만 한 파일로. 예비박을 앞에 넣어 받을 수도 있다
- **YouTube 검색** — API 키 없이 앱 안에서 검색하고 바로 분리

## 설치

**NVIDIA GPU + Docker**가 필요하다. 디스크 15GB 이상.
Windows는 WSL2 백엔드의 Docker Desktop, 리눅스는 nvidia-container-toolkit.

```bash
git clone https://github.com/jw-heo97/demucs_web.git
cd demucs_web
cp .env.example .env          # Windows: copy .env.example .env
docker compose up -d --build
```

<http://127.0.0.1:8080> 으로 접속. 로그인은 없다 — 이 PC에서만 열리고,
다른 기기에서는 아래 Tailscale로 접속한다.

> GPU가 최신 세대(Blackwell/sm_120)가 아니면 `Dockerfile`의 베이스 이미지 태그를
> 맞는 CUDA 버전으로 바꿔야 할 수 있다.

## 설정

`.env`에서 조정한다. 자주 쓰는 것:

| 항목 | 기본값 | 설명 |
|---|---|---|
| `WEB_BIND` | `127.0.0.1` | 그대로 둘 것. 로그인이 없어서 `0.0.0.0`으로 열면 같은 네트워크의 누구나 쓸 수 있다 |
| `MAX_DURATION_SEC` | `900` | 처리할 곡 길이 상한 |
| `SHIFTS` | `1` | 올리면 분리 품질↑ 시간↑ |
| `JOB_RETENTION_SEC` | `0` | 0이면 결과물을 지우지 않는다(보관함). 양수면 그 초가 지난 작업을 자동 삭제 |

## 외부에서 접속하기 (Tailscale)

이 앱에는 로그인이 없다. 접속할 수 있는 사람은 누구나 내 GPU로 작업을 돌리고
결과물을 지울 수 있으므로, 포트포워딩이나 `WEB_BIND=0.0.0.0`으로 직접 여는 것은 금물이다.
외부에서는 **`tailscale serve`만** 쓴다 — 내 tailnet에 로그인한 기기만 접속할 수 있고
HTTPS가 자동으로 붙는다.

준비: `winget install -e --id Tailscale.Tailscale` → `tailscale up` →
[관리 콘솔](https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates** 켜기.
`.env`는 `WEB_BIND=127.0.0.1` 그대로 둔다.

```bash
tailscale serve --bg 8080      # 켜기
tailscale serve status         # 확인
tailscale serve reset          # 끄기
```

주소는 `https://<기기이름>.<tailnet>.ts.net`.

> ⚠️ `tailscale funnel`은 쓰지 말 것. funnel은 인터넷 전체에 공개하는 기능이라
> 로그인이 없는 이 앱에서는 아무나 들어온다. 다른 사람과 같이 쓰려면 Tailscale의
> [기기 공유](https://tailscale.com/kb/1084/sharing)로 그 사람의 tailnet에 내 기기를 공유한다.

## 기술 스택

Python · FastAPI · demucs(htdemucs) · librosa · ffmpeg /
React · TypeScript · Vite / Docker 멀티스테이지(프론트 빌드 → CUDA 런타임)

```bash
cd web && npm install && npm run dev   # 개발 서버, /api는 컨테이너로 프록시
```

## 라이선스

MIT ([LICENSE](LICENSE)).
**저작권 주의** — YouTube 이용약관상 다운로드는 허용되지 않는다. 개인 학습·연습 용도로만 사용할 것.
