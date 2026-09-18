import { describe, expect, it } from "vitest";
import {
  aggregateSceneCaptures,
  classifySceneAggregate,
  mapTikTokUser,
  parseProfileCounts,
} from "../src/parsing.js";
import {
  TikTokSessionProvider,
  type TikTokBrowserSession,
} from "../src/tiktok-session-provider.js";

const CONTEXT = { runId: "run-1", targetId: "target-1" } as const;

function pageBody(total: number, hasMore: boolean, users: unknown[]) {
  return JSON.stringify({ total, hasMore, userList: users });
}

describe("tiktok parsing", () => {
  it("parses compact headers and maps full users", () => {
    expect(parseProfileCounts("81 Following 162.9M Followers 2.7B Likes")).toEqual({
      following: 81,
      followers: 162_900_000,
    });
    const item = mapTikTokUser({
      user: {
        secUid: "MS4wSec",
        uniqueId: "mrbeast",
        nickname: "MrBeast",
        verified: true,
        avatarLarger: "https://pic.test/a.jpg",
      },
    });
    expect(item).toEqual({
      platform: "tiktok",
      platformUserId: "MS4wSec",
      username: "mrbeast",
      fullName: "MrBeast",
      isVerified: true,
      profilePicUrl: "https://pic.test/a.jpg",
    });
  });

  it("deduplicates scroll pages and rejects identity-less entries", () => {
    const captures = [
      { url: "https://www.tiktok.com/api/user/list/?scene=151&a=1", bodyText: pageBody(81, true, [
        { user: { secUid: "s1", uniqueId: "one" } },
        { user: { secUid: "s2", uniqueId: "two" } },
      ]) },
      { url: "https://www.tiktok.com/api/user/list/?scene=151&a=2", bodyText: pageBody(81, false, [
        { user: { secUid: "s2", uniqueId: "two" } },
        { user: { uniqueId: "no-secuid" } },
        { broken: true },
      ]) },
    ];
    const aggregate = aggregateSceneCaptures("151", captures);
    expect(aggregate?.items.map((i) => i.username)).toEqual(["one", "two"]);
    expect(aggregate?.total).toBe(81);
    expect(aggregate?.hasMore).toBe(false);
    expect(aggregateSceneCaptures("67", captures)).toBeNull();
  });

  it("classifies scenes by total magnitude", () => {
    const profile = { following: 81, followers: 162_900_000 };
    expect(classifySceneAggregate({ total: 162_924_864 }, profile)).toBe("followers");
    expect(classifySceneAggregate({ total: 81 }, profile)).toBe("following");
    expect(classifySceneAggregate({ total: 32 }, profile)).toBe("friends");
    expect(classifySceneAggregate({ total: null }, profile)).toBe("unknown");
  });
});

function mockSession(overrides: Partial<Awaited<ReturnType<TikTokBrowserSession["collectTarget"]>>> = {}): TikTokBrowserSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async collectTarget(username: string) {
      calls.push(username);
      return {
        profileHeader: "81 Following 163M Followers 2.7B Likes",
        secUid: "MS4wLjABAAAAkhaby",
        captures: [
          { url: "https://www.tiktok.com/api/user/list/?scene=21", bodyText: pageBody(0, false, []) },
          { url: "https://www.tiktok.com/api/user/list/?scene=151", bodyText: pageBody(32, false, [
            { user: { secUid: "friend1", uniqueId: "mutual" } },
          ]) },
          { url: "https://www.tiktok.com/api/user/list/?scene=67", bodyText: pageBody(163_000_000, true, [
            { user: { secUid: "f1", uniqueId: "fan" } },
          ]) },
          { url: "https://www.tiktok.com/api/user/list/?scene=99", bodyText: pageBody(81, false, [
            { user: { secUid: "u2", uniqueId: "two" } },
            { user: { secUid: "u3", uniqueId: "three" } },
          ]) },
        ],
        challenged: false,
        ...overrides,
      };
    },
  };
}

describe("TikTokSessionProvider", () => {
  it("declares the owner-locked capability set (single mega-page)", () => {
    const provider = new TikTokSessionProvider({ session: mockSession() });
    expect(provider.capabilities).toEqual({
      profileLookup: true,
      followerCount: true,
      followingCount: true,
      followerIdentities: false,
      followingIdentities: true,
      pagination: false,
      stableUserIds: true,
    });
  });

  it("resolves a profile with live-parsed counts", async () => {
    const provider = new TikTokSessionProvider({ session: mockSession() });
    const profile = await provider.resolveProfile(
      { platform: "tiktok", username: " @khaby.lame " },
      CONTEXT,
    );
    expect(profile).toEqual({
      platform: "tiktok",
      platformUserId: "MS4wLjABAAAAkhaby",
      username: "khaby.lame",
      followerCount: 163_000_000,
      followingCount: 81,
    });
  });

  it("returns the full following list as one complete page after resolveProfile", async () => {
    const session = mockSession();
    const provider = new TikTokSessionProvider({ session, monotonicNow: () => 42 });
    await provider.resolveProfile({ platform: "tiktok", username: "khaby.lame" }, CONTEXT);
    const page = await provider.fetchFollowingPage(
      { profileId: "MS4wLjABAAAAkhaby", limit: 50 },
      CONTEXT,
    );
    expect(page).toEqual({
      items: [
        { platform: "tiktok", platformUserId: "u2", username: "two" },
        { platform: "tiktok", platformUserId: "u3", username: "three" },
      ],
      hasMore: false,
      requestMetadata: { attempts: 1, durationMs: 0 },
    });
    expect("nextCursor" in page).toBe(false);
    expect(session.calls).toEqual(["khaby.lame", "khaby.lame"]);
  });

  it("falls back to the raw profileId key when resolveProfile has not run", async () => {
    const session = mockSession();
    const provider = new TikTokSessionProvider({ session });
    const page = await provider.fetchFollowingPage({ profileId: "raw-key", limit: 50 }, CONTEXT);
    expect(page.hasMore).toBe(false);
    expect(session.calls).toEqual(["raw-key"]);
  });

  it("maps a challenge to a retryable stop without bypassing", async () => {
    const provider = new TikTokSessionProvider({
      session: mockSession({ challenged: true, secUid: "x", captures: [] }),
    });
    await expect(
      provider.resolveProfile({ platform: "tiktok", username: "khaby.lame" }, CONTEXT),
    ).rejects.toMatchObject({ category: "SOURCE_TEMPORARILY_UNAVAILABLE", retryable: true });
  });

  it("returns a controlled not-found and gates follower identities", async () => {
    const provider = new TikTokSessionProvider({
      session: mockSession({ secUid: undefined }),
    });
    await expect(
      provider.resolveProfile({ platform: "tiktok", username: "missing" }, CONTEXT),
    ).rejects.toMatchObject({ category: "PROFILE_NOT_FOUND" });

    const gated = new TikTokSessionProvider({ session: mockSession() });
    await expect(
      gated.fetchFollowersPage({ profileId: "x", limit: 10 }, CONTEXT),
    ).rejects.toMatchObject({ category: "CAPABILITY_UNSUPPORTED", retryable: false });
  });

  it("propagates an abort before any session work", async () => {
    const session = mockSession();
    const provider = new TikTokSessionProvider({ session });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.resolveProfile(
        { platform: "tiktok", username: "khaby.lame" },
        { ...CONTEXT, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(session.calls).toEqual([]);
  });
});
