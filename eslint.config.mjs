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
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        clearTimeout: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: tseslint.configs.recommended.rules,
  },
];
