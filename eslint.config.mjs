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
        crypto: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: tseslint.configs.recommended.rules,
  },
  {
    files: ["packages/social-graph-core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "apify",
              "apify/*",
              "pg",
              "pg/*",
              "*starpulse*",
              "@social-graph/fake-provider",
              "@social-graph/actor",
              "*fake-provider*",
              "*instagram*",
              "*tiktok*",
              "*twitter*",
              "*facebook*",
              "*youtube*",
            ],
            message: "social-graph-core must stay consumer-neutral: no Apify, PostgreSQL, Starpulse, provider implementations, or platform-specific SDKs or endpoints.",
          },
        ],
      }],
    },
  },
  {
    files: ["actor/social-graph-actor/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "apify",
              "apify/*",
              "pg",
              "pg/*",
              "*starpulse*",
              "@social-graph/fake-provider",
              "@social-graph/actor",
              "*fake-provider*",
            ],
            message: "Actor production source may import only the core contract; the Apify SDK binding arrives in P2-T6 and the fake provider stays test-only.",
          },
        ],
      }],
    },
  },
];
