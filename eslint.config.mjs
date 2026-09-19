import tsParser from "@typescript-eslint/parser"
import tsPlugin from "@typescript-eslint/eslint-plugin"

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "artifacts/**", "ci-artifacts/**"],
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
]
