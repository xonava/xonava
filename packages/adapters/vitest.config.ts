import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "adapters/drizzle-d1": path.resolve(import.meta.dirname, "src/drizzle-d1/index.ts"),
      "adapters/drizzle-pg": path.resolve(import.meta.dirname, "src/drizzle-pg/index.ts"),
      "testing": path.resolve(import.meta.dirname, "../testing/src/index.ts"),
      "core": path.resolve(import.meta.dirname, "../core/src"),
      "core/domain": path.resolve(import.meta.dirname, "../core/src/domain"),
      "core/entity": path.resolve(import.meta.dirname, "../core/src/entity"),
      "core/execution": path.resolve(import.meta.dirname, "../core/src/execution"),
      "core/events": path.resolve(import.meta.dirname, "../core/src/events"),
      "core/operation": path.resolve(import.meta.dirname, "../core/src/operation"),
      "core/persistence": path.resolve(import.meta.dirname, "../core/src/persistence"),
      "core/query": path.resolve(import.meta.dirname, "../core/src/query"),
      "core/cache": path.resolve(import.meta.dirname, "../core/src/cache"),
      "core/rate-limit": path.resolve(import.meta.dirname, "../core/src/rate-limit"),
      "core/telemetry": path.resolve(import.meta.dirname, "../core/src/telemetry"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})
