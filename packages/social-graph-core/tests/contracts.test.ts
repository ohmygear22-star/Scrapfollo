import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CollectionCompleteness,
  CoreRunMetrics,
  Platform,
  RelationshipStreamEvent,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "../src/index.js";

describe("public contracts", () => {
  it("exposes provider and authoritative stream contracts", () => {
    expectTypeOf<SocialGraphProvider>().toBeObject();
    expectTypeOf<Platform>().toEqualTypeOf<"instagram" | "x" | "tiktok">();
    expectTypeOf<SocialGraphProviderCapabilities>().toMatchTypeOf<{
      profileLookup: boolean;
      followerCount: boolean;
      followingCount: boolean;
      followerIdentities: boolean;
      followingIdentities: boolean;
      pagination: boolean;
      stableUserIds: boolean;
    }>();
    expectTypeOf<RelationshipStreamEvent>().toMatchTypeOf<
      | { type: "relationship"; value: unknown }
      | { type: "summary"; value: unknown }
    >();
    expectTypeOf<CoreRunMetrics>().toEqualTypeOf<
      Readonly<{
        profilesRequested: number;
        profilesSuccessful: number;
        profilesFailed: number;
        profilesPartial: number;
        followersReturned: number;
        followingReturned: number;
        totalRelationshipsReturned: number;
        rawItemsReceived: number;
        uniqueItemsProduced: number;
        duplicatesRemoved: number;
        requestsMade: number;
        requestsFailed: number;
        requestsRetried: number;
        bytesTransferred: number | null;
        runtimeMs: number;
      }>
    >();
    const value: CollectionCompleteness = {
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    };
    expect(value.complete).toBe(false);
  });
});
