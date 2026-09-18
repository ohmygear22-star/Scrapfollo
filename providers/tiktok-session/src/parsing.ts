/**
 * Pure parsers for TikTok web-app observations. All of them operate on data
 * the browser session already captured (header text, /api/user/list response
 * bodies) — no network access, fully unit-testable.
 */

import type { ProviderRelationshipItem } from "@social-graph/core";

export type ProfileCounts = { following: number; followers: number };

const COMPACT_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Parses "81 Following 162.9M Followers 2.7B Likes" style profile headers. */
export function parseProfileCounts(text: string): ProfileCounts | null {
  const followingMatch = /([\d.,]+)\s*([kmb]?)\s*following/i.exec(text);
  const followersMatch = /([\d.,]+)\s*([kmb]?)\s*followers/i.exec(text);
  if (followingMatch === null || followersMatch === null) return null;
  const toNumber = (value: string, suffix: string): number => {
    const base = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(base) ? base * (COMPACT_MULTIPLIERS[suffix.toLowerCase()] ?? 1) : Number.NaN;
  };
  const following = toNumber(followingMatch[1] ?? "", followingMatch[2] ?? "");
  const followers = toNumber(followersMatch[1] ?? "", followersMatch[2] ?? "");
  return Number.isFinite(following) && Number.isFinite(followers) ? { following, followers } : null;
}

export type ListCapture = { url: string; bodyText: string };

export type SceneAggregate = {
  scene: string | null;
  pages: number;
  items: ProviderRelationshipItem[];
  total: number | null;
  hasMore: boolean | null;
};

/**
 * Merges every captured /api/user/list response of one modal scene into a
 * single page, deduplicating by stable secUid across scroll-triggered pages.
 */
export function aggregateSceneCaptures(scene: string, captures: ListCapture[]): SceneAggregate | null {
  const matching = captures.filter((c) => c.url.includes(`scene=${scene}`));
  if (matching.length === 0) return null;
  const items = new Map<string, ProviderRelationshipItem>();
  let total: number | null = null;
  let hasMore: boolean | null = null;
  for (const capture of matching) {
    try {
      const body = JSON.parse(capture.bodyText) as Record<string, unknown>;
      if (typeof body["total"] === "number") total = body["total"];
      if (typeof body["hasMore"] === "boolean") hasMore = body["hasMore"];
      const list = body["userList"];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const item = mapTikTokUser(entry);
        if (item !== null && item.platformUserId !== undefined) {
          items.set(item.platformUserId, item);
        }
      }
    } catch {
      // truncated or non-JSON body: skip the page
    }

  }
  return {
    scene,
    pages: matching.length,
    items: Array.from(items.values()),
    total,
    hasMore,
  };
}

/** Classifies a scene aggregate against the profile's own header counts. */
export function classifySceneAggregate(
  aggregate: { total: number | null },
  profile: ProfileCounts,
): "followers" | "following" | "friends" | "unknown" {
  if (aggregate.total === null) return "unknown";
  const within = (value: number, target: number) => Math.abs(value - target) <= Math.max(target * 0.02, 2);
  if (within(aggregate.total, profile.followers)) return "followers";
  if (within(aggregate.total, profile.following)) return "following";
  if (aggregate.total < profile.following) return "friends";
  return "unknown";
}

/**
 * Maps a TikTok userList entry to the contract item. The stable identity is
 * secUid; uniqueId is the display username.
 */
export function mapTikTokUser(entry: unknown): ProviderRelationshipItem | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const user = record["user"] !== null && typeof record["user"] === "object"
    ? record["user"] as Record<string, unknown>
    : record;
  const secUid = typeof user["secUid"] === "string" ? user["secUid"] : undefined;
  const uniqueId = typeof user["uniqueId"] === "string" ? user["uniqueId"] : undefined;
  if (secUid === undefined || uniqueId === undefined || uniqueId === "") return null;
  return {
    platform: "tiktok",
    platformUserId: secUid,
    username: uniqueId,
    ...(typeof user["nickname"] === "string" && user["nickname"] !== "" ? { fullName: user["nickname"] } : {}),
    ...(typeof user["verified"] === "boolean" ? { isVerified: user["verified"] } : {}),
    ...(typeof user["avatarLarger"] === "string" && user["avatarLarger"] !== ""
      ? { profilePicUrl: user["avatarLarger"] }
      : {}),
  };
}
