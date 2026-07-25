import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Internal uvicorn in `lelab --dev` (Vite owns the public :8000).
const API = process.env.TRAINMOBILE_API_TARGET || "http://127.0.0.1:8001";

const apiProxy = {
  target: API,
  changeOrigin: true,
} as const;

const wsProxy = {
  target: API,
  changeOrigin: true,
  ws: true,
} as const;

// FastAPI route prefixes — keep Vite client paths (/src, /@vite, …) unproxied.
const API_PREFIXES = [
  "/datasets",
  "/models",
  "/jobs",
  "/cameras",
  "/robots",
  "/available-cameras",
  "/available-ports",
  "/move-arm",
  "/stop-teleoperation",
  "/teleoperation-status",
  "/joint-positions",
  "/start-recording",
  "/stop-recording",
  "/recording-status",
  "/recording-exit-early",
  "/recording-rerecord-episode",
  "/start-inference",
  "/stop-inference",
  "/inference-status",
  "/start-calibration",
  "/stop-calibration",
  "/calibration-status",
  "/complete-calibration-step",
  "/calibration-configs",
  "/hf-auth",
  "/hf-auth-status",
  "/health",
  "/system",
  "/get-configs",
  "/upload-dataset",
  "/dataset-info",
  "/delete-dataset",
  "/start-port-detection",
  "/detect-port-after-disconnect",
  "/save-robot-port",
  "/robot-port",
  "/save-robot-config",
  "/robot-config",
  "/ws-test",
];

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0",
    port: 8000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/ws": wsProxy,
      ...Object.fromEntries(API_PREFIXES.map((p) => [p, apiProxy])),
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  esbuild: {
    pure:
      mode === "production"
        ? ["console.log", "console.debug", "console.info"]
        : [],
  },
  preview: {
    host: "0.0.0.0",
    port: 8000,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
