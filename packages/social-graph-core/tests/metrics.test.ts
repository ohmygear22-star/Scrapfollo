import { describe, expect, it, vi } from "vitest";
import {
  collectRelationships,
  collectTargets,
  derivePerThousand,
} from "../src/index.js";
import type {
  CollectRelationshipRequest,
  CollectTargetsRequest,
  CoreRunMetrics,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  RelationshipCollectionMetrics,
  RelationshipStreamEvent,
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

const request: CollectRelationshipRequest = {
  runId: "run-1",
  targetId: "target-1",
  platform: "instagram",
  username: "source",
  relationship: "followers",
};

const sourceProfile: ProviderProfile = {
  platform: "instagram",
  platformUserId: "source-id",
  username: "source",
};

function item(userId: string): ProviderRelationshipItem {
  return { platform: "instagram", platformUserId: userId, username: userId };
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function finalMetrics(events: ReadonlyArray<RelationshipStreamEvent>): RelationshipCollectionMetrics {
  const summary = events.at(-1);
  if (summary?.type !== "summary") throw new Error("terminal summary missing");
  return summary.value.metrics;
}

const fastRetry = {
  policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  sleep: async () => {},
};

describe("relationship collection metrics", () => {
  it("counts raw, unique, duplicate, failed, and retried work with summed bytes", async () => {
    let calls = 0;
    const provider = {
      providerName: "metrics-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("flaky"), {
            category: "SOURCE_TEMPORARILY_UNAVAILABLE",
            retryable: true,
          });
        }
        const isFirstPage = calls === 2;
        const items = isFirstPage ? [item("u1"), item("u2")] : [item("u2"), item("u3")];
        return {
          items,
          hasMore: isFirstPage,
          ...(isFirstPage ? { nextCursor: "opaque-1" } : {}),
          requestMetadata: { attempts: 1, durationMs: 5, bytesTransferred: 300 },
        };
      }),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      provider,
      { retry: fastRetry },
    ));

    expect(finalMetrics(events)).toMatchObject({
      rawItemsReceived: 4,
      uniqueItemsProduced: 3,
      duplicatesRemoved: 1,
      requestsMade: 3,
      requestsFailed: 1,
      requestsRetried: 1,
      bytesTransferred: 600,
    });
  });

  it("does not add provider diagnostic attempts to core request counters", async () => {
    const provider = {
      providerName: "diagnostic-attempts-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => ({
        items: [item("u1")],
        hasMore: false,
        requestMetadata: { attempts: 7, durationMs: 5 },
      })),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(finalMetrics(events)).toMatchObject({
      requestsMade: 1,
      requestsFailed: 0,
      requestsRetried: 0,
    });
  });

  it("reports null bytes when the provider never measures bytes", async () => {
    const provider = {
      providerName: "no-bytes-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => ({
        items: [item("u1")],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 5 },
      })),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(finalMetrics(events).bytesTransferred).toBeNull();
  });

  it("measures runtime with the injected monotonic clock", async () => {
    let clock = 1_000;
    const provider = {
      providerName: "clock-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
        clock += 250;
        return {
          items: [item("u1")],
          hasMore: false,
          requestMetadata: { attempts: 1, durationMs: 5 },
        };
      }),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const events = await consume(collectRelationships(request, sourceProfile, provider, {
      monotonicNow: () => clock,
    }));

    expect(finalMetrics(events).runtimeMs).toBeGreaterThanOrEqual(250);
  });
});

describe("derivePerThousand", () => {
  const collectionMetrics: RelationshipCollectionMetrics = {
    rawItemsReceived: 4,
    uniqueItemsProduced: 250,
    duplicatesRemoved: 1,
    requestsMade: 3,
    requestsFailed: 0,
    requestsRetried: 0,
    bytesTransferred: 600,
    runtimeMs: 1_000,
  };

  it("returns null rates for zero results", () => {
    expect(derivePerThousand({ ...collectionMetrics, uniqueItemsProduced: 0 })).toEqual({
      requestsPer1000Results: null,
      secondsPer1000Results: null,
    });
  });

  it("derives per-thousand rates from measured work", () => {
    expect(derivePerThousand(collectionMetrics)).toEqual({
      requestsPer1000Results: 12,
      secondsPer1000Results: 4,
    });
  });

  it("derives run-level rates from returned relationships", () => {
    const runMetrics: CoreRunMetrics = {
      profilesRequested: 1,
      profilesSuccessful: 1,
      profilesFailed: 0,
      profilesPartial: 0,
      followersReturned: 250,
      followingReturned: 0,
      totalRelationshipsReturned: 250,
      rawItemsReceived: 250,
      uniqueItemsProduced: 250,
      duplicatesRemoved: 0,
      requestsMade: 5,
      requestsFailed: 0,
      requestsRetried: 0,
      bytesTransferred: null,
      runtimeMs: 2_000,
    };

    expect(derivePerThousand(runMetrics)).toEqual({
      requestsPer1000Results: 20,
      secondsPer1000Results: 8,
    });
  });
});

describe("core run metrics over a multi-target batch", () => {
  it("aggregates profiles, rows, requests, and bytes across targets", async () => {
    let profileCalls = 0;
    const instagram = {
      providerName: "run-instagram",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(async () => {
        profileCalls += 1;
        return { platform: "instagram", platformUserId: "ig-1", username: "alpha" };
      }),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => ({
        items: [item("u1"), item("u2")],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 2, bytesTransferred: 120 },
      })),
      fetchFollowingPage: vi.fn(async (): Promise<ProviderRelationshipPage> => ({
        items: [],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 1 },
      })),
    } as unknown as SocialGraphProvider;
    const x = {
      providerName: "run-x",
      platform: "x" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(async () => {
        profileCalls += 1;
        throw Object.assign(new Error("gone"), { category: "PROFILE_NOT_FOUND", retryable: false });
      }),
      fetchFollowersPage: vi.fn(),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const batchRequest: CollectTargetsRequest = {
      runId: "run-1",
      scrapeType: "followers",
      concurrency: 2,
      targets: [
        { targetId: "t1", platform: "instagram", username: "alpha" },
        { targetId: "t2", platform: "x", username: "beta" },
      ],
    };

    let runMetrics: CoreRunMetrics | undefined;
    const events: TargetStreamEvent[] = [];
    for await (const event of collectTargets(batchRequest, new Map([
      ["instagram", instagram],
      ["x", x],
    ]), {
      retry: fastRetry,
      onRunMetrics: (metrics) => {
        runMetrics = metrics;
      },
    })) {
      events.push(event);
    }

    expect(runMetrics).toMatchObject({
      profilesRequested: 2,
      profilesSuccessful: 1,
      profilesFailed: 1,
      profilesPartial: 0,
      followersReturned: 2,
      followingReturned: 0,
      totalRelationshipsReturned: 2,
      rawItemsReceived: 2,
      uniqueItemsProduced: 2,
      duplicatesRemoved: 0,
      // 1 profile lookup + 1 page request for instagram; 1 non-retryable failed profile lookup for x.
      requestsMade: 2 + 1,
      bytesTransferred: 120,
    });
    expect(profileCalls).toBeGreaterThanOrEqual(2);
    expect(runMetrics?.runtimeMs).toBeGreaterThanOrEqual(0);
  });
});
