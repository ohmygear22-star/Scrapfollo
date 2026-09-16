import type {
  CoreRunMetrics,
  RelationshipCollectionMetrics,
} from "../contracts/metrics.js";
import type { TargetCollectionStatus } from "../contracts/collection.js";

/**
 * Mutable batch-level accumulator for {@link CoreRunMetrics}. Profile request
 * counters come from injected retry-orchestration hooks (profile lookups have
 * no collection summary); relationship counters are summed from the collection
 * summaries each target emits; returned rows are counted when forwarded.
 */
export class CoreRunMetricsTracker {
  profilesRequested = 0;
  profilesSuccessful = 0;
  profilesFailed = 0;
  profilesPartial = 0;
  followersReturned = 0;
  followingReturned = 0;
  totalRelationshipsReturned = 0;
  rawItemsReceived = 0;
  uniqueItemsProduced = 0;
  duplicatesRemoved = 0;
  requestsMade = 0;
  requestsFailed = 0;
  requestsRetried = 0;

  readonly #startedAtMs: number;
  readonly #now: () => number;
  #bytesMeasured = false;
  #bytesSum = 0;

  constructor(now: () => number) {
    this.#startedAtMs = now();
    this.#now = now;
  }

  recordProfileRequested(): void {
    this.profilesRequested += 1;
  }

  recordProfileRequestMade(): void {
    this.requestsMade += 1;
  }

  recordProfileRequestFailed(): void {
    this.requestsFailed += 1;
  }

  recordProfileRequestRetried(): void {
    this.requestsRetried += 1;
  }

  recordTargetStatus(status: TargetCollectionStatus): void {
    if (status === "SUCCESS") this.profilesSuccessful += 1;
    else if (status === "PARTIAL") this.profilesPartial += 1;
    else this.profilesFailed += 1;
  }

  recordReturnedRow(relationship: "followers" | "following"): void {
    this.totalRelationshipsReturned += 1;
    if (relationship === "followers") this.followersReturned += 1;
    else this.followingReturned += 1;
  }

  recordCollection(metrics: RelationshipCollectionMetrics): void {
    this.rawItemsReceived += metrics.rawItemsReceived;
    this.uniqueItemsProduced += metrics.uniqueItemsProduced;
    this.duplicatesRemoved += metrics.duplicatesRemoved;
    this.requestsMade += metrics.requestsMade;
    this.requestsFailed += metrics.requestsFailed;
    this.requestsRetried += metrics.requestsRetried;
    if (metrics.bytesTransferred !== null) {
      this.#bytesMeasured = true;
      this.#bytesSum += metrics.bytesTransferred;
    }
  }

  /** Immutable snapshot; bytesTransferred stays null when nothing was measured. */
  finish(): CoreRunMetrics {
    return Object.freeze({
      profilesRequested: this.profilesRequested,
      profilesSuccessful: this.profilesSuccessful,
      profilesFailed: this.profilesFailed,
      profilesPartial: this.profilesPartial,
      followersReturned: this.followersReturned,
      followingReturned: this.followingReturned,
      totalRelationshipsReturned: this.totalRelationshipsReturned,
      rawItemsReceived: this.rawItemsReceived,
      uniqueItemsProduced: this.uniqueItemsProduced,
      duplicatesRemoved: this.duplicatesRemoved,
      requestsMade: this.requestsMade,
      requestsFailed: this.requestsFailed,
      requestsRetried: this.requestsRetried,
      bytesTransferred: this.#bytesMeasured ? this.#bytesSum : null,
      runtimeMs: Math.max(0, this.#now() - this.#startedAtMs),
    });
  }
}
