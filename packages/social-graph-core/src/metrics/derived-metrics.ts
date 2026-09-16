import type {
  CoreRunMetrics,
  RelationshipCollectionMetrics,
} from "../contracts/metrics.js";

export type DerivedPerThousand = {
  requestsPer1000Results: number | null;
  secondsPer1000Results: number | null;
};

type RateInputs = {
  results: number;
  requestsMade: number;
  runtimeMs: number;
};

/**
 * Derives per-thousand rates from measured work. Both rates are null when no
 * results were produced; rates never fabricate unmeasured values.
 */
export function derivePerThousand(
  metrics: CoreRunMetrics | RelationshipCollectionMetrics,
): DerivedPerThousand {
  const inputs: RateInputs = "totalRelationshipsReturned" in metrics
    ? {
      results: metrics.totalRelationshipsReturned,
      requestsMade: metrics.requestsMade,
      runtimeMs: metrics.runtimeMs,
    }
    : {
      results: metrics.uniqueItemsProduced,
      requestsMade: metrics.requestsMade,
      runtimeMs: metrics.runtimeMs,
    };

  if (inputs.results <= 0) {
    return Object.freeze({ requestsPer1000Results: null, secondsPer1000Results: null });
  }

  return Object.freeze({
    requestsPer1000Results: (inputs.requestsMade / inputs.results) * 1_000,
    secondsPer1000Results: (inputs.runtimeMs / 1_000 / inputs.results) * 1_000,
  });
}
