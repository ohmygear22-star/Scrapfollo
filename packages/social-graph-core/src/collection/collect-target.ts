import type {
  CollectTargetRequest,
  RelationshipCollectionSummary,
  RelationshipType,
  TargetCollectionStatus,
  TargetStreamEvent,
  TerminationReason,
} from "../contracts/collection.js";
import type { ProviderProfile, SocialGraphProvider } from "../contracts/provider.js";
import { CollectionError } from "../errors/collection-error.js";
import { normalizeProviderError } from "../errors/normalize-error.js";
import { isAbortError } from "../retry/abortable-delay.js";
import type { RetryOptions } from "../retry/retry-policy.js";
import { collectRelationships } from "./collect-relationships.js";
import { resolveProfile } from "./resolve-profile.js";

export type CollectTargetOptions = {
  now?: () => Date;
  retry?: RetryOptions;
};

type SelectedRelationship = {
  relationship: RelationshipType;
  maxResults?: number;
};

/**
 * Collects the requested relationship types for one target through one
 * provider. Profile resolution happens first and exactly once; a profile
 * failure is a target-level failure with no relationship work. After the
 * profile resolves, followers and following run as independent relationship
 * collections with independent summaries.
 */
export async function* collectTarget(
  request: CollectTargetRequest,
  provider: SocialGraphProvider,
  options: CollectTargetOptions = {},
): AsyncGenerator<TargetStreamEvent> {
  if (request.platform !== provider.platform) {
    yield failedTargetSummary(request, new CollectionError({
      category: "INVALID_INPUT",
      message: "Target platform does not match provider platform",
      retryable: false,
      platform: request.platform,
      targetId: request.targetId,
    }));
    return;
  }

  let profile: ProviderProfile;
  try {
    profile = await resolveProfile(request, provider, options.retry);
  } catch (error) {
    const normalized = isAbortError(error)
      ? new CollectionError({
        category: "UNKNOWN_ERROR",
        message: "Profile resolution was aborted",
        retryable: false,
        platform: request.platform,
        targetId: request.targetId,
        cause: error,
      })
      : normalizeProviderError(error, {
        platform: request.platform,
        targetId: request.targetId,
      });
    yield failedTargetSummary(request, normalized);
    return;
  }

  yield {
    type: "profile",
    runId: request.runId,
    targetId: request.targetId,
    value: profile,
  };

  const selected = selectedRelationships(request);
  const collections: RelationshipCollectionSummary[] = [];

  for (const { relationship, maxResults } of selected) {
    for await (const event of collectRelationships(
      {
        runId: request.runId,
        targetId: request.targetId,
        platform: request.platform,
        username: request.username,
        relationship,
        ...(maxResults === undefined ? {} : { maxResults }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      profile,
      provider,
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
      },
    )) {
      if (event.type === "relationship") {
        yield {
          type: "relationship",
          runId: request.runId,
          targetId: request.targetId,
          value: event.value,
        };
      } else {
        collections.push(event.value);
        yield {
          type: "collectionSummary",
          runId: request.runId,
          targetId: request.targetId,
          value: event.value,
        };
      }
    }
  }

  yield {
    type: "targetSummary",
    runId: request.runId,
    targetId: request.targetId,
    value: {
      runId: request.runId,
      targetId: request.targetId,
      platform: request.platform,
      username: request.username,
      status: deriveTargetStatus(collections, selected.length),
      collections,
    },
  };
}

function selectedRelationships(request: CollectTargetRequest): SelectedRelationship[] {
  if (request.scrapeType === "followers") {
    return [{
      relationship: "followers",
      ...(request.maxFollowers === undefined ? {} : { maxResults: request.maxFollowers }),
    }];
  }
  if (request.scrapeType === "following") {
    return [{
      relationship: "following",
      ...(request.maxFollowing === undefined ? {} : { maxResults: request.maxFollowing }),
    }];
  }
  return [
    {
      relationship: "followers",
      ...(request.maxFollowers === undefined ? {} : { maxResults: request.maxFollowers }),
    },
    {
      relationship: "following",
      ...(request.maxFollowing === undefined ? {} : { maxResults: request.maxFollowing }),
    },
  ];
}

function completedCollection(summary: RelationshipCollectionSummary): boolean {
  const reason: TerminationReason = summary.completeness.terminationReason;
  return reason === "SOURCE_EXHAUSTED" || reason === "MAX_LIMIT_REACHED";
}

export function deriveTargetStatus(
  collections: ReadonlyArray<RelationshipCollectionSummary>,
  expectedCount: number = collections.length,
): TargetCollectionStatus {
  if (collections.length < expectedCount) {
    return collections.some(completedCollection) ? "PARTIAL" : "FAILED";
  }
  if (collections.length === 0) return "FAILED";
  if (collections.every(completedCollection)) return "SUCCESS";
  if (collections.some(completedCollection)) return "PARTIAL";
  return "FAILED";
}

function failedTargetSummary(
  request: CollectTargetRequest,
  error: CollectionError,
): TargetStreamEvent {
  return {
    type: "targetSummary",
    runId: request.runId,
    targetId: request.targetId,
    value: {
      runId: request.runId,
      targetId: request.targetId,
      platform: request.platform,
      username: request.username,
      status: "FAILED",
      collections: [],
      error: error.toPublicError(),
    },
  };
}
