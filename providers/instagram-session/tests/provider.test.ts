import { describe, expect, it } from "vitest";
import {
  InstagramSessionProvider,
  InstagramSessionProviderError,
} from "../src/instagram-session-provider.js";
import { InstagramSessionTransport } from "../src/transport.js";
import {
  TEST_CONFIG,
  constantClock,
  createMockFetch,
  noSleep,
  type MockCall,
} from "./support/mock-fetch.js";

type Route = Parameters<typeof createMockFetch>[0][number];

function buildProvider(routes: Route[], calls: MockCall[] = []): InstagramSessionProvider {
  const transport = new InstagramSessionTransport(TEST_CONFIG, {
    fetchImpl: createMockFetch(routes, calls),
    monotonicNow: constantClock,
    sleep: noSleep,
  });
  return new InstagramSessionProvider({ config: TEST_CONFIG, transport });
}

const CONTEXT = { runId: "run-1", targetId: "target-1" } as const;

function webProfileRoute(user: unknown): Route {
  return {
    match: /users\/web_profile_info\//,
    respond: () => ({ body: JSON.stringify({ data: { user } }) }),
  };
}

function followingRoute(body: unknown, status = 200): Route {
  return {
    match: /friendships\/.+\/following\//,
    respond: () => ({ status, body: JSON.stringify(body) }),
  };
}

describe("InstagramSessionProvider", () => {
  it("declares the owner-locked capability set", () => {
    const provider = buildProvider([]);
    expect(provider.platform).toBe("instagram");
    expect(provider.providerName).toBe("instagram-session");
    expect(provider.capabilities).toEqual({
      profileLookup: true,
      followerCount: true,
      followingCount: true,
      followerIdentities: false,
      followingIdentities: true,
      pagination: true,
      stableUserIds: true,
    });
  });

  describe("resolveProfile", () => {
    it("maps the web_profile_info payload exactly, without extra keys", async () => {
      const provider = buildProvider([
        webProfileRoute({
          id: "123",
          username: "target",
          edge_followed_by: { count: 2 },
          edge_follow: { count: 1 },
        }),
      ]);

      const profile = await provider.resolveProfile(
        { platform: "instagram", username: "target" },
        CONTEXT,
      );

      expect(profile).toEqual({
        platform: "instagram",
        platformUserId: "123",
        username: "target",
        followerCount: 2,
        followingCount: 1,
      });
    });

    it("maps optional profile fields only when the source provides them", async () => {
      const provider = buildProvider([
        webProfileRoute({
          id: "123",
          username: "target",
          full_name: "Target Person",
          is_private: false,
          is_verified: true,
          profile_pic_url: "https://pic.test/x.jpg",
          edge_followed_by: { count: 7 },
        }),
      ]);

      const profile = await provider.resolveProfile(
        { platform: "instagram", username: "target" },
        CONTEXT,
      );

      expect(profile).toEqual({
        platform: "instagram",
        platformUserId: "123",
        username: "target",
        followerCount: 7,
        fullName: "Target Person",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://pic.test/x.jpg",
      });
    });

    it("normalizes a leading @ and surrounding whitespace", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [webProfileRoute({ id: "1", username: "target" })],
        calls,
      );

      await provider.resolveProfile(
        { platform: "instagram", username: " @Target " },
        CONTEXT,
      );

      expect(new URL(calls[0]!.url).searchParams.get("username")).toBe("Target");
    });

    it("rejects a platform mismatch before any request", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider([webProfileRoute(null)], calls);

      await expect(
        provider.resolveProfile({ platform: "tiktok", username: "target" }, CONTEXT),
      ).rejects.toMatchObject({ category: "INVALID_INPUT", retryable: false });
      expect(calls).toHaveLength(0);
    });

    it("rejects an empty username before any request", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider([webProfileRoute(null)], calls);

      await expect(
        provider.resolveProfile({ platform: "instagram", username: " @" }, CONTEXT),
      ).rejects.toMatchObject({ category: "INVALID_INPUT" });
      expect(calls).toHaveLength(0);
    });

    it("returns a controlled not-found for a 404 without falling back", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [{ match: /web_profile_info\//, respond: () => ({ status: 404, body: "{}" }) }],
        calls,
      );

      await expect(
        provider.resolveProfile({ platform: "instagram", username: "missing" }, CONTEXT),
      ).rejects.toMatchObject({ category: "PROFILE_NOT_FOUND", retryable: false });
      expect(calls).toHaveLength(1);
    });

    it("falls back to search + info when web_profile_info is rate-limited", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [
          { match: /web_profile_info\//, respond: () => ({ status: 429, body: "{}" }) },
          {
            match: /users\/search\//,
            respond: () => ({
              body: JSON.stringify({
                users: [
                  { pk: 77, username: "targeted" },
                  { pk: 88, username: "target", full_name: "Real Target", is_private: true },
                ],
              }),
            }),
          },
          {
            match: /users\/88\/info\//,
            respond: () => ({
              body: JSON.stringify({
                user: {
                  pk: "88",
                  username: "target",
                  follower_count: 5,
                  following_count: 3,
                  is_verified: true,
                },
              }),
            }),
          },
        ],
        calls,
      );

      const profile = await provider.resolveProfile(
        { platform: "instagram", username: "target" },
        CONTEXT,
      );

      expect(profile).toEqual({
        platform: "instagram",
        platformUserId: "88",
        username: "target",
        followerCount: 5,
        followingCount: 3,
        isVerified: true,
      });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/v1/users/web_profile_info/",
        "/api/v1/users/search/",
        "/api/v1/users/88/info/",
      ]);
    });

    it("does not fall back when the session itself is rejected", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [
          {
            match: /web_profile_info\//,
            respond: () => ({
              status: 400,
              body: JSON.stringify({ message: "login_required" }),
            }),
          },
        ],
        calls,
      );

      await expect(
        provider.resolveProfile({ platform: "instagram", username: "target" }, CONTEXT),
      ).rejects.toMatchObject({ category: "PROVIDER_UNAVAILABLE", retryable: false });
      expect(calls).toHaveLength(1);
    });

    it("treats a search without an exact match as not found", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [
          { match: /web_profile_info\//, respond: () => ({ status: 429, body: "{}" }) },
          {
            match: /users\/search\//,
            respond: () => ({ body: JSON.stringify({ users: [{ pk: 1, username: "other" }] }) }),
          },
        ],
        calls,
      );

      await expect(
        provider.resolveProfile({ platform: "instagram", username: "target" }, CONTEXT),
      ).rejects.toMatchObject({ category: "PROFILE_NOT_FOUND" });
      expect(calls).toHaveLength(2);
    });

    it("propagates an abort before any request", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider([webProfileRoute(null)], calls);
      const controller = new AbortController();
      controller.abort();

      await expect(
        provider.resolveProfile(
          { platform: "instagram", username: "target" },
          { ...CONTEXT, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toHaveLength(0);
    });
  });

  describe("fetchFollowersPage", () => {
    it("always rejects with capability-unsupported (count-only model)", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider([], calls);

      await expect(
        provider.fetchFollowersPage({ profileId: "123", limit: 12 }, CONTEXT),
      ).rejects.toMatchObject({
        category: "CAPABILITY_UNSUPPORTED",
        retryable: false,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("fetchFollowingPage", () => {
    it("returns an exact page with a server cursor and minimal metadata", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [
          followingRoute({
            users: [
              { pk: "u2", username: "two" },
              { pk: "u3", username: "three", full_name: "Three", is_verified: false },
            ],
            has_more: true,
            next_max_id: "CURSOR-1",
          }),
        ],
        calls,
      );

      const page = await provider.fetchFollowingPage(
        { profileId: "p1", limit: 12 },
        CONTEXT,
      );

      expect(page).toEqual({
        items: [
          { platform: "instagram", platformUserId: "u2", username: "two" },
          {
            platform: "instagram",
            platformUserId: "u3",
            username: "three",
            fullName: "Three",
            isVerified: false,
          },
        ],
        nextCursor: "CURSOR-1",
        hasMore: true,
        requestMetadata: { attempts: 1, durationMs: 0 },
      });

      const query = new URL(calls[0]!.url).searchParams;
      expect(query.get("count")).toBe("12");
      expect(query.get("search_surface")).toBe("following_list_page");
      expect(query.has("max_id")).toBe(false);
    });

    it("derives the cursor from the last item when next_max_id is absent", async () => {
      const provider = buildProvider([
        followingRoute({
          users: [{ pk: "u9", username: "nine" }],
          has_more: true,
        }),
      ]);

      const page = await provider.fetchFollowingPage(
        { profileId: "p1", limit: 12 },
        CONTEXT,
      );

      expect(page.nextCursor).toBe("u9");
      expect(page.hasMore).toBe(true);
    });

    it("omits nextCursor when the list is complete", async () => {
      const provider = buildProvider([
        followingRoute({ users: [{ pk: "u2", username: "two" }], has_more: false }),
      ]);

      const page = await provider.fetchFollowingPage(
        { profileId: "p1", limit: 12 },
        CONTEXT,
      );

      expect(page).toEqual({
        items: [{ platform: "instagram", platformUserId: "u2", username: "two" }],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 0 },
      });
      expect("nextCursor" in page).toBe(false);
    });

    it("fails pagination terminally when has_more has no derivable cursor", async () => {
      const provider = buildProvider([
        followingRoute({ users: [], has_more: true }),
      ]);

      await expect(
        provider.fetchFollowingPage({ profileId: "p1", limit: 12 }, CONTEXT),
      ).rejects.toMatchObject({ category: "PAGINATION_FAILED", retryable: false });
    });

    it("passes the opaque cursor through as max_id", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [followingRoute({ users: [], has_more: false })],
        calls,
      );

      await provider.fetchFollowingPage(
        { profileId: "p1", cursor: "CURSOR-1", limit: 12 },
        CONTEXT,
      );

      expect(new URL(calls[0]!.url).searchParams.get("max_id")).toBe("CURSOR-1");
    });

    it("clamps the requested page size to the configured maximum", async () => {
      const calls: MockCall[] = [];
      const provider = buildProvider(
        [followingRoute({ users: [], has_more: false })],
        calls,
      );

      await provider.fetchFollowingPage({ profileId: "p1", limit: 100 }, CONTEXT);

      expect(new URL(calls[0]!.url).searchParams.get("count")).toBe("50");
    });

    it("maps a 404 to a controlled not-found", async () => {
      const provider = buildProvider([followingRoute({ message: "not found" }, 404)]);

      await expect(
        provider.fetchFollowingPage({ profileId: "gone", limit: 12 }, CONTEXT),
      ).rejects.toMatchObject({ category: "PROFILE_NOT_FOUND", retryable: false });
    });

    it.each([
      ["empty profileId", { profileId: "  ", limit: 12 }],
      ["zero limit", { profileId: "p1", limit: 0 }],
      ["fractional limit", { profileId: "p1", limit: 1.5 }],
      ["empty cursor", { profileId: "p1", cursor: "", limit: 12 }],
    ])("rejects invalid input (%s) before any request", (_name, input) => {
      const calls: MockCall[] = [];
      const provider = buildProvider([], calls);

      const rejection = expect(
        provider.fetchFollowingPage(input as { profileId: string; limit: number }, CONTEXT),
      ).rejects.toMatchObject({ category: "INVALID_INPUT", retryable: false });
      return rejection;
    });

    it("rejects an unexpected response shape as a permanent unknown error", async () => {
      const provider = buildProvider([followingRoute({ unexpected: true })]);

      await expect(
        provider.fetchFollowingPage({ profileId: "p1", limit: 12 }, CONTEXT),
      ).rejects.toBeInstanceOf(InstagramSessionProviderError);
    });

    it("filters users without a usable identity", async () => {
      const provider = buildProvider([
        followingRoute({
          users: [
            { pk: "u1", username: "one" },
            { pk: "u2" },
            { pk: "u3", username: "" },
            { username: "no-pk" },
            null,
          ],
          has_more: false,
        }),
      ]);

      const page = await provider.fetchFollowingPage(
        { profileId: "p1", limit: 12 },
        CONTEXT,
      );

      expect(page.items).toEqual([
        { platform: "instagram", platformUserId: "u1", username: "one" },
      ]);
    });
  });
});

describe("InstagramSessionProvider seeded resolution", () => {
  it("resolves via users/{id}/info/ without touching username endpoints", async () => {
    const calls: MockCall[] = [];
    const seeded = new InstagramSessionProvider({
      config: TEST_CONFIG,
      transport: new InstagramSessionTransport(TEST_CONFIG, {
        fetchImpl: createMockFetch(
          [
            {
              match: /users\/232192182\/info\//,
              respond: () => ({
                body: JSON.stringify({
                  user: {
                    pk: "232192182",
                    username: "therock",
                    follower_count: 381391432,
                    following_count: 382,
                    is_verified: true,
                  },
                }),
              }),
            },
          ],
          calls,
        ),
        monotonicNow: constantClock,
        sleep: noSleep,
      }),
      seeds: { "@Therock": "232192182" },
    });

    const profile = await seeded.resolveProfile(
      { platform: "instagram", username: "therock" },
      CONTEXT,
    );

    expect(profile).toEqual({
      platform: "instagram",
      platformUserId: "232192182",
      username: "therock",
      followerCount: 381391432,
      followingCount: 382,
      isVerified: true,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/users/232192182/info/",
    ]);
  });
});
