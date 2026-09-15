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

export type CollectRelationshipsOptions = {
  now?: () => Date;
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

  let page;
  try {
    const fetchPage = request.relationship === "followers"
      ? provider.fetchFollowersPage.bind(provider)
      : provider.fetchFollowingPage.bind(provider);
    page = await fetchPage(
      {
        profileId: sourceProfile.platformUserId,
        limit: request.maxResults ?? 100,
      },
      {
        runId: request.runId,
        targetId: request.targetId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );

    let position = 0;
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

      position += 1;
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
  } catch (error) {
    const normalized = normalizeProviderError(error, {
      platform: request.platform,
      targetId: request.targetId,
    });
    yield summaryFor(request, sourceProfile, normalized.toPublicError());
    return;
  }

  if (page.hasMore) {
    yield summaryFor(request, sourceProfile, new CollectionError({
      category: "PAGINATION_FAILED",
      message: "Additional page encountered before pagination support is active",
      retryable: false,
      platform: request.platform,
      targetId: request.targetId,
    }).toPublicError());
    return;
  }

  yield {
    type: "summary",
    value: {
      ...summaryBase(request, sourceProfile),
      completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" },
    },
  };
}

function summaryFor(
  request: CollectRelationshipRequest,
  sourceProfile: ProviderProfile,
  error: ReturnType<CollectionError["toPublicError"]>,
): RelationshipStreamEvent {
  return {
    type: "summary",
    value: {
      ...summaryBase(request, sourceProfile),
      completeness: { complete: false, terminationReason: "ERROR", error },
    },
  };
}

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
    metrics: {
      rawItemsReceived: 0,
      uniqueItemsProduced: 0,
      duplicatesRemoved: 0,
      requestsMade: 0,
      requestsFailed: 0,
      requestsRetried: 0,
      bytesTransferred: null,
      runtimeMs: 0,
    },
  };
}
