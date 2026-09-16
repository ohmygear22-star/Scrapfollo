import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..");

const FORBIDDEN_IN_SRC = /apify|pg|starpulse|fake-provider|@social-graph\/actor/i;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

async function scanImports(directory: string): Promise<Array<{ file: string; specifier: string }>> {
  const files = await collectTypeScriptFiles(directory);
  const imports: Array<{ file: string; specifier: string }> = [];
  const importPattern = /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|(?:import|export)\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier !== undefined) {
        imports.push({ file: file.slice(PACKAGE_ROOT.length + 1), specifier });
      }
    }
  }
  return imports;
}

describe("actor package architecture boundaries", () => {
  it("imports only relative modules and the core contract in production source", async () => {
    const imports = await scanImports(join(PACKAGE_ROOT, "src"));

    const external = imports.filter(({ specifier }) =>
      !specifier.startsWith(".") && specifier !== "@social-graph/core");
    expect(external).toEqual([]);

    expect(imports).not.toContainEqual(
      expect.objectContaining({ specifier: expect.stringMatching(FORBIDDEN_IN_SRC) }),
    );
  });

  it("keeps the fake provider out of production source", async () => {
    const imports = await scanImports(join(PACKAGE_ROOT, "src"));

    expect(imports).not.toContainEqual(
      expect.objectContaining({ specifier: expect.stringMatching(/fake-provider/i) }),
    );
  });
});
