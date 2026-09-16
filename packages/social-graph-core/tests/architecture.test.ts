import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRelationship } from "../src/index.js";
import type { NormalizedRelationship } from "../src/index.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..");

const FORBIDDEN_IMPORT_PATTERN = /apify|pg|starpulse|fake-provider|@social-graph\/actor/i;

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

describe("social-graph-core architecture boundaries", () => {
  it("forbids consumer and provider implementation imports from production source", async () => {
    // After the deliberate-fixture failure proof, scanning covers src only.
    const imports = await scanImports(join(PACKAGE_ROOT, "src"));
    expect(imports).not.toContainEqual(
      expect.objectContaining({ specifier: expect.stringMatching(FORBIDDEN_IMPORT_PATTERN) }),
    );
  });

  it("imports only relative internal modules in production source", async () => {
    const imports = await scanImports(join(PACKAGE_ROOT, "src"));
    const external = imports.filter(({ specifier }) => !specifier.startsWith("."));
    expect(external).toEqual([]);
  });

  it("exports no provider raw response field and only approved platforms", () => {
    const row: NormalizedRelationship = normalizeRelationship({
      sourceProfile: {
        platform: "instagram",
        platformUserId: "source-id",
        username: "source",
      },
      relationship: "followers",
      item: {
        platform: "instagram",
        platformUserId: "user-1",
        username: "user",
        fullName: "User Example",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://example.test/user.jpg",
        rawResponse: { token: "secret" },
      } as never,
      position: 1,
      scrapedAt: "2026-09-16T00:00:00.000Z",
    });

    const keys = Object.keys(row).join(",");
    expect(keys).not.toMatch(/raw|provider|payload|cursor|metadata/i);
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(["instagram", "x", "tiktok"]).toContain(row.platform);
  });
});
