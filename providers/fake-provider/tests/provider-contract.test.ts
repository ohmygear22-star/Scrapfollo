import { defineSocialGraphProviderContract } from "../../../tests/contracts/provider-contract.js";
import { FakeProvider } from "../src/index.js";
import { describe, expect, it } from "vitest";

for (const platform of ["instagram", "x", "tiktok"] as const) {
  defineSocialGraphProviderContract({
    platform,
    createProvider: () =>
      FakeProvider.fromScenario({
        platform,
        capabilities: {
          profileLookup: true,
          followerCount: true,
          followingCount: true,
          followerIdentities: true,
          followingIdentities: true,
          pagination: true,
          stableUserIds: true,
        },
        profiles: {
          target: {
            profile: {
              platform,
              platformUserId: "p1",
              username: "target",
              followerCount: 2,
              followingCount: 1,
            },
            followers: [
              [{ platform, platformUserId: "u1", username: "one" }],
              [{ platform, platformUserId: "u3", username: "three" }],
            ],
            following: [[{ platform, platformUserId: "u2", username: "two" }]],
          },
        },
      }),
  });
}

defineSocialGraphProviderContract({
  platform: "x",
  capabilities: {
    profileLookup: true,
    followerCount: false,
    followingCount: false,
    followerIdentities: true,
    followingIdentities: false,
    pagination: false,
    stableUserIds: false,
  },
  createProvider: () =>
    FakeProvider.fromScenario({
      platform: "x",
      capabilities: {
        profileLookup: true,
        followerCount: false,
        followingCount: false,
        followerIdentities: true,
        followingIdentities: false,
        pagination: false,
        stableUserIds: false,
      },
      profiles: {
        target: {
          profile: { platform: "x", platformUserId: "p1", username: "target" },
          followers: [[{ platform: "x", platformUserId: "u1", username: "one" }]],
          following: [],
        },
      },
    }),
});

describe("FakeProvider scenario validation", () => {
  it("rejects relationship items from a different platform", () => {
    expect(() =>
      FakeProvider.fromScenario({
        platform: "instagram",
        capabilities: {
          profileLookup: true,
          followerCount: true,
          followingCount: true,
          followerIdentities: true,
          followingIdentities: true,
          pagination: true,
          stableUserIds: true,
        },
        profiles: {
          target: {
            profile: {
              platform: "instagram",
              platformUserId: "p1",
              username: "target",
            },
            followers: [[{ platform: "x", username: "wrong-platform" }]],
            following: [],
          },
        },
      }),
    ).toThrow(/platform/i);
  });

  it("records provider operation calls for deterministic inspection", async () => {
    const provider = FakeProvider.fromScenario({
      platform: "x",
      capabilities: {
        profileLookup: true,
        followerCount: true,
        followingCount: true,
        followerIdentities: true,
        followingIdentities: true,
        pagination: true,
        stableUserIds: true,
      },
      profiles: {
        target: {
          profile: { platform: "x", platformUserId: "p1", username: "target" },
          followers: [[{ platform: "x", platformUserId: "u1", username: "one" }]],
          following: [],
        },
      },
    });
    const context = { runId: "run-calls", targetId: "target-calls" };

    await provider.resolveProfile({ platform: "x", username: "target" }, context);
    await provider.fetchFollowersPage({ profileId: "p1", limit: 10 }, context);

    expect(provider.calls).toEqual([
      {
        operation: "resolveProfile",
        runId: "run-calls",
        targetId: "target-calls",
        username: "target",
      },
      {
        operation: "fetchFollowersPage",
        runId: "run-calls",
        targetId: "target-calls",
        profileId: "p1",
      },
    ]);
  });

  it("throws configured normalized error metadata for a chosen operation", async () => {
    const provider = FakeProvider.fromScenario({
      platform: "tiktok",
      capabilities: {
        profileLookup: true,
        followerCount: true,
        followingCount: true,
        followerIdentities: true,
        followingIdentities: true,
        pagination: true,
        stableUserIds: true,
      },
      errors: {
        fetchFollowersPage: {
          category: "RATE_LIMITED",
          message: "configured fake rate limit",
          retryable: true,
        },
      },
      profiles: {
        target: {
          profile: {
            platform: "tiktok",
            platformUserId: "p1",
            username: "target",
          },
          followers: [],
          following: [],
        },
      },
    });

    await expect(
      provider.fetchFollowersPage(
        { profileId: "p1", limit: 10 },
        { runId: "run-errors", targetId: "target-errors" },
      ),
    ).rejects.toMatchObject({
      category: "RATE_LIMITED",
      message: "configured fake rate limit",
      retryable: true,
    });
  });
});
