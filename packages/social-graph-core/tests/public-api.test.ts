import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

const RUNTIME_EXPORTS = [
  "CollectionError",
  "CoreRunMetricsTracker",
  "DEFAULT_RETRY_POLICY",
  "ExactDeduplicator",
  "RelationshipMetricsCounter",
  "abortableDelay",
  "collectRelationships",
  "collectTarget",
  "collectTargets",
  "completeCollection",
  "createAbortError",
  "derivePerThousand",
  "deriveTargetStatus",
  "isAbortError",
  "normalizeProviderError",
  "normalizeRelationship",
  "relationshipDedupeKey",
  "resolveProfile",
  "retryOperation",
].sort();

const TYPE_EXPORTS = [
  "CollectRelationshipRequest",
  "CollectRelationshipsOptions",
  "CollectTargetOptions",
  "CollectTargetRequest",
  "CollectTargetsOptions",
  "CollectTargetsRequest",
  "CollectionCompleteness",
  "CollectionErrorOptions",
  "CompletenessOutcome",
  "CoreRunMetrics",
  "DerivedPerThousand",
  "ErrorContext",
  "FetchRelationshipPageInput",
  "NormalizeRelationshipInput",
  "NormalizedRelationship",
  "Platform",
  "ProviderProfile",
  "ProviderRelationshipItem",
  "ProviderRelationshipPage",
  "ProviderRequestContext",
  "PublicCollectionError",
  "PublicCollectionErrorCategory",
  "RelationshipCollectionMetrics",
  "RelationshipCollectionSummary",
  "RelationshipDedupeKeyInput",
  "RelationshipStreamEvent",
  "RelationshipType",
  "ResolveProfileInput",
  "RetryFailureInfo",
  "RetryHookInfo",
  "RetryHooks",
  "RetryOperationOptions",
  "RetryOptions",
  "RetryPolicy",
  "RetryRetryInfo",
  "ScrapeType",
  "SocialGraphProvider",
  "SocialGraphProviderCapabilities",
  "SocialGraphProviderRegistry",
  "TargetCollectionStatus",
  "TargetCollectionSummary",
  "TargetStreamEvent",
  "TerminationReason",
];

describe("social-graph-core public API lock", () => {
  it("exports exactly the locked runtime API", () => {
    expect(Object.keys(core).sort()).toEqual(RUNTIME_EXPORTS);
  });

  it("exports exactly the locked type API", async () => {
    const indexSource = await readFile(join(import.meta.dirname, "../src/index.ts"), "utf8");
    const exportedNames = [...indexSource.matchAll(/^export type \{([^}]+)\}/gm)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort();

    expect([...new Set(exportedNames)]).toEqual(TYPE_EXPORTS);
  });

  it("supports exactly the approved platform identities", () => {
    const platforms: core.Platform[] = ["instagram", "x", "tiktok"];
    expect(platforms).toHaveLength(3);

    // @ts-expect-error youtube must never enter the platform contract
    const rejected: core.Platform[] = ["instagram", "x", "tiktok", "youtube"];
    void rejected;
  });

  it("declares capabilities and the provider registry on the public surface", () => {
    const capabilities: core.SocialGraphProviderCapabilities = {
      profileLookup: true,
      followerCount: true,
      followingCount: true,
      followerIdentities: true,
      followingIdentities: true,
      pagination: true,
      stableUserIds: true,
    };
    expect(Object.keys(capabilities).sort()).toEqual([
      "followerCount",
      "followerIdentities",
      "followingCount",
      "followingIdentities",
      "pagination",
      "profileLookup",
      "stableUserIds",
    ]);

    const registry: core.SocialGraphProviderRegistry = new Map();
    expect(registry).toBeInstanceOf(Map);
  });
});
