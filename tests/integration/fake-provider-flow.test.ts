import { describe, expect, it } from "vitest";
import {
  collectTargets,
  derivePerThousand,
} from "@social-graph/core";
import type {
  CoreRunMetrics,
  NormalizedRelationship,
  Platform,
  SocialGraphProvider,
  SocialGraphProviderRegistry,
  TargetStreamEvent,
} from "@social-graph/core";
import { FakeProvider } from "@social-graph/fake-provider";
import type { FakeProviderScenario } from "@social-graph/fake-provider";

const fullCapabilities = {
  profileLookup: true,
  followerCount: true,
  followingCount: true,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

const instagramScenario: FakeProviderScenario = {
  platform: "instagram",
  capabilities: { ...fullCapabilities },
  profiles: {
    alpha: {
      profile: {
        platform: "instagram",
        platformUserId: "ig-alpha",
        username: "alpha",
        followerCount: 3,
        followingCount: 2,
      },
      followers: [
        [
          { platform: "instagram", platformUserId: "ig-f1", username: "follower-one" },
          { platform: "instagram", platformUserId: "ig-f2", username: "follower-two" },
        ],
        [
          { platform: "instagram", platformUserId: "ig-f2", username: "follower-two-renamed" },
          { platform: "instagram", platformUserId: "ig-f3", username: "follower-three" },
        ],
      ],
      following: [
        [
          { platform: "instagram", platformUserId: "ig-g1", username: "friend-one" },
          { platform: "instagram", platformUserId: "ig-g2", username: "friend-two" },
        ],
        [
          { platform: "instagram", platformUserId: "ig-g2", username: "friend-two-renamed" },
        ],
      ],
    },
  },
};

const xScenario: FakeProviderScenario = {
  platform: "x",
  capabilities: { ...fullCapabilities },
  profiles: {},
};

const tiktokScenario: FakeProviderScenario = {
  platform: "tiktok",
  capabilities: { ...fullCapabilities, followingIdentities: false },
  failureSchedules: {
    fetchFollowersPage: [
      {
        category: "SOURCE_TEMPORARILY_UNAVAILABLE",
        message: "Transient fake provider outage",
        retryable: true,
      },
    ],
  },
  profiles: {
    gamma: {
      profile: {
        platform: "tiktok",
        platformUserId: "tt-gamma",
        username: "gamma",
      },
      followers: [
        [
          { platform: "tiktok", platformUserId: "tt-f1", username: "tkfollower-one" },
          { platform: "tiktok", platformUserId: "tt-f2", username: "tkfollower-two" },
        ],
      ],
      following: [],
    },
  },
};

function buildRegistry(): {
  registry: SocialGraphProviderRegistry;
  instagram: FakeProvider;
  x: FakeProvider;
  tiktok: FakeProvider;
} {
  const instagram = FakeProvider.fromScenario(instagramScenario);
  const x = FakeProvider.fromScenario(xScenario);
  const tiktok = FakeProvider.fromScenario(tiktokScenario);
  return {
    registry: new Map<Platform, SocialGraphProvider>([
      ["instagram", instagram],
      ["x", x],
      ["tiktok", tiktok],
    ]),
    instagram,
    x,
    tiktok,
  };
}

function relationshipRows(events: ReadonlyArray<TargetStreamEvent>): NormalizedRelationship[] {
  return events
    .filter((event): event is Extract<TargetStreamEvent, { type: "relationship" }> =>
      event.type === "relationship")
    .map((event) => event.value);
}

function callsFor(
  provider: FakeProvider,
  operation: "fetchFollowersPage" | "fetchFollowingPage" | "resolveProfile",
  profileId?: string,
) {
  return provider.calls.filter((call) =>
    call.operation === operation
    && (profileId === undefined || call.profileId === profileId));
}

function relationshipRowsFor(
  events: ReadonlyArray<TargetStreamEvent>,
  targetId: string,
  relationship: "followers" | "following",
): NormalizedRelationship[] {
  return events
    .filter((event): event is Extract<TargetStreamEvent, { type: "relationship" }> =>
      event.type === "relationship" && event.targetId === targetId)
    .map((event) => event.value)
    .filter((row) => row.relationship === relationship);
}

function targetSummaryFor(events: ReadonlyArray<TargetStreamEvent>, targetId: string) {
  const summary = events.find((event): event is Extract<TargetStreamEvent, { type: "targetSummary" }> =>
    event.type === "targetSummary" && event.targetId === targetId);
  if (summary === undefined) throw new Error(`target summary missing for ${targetId}`);
  return summary.value;
}

function collectionSummaryFor(
  events: ReadonlyArray<TargetStreamEvent>,
  targetId: string,
  relationship: "followers" | "following",
) {
  const summary = events.find((event): event is Extract<TargetStreamEvent, { type: "collectionSummary" }> =>
    event.type === "collectionSummary"
    && event.targetId === targetId
    && event.value.relationship === relationship);
  if (summary === undefined) {
    throw new Error(`collection summary missing for ${targetId} ${relationship}`);
  }
  return summary.value;
}

const fastRetry = {
  policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  sleep: async () => {},
};

describe("full FakeProvider Phase 1 flow", () => {
  it("streams Instagram, X, and TikTok through one core contract", async () => {
    const { registry, instagram, x, tiktok } = buildRegistry();
    const events: TargetStreamEvent[] = [];
    let runMetrics: CoreRunMetrics | undefined;

    const stream = collectTargets({
      runId: "integration-run",
      scrapeType: "both",
      concurrency: 2,
      eventBufferSize: 1,
      targets: [
        { targetId: "t-alpha", platform: "instagram", username: "alpha" },
        { targetId: "t-beta", platform: "x", username: "beta" },
        { targetId: "t-gamma", platform: "tiktok", username: "gamma" },
      ],
    }, registry, {
      retry: fastRetry,
      onRunMetrics: (metrics) => {
        runMetrics = metrics;
      },
    });

    let seenAlphaFollowerRow = false;
    for await (const event of stream) {
      events.push(event);
      if (event.type === "relationship" && event.targetId === "t-alpha" && !seenAlphaFollowerRow) {
        seenAlphaFollowerRow = true;
        // Backpressure: the second followers page is not requested while the
        // first page still has unconsumed rows.
        expect(callsFor(instagram, "fetchFollowersPage", "ig-alpha")).toHaveLength(1);
      }
    }

    // Multi-platform routing and platform-bearing output.
    const platforms = new Set(relationshipRows(events).map((row) => row.platform));
    expect(platforms).toEqual(new Set(["instagram", "tiktok"]));

    // Profile resolution: alpha and gamma resolved through their providers.
    const profileEvents = events.filter((event) => event.type === "profile");
    expect(profileEvents.map((event) => (event as { targetId: string }).targetId).sort())
      .toEqual(["t-alpha", "t-gamma"]);

    // Profile failure: x beta is target-level FAILED with no fabricated
    // relationship collection for a profile that never resolved.
    const betaSummary = targetSummaryFor(events, "t-beta");
    expect(betaSummary.status).toBe("FAILED");
    expect(betaSummary.error).toMatchObject({ category: "PROFILE_NOT_FOUND" });
    expect(betaSummary.collections).toEqual([]);
    expect(events.some((event) =>
      (event.type === "collectionSummary" || event.type === "relationship")
      && event.targetId === "t-beta")).toBe(false);
    expect(callsFor(x, "fetchFollowersPage")).toHaveLength(0);
    expect(callsFor(x, "fetchFollowingPage")).toHaveLength(0);

    // Multi-page pagination + deduplication (ig-f2/ig-g2 overlap across pages).
    expect(callsFor(instagram, "fetchFollowersPage", "ig-alpha")).toHaveLength(2);
    expect(callsFor(instagram, "fetchFollowingPage", "ig-alpha")).toHaveLength(2);
    expect(relationshipRowsFor(events, "t-alpha", "followers").map((row) => row.userId))
      .toEqual(["ig-f1", "ig-f2", "ig-f3"]);
    expect(relationshipRowsFor(events, "t-alpha", "followers").map((row) => row.position))
      .toEqual([1, 2, 3]);
    expect(relationshipRowsFor(events, "t-alpha", "following").map((row) => row.userId))
      .toEqual(["ig-g1", "ig-g2"]);

    // Capability gating: tiktok declares followingIdentities false.
    expect(collectionSummaryFor(events, "t-gamma", "following").completeness).toMatchObject({
      complete: false,
      terminationReason: "ERROR",
      error: { category: "CAPABILITY_UNSUPPORTED" },
    });
    expect(callsFor(tiktok, "fetchFollowingPage")).toHaveLength(0);

    // Retry: tiktok followers failed transiently once, then succeeded.
    expect(collectionSummaryFor(events, "t-gamma", "followers").completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
    expect(collectionSummaryFor(events, "t-gamma", "followers").metrics).toMatchObject({
      requestsMade: 2,
      requestsFailed: 1,
      requestsRetried: 1,
    });

    // Completeness + both-mode independence.
    expect(collectionSummaryFor(events, "t-alpha", "followers").completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
    expect(collectionSummaryFor(events, "t-alpha", "following").completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });

    // Target statuses: SUCCESS, FAILED (profile), PARTIAL (capability).
    expect(targetSummaryFor(events, "t-alpha").status).toBe("SUCCESS");
    expect(targetSummaryFor(events, "t-gamma").status).toBe("PARTIAL");

    // Metrics at the run level include measured work across targets.
    expect(runMetrics).toMatchObject({
      profilesRequested: 3,
      profilesSuccessful: 1,
      profilesFailed: 1,
      profilesPartial: 1,
      followersReturned: 5,
      followingReturned: 2,
      totalRelationshipsReturned: 7,
      rawItemsReceived: 9,
      uniqueItemsProduced: 7,
      duplicatesRemoved: 2,
      requestsMade: 9,
      requestsFailed: 2,
      requestsRetried: 1,
    });
    expect(derivePerThousand(runMetrics as CoreRunMetrics)).toEqual({
      requestsPer1000Results: (9 / 7) * 1_000,
      secondsPer1000Results: expect.any(Number),
    });

    // Raw-response containment: no cursors, provider metadata, or YouTube.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("fake:");
    expect(serialized).not.toContain("requestMetadata");
    expect(serialized).not.toContain("nextCursor");
    expect(serialized).not.toContain("youtube");
  });
});
