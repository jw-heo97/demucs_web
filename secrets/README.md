# secrets/

yt-dlp 쿠키 파일을 두는 곳. 컨테이너에는 읽기 전용(`:ro`)으로만 마운트된다.

YouTube 가 "Sign in to confirm you're not a bot" 을 띄우기 시작하면:

1. 브라우저 확장(Get cookies.txt LOCALLY 등)으로 youtube.com 쿠키를
   Netscape 형식으로 내보내 `secrets/cookies.txt` 로 저장
2. `.env` 에 `COOKIES_FILE=/secrets/cookies.txt` 추가
3. `docker compose up -d --force-recreate`

> ⚠️ cookies.txt 는 **로그인 세션 그 자체**다. 이미지에 굽거나 커밋하지 말 것.
> `.dockerignore` 에서 `secrets/` 를 이미 제외해 두었다.
