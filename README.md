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

**NVIDIA GPU + Docker**가 필요하다 (CPU도 되지만 훨씬 느리다). 디스크 15GB 이상.
Windows는 WSL2 백엔드의 Docker Desktop, 리눅스는 nvidia-container-toolkit.

```bash
git clone https://github.com/jw-heo97/demucs_web.git
cd demucs_web
cp .env.example .env          # Windows: copy .env.example .env
docker compose up -d --build
```

<http://127.0.0.1:8080> 으로 접속. 첫 기동 때 관리자 계정이 만들어지고,
`.env`의 `ADMIN_PASSWORD`가 비어 있으면 임의 비밀번호를 로그에 **한 번만** 찍는다:

```bash
docker compose logs api | grep 비밀번호
```

> GPU가 최신 세대(Blackwell/sm_120)가 아니면 `Dockerfile`의 베이스 이미지 태그를
> 맞는 CUDA 버전으로 바꿔야 할 수 있다.

## 설정

`.env`에서 조정한다. 자주 쓰는 것:

| 항목 | 기본값 | 설명 |
|---|---|---|
| `WEB_BIND` | `127.0.0.1` | `0.0.0.0`으로 바꾸면 LAN에 열린다 |
| `MAX_DURATION_SEC` | `900` | 처리할 곡 길이 상한 |
| `SHIFTS` | `1` | 올리면 분리 품질↑ 시간↑ |
| `REQUIRE_ROLE` | (비움) | `admin`으로 두면 관리자만 접속 가능 |

로그인한 사용자는 분리·보관함·송 맵·검색을 모두 쓸 수 있고,
**보안 화면(계정 관리·접속 기록)만 관리자 전용**이다.

## 외부에서 접속하기 (Tailscale)

포트포워딩으로 인터넷에 직접 여는 것은 권하지 않는다 — HTTP라 비밀번호와 세션 쿠키가
평문으로 오간다. Tailscale을 쓰면 공인 IP 노출 없이 HTTPS로 접속할 수 있다.

준비: `winget install -e --id Tailscale.Tailscale` → `tailscale up` →
[관리 콘솔](https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates** 켜기.
`.env`는 `WEB_BIND=127.0.0.1`로 두고 노출은 Tailscale에 맡긴다.

**① 내 계정 기기만** — 평소에는 이걸 쓴다

```bash
tailscale serve --bg 8080      # 켜기
tailscale serve status         # 확인
tailscale serve reset          # 끄기
```

**② 인터넷 전체 공개** — 상대가 Tailscale을 깔지 않아도 접속된다

```bash
tailscale funnel --bg 8080     # 켜기
tailscale funnel status        # 확인
tailscale funnel reset         # 끄기
```

주소는 둘 다 `https://<기기이름>.<tailnet>.ts.net` 이고 **동시에 켤 수는 없다.**
바꾸려면 한쪽을 `reset` 하고 다른 쪽을 켠다.

> ⚠️ funnel로 공개하면 **앱의 로그인이 유일한 방어선**이 된다. 긴 임의 비밀번호를 쓰고,
> 여러 명이 쓴다면 계정을 따로 만들 것. 공인 IP에 열린 포트는 며칠 안에 스캐너에 발견된다.

`tailscale serve`가 호스트에서 프록시하며 `X-Forwarded-For`를 넘겨주므로,
`.env`에 `TRUST_PROXY_HEADER=1`을 켜면 기기별 실제 주소가 접속 기록에 남는다.

## 기술 스택

Python · FastAPI · demucs(htdemucs) · librosa · ffmpeg /
React · TypeScript · Vite / Docker 멀티스테이지(프론트 빌드 → CUDA 런타임)

```bash
cd web && npm install && npm run dev   # 개발 서버, /api는 컨테이너로 프록시
```

## 라이선스

MIT ([LICENSE](LICENSE)).
**저작권 주의** — YouTube 이용약관상 다운로드는 허용되지 않는다. 개인 학습·연습 용도로만 사용할 것.
