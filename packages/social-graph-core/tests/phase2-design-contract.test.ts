import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Phase 2 actor design contract", () => {
  it("documents the actor architecture, input schema, and output contracts", async () => {
    const design = await readRepositoryFile(
      "docs/superpowers/specs/2026-09-16-social-graph-phase-2-actor-design.md",
    );

    for (const term of [
      // Architecture and composition
      "collectTargets",
      "SocialGraphProviderRegistry",
      "FakeProvider",
      "composition root",
      // Input schema and validation
      "targets",
      "scrapeType",
      "maxFollowers",
      "maxFollowing",
      "concurrency",
      "eventBufferSize",
      "normalizedUsername",
      "safety limit",
      // Dataset streaming contract
      "Dataset",
      "pushData",
      "bounded batch",
      "ABORTED",
      // Run summary and cost layer
      "RUN_SUMMARY",
      "Key-Value Store",
      "compute_units",
      "proxy_bytes",
      "proxy_cost",
      "dataset_operations",
      "actor_runtime_ms",
      "estimated_cost",
      "currency",
      "cost_data_status",
      "MAX_LIMIT_REACHED",
      "PROVIDER_UNAVAILABLE",
      "SUCCESS_RATE",
      "COST_PER_1000_RESULTS",
      // Logging and redaction
      "run_id",
      "page ordinal",
      "redact",
      // Scope and gates
      "Phase 3",
      "Out of scope",
      "Store publication",
      "apify push",
    ]) {
      expect(design, `design must mention ${term}`).toContain(term);
    }
  });

  it("documents the task plan with the verification ladder and phase gate", async () => {
    const plan = await readRepositoryFile(
      "docs/superpowers/plans/2026-09-16-social-graph-phase-2-plan.md",
    );

    for (const term of [
      "P2-T1",
      "P2-T2",
      "P2-T3",
      "P2-T4",
      "P2-T5",
      "P2-T6",
      "verification ladder",
      "focused",
      "typecheck",
      "lint",
      "build",
      "git diff --check",
      "independent review",
      "baseline",
      "phase gate",
      "clean checkout",
      "TDD",
      "RED",
      "GREEN",
      "Completion criteria",
    ]) {
      expect(plan, `plan must mention ${term}`).toContain(term);
    }
    expect(plan).toContain("Do not start Phase 3");
  });
});
