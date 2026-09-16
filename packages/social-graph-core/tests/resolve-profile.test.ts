import { describe, expect, it, vi } from "vitest";
import {
  CollectionError,
  normalizeProviderError,
  resolveProfile,
} from "../src/index.js";
import type {
  CollectRelationshipRequest,
  Platform,
  ProviderProfile,
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
  username: "target",
  relationship: "followers",
};

function providerFor(
  platform: Platform,
  overrides: Partial<SocialGraphProviderCapabilities> = {},
  result: ProviderProfile = {
    platform,
    platformUserId: "p1",
    username: "target",
  },
): SocialGraphProvider & { resolveProfile: ReturnType<typeof vi.fn> } {
  return {
    providerName: "test-provider",
    platform,
    capabilities: { ...capabilities, ...overrides },
    resolveProfile: vi.fn().mockResolvedValue(result),
    fetchFollowersPage: vi.fn(),
    fetchFollowingPage: vi.fn(),
  };
}

describe("resolveProfile", () => {
  it("copies only allowed fields and capability-backed counts", async () => {
    const provider = providerFor(
      "instagram",
      { followerCount: true, followingCount: false },
      {
        platform: "instagram",
        platformUserId: "p1",
        username: "target",
        fullName: "Target User",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://example.test/profile.jpg",
        followerCount: 10,
        followingCount: 20,
        rawResponse: "secret",
      } as ProviderProfile,
    );

    await expect(resolveProfile(request, provider)).resolves.toEqual({
      platform: "instagram",
      platformUserId: "p1",
      username: "target",
      fullName: "Target User",
      isPrivate: false,
      isVerified: true,
      profilePicUrl: "https://example.test/profile.jpg",
      followerCount: 10,
    });
  });

  it("forwards tracing context and rejects an aborted signal before invoking the provider", async () => {
    const provider = providerFor("instagram");
    const controller = new AbortController();

    await resolveProfile({ ...request, signal: controller.signal }, provider);

    expect(provider.resolveProfile).toHaveBeenCalledWith(
      { platform: "instagram", username: "target" },
      { runId: "run-1", targetId: "target-1", signal: controller.signal },
    );

    const abortedProvider = providerFor("instagram");
    await expect(resolveProfile(
      { ...request, signal: AbortSignal.abort() },
      abortedProvider,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedProvider.resolveProfile).not.toHaveBeenCalled();
  });

  it("rejects unsupported lookup before invoking the provider", async () => {
    const provider = providerFor("instagram", { profileLookup: false });

    await expect(resolveProfile(request, provider)).rejects.toMatchObject({
      category: "CAPABILITY_UNSUPPORTED",
      retryable: false,
    });
    expect(provider.resolveProfile).not.toHaveBeenCalled();
  });

  it("rejects request/provider and output platform mismatches", async () => {
    const wrongProvider = providerFor("instagram");
    await expect(resolveProfile({ ...request, platform: "x" }, wrongProvider))
      .rejects.toMatchObject({ category: "INVALID_INPUT" });
    expect(wrongProvider.resolveProfile).not.toHaveBeenCalled();

    const wrongOutput = providerFor("instagram", {}, {
      platform: "x",
      platformUserId: "p1",
      username: "target",
    });
    await expect(resolveProfile(request, wrongOutput)).rejects.toMatchObject({
      category: "INVALID_INPUT",
    });
  });

  it.each([
    "PROFILE_NOT_FOUND",
    "PROFILE_UNAVAILABLE",
    "PRIVATE_PROFILE_UNSUPPORTED",
    "CAPABILITY_UNSUPPORTED",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "SOURCE_TEMPORARILY_UNAVAILABLE",
    "PAGINATION_FAILED",
    "INVALID_INPUT",
    "UNKNOWN_ERROR",
  ] as const)("preserves the documented %s category safely", async (category) => {
    const cause = new Error("internal secret");
    const providerError = Object.assign(new Error("safe provider message"), {
      category,
      retryable: category === "RATE_LIMITED",
      cause,
    });
    const normalized = normalizeProviderError(providerError, {
      platform: "instagram",
      targetId: "target-1",
    });

    expect(normalized).toBeInstanceOf(CollectionError);
    expect(normalized).toMatchObject({ category, cause: providerError });
    expect(normalized.toPublicError()).toMatchObject({
      category,
      retryable: category === "RATE_LIMITED",
      platform: "instagram",
      targetId: "target-1",
    });
    expect(normalized.toPublicError().message).not.toBe("safe provider message");
    expect(normalized.toPublicError()).not.toHaveProperty("cause");
  });

  it("normalizes unknown thrown values without leaking them", () => {
    const normalized = normalizeProviderError({ token: "secret" });

    expect(normalized).toMatchObject({
      category: "UNKNOWN_ERROR",
      message: "An unknown provider error occurred",
      retryable: false,
    });
    expect(normalized.toPublicError()).not.toHaveProperty("cause");
    expect(JSON.stringify(normalized.toPublicError())).not.toContain("secret");
  });

  it("does not expose an untrusted provider message for a recognized category", () => {
    const providerError = Object.assign(
      new Error("request failed with token=provider-secret at https://internal.example"),
      { category: "RATE_LIMITED", retryable: true },
    );

    const normalized = normalizeProviderError(providerError, {
      platform: "x",
      targetId: "target-sensitive",
    });

    expect(normalized.cause).toBe(providerError);
    expect(normalized.toPublicError()).toEqual({
      category: "RATE_LIMITED",
      message: "The provider rate limit was reached",
      retryable: true,
      platform: "x",
      targetId: "target-sensitive",
    });
    expect(JSON.stringify(normalized.toPublicError())).not.toContain("provider-secret");
    expect(JSON.stringify(normalized.toPublicError())).not.toContain("internal.example");
  });

  it("preserves a trusted CollectionError message while adding missing caller context", () => {
    const internalCause = new Error("internal-only detail");
    const trusted = new CollectionError({
      category: "PROFILE_UNAVAILABLE",
      message: "Profile is temporarily unavailable",
      retryable: true,
      cause: internalCause,
    });

    const normalized = normalizeProviderError(trusted, {
      platform: "tiktok",
      targetId: "target-2",
    });

    expect(normalized).toMatchObject({
      category: "PROFILE_UNAVAILABLE",
      message: "Profile is temporarily unavailable",
      retryable: true,
      platform: "tiktok",
      targetId: "target-2",
      cause: internalCause,
    });
    expect(normalized.toPublicError()).not.toHaveProperty("cause");
    expect(JSON.stringify(normalized.toPublicError())).not.toContain("internal-only detail");
  });

  it("normalizes provider failures during resolution", async () => {
    const provider = providerFor("instagram");
    provider.resolveProfile.mockRejectedValue(Object.assign(new Error("Profile not found"), {
      category: "PROFILE_NOT_FOUND",
      retryable: false,
    }));

    await expect(resolveProfile(request, provider)).rejects.toMatchObject({
      category: "PROFILE_NOT_FOUND",
      retryable: false,
      platform: "instagram",
      targetId: "target-1",
    });
  });
});
