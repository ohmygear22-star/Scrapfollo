import type { PublicCollectionError } from "./errors.js";
import type { RelationshipCollectionMetrics } from "./metrics.js";
import type { Platform, ProviderProfile } from "./provider.js";

export type RelationshipType = "followers" | "following";
export type ScrapeType = RelationshipType | "both";

export type TerminationReason =
  | "SOURCE_EXHAUSTED"
  | "MAX_LIMIT_REACHED"
  | "ERROR"
  | "ABORTED";

export type CollectRelationshipRequest = {
  runId: string;
  targetId: string;
  platform: Platform;
  username: string;
  relationship: RelationshipType;
  maxResults?: number;
  signal?: AbortSignal;
};

export type CollectTargetRequest = {
  runId: string;
  targetId: string;
  platform: Platform;
  username: string;
  scrapeType: ScrapeType;
  maxFollowers?: number;
  maxFollowing?: number;
  signal?: AbortSignal;
};

export type CollectTargetsRequest = {
  runId: string;
  targets: ReadonlyArray<{
    targetId: string;
    platform: Platform;
    username: string;
  }>;
  scrapeType: ScrapeType;
  maxFollowers?: number;
  maxFollowing?: number;
  concurrency: number;
  signal?: AbortSignal;
};

export type NormalizedRelationship = {
  platform: Platform;
  sourceUsername: string;
  sourceUserId: string;
  relationship: RelationshipType;
  userId?: string;
  username: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
  position: number;
  scrapedAt: string;
};

export type CollectionCompleteness = {
  complete: boolean;
  terminationReason: TerminationReason;
  error?: PublicCollectionError;
};

export type RelationshipCollectionSummary = {
  runId: string;
  targetId: string;
  platform: Platform;
  sourceProfile: ProviderProfile;
  relationship: RelationshipType;
  completeness: CollectionCompleteness;
  metrics: RelationshipCollectionMetrics;
};

export type RelationshipStreamEvent =
  | { type: "relationship"; value: NormalizedRelationship }
  | { type: "summary"; value: RelationshipCollectionSummary };

export type TargetCollectionStatus = "SUCCESS" | "PARTIAL" | "FAILED";

export type TargetCollectionSummary = {
  runId: string;
  targetId: string;
  platform: Platform;
  username: string;
  status: TargetCollectionStatus;
  collections: ReadonlyArray<RelationshipCollectionSummary>;
  error?: PublicCollectionError;
};

export type TargetStreamEvent =
  | { type: "profile"; runId: string; targetId: string; value: ProviderProfile }
  | { type: "relationship"; runId: string; targetId: string; value: NormalizedRelationship }
  | {
      type: "collectionSummary";
      runId: string;
      targetId: string;
      value: RelationshipCollectionSummary;
    }
  | {
      type: "targetSummary";
      runId: string;
      targetId: string;
      value: TargetCollectionSummary;
    };
