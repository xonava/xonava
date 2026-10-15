import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@xonava/adapters/drizzle-d1": path.resolve(import.meta.dirname, "src/drizzle-d1/index.ts"),
      "@xonava/adapters/drizzle-pg": path.resolve(import.meta.dirname, "src/drizzle-pg/index.ts"),
      "@xonava/testing": path.resolve(import.meta.dirname, "../testing/src/index.ts"),
      "@xonava/core": path.resolve(import.meta.dirname, "../core/src"),
      "@xonava/core/domain": path.resolve(import.meta.dirname, "../core/src/domain"),
      "@xonava/core/entity": path.resolve(import.meta.dirname, "../core/src/entity"),
      "@xonava/core/execution": path.resolve(import.meta.dirname, "../core/src/execution"),
      "@xonava/core/events": path.resolve(import.meta.dirname, "../core/src/events"),
      "@xonava/core/operation": path.resolve(import.meta.dirname, "../core/src/operation"),
      "@xonava/core/persistence": path.resolve(import.meta.dirname, "../core/src/persistence"),
      "@xonava/core/query": path.resolve(import.meta.dirname, "../core/src/query"),
      "@xonava/core/cache": path.resolve(import.meta.dirname, "../core/src/cache"),
      "@xonava/core/rate-limit": path.resolve(import.meta.dirname, "../core/src/rate-limit"),
      "@xonava/core/telemetry": path.resolve(import.meta.dirname, "../core/src/telemetry"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})
