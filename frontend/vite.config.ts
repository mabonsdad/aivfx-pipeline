import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_BASE_PATH || "/";

  return {
    base,
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(process.cwd(), "index.html"),
          apiTest: resolve(process.cwd(), "api-test.html"),
        },
      },
    },
    server: {
      port: 5173,
    },
  };
});
