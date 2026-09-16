import type { CollectionCompleteness } from "../contracts/collection.js";
import type { PublicCollectionError } from "../contracts/errors.js";

export type CompletenessOutcome =
  | { outcome: "source" }
  | { outcome: "max" }
  | { outcome: "error"; error: PublicCollectionError }
  | { outcome: "abort" };

/**
 * Authoritative terminal mapping for every relationship collection. Only
 * SOURCE_EXHAUSTED is complete; only ERROR carries a PublicCollectionError;
 * MAX_LIMIT_REACHED and ABORTED are incomplete without an error.
 */
export function completeCollection(outcome: CompletenessOutcome): CollectionCompleteness {
  switch (outcome.outcome) {
    case "source":
      return { complete: true, terminationReason: "SOURCE_EXHAUSTED" };
    case "max":
      return { complete: false, terminationReason: "MAX_LIMIT_REACHED" };
    case "error":
      return { complete: false, terminationReason: "ERROR", error: outcome.error };
    case "abort":
      return { complete: false, terminationReason: "ABORTED" };
  }
}
