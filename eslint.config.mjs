import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
      globals: { AbortSignal: "readonly", setTimeout: "readonly" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: tseslint.configs.recommended.rules,
  },
];
