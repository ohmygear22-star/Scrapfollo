/**
 * TikTok owned-session provider (Option A, owner-authorized 2026-09-17/18).
 *
 * Collection runs inside the Apify actor's browser session (headful Chrome,
 * SG sticky datacenter proxy, the app's own JS signing). This package holds
 * the provider logic and every parser; the browser mechanics live behind the
 * injected TikTokBrowserSession seam so the whole provider is unit-testable
 * without a single live request.
 *
 * Owner data scope (2026-09-17): following = full who-list; followers =
 * count-only. The friends (mutual) list is collected by the session but is
 * not part of the core contract yet.
 */

import type {
  FetchRelationshipPageInput,
  ProviderProfile,
  ProviderRelationshipPage,
  ProviderRequestContext,
  PublicCollectionErrorCategory,
  ResolveProfileInput,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "@social-graph/core";
import {
  aggregateSceneCaptures,
  classifySceneAggregate,
  parseProfileCounts,
  type ListCapture,
} from "./parsing.js";

/**
 * The browser seam the actor implements: one method, the proven flow
 * (profile → modal → tabs → scroll), returning raw observations.
 */
export interface TikTokBrowserSession {
  collectTarget(username: string, signal?: AbortSignal): Promise<{
    /** Profile header text, e.g. "81 Following 163M Followers 2.7B Likes". */
    profileHeader: string;
    /** Stable id; undefined when the profile did not resolve. */
    secUid: string | undefined;
    /** Every /api/user/list response body captured during the flow. */
    captures: ListCapture[];
    /** True when the platform presented a challenge (captcha) instead. */
    challenged: boolean;
  }>;
}

export class TikTokSessionProviderError extends Error {
  readonly category: PublicCollectionErrorCategory;
  readonly retryable: boolean;

  constructor(category: PublicCollectionErrorCategory, message: string, retryable = false) {
    super(message);
    this.name = "TikTokSessionProviderError";
    this.category = category;
    this.retryable = retryable;
  }
}

export type TikTokSessionProviderOptions = {
  session: TikTokBrowserSession;
  monotonicNow?: () => number;
};

const TIKTOK_CAPABILITIES: SocialGraphProviderCapabilities = Object.freeze({
  profileLookup: true,
  followerCount: true,
  followingCount: true,
  followerIdentities: false,
  followingIdentities: true,
  pagination: false,
  stableUserIds: true,
});

export class TikTokSessionProvider implements SocialGraphProvider {
  readonly providerName = "tiktok-session";
  readonly platform = "tiktok" as const;
  readonly capabilities: SocialGraphProviderCapabilities = TIKTOK_CAPABILITIES;

  readonly #session: TikTokBrowserSession;
  readonly #monotonicNow: () => number;
  #lastUsername: string | null = null;

  constructor(options: TikTokSessionProviderOptions) {
    this.#session = options.session;
    this.#monotonicNow = options.monotonicNow ?? Date.now;
  }

  async resolveProfile(
    input: ResolveProfileInput,
    context: ProviderRequestContext,
  ): Promise<ProviderProfile> {
    context.signal?.throwIfAborted();
    if (input.platform !== this.platform) {
      throw new TikTokSessionProviderError(
        "INVALID_INPUT",
        `Expected platform tiktok, received ${input.platform}`,
      );
    }
    const username = normalizeUsername(input.username);
    this.#lastUsername = username;
    const observation = await this.#session.collectTarget(username, context.signal);
    if (observation.challenged) {
      throw new TikTokSessionProviderError(
        "SOURCE_TEMPORARILY_UNAVAILABLE",
        "TikTok presented a challenge; collection stops for this run without bypassing it",
        true,
      );
    }
    if (observation.secUid === undefined) {
      throw new TikTokSessionProviderError(
        "PROFILE_NOT_FOUND",
        "TikTok profile did not resolve",
      );
    }
    const counts = parseProfileCounts(observation.profileHeader);
    return {
      platform: "tiktok",
      platformUserId: observation.secUid,
      username,
      ...(counts === null ? {} : { followerCount: counts.followers, followingCount: counts.following }),
    };
  }

  async fetchFollowersPage(
    _input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    context.signal?.throwIfAborted();
    throw new TikTokSessionProviderError(
      "CAPABILITY_UNSUPPORTED",
      "Follower identity lists are not supported for TikTok; follower totals come from resolveProfile",
    );
  }

  async fetchFollowingPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    context.signal?.throwIfAborted();
    if (typeof input.profileId !== "string" || input.profileId.trim() === "") {
      throw new TikTokSessionProviderError("INVALID_INPUT", "profileId must be a non-empty string");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new TikTokSessionProviderError("INVALID_INPUT", "limit must be a positive safe integer");
    }

    // The browser flow collects the whole list in one pass. Core always
    // resolves the profile first, so the remembered username keys the
    // session; a standalone call falls back to the raw profileId key.
    const navigationKey = this.#lastUsername ?? input.profileId;
    const startedAt = this.#monotonicNow();
    const observation = await this.#session.collectTarget(navigationKey, context.signal);
    if (observation.challenged) {
      throw new TikTokSessionProviderError(
        "SOURCE_TEMPORARILY_UNAVAILABLE",
        "TikTok presented a challenge; collection stops for this run without bypassing it",
        true,
      );
    }
    const counts = parseProfileCounts(observation.profileHeader);
    if (counts === null) {
      throw new TikTokSessionProviderError(
        "UNKNOWN_ERROR",
        "Profile counts did not parse; cannot classify list scenes",
      );
    }
    const followingAggregate = this.#selectAggregate(observation.captures, counts, "following");
    if (followingAggregate === null) {
      throw new TikTokSessionProviderError(
        "UNKNOWN_ERROR",
        "No following-list scene was captured for this target",
      );
    }
    return {
      items: followingAggregate.items.slice(0, input.limit),
      hasMore: false,
      requestMetadata: {
        attempts: 1,
        durationMs: this.#monotonicNow() - startedAt,
      },
    };
  }

  #selectAggregate(
    captures: ListCapture[],
    counts: { following: number; followers: number },
    kind: "following",
  ) {
    const sceneIds = Array.from(new Set(
      captures
        .map((c) => /scene=(\d+)/.exec(c.url)?.[1])
        .filter((id): id is string => id !== undefined),
    ));
    let fallback: ReturnType<typeof aggregateSceneCaptures> = null;
    for (const sceneId of sceneIds) {
      const aggregate = aggregateSceneCaptures(sceneId, captures);
      if (aggregate === null) continue;
      const classified = classifySceneAggregate(aggregate, counts);
      if (classified === kind) return aggregate;
      if (fallback === null && aggregate.items.length > 0) {
        fallback = aggregate;
      }
    }
    return fallback;
  }
}

function normalizeUsername(username: string): string {
  const trimmed = username.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (withoutAt === "") {
    throw new TikTokSessionProviderError("INVALID_INPUT", "username must be a non-empty string");
  }
  return withoutAt;
}
