import tsParser from "@typescript-eslint/parser"
import tsPlugin from "@typescript-eslint/eslint-plugin"

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "artifacts/**", ".release-check/**"],
  },
  {
    files: ["**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2024, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Type-aware correctness rules for core production code: async misuse is a
    // correctness bug in a transactional framework, not a style issue.
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/**/__tests__/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./packages/core/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": ["error", { allowThrowingUnknown: true, allowThrowingAny: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
]
