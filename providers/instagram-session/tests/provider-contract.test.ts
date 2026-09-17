import { describe, expect, it } from "vitest";
import { defineSocialGraphProviderContract } from "../../../tests/contracts/provider-contract.js";
import { InstagramSessionProvider } from "../src/index.js";
import { InstagramSessionTransport } from "../src/transport.js";
import {
  TEST_CONFIG,
  constantClock,
  createMockFetch,
  noSleep,
} from "./support/mock-fetch.js";

/**
 * The shared provider contract, exercised against a mock Instagram transport
 * that serves the canonical contract fixtures. Follower identity tests are
 * skipped by design: the owner-locked count-only model declares
 * `followerIdentities: false`.
 */
defineSocialGraphProviderContract({
  platform: "instagram",
  capabilities: {
    profileLookup: true,
    followerCount: true,
    followingCount: true,
    followerIdentities: false,
    followingIdentities: true,
    pagination: true,
    stableUserIds: true,
  },
  createProvider: () =>
    new InstagramSessionProvider({
      config: TEST_CONFIG,
      transport: new InstagramSessionTransport(TEST_CONFIG, {
        fetchImpl: createMockFetch([
          {
            match: /web_profile_info\/\?username=target/,
            respond: () => ({
              body: JSON.stringify({
                data: {
                  user: {
                    id: "p1",
                    username: "target",
                    edge_followed_by: { count: 2 },
                    edge_follow: { count: 1 },
                  },
                },
              }),
            }),
          },
          {
            match: /web_profile_info\/\?username=missing/,
            respond: () => ({ status: 404, body: "{}" }),
          },
          {
            match: /friendships\/p1\/following\//,
            respond: () => ({
              body: JSON.stringify({
                users: [{ pk: "u2", username: "two" }],
                has_more: false,
              }),
            }),
          },
        ]),
        monotonicNow: constantClock,
        sleep: noSleep,
      }),
    }),
});

describe("instagram-session contract extensions", () => {
  it("requires the owned-session environment when no config is provided", () => {
    expect(() => new InstagramSessionProvider({ env: {} })).toThrow(/IG_SESSIONID/);
  });
});
