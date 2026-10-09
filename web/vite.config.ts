import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 앱(Capacitor/Tauri)으로 감쌀 때를 대비해 상대 경로로 빌드한다.
// base 가 절대경로면 file:// 로 로드되는 앱 환경에서 자산을 못 찾는다.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 앱 번들에 소스맵을 넣지 않는다
    sourcemap: false,
  },
  server: {
    port: 5173,
    // 개발 중에는 API 를 컨테이너로 넘긴다 (npm run dev). 개발 서버를 Docker 의 node 로 돌리면
    // 컨테이너 안에서 호스트는 127.0.0.1 이 아니라서 API_TARGET=http://host.docker.internal:8080 으로 준다
    proxy: {
      "/api": { target: process.env.API_TARGET || "http://127.0.0.1:8080", changeOrigin: true },
      "/healthz": { target: process.env.API_TARGET || "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
});
