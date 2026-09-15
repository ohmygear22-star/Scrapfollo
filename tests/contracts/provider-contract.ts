import { describe, expect, it } from "vitest";
import type {
  Platform,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "@social-graph/core";

type ProviderContractOptions = {
  platform: Platform;
  capabilities?: SocialGraphProviderCapabilities;
  createProvider: () => SocialGraphProvider;
};

const expectedCapabilities: SocialGraphProviderCapabilities = {
  profileLookup: true,
  followerCount: true,
  followingCount: true,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

export function defineSocialGraphProviderContract({
  platform,
  capabilities = expectedCapabilities,
  createProvider,
}: ProviderContractOptions): void {
  describe(`${platform} SocialGraphProvider contract`, () => {
    it("reports its platform and all declared capabilities", () => {
      const provider = createProvider();

      expect(provider.platform).toBe(platform);
      expect(provider.capabilities).toEqual(capabilities);
    });

    if (capabilities.profileLookup) {
      it("resolves a public profile with matching platform identity", async () => {
        const provider = createProvider();

        const profile = await provider.resolveProfile(
          { platform, username: "target" },
          { runId: "run-1", targetId: "target-1" },
        );

        expect(profile).toEqual({
          platform,
          platformUserId: "p1",
          username: "target",
          ...(capabilities.followerCount ? { followerCount: 2 } : {}),
          ...(capabilities.followingCount ? { followingCount: 1 } : {}),
        });
      });

      it("returns a controlled not-found failure", async () => {
        const provider = createProvider();

        await expect(
          provider.resolveProfile(
            { platform, username: "missing" },
            { runId: "run-1", targetId: "missing-1" },
          ),
        ).rejects.toMatchObject({
          category: "PROFILE_NOT_FOUND",
          retryable: false,
        });
      });
    }

    if (capabilities.followerIdentities) {
      it("returns a valid follower page shape", async () => {
        const provider = createProvider();
        const context = { runId: "run-1", targetId: "target-1" };

        const first = await provider.fetchFollowersPage(
          { profileId: "p1", limit: 1 },
          context,
        );

        expect(first.items).toEqual([
          { platform, platformUserId: "u1", username: "one" },
        ]);
        expect(first.requestMetadata).toMatchObject({ attempts: 1, durationMs: 0 });

        if (!capabilities.pagination) {
          expect(first.hasMore).toBe(false);
          expect(first.nextCursor).toBeUndefined();
          return;
        }

        expect(first.hasMore).toBe(true);
        expect(first.nextCursor).toEqual(expect.any(String));
        if (first.nextCursor === undefined) {
          throw new Error("Expected an opaque continuation cursor");
        }

        const second = await provider.fetchFollowersPage(
          { profileId: "p1", cursor: first.nextCursor, limit: 1 },
          context,
        );

        expect(second).toMatchObject({
          items: [{ platform, platformUserId: "u3", username: "three" }],
          hasMore: false,
          requestMetadata: { attempts: 1, durationMs: 0 },
        });
        expect(second.nextCursor).toBeUndefined();
      });
    }

    if (capabilities.followingIdentities) {
      it("keeps following pages independent from follower pagination", async () => {
        const provider = createProvider();

        const page = await provider.fetchFollowingPage(
          { profileId: "p1", limit: 1 },
          { runId: "run-1", targetId: "target-1" },
        );

        expect(page).toEqual({
          items: [{ platform, platformUserId: "u2", username: "two" }],
          hasMore: false,
          requestMetadata: { attempts: 1, durationMs: 0 },
        });
      });
    }

    if (capabilities.profileLookup) {
      it("propagates an already-aborted request", async () => {
        const provider = createProvider();
        const controller = new globalThis.AbortController();
        controller.abort();

        await expect(
          provider.resolveProfile(
            { platform, username: "target" },
            { runId: "run-1", targetId: "target-1", signal: controller.signal },
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
      });
    }
  });
}
