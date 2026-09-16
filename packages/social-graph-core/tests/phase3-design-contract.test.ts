import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Phase 3 spike design contract", () => {
  it("documents the owner stop rule, taxonomy, and bounded protocol", async () => {
    const design = await readRepositoryFile(
      "docs/superpowers/specs/2026-09-17-social-graph-phase-3-spike-design.md",
    );

    for (const term of [
      "stop and report first",
      "no retry, no alternate endpoint, no proxy",
      "halts immediately",
      "≤ 3 requests TOTAL",
      "≤ 4 requests",
      "Single-shot yields only to an",
      "CAUGHT",
      "SOFT_LIMITED",
      "NOT_FOUND",
      "NETWORK_ERROR",
      "default to `CAUGHT`",
      "Request budget",
      "Single-shot",
      "budget",
      "no proxies",
      "login",
      "secUid",
      "Instagram",
      "TikTok",
      "decision tree",
      "100/1k/5k/10k",
      "$500",
      "phase gate",
      "P3-T1",
      "P3-T2",
      "P3-T3",
      "P3-T4",
      "P3-T5",
      "P3-T6",
    ]) {
      expect(design, `design must mention ${term}`).toContain(term);
    }
  });
});
