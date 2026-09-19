import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
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
        // Enforced ratchet floors for the complete core, including defensive
        // error branches. Raise these only alongside tests; never lower them.
        lines: 94,
        statements: 90,
        functions: 96,
        branches: 86,
      },
    },
  },
})
