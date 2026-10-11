import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client" },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
  test: {
    // Client tests opt into jsdom per file so server fixture URLs remain file URLs.
    environment: "node",
    setupFiles: ["./src/client/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"]
  }
});
