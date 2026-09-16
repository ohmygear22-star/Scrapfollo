import { describe, expect, it, vi } from "vitest";
import {
  collectRelationships,
  ExactDeduplicator,
  relationshipDedupeKey,
} from "../src/index.js";
import type {
  CollectRelationshipRequest,
  ProviderProfile,
  ProviderRelationshipItem,
  RelationshipStreamEvent,
  RelationshipType,
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

function row(input: Partial<ProviderRelationshipItem> = {}): ProviderRelationshipItem {
  return {
    platform: "instagram",
    username: "user",
    ...input,
  };
}

function providerWith(
  capabilityOverrides: Partial<SocialGraphProviderCapabilities>,
  pages: ReadonlyArray<ReadonlyArray<ProviderRelationshipItem>>,
): SocialGraphProvider {
  return {
    providerName: "deduplication-test-provider",
    platform: "instagram",
    capabilities: { ...capabilities, ...capabilityOverrides },
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async ({ cursor }) => {
      const pageIndex = cursor === undefined ? 0 : Number(cursor);
      return {
        items: [...(pages[pageIndex] ?? [])],
        hasMore: pageIndex < pages.length - 1,
        ...(pageIndex < pages.length - 1 ? { nextCursor: String(pageIndex + 1) } : {}),
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

function relationships(events: ReadonlyArray<RelationshipStreamEvent>) {
  return events
    .filter((event): event is Extract<RelationshipStreamEvent, { type: "relationship" }> => (
      event.type === "relationship"
    ))
    .map((event) => event.value);
}

function base(input: {
  platform?: "instagram" | "x";
  sourceUserId?: string;
  relationship?: RelationshipType;
  platformUserId?: string;
  username?: string;
  stableUserIds?: boolean;
} = {}) {
  return {
    platform: "instagram" as const,
    sourceUserId: "source-id",
    relationship: "followers" as const,
    platformUserId: "42",
    username: "User",
    stableUserIds: false,
    ...input,
  };
}

describe("exact streamed relationship deduplication", () => {
  it("deduplicates overlapping pages by stable platform ID", async () => {
    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      providerWith({}, [
        [row({ platformUserId: "u1", username: "first" }), row({ platformUserId: "u2", username: "second" })],
        [row({ platformUserId: "u2", username: "renamed-second" }), row({ platformUserId: "u3", username: "third" })],
      ]),
    ));

    const rows = relationships(events);
    expect(rows.map((item) => item.userId)).toEqual(["u1", "u2", "u3"]);
    expect(rows.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: {
        metrics: {
          rawItemsReceived: 4,
          uniqueItemsProduced: 3,
          duplicatesRemoved: 1,
          requestsMade: 2,
        },
      },
    });
  });

  it("uses source, relationship, and normalized username only when ID is absent", () => {
    expect(relationshipDedupeKey(base({ platformUserId: undefined, username: " User " })))
      .toBe(relationshipDedupeKey(base({ platformUserId: undefined, username: "user" })));
    expect(relationshipDedupeKey(base({ platformUserId: undefined, sourceUserId: "other-source" })))
      .not.toBe(relationshipDedupeKey(base({ platformUserId: undefined })));
    expect(relationshipDedupeKey(base({ platformUserId: undefined, relationship: "following" })))
      .not.toBe(relationshipDedupeKey(base({ platformUserId: undefined })));
  });

  it("uses the username fallback when provider IDs are not declared stable", async () => {
    const rows = relationships(await consume(collectRelationships(
      request,
      sourceProfile,
      providerWith({ stableUserIds: false }, [[
        row({ platformUserId: "unstable-1", username: "Same" }),
        row({ platformUserId: "unstable-2", username: "same" }),
      ]]),
    )));

    expect(rows).toHaveLength(1);
  });

  it("keeps otherwise identical identities separate across platforms", () => {
    expect(relationshipDedupeKey(base({ platform: "instagram", stableUserIds: true })))
      .not.toBe(relationshipDedupeKey(base({ platform: "x", stableUserIds: true })));
    expect(relationshipDedupeKey(base({ platform: "instagram", platformUserId: undefined })))
      .not.toBe(relationshipDedupeKey(base({ platform: "x", platformUserId: undefined })));
  });

  it("falls back to username identity when a stable-ID provider omits an item ID", () => {
    expect(relationshipDedupeKey(base({
      stableUserIds: true,
      platformUserId: undefined,
      username: "Same",
    }))).toBe(relationshipDedupeKey(base({
      stableUserIds: true,
      platformUserId: undefined,
      username: " same ",
    })));
    expect(relationshipDedupeKey(base({
      stableUserIds: true,
      platformUserId: undefined,
    }))).not.toBe(relationshipDedupeKey(base({
      stableUserIds: true,
      platformUserId: "42",
    })));
  });

  it("encodes key fields without delimiter-collision ambiguity", () => {
    expect(relationshipDedupeKey(base({
      platformUserId: undefined,
      sourceUserId: "source:followers",
      relationship: "following",
      username: "user",
    }))).not.toBe(relationshipDedupeKey(base({
      platformUserId: undefined,
      sourceUserId: "source",
      relationship: "followers",
      username: "following:user",
    })));
  });

  it("retains only accepted keys in the exact deduplicator", () => {
    const deduplicator = new ExactDeduplicator();

    expect(deduplicator.accept("one")).toBe(true);
    expect(deduplicator.accept("one")).toBe(false);
    expect(deduplicator.accept("two")).toBe(true);
  });
});
