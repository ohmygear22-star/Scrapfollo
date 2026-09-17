/**
 * Live smoke for the Instagram owned-session provider (P3-T6 follow-up).
 *
 * Bounded live-fire: at most 4 Instagram requests.
 *   1. resolveProfile("therock") via web_profile_info
 *      (on 429 it falls back to search + users/{pk}/info — +2 requests)
 *   2. fetchFollowingPage(profileId, limit 12)
 *
 * Output is sanitized by construction: the provider never logs cookie
 * material, cursors are reported as prefix+length only, and this script
 * prints only public profile data and pagination shape.
 *
 * Usage (droplet): node spike/ig-session-smoke.mjs [username]
 * Reads IG_* variables from /opt/scrapfollo/.env.
 */

import { readFileSync } from "node:fs";
import { InstagramSessionProvider } from "../providers/instagram-session/dist/index.js";

const ENV_PATH = process.env["SCRAPFOLLO_ENV"] ?? "/opt/scrapfollo/.env";

function loadEnvFile(path) {
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      entries.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
    }
  }
  return Object.fromEntries(entries);
}

const username = process.argv[2] ?? "therock";
const env = loadEnvFile(ENV_PATH);
const provider = new InstagramSessionProvider({ env });
const context = {
  runId: `ig-smoke-${new Date().toISOString()}`,
  targetId: `${username}-smoke`,
};

let profile;
try {
  const startedAt = Date.now();
  profile = await provider.resolveProfile({ platform: "instagram", username }, context);
  console.log(
    JSON.stringify({
      step: "resolveProfile",
      ms: Date.now() - startedAt,
      username: profile.username,
      platformUserId: profile.platformUserId,
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      isVerified: profile.isVerified,
      isPrivate: profile.isPrivate,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      step: "resolveProfile",
      failed: true,
      category: error?.category,
      retryable: error?.retryable,
      message: error?.message,
    }),
  );
  process.exit(1);
}

try {
  const startedAt = Date.now();
  const page = await provider.fetchFollowingPage(
    { profileId: profile.platformUserId, limit: 12 },
    context,
  );
  console.log(
    JSON.stringify({
      step: "fetchFollowingPage",
      ms: Date.now() - startedAt,
      items: page.items.length,
      hasMore: page.hasMore,
      nextCursorPrefix: page.nextCursor === undefined ? undefined : page.nextCursor.slice(0, 4),
      nextCursorLength: page.nextCursor?.length,
      sample: page.items
        .slice(0, 3)
        .map((item) => `${item.platformUserId}:${item.username}`),
    }),
  );
  console.log("SMOKE_OK");
} catch (error) {
  console.log(
    JSON.stringify({
      step: "fetchFollowingPage",
      failed: true,
      category: error?.category,
      retryable: error?.retryable,
      message: error?.message,
    }),
  );
  process.exit(1);
}
