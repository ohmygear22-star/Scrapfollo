/**
 * Instagram owned-session provider.
 *
 * Owner decision 2026-09-17: collection uses the session of one dedicated,
 * owned Instagram account. Data scope is locked to:
 *   - following identities: full "who" list with opaque-cursor pagination
 *     (Instagram does not limit third-party following lists);
 *   - follower identities: NOT supported — Instagram limits third-party
 *     follower lists to a subset, so identity diffs would fabricate removals;
 *   - follower/following counts: exact, via profile resolution (daily
 *     count-only capture on the consumer side).
 *
 * Every public method performs exactly one HTTP request per transport call;
 * core owns retries and counts attempts via its retry hooks.
 */

import type {
  FetchRelationshipPageInput,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  ProviderRequestContext,
  PublicCollectionErrorCategory,
  ResolveProfileInput,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "@social-graph/core";
import {
  instagramSessionConfigFromEnv,
  type InstagramSessionConfig,
  type InstagramSessionEnv,
} from "./config.js";
import {
  InstagramSessionTransport,
  InstagramTransportError,
} from "./transport.js";

export class InstagramSessionProviderError extends Error {
  readonly category: PublicCollectionErrorCategory;
  readonly retryable: boolean;

  constructor(category: PublicCollectionErrorCategory, message: string, retryable = false) {
    super(message);
    this.name = "InstagramSessionProviderError";
    this.category = category;
    this.retryable = retryable;
  }
}

export type InstagramSessionProviderOptions = {
  config?: InstagramSessionConfig;
  env?: InstagramSessionEnv;
  transport?: InstagramSessionTransport;
  /**
   * One-time username → platform user id seeds. Instagram removed the
   * REST username-resolution family (web_profile_info is persistently
   * throttled; users/search 400s; users/web_search 404s), so identity
   * resolution prefers a seeded id + the proven users/{id}/info/ call.
   * Seeds are harvested from the logged-in browser's own app requests.
   */
  seeds?: Record<string, string>;
};

const INSTAGRAM_CAPABILITIES: SocialGraphProviderCapabilities = Object.freeze({
  profileLookup: true,
  followerCount: true,
  followingCount: true,
  followerIdentities: false,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
});

type RawUser = Record<string, unknown>;

export class InstagramSessionProvider implements SocialGraphProvider {
  readonly providerName = "instagram-session";
  readonly platform = "instagram" as const;
  readonly capabilities: SocialGraphProviderCapabilities = INSTAGRAM_CAPABILITIES;

  readonly #transport: InstagramSessionTransport;
  readonly #pageSizeMax: number;
  readonly #seeds: Map<string, string>;

  constructor(options: InstagramSessionProviderOptions = {}) {
    const config = options.config ?? instagramSessionConfigFromEnv(options.env ?? {});
    this.#transport = options.transport ?? new InstagramSessionTransport(config);
    this.#pageSizeMax = config.pageSizeMax;
    this.#seeds = new Map(
      Object.entries(options.seeds ?? {}).map(([username, id]) => [
        username.trim().replace(/^@/, "").toLowerCase(),
        id,
      ]),
    );
  }

  async resolveProfile(
    input: ResolveProfileInput,
    context: ProviderRequestContext,
  ): Promise<ProviderProfile> {
    throwIfAborted(context);
    if (input.platform !== this.platform) {
      throw new InstagramSessionProviderError(
        "INVALID_INPUT",
        `Expected platform instagram, received ${input.platform}`,
      );
    }
    const username = normalizeUsername(input.username);
    const seed = this.#seeds.get(username.toLowerCase());
    if (seed !== undefined) {
      return await this.#resolveViaSeededInfo(username, seed, context.signal);
    }

    try {
      return await this.#resolveViaWebProfileInfo(username, context.signal);
    } catch (error) {
      if (error instanceof InstagramTransportError && isTransient(error)) {
        // web_profile_info is heavily throttled; fall back to search + info.
        return await this.#resolveViaSearch(username, context.signal);
      }
      throw error;
    }
  }

  async fetchFollowersPage(
    _input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    throwIfAborted(context);
    throw new InstagramSessionProviderError(
      "CAPABILITY_UNSUPPORTED",
      "Follower identity lists are not supported for Instagram; follower totals come from resolveProfile (limited third-party lists would fabricate removal diffs)",
    );
  }

  async fetchFollowingPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage> {
    throwIfAborted(context);
    if (typeof input.profileId !== "string" || input.profileId.trim() === "") {
      throw new InstagramSessionProviderError("INVALID_INPUT", "profileId must be a non-empty string");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new InstagramSessionProviderError("INVALID_INPUT", "limit must be a positive safe integer");
    }
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor === "")) {
      throw new InstagramSessionProviderError("INVALID_INPUT", "cursor must be a non-empty string when present");
    }

    const response = await this.#transport.request({
      method: "GET",
      path: `/api/v1/friendships/${encodeURIComponent(input.profileId)}/following/`,
      query: {
        count: Math.min(input.limit, this.#pageSizeMax),
        search_surface: "following_list_page",
        ...(input.cursor === undefined ? {} : { max_id: input.cursor }),
      },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    const parsed = parseJsonObject(response.bodyText);
    const rawUsers = parsed?.users;
    if (!Array.isArray(rawUsers)) {
      throw new InstagramSessionProviderError(
        "UNKNOWN_ERROR",
        "Instagram following response did not contain a users array",
      );
    }

    const items = rawUsers.filter(isUsableUser).map(mapUser);
    const hasMore = parsed?.has_more === true;
    const nextCursor = cursorFromResponse(parsed, items, hasMore);

    if (hasMore && nextCursor === undefined) {
      throw new InstagramSessionProviderError(
        "PAGINATION_FAILED",
        "Instagram reported more following pages but exposed no continuation cursor",
      );
    }

    return {
      items,
      ...(hasMore && nextCursor !== undefined ? { nextCursor } : {}),
      hasMore,
      requestMetadata: {
        attempts: 1,
        durationMs: response.durationMs,
      },
    };
  }

  async #resolveViaSeededInfo(
    username: string,
    seededId: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderProfile> {
    const response = await this.#transport.request({
      method: "GET",
      path: `/api/v1/users/${encodeURIComponent(seededId)}/info/`,
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = parseJsonObject(response.bodyText);
    const infoUser = userOf(parsed?.["user"]);
    if (infoUser === undefined) {
      throw new InstagramSessionProviderError(
        "PROFILE_UNAVAILABLE",
        "Instagram returned no profile for the seeded user id",
      );
    }
    return {
      platform: "instagram",
      platformUserId: String(infoUser["pk"]),
      username: String(infoUser["username"] ?? username),
      ...countField("followerCount", countValue(infoUser["follower_count"])),
      ...countField("followingCount", countValue(infoUser["following_count"])),
      ...stringField("fullName", infoUser["full_name"]),
      ...booleanField("isPrivate", infoUser["is_private"]),
      ...booleanField("isVerified", infoUser["is_verified"]),
      ...stringField("profilePicUrl", infoUser["profile_pic_url"]),
    };
  }

  async #resolveViaWebProfileInfo(
    username: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderProfile> {
    const response = await this.#transport.request({
      method: "GET",
      path: "/api/v1/users/web_profile_info/",
      query: { username },
      ...(signal === undefined ? {} : { signal }),
    });

    const parsed = parseJsonObject(response.bodyText);
    const data = userOf(parsed?.["data"]);
    const user = userOf(data?.["user"]);
    if (user === undefined || typeof user["id"] !== "string" || typeof user["username"] !== "string") {
      throw new InstagramSessionProviderError(
        "PROFILE_NOT_FOUND",
        "Instagram returned no profile for the requested username",
      );
    }

    return {
      platform: "instagram",
      platformUserId: user["id"],
      username: user["username"],
      ...countField("followerCount", countOf(user["edge_followed_by"])),
      ...countField("followingCount", countOf(user["edge_follow"])),
      ...stringField("fullName", user["full_name"]),
      ...booleanField("isPrivate", user["is_private"]),
      ...booleanField("isVerified", user["is_verified"]),
      ...stringField("profilePicUrl", user["profile_pic_url"]),
    };
  }

  async #resolveViaSearch(
    username: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderProfile> {
    const searchResponse = await this.#transport.request({
      method: "GET",
      path: "/api/v1/users/search/",
      query: { q: username, count: 10 },
      ...(signal === undefined ? {} : { signal }),
    });
    const searchParsed = parseJsonObject(searchResponse.bodyText);
    const candidates = Array.isArray(searchParsed?.users) ? searchParsed["users"] as unknown[] : [];
    const match = candidates.find(
      (candidate) =>
        isUsableUser(candidate) &&
        String(candidate["username"]).toLowerCase() === username.toLowerCase(),
    ) as RawUser | undefined;
    if (match === undefined) {
      throw new InstagramSessionProviderError(
        "PROFILE_NOT_FOUND",
        "Instagram search returned no exact match for the requested username",
      );
    }

    const infoResponse = await this.#transport.request({
      method: "GET",
      path: `/api/v1/users/${encodeURIComponent(String(match["pk"]))}/info/`,
      ...(signal === undefined ? {} : { signal }),
    });
    const infoParsed = parseJsonObject(infoResponse.bodyText);
    const infoUser = userOf(infoParsed?.["user"]);
    if (infoUser === undefined) {
      throw new InstagramSessionProviderError(
        "PROFILE_UNAVAILABLE",
        "Instagram matched the username but returned no profile details",
      );
    }

    return {
      platform: "instagram",
      platformUserId: String(infoUser["pk"]),
      username: String(infoUser["username"] ?? username),
      ...countField("followerCount", countValue(infoUser["follower_count"])),
      ...countField("followingCount", countValue(infoUser["following_count"])),
      ...stringField("fullName", infoUser["full_name"]),
      ...booleanField("isPrivate", infoUser["is_private"]),
      ...booleanField("isVerified", infoUser["is_verified"]),
      ...stringField("profilePicUrl", infoUser["profile_pic_url"]),
    };
  }
}

function isTransient(error: InstagramTransportError): boolean {
  return (
    error.category === "RATE_LIMITED" || error.category === "SOURCE_TEMPORARILY_UNAVAILABLE"
  );
}

function cursorFromResponse(
  parsed: Record<string, unknown> | undefined,
  items: ProviderRelationshipItem[],
  hasMore: boolean,
): string | undefined {
  const nextMaxId = parsed?.["next_max_id"];
  if (typeof nextMaxId === "string" && nextMaxId !== "") {
    return nextMaxId;
  }
  if (typeof nextMaxId === "number" && Number.isSafeInteger(nextMaxId)) {
    return String(nextMaxId);
  }
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
  if (hasMore && lastItem !== undefined && lastItem.platformUserId !== undefined) {
    return lastItem.platformUserId;
  }
  return undefined;
}

function isUsableUser(candidate: unknown): candidate is RawUser {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const user = candidate as RawUser;
  return (
    (typeof user["pk"] === "string" || typeof user["pk"] === "number")
    && typeof user["username"] === "string"
    && user["username"] !== ""
  );
}

function mapUser(user: RawUser): ProviderRelationshipItem {
  return {
    platform: "instagram",
    platformUserId: String(user["pk"]),
    username: user["username"] as string,
    ...stringField("fullName", user["full_name"]),
    ...booleanField("isPrivate", user["is_private"]),
    ...booleanField("isVerified", user["is_verified"]),
    ...stringField("profilePicUrl", user["profile_pic_url"]),
  };
}

function userOf(value: unknown): RawUser | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawUser)
    : undefined;
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countOf(edge: unknown): number | undefined {
  if (edge === null || typeof edge !== "object") {
    return undefined;
  }
  const count = (edge as RawUser)["count"];
  return typeof count === "number" && Number.isFinite(count) ? count : undefined;
}

function parseJsonObject(bodyText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function countField(name: "followerCount" | "followingCount", value: number | undefined) {
  return value === undefined ? {} : { [name]: value };
}

function stringField(name: string, value: unknown) {
  return typeof value === "string" && value !== "" ? { [name]: value } : {};
}

function booleanField(name: string, value: unknown) {
  return typeof value === "boolean" ? { [name]: value } : {};
}

function normalizeUsername(username: string): string {
  const trimmed = username.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (withoutAt === "") {
    throw new InstagramSessionProviderError("INVALID_INPUT", "username must be a non-empty string");
  }
  return withoutAt;
}

function throwIfAborted(context: ProviderRequestContext): void {
  context.signal?.throwIfAborted();
}
