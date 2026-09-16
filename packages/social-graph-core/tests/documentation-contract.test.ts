import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("provider development documentation contract", () => {
  it("documents every required provider operation and contract-suite entrypoint", async () => {
    const guide = await readRepositoryFile("docs/providers/social-graph-provider.md");

    for (const term of [
      "resolveProfile",
      "fetchFollowersPage",
      "fetchFollowingPage",
      "defineSocialGraphProviderContract",
      "SocialGraphProviderCapabilities",
      "SocialGraphProviderRegistry",
      "instagram",
      "tiktok",
      "YouTube",
      "opaque cursor",
      "AbortSignal",
      "raw response",
    ]) {
      expect(guide, `guide must mention ${term}`).toContain(term);
    }
  });

  it("documents the corrected lifecycle and cancellation semantics", async () => {
    const guide = await readRepositoryFile("docs/providers/social-graph-provider.md");

    for (const term of [
      "before any relationship collection begins",
      "target-level",
      "sourceProfile",
      "MAX_LIMIT_REACHED",
      "SOURCE_EXHAUSTED",
      "ABORTED",
      "PAGINATION_FAILED",
      "return()",
      "stableUserIds",
      "requestsMade",
      "attempts",
    ]) {
      expect(guide, `guide must mention ${term}`).toContain(term);
    }
    expect(guide).not.toContain("hasMore: true is guarded as");
  });

  it("documents the verification evidence template without pre-filled results", async () => {
    const evidence = await readRepositoryFile("docs/phase-1-verification.md");

    for (const command of [
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm test:integration",
      "git diff --check",
    ]) {
      expect(evidence, `evidence template must list ${command}`).toContain(command);
    }
    expect(evidence).toContain("Result:");
  });

  it("ships a repository README describing the workspace", async () => {
    const readme = await readRepositoryFile("README.md");

    expect(readme).toContain("social-graph-core");
    expect(readme).toContain("fake-provider");
    expect(readme).toContain("Phase 1");
  });
});
