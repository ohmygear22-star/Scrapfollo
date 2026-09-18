import { describe, expect, it } from "vitest";
import { defineSocialGraphProviderContract } from "../../../tests/contracts/provider-contract.js";
import { TikTokSessionProvider, type TikTokBrowserSession } from "../src/index.js";

function contractSession(): TikTokBrowserSession {
  return {
    async collectTarget(username: string) {
      if (username === "missing") {
        return { profileHeader: "", secUid: undefined, captures: [], challenged: false };
      }
      return {
        profileHeader: "1 Following 2 Followers 3 Likes",
        secUid: "p1",
        captures: [
          {
            url: "https://www.tiktok.com/api/user/list/?scene=151",
            bodyText: JSON.stringify({
              total: 1,
              hasMore: false,
              userList: [{ user: { secUid: "u2", uniqueId: "two" } }],
            }),
          },
        ],
        challenged: false,
      };
    },
  };
}

defineSocialGraphProviderContract({
  platform: "tiktok",
  capabilities: {
    profileLookup: true,
    followerCount: true,
    followingCount: true,
    followerIdentities: false,
    followingIdentities: true,
    pagination: false,
    stableUserIds: true,
  },
  createProvider: () =>
    new TikTokSessionProvider({ session: contractSession(), monotonicNow: () => 7 }),
});

describe("tiktok-session contract extensions", () => {
  it("keeps the browser seam synchronous-keyed: contract page has zero duration on the injected clock", async () => {
    const provider = new TikTokSessionProvider({ session: contractSession(), monotonicNow: () => 7 });
    await provider.resolveProfile({ platform: "tiktok", username: "target" }, { runId: "r", targetId: "t" });
    const page = await provider.fetchFollowingPage({ profileId: "p1", limit: 1 }, { runId: "r", targetId: "t" });
    expect(page.requestMetadata).toEqual({ attempts: 1, durationMs: 0 });
    expect(page.items).toEqual([{ platform: "tiktok", platformUserId: "u2", username: "two" }]);
  });
});
