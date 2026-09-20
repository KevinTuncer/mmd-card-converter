import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@lib": resolve(import.meta.dirname, "lib"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/app/converter/__tests__/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    environment: "node",
  },
});
