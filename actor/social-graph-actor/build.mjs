import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

// The Apify SDK stays external (it assumes an unbundled runtime); the
// platform installs it via bundle/package.json. Everything else — actor
// code plus the @social-graph/core workspace source — is bundled here.
await build({
  entryPoints: ["src/apify-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "bundle/main.cjs",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["apify", "playwright"],
  logLevel: "warning",
  banner: {
    js: "/* Bundled social-graph actor. Source of truth: src/ (the Apify SDK is confined to src/apify-binding.ts). */",
  },
});

await writeFile(
  "bundle/package.json",
  `${JSON.stringify({ private: true, dependencies: { apify: "3.7.2" } }, null, 2)}\n`,
  "utf8",
);
