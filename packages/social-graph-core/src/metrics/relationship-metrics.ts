import type { RelationshipCollectionMetrics } from "../contracts/metrics.js";
import type { ProviderRelationshipPage } from "../contracts/provider.js";

/**
 * Mutable per-collection accumulator. Every counter increments at its exact
 * decision point: raw items and measured bytes on page receipt, unique and
 * duplicate at the dedupe decision, request counters only from
 * retry-orchestration hooks. Runtime comes from the injected monotonic clock.
 */
export class RelationshipMetricsCounter {
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

  recordPage(page: Pick<ProviderRelationshipPage, "items" | "requestMetadata">): void {
    this.rawItemsReceived += page.items.length;
    const bytes = page.requestMetadata.bytesTransferred;
    if (typeof bytes === "number" && Number.isFinite(bytes)) {
      this.#bytesMeasured = true;
      this.#bytesSum += bytes;
    }
  }

  recordUnique(): void {
    this.uniqueItemsProduced += 1;
  }

  recordDuplicate(): void {
    this.duplicatesRemoved += 1;
  }

  recordRequestMade(): void {
    this.requestsMade += 1;
  }

  recordRequestFailed(): void {
    this.requestsFailed += 1;
  }

  recordRequestRetried(): void {
    this.requestsRetried += 1;
  }

  /** Immutable snapshot; bytesTransferred stays null when nothing was measured. */
  finish(): RelationshipCollectionMetrics {
    return Object.freeze({
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
