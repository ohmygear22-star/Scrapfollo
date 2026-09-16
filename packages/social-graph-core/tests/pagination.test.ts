import { describe, expect, it, vi } from "vitest";
import { collectRelationships } from "../src/index.js";
import type {
  CollectRelationshipRequest,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
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

const row = (platformUserId: string): ProviderRelationshipItem => ({
  platform: "instagram",
  platformUserId,
  username: platformUserId,
});

const page = (
  items: ProviderRelationshipItem[],
  pagination: Pick<ProviderRelationshipPage, "hasMore" | "nextCursor">,
): ProviderRelationshipPage => ({
  items,
  ...pagination,
  requestMetadata: { attempts: 1, durationMs: 1 },
});

function providerFor(
  pages: ProviderRelationshipPage[],
  options: { capabilities?: Partial<SocialGraphProviderCapabilities> } = {},
): SocialGraphProvider & { pageCalls: number; fetchFollowersPage: ReturnType<typeof vi.fn> } {
  const provider = {
    providerName: "pagination-test-provider",
    platform: "instagram" as const,
    capabilities: { ...capabilities, ...options.capabilities },
    pageCalls: 0,
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async () => {
      const nextPage = pages[provider.pageCalls];
      provider.pageCalls += 1;
      if (nextPage === undefined) throw new Error("unexpected page request");
      return nextPage;
    }),
    fetchFollowingPage: vi.fn(),
  };
  return provider;
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("collectRelationships pagination", () => {
  it("requests the next page only after current-page rows are consumed", async () => {
    const twoPageProvider = providerFor([
      page([row("u1")], { hasMore: true, nextCursor: "opaque-next-token" }),
      page([row("u2")], { hasMore: false }),
    ]);
    const iterator = collectRelationships(request, sourceProfile, twoPageProvider);

    await iterator.next();
    expect(twoPageProvider.pageCalls).toBe(1);
    const second = await iterator.next();
    expect(twoPageProvider.pageCalls).toBe(2);
    expect(second.value).toMatchObject({ type: "relationship", value: { userId: "u2", position: 2 } });
    expect((await iterator.next()).value).toMatchObject({ type: "summary", value: { completeness: { complete: true } } });
  });

  it.each(["missing", "repeated"] as const)(
    "ends with PAGINATION_FAILED for a %s next cursor",
    async (mode) => {
      const anomalous = mode === "missing"
        ? [page([row("u1")], { hasMore: true })]
        : [
          page([row("u1")], { hasMore: true, nextCursor: "same-opaque-token" }),
          page([row("u2")], { hasMore: true, nextCursor: "same-opaque-token" }),
        ];

      const events = await consume(collectRelationships(
        request,
        sourceProfile,
        providerFor(anomalous),
      ));

      expect(events.filter((event) => event.type === "summary")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "summary",
        value: { completeness: { complete: false, terminationReason: "ERROR", error: { category: "PAGINATION_FAILED" } } },
      });
    },
  );

  it("rejects a next page from a provider that declares pagination false", async () => {
    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      providerFor(
        [page([row("u1")], { hasMore: true, nextCursor: "unexpected" })],
        { capabilities: { pagination: false } },
      ),
    ));

    expect(events.at(-1)).toMatchObject({
      value: { completeness: { error: { category: "PAGINATION_FAILED" } } },
    });
  });
});
