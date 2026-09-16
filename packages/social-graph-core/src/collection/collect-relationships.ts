import type {
  CollectRelationshipRequest,
  RelationshipCollectionSummary,
  RelationshipStreamEvent,
} from "../contracts/collection.js";
import type {
  ProviderProfile,
  SocialGraphProvider,
} from "../contracts/provider.js";
import { CollectionError } from "../errors/collection-error.js";
import { normalizeProviderError } from "../errors/normalize-error.js";
import { normalizeRelationship } from "../normalization/normalize-relationship.js";
import { ExactDeduplicator } from "../deduplication/exact-deduplicator.js";
import { completeCollection } from "./completeness.js";
import { RelationshipMetricsCounter } from "../metrics/relationship-metrics.js";
import { relationshipDedupeKey } from "../deduplication/relationship-key.js";
import { isAbortError } from "../retry/abortable-delay.js";
import { retryOperation } from "../retry/retry-operation.js";
import type { RetryOptions } from "../retry/retry-policy.js";
import { PaginationState, PaginationStateError } from "./pagination-state.js";

export type CollectRelationshipsOptions = {
  now?: () => Date;
  retry?: RetryOptions;
  monotonicNow?: () => number;
};

export async function* collectRelationships(
  request: CollectRelationshipRequest,
  sourceProfile: ProviderProfile,
  provider: SocialGraphProvider,
  options: CollectRelationshipsOptions = {},
): AsyncGenerator<RelationshipStreamEvent> {
  if (
    request.platform !== provider.platform
    || sourceProfile.platform !== provider.platform
  ) {
    yield summaryFor(request, sourceProfile, new CollectionError({
      category: "INVALID_INPUT",
      message: "Request and resolved profile platforms must match the provider platform",
      retryable: false,
      platform: request.platform,
      targetId: request.targetId,
    }).toPublicError());
    return;
  }

  const capability = request.relationship === "followers"
    ? "followerIdentities"
    : "followingIdentities";

  if (!provider.capabilities[capability]) {
    yield summaryFor(request, sourceProfile, {
      category: "CAPABILITY_UNSUPPORTED",
      message: `Provider does not support ${request.relationship} identities`,
      retryable: false,
      platform: request.platform,
      targetId: request.targetId,
    });
    return;
  }

  if (
    request.maxResults !== undefined
    && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1)
  ) {
    yield summaryFor(request, sourceProfile, {
      category: "INVALID_INPUT",
      message: "maxResults must be a positive safe integer",
      retryable: false,
      platform: request.platform,
      targetId: request.targetId,
    });
    return;
  }

  const pagination = new PaginationState();
  const deduplicator = new ExactDeduplicator();
  const monotonicNow = options.monotonicNow ?? Date.now;
  const metrics = new RelationshipMetricsCounter(monotonicNow);
  let position = 0;
  let uniqueItemsProduced = 0;
  let cursor: string | undefined;
  const fetchPage = request.relationship === "followers"
    ? provider.fetchFollowersPage.bind(provider)
    : provider.fetchFollowingPage.bind(provider);

  const callerSignal = request.signal;
  const internalController = new AbortController();
  const internalSignal = internalController.signal;
  const forwardAbort = () => internalController.abort();
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) internalController.abort();
    callerSignal.addEventListener("abort", forwardAbort);
  }

  try {
    do {
      const page = await retryOperation(
        () => fetchPage(
          {
            profileId: sourceProfile.platformUserId,
            limit: request.maxResults ?? 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          {
            runId: request.runId,
            targetId: request.targetId,
            signal: internalSignal,
          },
        ),
        {
          signal: internalSignal,
          ...(options.retry ?? {}),
          hooks: {
            onAttempt: () => {
              metrics.recordRequestMade();
            },
            onFailure: () => {
              metrics.recordRequestFailed();
            },
            onRetry: () => {
              metrics.recordRequestRetried();
            },
          },
        },
      );
      pagination.recordPage(page);
      metrics.recordPage(page);
      let uniqueRowAfterMax = false;

      for (const item of page.items) {
        if (item.platform !== provider.platform) {
          throw new CollectionError({
            category: "INVALID_INPUT",
            message: "Relationship item platform does not match provider platform",
            retryable: false,
            platform: request.platform,
            targetId: request.targetId,
          });
        }

        const key = relationshipDedupeKey({
          platform: item.platform,
          sourceUserId: sourceProfile.platformUserId,
          relationship: request.relationship,
          ...(item.platformUserId === undefined ? {} : { platformUserId: item.platformUserId }),
          username: item.username,
          stableUserIds: provider.capabilities.stableUserIds,
        });
        if (deduplicator.has(key)) {
          metrics.recordDuplicate();
          continue;
        }
        if (
          request.maxResults !== undefined
          && uniqueItemsProduced >= request.maxResults
        ) {
          uniqueRowAfterMax = true;
          break;
        }
        deduplicator.accept(key);

        position += 1;
        uniqueItemsProduced += 1;
        metrics.recordUnique();
        yield {
          type: "relationship",
          value: normalizeRelationship({
            sourceProfile,
            relationship: request.relationship,
            item,
            position,
            scrapedAt: (options.now ?? (() => new Date()))().toISOString(),
          }),
        };
      }

      if (
        request.maxResults !== undefined
        && uniqueItemsProduced >= request.maxResults
      ) {
        if (page.hasMore || uniqueRowAfterMax) {
          yield {
            type: "summary",
            value: {
              ...summaryBase(request, sourceProfile),
              metrics: metrics.finish(),
              completeness: completeCollection({ outcome: "max" }),
            },
          };
          return;
        }
        break;
      }

      cursor = pagination.nextCursorFor(page, provider.capabilities.pagination);
    } while (cursor !== undefined);

    yield {
      type: "summary",
      value: {
        ...summaryBase(request, sourceProfile),
        metrics: metrics.finish(),
        completeness: completeCollection({ outcome: "source" }),
      },
    };
  } catch (error) {
    if (isAbortError(error)) {
      if (callerSignal?.aborted) {
        yield {
          type: "summary",
          value: {
            ...summaryBase(request, sourceProfile),
            metrics: metrics.finish(),
            completeness: completeCollection({ outcome: "abort" }),
          },
        };
      }
      return;
    }

    if (error instanceof PaginationStateError) {
      yield summaryFor(request, sourceProfile, new CollectionError({
        category: "PAGINATION_FAILED",
        message: error.message,
        retryable: false,
        platform: request.platform,
        targetId: request.targetId,
      }).toPublicError(), metrics);
      return;
    }

    const normalized = normalizeProviderError(error, {
      platform: request.platform,
      targetId: request.targetId,
    });
    yield summaryFor(request, sourceProfile, normalized.toPublicError(), metrics);
    return;
  } finally {
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener("abort", forwardAbort);
    }
    internalController.abort();
  }
}

function summaryFor(
  request: CollectRelationshipRequest,
  sourceProfile: ProviderProfile,
  error: ReturnType<CollectionError["toPublicError"]>,
  metrics?: RelationshipMetricsCounter,
): RelationshipStreamEvent {
  return {
    type: "summary",
    value: {
      ...summaryBase(request, sourceProfile),
      ...(metrics === undefined ? {} : { metrics: metrics.finish() }),
      completeness: completeCollection({ outcome: "error", error }),
    },
  };
}

const ZERO_METRICS: RelationshipCollectionSummary["metrics"] = Object.freeze({
  rawItemsReceived: 0,
  uniqueItemsProduced: 0,
  duplicatesRemoved: 0,
  requestsMade: 0,
  requestsFailed: 0,
  requestsRetried: 0,
  bytesTransferred: null,
  runtimeMs: 0,
});

function summaryBase(
  request: CollectRelationshipRequest,
  sourceProfile: ProviderProfile,
): Omit<RelationshipCollectionSummary, "completeness"> {
  return {
    runId: request.runId,
    targetId: request.targetId,
    platform: request.platform,
    sourceProfile,
    relationship: request.relationship,
    metrics: ZERO_METRICS,
  };
}
