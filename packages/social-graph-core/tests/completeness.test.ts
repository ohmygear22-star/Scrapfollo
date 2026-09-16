import { describe, expect, it, vi } from "vitest";
import { collectRelationships, completeCollection } from "../src/index.js";
import type {
  CollectRelationshipRequest,
  CompletenessOutcome,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  PublicCollectionError,
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

const publicError: PublicCollectionError = {
  category: "SOURCE_TEMPORARILY_UNAVAILABLE",
  message: "The source is temporarily unavailable",
  retryable: true,
  platform: "instagram",
  targetId: "target-1",
};

const outcomes: ReadonlyArray<[CompletenessOutcome["outcome"], ReturnType<typeof completeCollection>]> = [
  ["source", { complete: true, terminationReason: "SOURCE_EXHAUSTED" }],
  ["max", { complete: false, terminationReason: "MAX_LIMIT_REACHED" }],
  ["error", { complete: false, terminationReason: "ERROR", error: publicError }],
  ["abort", { complete: false, terminationReason: "ABORTED" }],
];

describe("completeCollection authoritative mapping", () => {
  it.each(outcomes)("maps %s to its approved completeness", (outcome, expected) => {
    const result = completeCollection(
      outcome === "error" ? { outcome, error: publicError } : { outcome },
    );
    expect(result).toEqual(expected);
  });

  it("attaches an error only to the ERROR outcome", () => {
    for (const outcome of ["source", "max", "abort"] as const) {
      expect(completeCollection({ outcome }).error).toBeUndefined();
    }
  });

  it("keeps SOURCE_EXHAUSTED as the sole complete outcome", () => {
    for (const [outcome] of outcomes) {
      const result = completeCollection(
        outcome === "error" ? { outcome, error: publicError } : { outcome },
      );
      expect(result.complete).toBe(outcome === "source");
    }
  });
});

function providerFor(options: {
  pages?: ReadonlyArray<{ items: ProviderRelationshipItem[]; hasMore: boolean; nextCursor?: string }>;
} = {}): SocialGraphProvider {
  const pages = options.pages ?? [];
  let calls = 0;
  return {
    providerName: "completeness-test-provider",
    platform: "instagram",
    capabilities: { ...capabilities },
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      const spec = pages[calls];
      calls += 1;
      if (spec === undefined) {
        return { items: [], hasMore: false, requestMetadata: { attempts: 1, durationMs: 1 } };
      }
      return {
        items: spec.items,
        hasMore: spec.hasMore,
        ...(spec.nextCursor === undefined ? {} : { nextCursor: spec.nextCursor }),
        requestMetadata: { attempts: 1, durationMs: 1 },
      };
    }),
    fetchFollowingPage: vi.fn(),
  };
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function summaries(events: ReadonlyArray<RelationshipStreamEvent>) {
  return events.filter((event) => event.type === "summary");
}

const fastRetry = {
  policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  sleep: async () => {},
};

describe("terminal summary invariants over streams", () => {
  it("emits exactly one summary after rows and no later relationship on error", async () => {
    const failingProvider = {
      providerName: "completeness-failing-provider",
      platform: "instagram",
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (input: { cursor?: string }) => {
        if (input.cursor === undefined) {
          return {
            items: [row("u1"), row("u2")],
            hasMore: true,
            nextCursor: "opaque-1",
            requestMetadata: { attempts: 1, durationMs: 1 },
          } satisfies ProviderRelationshipPage;
        }
        throw Object.assign(new Error("boom"), {
          category: "SOURCE_TEMPORARILY_UNAVAILABLE",
          retryable: true,
        });
      }),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      failingProvider,
      { retry: fastRetry },
    ));

    expect(events.filter((event) => event.type === "relationship")).toHaveLength(2);
    expect(summaries(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("summary");
    expect(summaries(events)[0]).toMatchObject({
      value: {
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "SOURCE_TEMPORARILY_UNAVAILABLE" },
        },
      },
    });
  });

  it("ends a complete run with exactly one SOURCE_EXHAUSTED summary", async () => {
    const provider = providerFor({
      pages: [{ items: [row("u1")], hasMore: false }],
    });

    const events = await consume(collectRelationships(request, sourceProfile, provider));

    expect(summaries(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" } },
    });
  });

  it("ends an aborted run with exactly one ABORTED summary", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await consume(collectRelationships(
      { ...request, signal: controller.signal },
      sourceProfile,
      providerFor(),
    ));

    expect(summaries(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "ABORTED" } },
    });
  });

  it("emits rows before an ABORTED summary when abort lands between pages", async () => {
    const controller = new AbortController();
    const provider = {
      providerName: "abort-between-pages-provider",
      platform: "instagram",
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;

    const firstPage = {
      providerName: "first-page-provider",
      platform: "instagram",
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
        if (!controller.signal.aborted) {
          controller.abort();
          return {
            items: [row("u1"), row("u2")],
            hasMore: true,
            nextCursor: "opaque-1",
            requestMetadata: { attempts: 1, durationMs: 1 },
          };
        }
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
      fetchFollowingPage: vi.fn(),
    } as unknown as SocialGraphProvider;
    void provider;

    const events = await consume(collectRelationships(
      { ...request, signal: controller.signal },
      sourceProfile,
      firstPage,
      { retry: fastRetry },
    ));

    expect(events.filter((event) => event.type === "relationship")).toHaveLength(2);
    expect(summaries(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "ABORTED" } },
    });
  });

  it("ends a max-limited run with exactly one non-error MAX_LIMIT_REACHED summary", async () => {
    const provider = providerFor({
      pages: [{ items: [row("u1"), row("u2"), row("u3"), row("u4")], hasMore: false }],
    });

    const events = await consume(collectRelationships(
      { ...request, maxResults: 3 },
      sourceProfile,
      provider,
    ));

    expect(summaries(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "MAX_LIMIT_REACHED" } },
    });
    expect((summaries(events)[0] as { value: { completeness: { error?: unknown } } }).value.completeness.error)
      .toBeUndefined();
  });
});
