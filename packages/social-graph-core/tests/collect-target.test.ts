import { describe, expect, it, vi } from "vitest";
import { collectTarget, deriveTargetStatus } from "../src/index.js";
import type {
  CollectTargetRequest,
  RelationshipCollectionSummary,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
  TargetStreamEvent,
} from "../src/index.js";

const capabilities: SocialGraphProviderCapabilities = {
  profileLookup: true,
  followerCount: false,
  followingCount: false,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

const resolvedProfile: ProviderProfile = {
  platform: "instagram",
  platformUserId: "source-id",
  username: "source",
};

const bothRequest: CollectTargetRequest = {
  runId: "run-1",
  targetId: "target-1",
  platform: "instagram",
  username: "source",
  scrapeType: "both",
};

function item(userId: string): ProviderRelationshipItem {
  return { platform: "instagram", platformUserId: userId, username: userId };
}

function targetProvider(options: {
  followersPages?: ReadonlyArray<ProviderRelationshipItem[]>;
  followingPages?: ReadonlyArray<ProviderRelationshipItem[]>;
  followingError?: unknown;
  platform?: "instagram" | "x";
  capabilities?: Partial<SocialGraphProviderCapabilities>;
} = {}): SocialGraphProvider & {
  resolveProfile: ReturnType<typeof vi.fn>;
  followersCalls: number;
  followingCalls: number;
} {
  const followersPages = options.followersPages ?? [[item("f1"), item("f2")]];
  const followingPages = options.followingPages ?? [[item("g1")]];
  const provider = {
    providerName: "target-test-provider",
    platform: options.platform ?? "instagram",
    capabilities: { ...capabilities, ...options.capabilities },
    followersCalls: 0,
    followingCalls: 0,
    resolveProfile: vi.fn(async () => ({ ...resolvedProfile })),
    fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      const spec = followersPages[provider.followersCalls];
      provider.followersCalls += 1;
      return {
        items: spec ?? [],
        hasMore: provider.followersCalls < followersPages.length,
        ...(provider.followersCalls < followersPages.length ? { nextCursor: `f-${provider.followersCalls}` } : {}),
        requestMetadata: { attempts: 1, durationMs: 1 },
      };
    }),
    fetchFollowingPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      if (options.followingError !== undefined) throw options.followingError;
      const spec = followingPages[provider.followingCalls];
      provider.followingCalls += 1;
      return {
        items: spec ?? [],
        hasMore: provider.followingCalls < followingPages.length,
        ...(provider.followingCalls < followingPages.length ? { nextCursor: `g-${provider.followingCalls}` } : {}),
        requestMetadata: { attempts: 1, durationMs: 1 },
      };
    }),
  };
  return provider;
}

const fastRetry = {
  policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  sleep: async () => {},
};

async function consume(stream: AsyncIterable<TargetStreamEvent>) {
  const events: TargetStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function collectionSummary(
  events: ReadonlyArray<TargetStreamEvent>,
  relationship: "followers" | "following",
) {
  const summary = events
    .filter((event): event is Extract<TargetStreamEvent, { type: "collectionSummary" }> =>
      event.type === "collectionSummary")
    .find((event) => event.value.relationship === relationship);
  if (summary === undefined) throw new Error(`${relationship} collection summary missing`);
  return summary.value;
}

function targetSummary(events: ReadonlyArray<TargetStreamEvent>) {
  const summary = events.find((event) => event.type === "targetSummary");
  if (summary?.type !== "targetSummary") throw new Error("target summary missing");
  return summary.value;
}

describe("collectTarget orchestration", () => {
  it("summarizes followers and following independently when only following fails", async () => {
    const provider = targetProvider({
      followingError: Object.assign(new Error("following exploded"), {
        category: "SOURCE_TEMPORARILY_UNAVAILABLE",
        retryable: false,
      }),
    });

    const events = await consume(collectTarget(bothRequest, provider, { retry: fastRetry }));

    expect(collectionSummary(events, "followers").completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
    expect(collectionSummary(events, "following").completeness).toMatchObject({
      complete: false,
      terminationReason: "ERROR",
      error: { category: "SOURCE_TEMPORARILY_UNAVAILABLE" },
    });
    expect(targetSummary(events).status).toBe("PARTIAL");
    expect(targetSummary(events).platform).toBe("instagram");
    expect(targetSummary(events).collections).toHaveLength(2);
  });

  it("resolves the profile exactly once and emits it before relationship rows", async () => {
    const provider = targetProvider();

    const events = await consume(collectTarget(bothRequest, provider));

    expect(provider.resolveProfile).toHaveBeenCalledTimes(1);
    const profileEvent = events.find((event) => event.type === "profile");
    expect(profileEvent).toMatchObject({
      runId: "run-1",
      targetId: "target-1",
      value: resolvedProfile,
    });
    expect(events[0]?.type).toBe("profile");
    expect(targetSummary(events).status).toBe("SUCCESS");
    const rows = events.filter((event) => event.type === "relationship");
    expect(rows.map((event) => (event as { value: { userId?: string } }).value.userId))
      .toEqual(["f1", "f2", "g1"]);
  });

  it("uses the real resolved profile in both collection summaries", async () => {
    const provider = targetProvider();

    const events = await consume(collectTarget(bothRequest, provider));

    expect(collectionSummary(events, "followers").sourceProfile).toEqual(resolvedProfile);
    expect(collectionSummary(events, "following").sourceProfile).toEqual(resolvedProfile);
  });

  it("fails the whole target with a normalized error when profile resolution fails", async () => {
    const provider = targetProvider();
    (provider.resolveProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("no such user"), { category: "PROFILE_NOT_FOUND", retryable: false }),
    );

    const events = await consume(collectTarget(bothRequest, provider));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "targetSummary",
      runId: "run-1",
      targetId: "target-1",
      value: {
        status: "FAILED",
        collections: [],
        error: { category: "PROFILE_NOT_FOUND", retryable: false },
      },
    });
    expect(provider.followersCalls).toBe(0);
    expect(provider.followingCalls).toBe(0);
  });

  it("fails the target before profile lookup on platform mismatch", async () => {
    const provider = targetProvider({ platform: "x" });

    const events = await consume(collectTarget(bothRequest, provider));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "targetSummary",
      value: {
        status: "FAILED",
        error: { category: "INVALID_INPUT" },
      },
    });
    expect(provider.resolveProfile).not.toHaveBeenCalled();
  });

  it("collects only the requested relationship for single-mode scrape types", async () => {
    const provider = targetProvider();

    const events = await consume(collectTarget(
      { ...bothRequest, scrapeType: "following" },
      provider,
    ));

    expect(provider.followersCalls).toBe(0);
    expect(provider.followingCalls).toBe(1);
    const summaries = events.filter((event) => event.type === "collectionSummary");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { value: { relationship: string } }).value.relationship).toBe("following");
    expect(targetSummary(events).status).toBe("SUCCESS");
  });

  it("forwards per-relationship limits independently", async () => {
    const provider = targetProvider({
      followersPages: [[item("f1"), item("f2"), item("f3"), item("f4")]],
      followingPages: [[item("g1"), item("g2"), item("g3")]],
    });

    const events = await consume(collectTarget(
      { ...bothRequest, maxFollowers: 2, maxFollowing: 3 },
      provider,
    ));

    expect(collectionSummary(events, "followers").completeness.terminationReason)
      .toBe("MAX_LIMIT_REACHED");
    expect(collectionSummary(events, "following").completeness.terminationReason)
      .toBe("SOURCE_EXHAUSTED");
    expect(targetSummary(events).status).toBe("SUCCESS");
    const followers = events
      .filter((event): event is Extract<TargetStreamEvent, { type: "relationship" }> =>
        event.type === "relationship" && event.value.relationship === "followers");
    expect(followers).toHaveLength(2);
  });

  it("collects followers only for followers-mode scrape type", async () => {
    const provider = targetProvider();

    const events = await consume(collectTarget(
      { ...bothRequest, scrapeType: "followers" },
      provider,
    ));

    expect(provider.followersCalls).toBe(1);
    expect(provider.followingCalls).toBe(0);
    const summaries = events.filter((event) => event.type === "collectionSummary");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { value: { relationship: string } }).value.relationship).toBe("followers");
    expect(targetSummary(events).status).toBe("SUCCESS");
  });

  it("ends with one FAILED target summary when profile resolution is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = targetProvider();
    (provider.resolveProfile as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    );

    const events = await consume(collectTarget(
      { ...bothRequest, signal: controller.signal },
      provider,
      { retry: fastRetry },
    ));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "targetSummary",
      value: { status: "FAILED", collections: [] },
    });
    expect(provider.followersCalls).toBe(0);
  });

  it("derives target status from emitted summaries only", () => {
    const summary = (reason: RelationshipCollectionSummary["completeness"]["terminationReason"]): RelationshipCollectionSummary => ({
      runId: "run-1",
      targetId: "target-1",
      platform: "instagram",
      sourceProfile: resolvedProfile,
      relationship: "followers",
      completeness: { complete: reason === "SOURCE_EXHAUSTED", terminationReason: reason },
      metrics: {
        rawItemsReceived: 0,
        uniqueItemsProduced: 0,
        duplicatesRemoved: 0,
        requestsMade: 0,
        requestsFailed: 0,
        requestsRetried: 0,
        bytesTransferred: null,
        runtimeMs: 0,
      },
    });

    expect(deriveTargetStatus([summary("SOURCE_EXHAUSTED"), summary("MAX_LIMIT_REACHED")]))
      .toBe("SUCCESS");
    expect(deriveTargetStatus([summary("SOURCE_EXHAUSTED"), summary("ERROR")]))
      .toBe("PARTIAL");
    expect(deriveTargetStatus([summary("ABORTED"), summary("ERROR")]))
      .toBe("FAILED");
    expect(deriveTargetStatus([])).toBe("FAILED");
    expect(deriveTargetStatus([summary("SOURCE_EXHAUSTED")], 2)).toBe("PARTIAL");
    expect(deriveTargetStatus([], 2)).toBe("FAILED");
  });

  it("reports FAILED when every requested collection errors after a successful profile", async () => {
    const provider = targetProvider();
    (provider as unknown as {
      fetchFollowersPage: ReturnType<typeof vi.fn>;
    }).fetchFollowersPage.mockRejectedValue(
      Object.assign(new Error("gone"), { category: "PROVIDER_UNAVAILABLE", retryable: false }),
    );
    (provider as unknown as {
      fetchFollowingPage: ReturnType<typeof vi.fn>;
    }).fetchFollowingPage.mockRejectedValue(
      Object.assign(new Error("gone"), { category: "PROVIDER_UNAVAILABLE", retryable: false }),
    );

    const events = await consume(collectTarget(bothRequest, provider, { retry: fastRetry }));

    expect(targetSummary(events).status).toBe("FAILED");
    expect(targetSummary(events).collections).toHaveLength(2);
  });
});
