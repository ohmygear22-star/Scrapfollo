import { describe, expect, it, vi } from "vitest";
import { collectRelationships } from "../src/index.js";
import type {
  CollectRelationshipRequest,
  Platform,
  ProviderProfile,
  ProviderRelationshipItem,
  RelationshipStreamEvent,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
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

function providerFor(options: {
  platform?: Platform;
  capabilities?: Partial<SocialGraphProviderCapabilities>;
  items?: ProviderRelationshipItem[];
  hasMore?: boolean;
  pageError?: unknown;
} = {}): SocialGraphProvider & {
  pageCalls: number;
  resolveProfile: ReturnType<typeof vi.fn>;
  fetchFollowersPage: ReturnType<typeof vi.fn>;
  fetchFollowingPage: ReturnType<typeof vi.fn>;
} {
  const platform = options.platform ?? "instagram";
  const resolvedProfile: ProviderProfile = {
    platform,
    platformUserId: "source-id",
    username: "source",
  };
  const provider = {
    providerName: "single-page-test-provider",
    platform,
    capabilities: { ...capabilities, ...options.capabilities },
    pageCalls: 0,
    resolveProfile: vi.fn().mockResolvedValue(resolvedProfile),
    fetchFollowersPage: vi.fn(async () => {
      provider.pageCalls += 1;
      if (options.pageError !== undefined) throw options.pageError;
      return {
        items: options.items ?? [{ platform, platformUserId: "user-1", username: "alice" }],
        hasMore: options.hasMore ?? false,
        requestMetadata: { attempts: 1, durationMs: 4 },
      };
    }),
    fetchFollowingPage: vi.fn(async () => {
      provider.pageCalls += 1;
      if (options.pageError !== undefined) throw options.pageError;
      return {
        items: options.items ?? [{ platform, platformUserId: "user-1", username: "alice" }],
        hasMore: options.hasMore ?? false,
        requestMetadata: { attempts: 1, durationMs: 4 },
      };
    }),
  };
  return provider;
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("collectRelationships single-page streaming", () => {
  it("does not request data until pulled and yields rows before one terminal summary", async () => {
    const provider = providerFor();
    const stream = collectRelationships(request, sourceProfile, provider, {
      now: () => new Date("2026-09-15T01:02:03.000Z"),
    });

    expect(provider.pageCalls).toBe(0);
    const first = await stream.next();
    expect(provider.pageCalls).toBe(1);
    expect(first).toMatchObject({
      done: false,
      value: {
        type: "relationship",
        value: {
          platform: "instagram",
          sourceUserId: "source-id",
          sourceUsername: "source",
          relationship: "followers",
          userId: "user-1",
          username: "alice",
          position: 1,
          scrapedAt: "2026-09-15T01:02:03.000Z",
        },
      },
    });
    const second = await stream.next();
    expect(second).toMatchObject({
      done: false,
      value: {
        type: "summary",
        value: {
          completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" },
        },
      },
    });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it.each([
    ["followers", "followerIdentities"],
    ["following", "followingIdentities"],
  ] as const)("rejects %s when %s is unsupported without requesting a page", async (relationship, capability) => {
    const provider = providerFor({ capabilities: { [capability]: false } });
    const events = await consume(collectRelationships(
      { ...request, relationship },
      sourceProfile,
      provider,
    ));

    expect(events).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: {
        relationship,
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "CAPABILITY_UNSUPPORTED" },
        },
      },
    });
    expect(provider.pageCalls).toBe(0);
  });

  it("uses the relationship-specific provider operation", async () => {
    const provider = providerFor();
    await consume(collectRelationships(
      { ...request, relationship: "following" },
      sourceProfile,
      provider,
    ));

    expect(provider.fetchFollowersPage).not.toHaveBeenCalled();
    expect(provider.fetchFollowingPage).toHaveBeenCalledOnce();
  });

  it("normalizes an allowlist, preserves platform, and never leaks provider-only fields", async () => {
    const provider = providerFor({
      items: [{
        platform: "instagram",
        platformUserId: "user-1",
        username: "alice",
        fullName: "Alice Example",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://example.test/alice.jpg",
        rawResponse: { token: "secret" },
      } as ProviderRelationshipItem],
    });

    const [event] = await consume(collectRelationships(request, sourceProfile, provider));

    expect(event).toEqual({
      type: "relationship",
      value: {
        platform: "instagram",
        sourceUserId: "source-id",
        sourceUsername: "source",
        relationship: "followers",
        userId: "user-1",
        username: "alice",
        fullName: "Alice Example",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://example.test/alice.jpg",
        position: 1,
        scrapedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("rawResponse");
  });

  it("returns INVALID_INPUT without yielding a mismatched-platform relationship", async () => {
    const provider = providerFor({
      items: [{ platform: "x", platformUserId: "x-user", username: "wrong" }],
    });

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "summary",
      value: {
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "INVALID_INPUT" },
        },
      },
    });
  });

  it("assigns one-based positions while yielding rows individually", async () => {
    const provider = providerFor({
      items: [
        { platform: "instagram", platformUserId: "user-1", username: "alice" },
        { platform: "instagram", platformUserId: "user-2", username: "bob" },
      ],
    });
    const iterator = collectRelationships(request, sourceProfile, provider);

    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value).toMatchObject({ type: "relationship", value: { position: 1 } });
    expect(second.value).toMatchObject({ type: "relationship", value: { position: 2 } });
    expect((await iterator.next()).value).toMatchObject({ type: "summary" });
  });

  it("uses the already-resolved profile and never resolves it internally", async () => {
    const provider = providerFor();
    provider.resolveProfile.mockRejectedValue(new Error("must not be called"));

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(provider.resolveProfile).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: "relationship",
      value: { sourceUserId: "source-id", sourceUsername: "source" },
    });
  });

  it("ends a post-profile page failure with exactly one ERROR summary using the real profile", async () => {
    const provider = providerFor({
      pageError: Object.assign(new Error("provider failed"), {
        category: "PROVIDER_UNAVAILABLE",
        retryable: true,
      }),
    });

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      provider,
      { retry: { policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } },
    ));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "summary",
      value: {
        sourceProfile,
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "PROVIDER_UNAVAILABLE" },
        },
      },
    });
  });

  it("ends an unexpected hasMore page with one PAGINATION_FAILED summary and no second request", async () => {
    const provider = providerFor({ hasMore: true });

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(provider.pageCalls).toBe(1);
    expect(events.filter((event) => event.type === "summary")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: {
        sourceProfile,
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "PAGINATION_FAILED" },
        },
      },
    });
  });

  it("ends a terminal page with exactly one SOURCE_EXHAUSTED summary", async () => {
    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      providerFor({ hasMore: false }),
    ));

    const summaries = events.filter((event) => event.type === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      value: {
        sourceProfile,
        completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" },
      },
    });
  });
});
