import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = parsePort(env.CODE_AGENT_PORT, 3000);
  const webPort = parsePort(env.CODE_AGENT_WEB_PORT, 5173);
  const webHost = env.CODE_AGENT_WEB_HOST?.trim() || env.CODE_AGENT_HOST?.trim() || "127.0.0.1";

  return {
    plugins: [react()],
    root: path.resolve("web"),
    server: {
      host: webHost,
      port: webPort,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
      },
    },
    build: {
      outDir: path.resolve("web/dist"),
      emptyOutDir: true,
    },
  };
});
