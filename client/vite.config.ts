import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Mirrors the /api/* routes of nginx.conf, so the relative URLs in the
    // tracked client/.env also work under `npm run dev`. The targets are the
    // local ports from docs/RUNNING.md; each prefix is stripped, like nginx's
    // trailing-slash proxy_pass. The proxy streams responses, so the agent's
    // SSE endpoint (/reports/stream) works through it unchanged.
    proxy: {
      "/api/agent/": {
        target: "http://localhost:8090",
        rewrite: (path) => path.replace(/^\/api\/agent/, ""),
      },
      "/api/converter/": {
        target: "http://localhost:5001",
        rewrite: (path) => path.replace(/^\/api\/converter/, ""),
      },
      "/api/rag/": {
        target: "http://localhost:8100",
        rewrite: (path) => path.replace(/^\/api\/rag/, ""),
      },
    },
  },
});
