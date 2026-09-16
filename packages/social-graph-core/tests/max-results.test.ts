import { describe, expect, it, vi } from "vitest";
import { collectRelationships } from "../src/index.js";
import type {
  CollectRelationshipRequest,
  Platform,
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

function row(userId: string): ProviderRelationshipItem {
  return { platform: "instagram", platformUserId: userId, username: userId };
}

type TestPage = {
  items: ProviderRelationshipItem[];
  hasMore: boolean;
  nextCursor?: string;
};

function page(
  items: ProviderRelationshipItem[],
  options: { hasMore?: boolean; nextCursor?: string } = {},
): TestPage {
  return {
    items,
    hasMore: options.hasMore ?? false,
    ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
  };
}

function providerWithPages(
  pages: ReadonlyArray<TestPage>,
): SocialGraphProvider & { pageCalls: number } {
  const platform: Platform = "instagram";
  const provider = {
    providerName: "max-results-test-provider",
    platform,
    capabilities: { ...capabilities },
    pageCalls: 0,
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      provider.pageCalls += 1;
      const spec = pages[provider.pageCalls - 1];
      if (spec === undefined) {
        throw new Error(`unexpected page request #${provider.pageCalls}`);
      }
      return {
        items: spec.items,
        hasMore: spec.hasMore,
        ...(spec.nextCursor === undefined ? {} : { nextCursor: spec.nextCursor }),
        requestMetadata: { attempts: 1, durationMs: 4 },
      };
    }),
    fetchFollowingPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      throw new Error("following not requested in this suite");
    }),
  };
  return provider;
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function relationships(events: ReadonlyArray<RelationshipStreamEvent>) {
  return events
    .filter((event): event is Extract<RelationshipStreamEvent, { type: "relationship" }> =>
      event.type === "relationship")
    .map((event) => event.value);
}

function finalSummary(events: ReadonlyArray<RelationshipStreamEvent>) {
  const summary = events.at(-1);
  if (summary?.type !== "summary") throw new Error("terminal summary missing");
  return summary.value;
}

describe("exact maximum-result termination", () => {
  it("A: reports MAX_LIMIT_REACHED when the source has more results than max", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2"), row("u3")], { hasMore: true, nextCursor: "opaque-next" }),
      page([row("u4")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(1);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
  });

  it("B: reports SOURCE_EXHAUSTED when a terminal page contains exactly max unique rows", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2"), row("u3")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(1);
    expect(finalSummary(events).completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
  });

  it("C: reports MAX_LIMIT_REACHED when a terminal page has a later unique row", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2"), row("u3"), row("u4")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(1);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
    expect(finalSummary(events).metrics).toMatchObject({
      rawItemsReceived: 4,
      uniqueItemsProduced: 3,
      duplicatesRemoved: 0,
      requestsMade: 1,
    });
  });

  it("D: reports SOURCE_EXHAUSTED when the terminal-page remainder contains only duplicates", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2"), row("u3"), row("u2"), row("u1")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(1);
    expect(finalSummary(events).completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
    expect(finalSummary(events).metrics).toMatchObject({
      rawItemsReceived: 5,
      uniqueItemsProduced: 3,
      duplicatesRemoved: 2,
    });
  });

  it("stops at max across pages without fetching the next page", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2")], { hasMore: true, nextCursor: "opaque-1" }),
      page([row("u3")], { hasMore: true, nextCursor: "opaque-2" }),
      page([row("u4")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(2);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
  });

  it("reports MAX_LIMIT_REACHED when max lands mid-page with more uniques on the same page", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2"), row("u3"), row("u4")], { hasMore: true, nextCursor: "opaque-1" }),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(provider.pageCalls).toBe(1);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
    expect(finalSummary(events).completeness.error).toBeUndefined();
  });

  it("counts only unique rows toward max when duplicates precede the boundary", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u1"), row("u2"), row("u3"), row("u4")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
    expect(finalSummary(events).metrics).toMatchObject({
      rawItemsReceived: 5,
      uniqueItemsProduced: 3,
      duplicatesRemoved: 1,
    });
  });

  it("supports maxResults of one as the minimum boundary", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 1 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events).map((row) => row.userId)).toEqual(["u1"]);
    expect(finalSummary(events).completeness).toEqual({
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    });
  });

  it("reports SOURCE_EXHAUSTED below max when the source ends early", async () => {
    const provider = providerWithPages([
      page([row("u1"), row("u2")]),
    ]);

    const events = await consume(collectRelationships(
      { ...request, maxResults: 5 },
      sourceProfile,
      provider,
    ));

    expect(relationships(events)).toHaveLength(2);
    expect(finalSummary(events).completeness).toEqual({
      complete: true,
      terminationReason: "SOURCE_EXHAUSTED",
    });
  });

  it.each([0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1] as const)(
    "rejects invalid maxResults %s without a page request",
    async (maxResults) => {
      const provider = providerWithPages([page([row("u1")])]);

      const events = await consume(collectRelationships(
        { ...request, maxResults },
        sourceProfile,
        provider,
      ));

      expect(provider.pageCalls).toBe(0);
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
    },
  );
});
