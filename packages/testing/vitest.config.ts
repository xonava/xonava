import { defineConfig } from "vitest/config"
import path from "node:path"
export default defineConfig({
  resolve: { alias: {
    // The adapters package depends on zod 4; a nested zod 3 here would make its ZodError checks miss schemas built by tests.
    "zod": path.resolve(import.meta.dirname, "../../node_modules/zod"),
    "@xonava/core/domain": path.resolve(import.meta.dirname, "../core/src/domain/index.ts"),
    "@xonava/core/entity": path.resolve(import.meta.dirname, "../core/src/entity/index.ts"),
    "@xonava/core/execution": path.resolve(import.meta.dirname, "../core/src/execution/index.ts"),
    "@xonava/core/events": path.resolve(import.meta.dirname, "../core/src/events/index.ts"),
    "@xonava/core/operation": path.resolve(import.meta.dirname, "../core/src/operation/index.ts"),
    "@xonava/core/bootstrap": path.resolve(import.meta.dirname, "../core/src/bootstrap/index.ts"),
    "@xonava/core/security": path.resolve(import.meta.dirname, "../core/src/security/index.ts"),
    "@xonava/core/query": path.resolve(import.meta.dirname, "../core/src/query/index.ts"),
    "@xonava/core/persistence": path.resolve(import.meta.dirname, "../core/src/persistence/index.ts"),
    "@xonava/core/cache": path.resolve(import.meta.dirname, "../core/src/cache/index.ts"),
    "@xonava/core/rate-limit": path.resolve(import.meta.dirname, "../core/src/rate-limit/index.ts"),
    "@xonava/core/telemetry": path.resolve(import.meta.dirname, "../core/src/telemetry/index.ts"),
    "@xonava/core/temporal": path.resolve(import.meta.dirname, "../core/src/temporal/index.ts"),
    "@xonava/core/sequence": path.resolve(import.meta.dirname, "../core/src/sequence/index.ts"),
    "@xonava/core/aggregate": path.resolve(import.meta.dirname, "../core/src/aggregate/index.ts"),
    "@xonava/core/rules": path.resolve(import.meta.dirname, "../core/src/rules/index.ts"),
    "@xonava/core/object-store": path.resolve(import.meta.dirname, "../core/src/object-store/index.ts"),
    "@xonava/core/storage": path.resolve(import.meta.dirname, "../core/src/storage/index.ts"),
    "@xonava/core/serialization": path.resolve(import.meta.dirname, "../core/src/serialization/index.ts"),
    "@xonava/core/workflow": path.resolve(import.meta.dirname, "../core/src/workflow/index.ts"),
    "@xonava/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
    "@xonava/adapters/http": path.resolve(import.meta.dirname, "../adapters/src/http/index.ts"),
    "@xonava/adapters/server": path.resolve(import.meta.dirname, "../adapters/src/server/index.ts"),
    "@xonava/adapters/drizzle-d1": path.resolve(import.meta.dirname, "../adapters/src/drizzle-d1/index.ts"),
    "@xonava/adapters/drizzle-pg": path.resolve(import.meta.dirname, "../adapters/src/drizzle-pg/index.ts"),
    "@xonava/adapters/storage": path.resolve(import.meta.dirname, "../adapters/src/storage/index.ts"),
    "@xonava/adapters/drizzle-mysql": path.resolve(import.meta.dirname, "../adapters/src/drizzle-mysql/index.ts"),
    "@xonava/adapters": path.resolve(import.meta.dirname, "../adapters/src/index.ts"),
  }},
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
      ],
      thresholds: {
        // Enforced ratchet floors for the testing package, measured when they were
        // introduced. Raise these only alongside tests; never lower them.
        lines: 76,
        statements: 75,
        functions: 75,
        branches: 55,
      },
    },
  },
})
