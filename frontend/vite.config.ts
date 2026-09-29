import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server proxies API / MJPEG / WebSocket to the FastAPI backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backend = env.VITE_BACKEND_URL || "http://127.0.0.1:8000";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
