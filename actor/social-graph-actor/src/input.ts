import type { Platform, ScrapeType } from "@social-graph/core";

const PLATFORMS: ReadonlySet<Platform> = new Set(["instagram", "x", "tiktok"]);
const SCRAPE_TYPES: ReadonlySet<ScrapeType> = new Set(["followers", "following", "both"]);

const TARGET_LIMIT = 100;
const MAX_RESULTS_LIMIT = 100_000;
const CONCURRENCY_MAX = 8;
const EVENT_BUFFER_MAX = 64;
const DEFAULT_CONCURRENCY = 2;

export type ActorInputTarget = {
  targetId: string;
  platform: Platform;
  username: string;
};

export type ValidatedActorInput = {
  targets: ReadonlyArray<ActorInputTarget>;
  scrapeType: ScrapeType;
  maxFollowers?: number;
  maxFollowing?: number;
  concurrency: number;
  eventBufferSize: number;
};

export class ActorInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(`INVALID_INPUT: ${message}`);
    this.name = "ActorInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveIntegerWithin(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ActorInputError(`${field} must be a positive integer`);
  }
  if (value > maximum) {
    throw new ActorInputError(`${field} exceeds the safety limit of ${maximum}`);
  }
  return value;
}

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

function normalizedIdentity(platform: Platform, username: string): string {
  return `${platform}:${username.trim().toLocaleLowerCase("en-US")}`;
}

/**
 * Pure, strict validation of the actor's public input. Rejects unknown keys,
 * unsupported platforms (YouTube excluded), duplicate
 * (platform, normalizedUsername) targets, and any numeric option outside the
 * configured safety limits. Usernames are trimmed and a leading `@` removed;
 * targetIds are generated as `t<index>`.
 */
export function validateActorInput(raw: unknown): ValidatedActorInput {
  if (!isRecord(raw)) {
    throw new ActorInputError("Input must be a JSON object");
  }

  const allowedKeys = new Set([
    "targets",
    "scrapeType",
    "maxFollowers",
    "maxFollowing",
    "concurrency",
    "eventBufferSize",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new ActorInputError(`Unknown input key: ${key}`);
    }
  }

  if (!Array.isArray(raw.targets)) {
    throw new ActorInputError("targets must be an array");
  }
  if (raw.targets.length === 0) {
    throw new ActorInputError("At least one target is required");
  }
  if (raw.targets.length > TARGET_LIMIT) {
    throw new ActorInputError(`targets exceed the safety limit of ${TARGET_LIMIT}`);
  }

  const seenIdentities = new Set<string>();
  const targets: ActorInputTarget[] = [];
  raw.targets.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new ActorInputError(`targets[${index}] must be an object`);
    }
    for (const key of Object.keys(candidate)) {
      if (key !== "platform" && key !== "username") {
        throw new ActorInputError(`Unknown target key: ${key}`);
      }
    }

    const { platform, username } = candidate;
    if (typeof platform !== "string" || !PLATFORMS.has(platform as Platform)) {
      throw new ActorInputError(
        `targets[${index}].platform must be one of instagram, x, or tiktok`,
      );
    }
    if (typeof username !== "string") {
      throw new ActorInputError(`targets[${index}].username must be a string`);
    }

    const normalized = normalizeUsername(username);
    if (normalized === "") {
      throw new ActorInputError(`targets[${index}].username must not be empty`);
    }

    const identity = normalizedIdentity(platform as Platform, normalized);
    if (seenIdentities.has(identity)) {
      throw new ActorInputError(`Duplicate target platform/username: ${identity}`);
    }
    seenIdentities.add(identity);

    targets.push({
      targetId: `t${index + 1}`,
      platform: platform as Platform,
      username: normalized,
    });
  });

  if (typeof raw.scrapeType !== "string" || !SCRAPE_TYPES.has(raw.scrapeType as ScrapeType)) {
    throw new ActorInputError("scrapeType must be followers, following, or both");
  }

  const maxFollowers = raw.maxFollowers === undefined
    ? undefined
    : requirePositiveIntegerWithin(raw.maxFollowers, "maxFollowers", MAX_RESULTS_LIMIT);
  const maxFollowing = raw.maxFollowing === undefined
    ? undefined
    : requirePositiveIntegerWithin(raw.maxFollowing, "maxFollowing", MAX_RESULTS_LIMIT);

  const concurrency = raw.concurrency === undefined
    ? DEFAULT_CONCURRENCY
    : requirePositiveIntegerWithin(raw.concurrency, "concurrency", CONCURRENCY_MAX);

  const eventBufferSize = raw.eventBufferSize === undefined
    ? concurrency * 4
    : requirePositiveIntegerWithin(raw.eventBufferSize, "eventBufferSize", EVENT_BUFFER_MAX);

  return {
    targets,
    scrapeType: raw.scrapeType as ScrapeType,
    ...(maxFollowers === undefined ? {} : { maxFollowers }),
    ...(maxFollowing === undefined ? {} : { maxFollowing }),
    concurrency,
    eventBufferSize,
  };
}
