import type { PublicCollectionErrorCategory } from "../contracts/errors.js";
import type { Platform } from "../contracts/provider.js";
import { CollectionError } from "./collection-error.js";

const categories = new Set<PublicCollectionErrorCategory>([
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
]);

const safeMessages: Record<PublicCollectionErrorCategory, string> = {
  PROFILE_NOT_FOUND: "The requested profile was not found",
  PROFILE_UNAVAILABLE: "The requested profile is unavailable",
  PRIVATE_PROFILE_UNSUPPORTED: "Private profiles are not supported",
  CAPABILITY_UNSUPPORTED: "The provider does not support this capability",
  PROVIDER_UNAVAILABLE: "The provider is unavailable",
  RATE_LIMITED: "The provider rate limit was reached",
  SOURCE_TEMPORARILY_UNAVAILABLE: "The source is temporarily unavailable",
  PAGINATION_FAILED: "Relationship pagination failed",
  INVALID_INPUT: "The provider rejected the request input",
  UNKNOWN_ERROR: "An unknown provider error occurred",
};

export type ErrorContext = {
  platform?: Platform;
  targetId?: string;
};

export function normalizeProviderError(
  error: unknown,
  context: ErrorContext = {},
): CollectionError {
  if (error instanceof CollectionError) {
    const platform = error.platform ?? context.platform;
    const targetId = error.targetId ?? context.targetId;
    if (platform === error.platform && targetId === error.targetId) return error;

    return new CollectionError({
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      ...(platform === undefined ? {} : { platform }),
      ...(targetId === undefined ? {} : { targetId }),
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });
  }

  const candidate = asRecord(error);
  const category = isCategory(candidate?.category)
    ? candidate.category
    : "UNKNOWN_ERROR";
  const recognized = category !== "UNKNOWN_ERROR" || candidate?.category === "UNKNOWN_ERROR";

  return new CollectionError({
    category,
    message: safeMessages[category],
    retryable: recognized && typeof candidate?.retryable === "boolean"
      ? candidate.retryable
      : false,
    ...context,
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function isCategory(value: unknown): value is PublicCollectionErrorCategory {
  return typeof value === "string" && categories.has(value as PublicCollectionErrorCategory);
}
