import type { CoreRunMetrics } from "@social-graph/core";
import type { ActorRunOutcome } from "./main.js";

export type RunSummaryTiming = {
  startedAt: string;
  finishedAt: string;
  actorRuntimeMs: number;
  datasetOperations: number;
  /** Provided only when the platform reports real usage; local runs omit it. */
  measuredCost?: MeasuredCost;
  computeUnits?: number;
  proxyBytes?: number;
  proxyCostUsd?: number;
};

export type MeasuredCost = {
  estimatedCostUsd: number;
  currency: string;
  status: "actual" | "estimated";
};

export type ApifyCostLayer = {
  compute_units: number | null;
  proxy_bytes: number | null;
  proxy_cost: number | null;
  dataset_operations: number;
  actor_runtime_ms: number;
  estimated_cost: number | null;
  currency: string | null;
  cost_data_status: "actual" | "estimated" | "unavailable";
};

export type DerivedMetrics = {
  SUCCESS_RATE: number;
  COST_PER_1000_RESULTS: number | null;
  REQUESTS_PER_1000_RESULTS: number | null;
  SECONDS_PER_1000_RESULTS: number | null;
};

export type RunSummary = {
  run_id: string;
  started_at: string;
  finished_at: string;
  requested: {
    scrapeType: ActorRunOutcome["input"]["scrapeType"];
    targets: ReadonlyArray<{ targetId: string; platform: string; username: string }>;
    maxFollowers?: number;
    maxFollowing?: number;
  };
  targets: ReadonlyArray<ActorRunOutcome["targets"][number]>;
  core_run_metrics: CoreRunMetrics;
  apify: ApifyCostLayer;
  derived: DerivedMetrics;
  aborted: boolean;
  abort_reason?: "timeout";
  rows_written: number;
  rows_dropped: number;
};

/**
 * Assembles the RUN_SUMMARY stored in the Key-Value Store. The Apify cost
 * layer carries only measured values; without a measurement it reports
 * `unavailable` with nulls and derived cost metrics stay null — never
 * fabricated (spec §12).
 */
export function buildRunSummary(
  outcome: ActorRunOutcome,
  timing: RunSummaryTiming,
): RunSummary {
  const { measuredCost, computeUnits, proxyBytes, proxyCostUsd } = timing;
  const metrics = outcome.metrics;
  const costStatus: ApifyCostLayer["cost_data_status"] = measuredCost?.status ?? "unavailable";
  const estimatedCost = measuredCost?.estimatedCostUsd ?? null;
  const results = metrics?.totalRelationshipsReturned ?? 0;

  const derived: DerivedMetrics = {
    SUCCESS_RATE: metrics === undefined || metrics.profilesRequested === 0
      ? 0
      : metrics.profilesSuccessful / metrics.profilesRequested,
    COST_PER_1000_RESULTS: estimatedCost === null || results <= 0
      ? null
      : (estimatedCost / results) * 1_000,
    REQUESTS_PER_1000_RESULTS: metrics === undefined || results <= 0
      ? null
      : (metrics.requestsMade / results) * 1_000,
    SECONDS_PER_1000_RESULTS: metrics === undefined || results <= 0
      ? null
      : metrics.runtimeMs / results,
  };

  return Object.freeze({
    run_id: outcome.runId,
    started_at: timing.startedAt,
    finished_at: timing.finishedAt,
    requested: {
      scrapeType: outcome.input.scrapeType,
      targets: outcome.input.targets,
      ...(outcome.input.maxFollowers === undefined ? {} : { maxFollowers: outcome.input.maxFollowers }),
      ...(outcome.input.maxFollowing === undefined ? {} : { maxFollowing: outcome.input.maxFollowing }),
    },
    targets: outcome.targets,
    core_run_metrics: metrics ?? emptyMetrics(),
    apify: Object.freeze({
      compute_units: computeUnits ?? null,
      proxy_bytes: proxyBytes ?? null,
      proxy_cost: proxyCostUsd ?? null,
      dataset_operations: timing.datasetOperations,
      actor_runtime_ms: timing.actorRuntimeMs,
      estimated_cost: estimatedCost,
      currency: measuredCost?.currency ?? null,
      cost_data_status: costStatus,
    }),
    derived: Object.freeze(derived),
    aborted: outcome.aborted,
    ...(outcome.abortReason === undefined ? {} : { abort_reason: outcome.abortReason }),
    rows_written: outcome.rowsWritten,
    rows_dropped: outcome.rowsDropped,
  });
}

function emptyMetrics(): CoreRunMetrics {
  return Object.freeze({
    profilesRequested: 0,
    profilesSuccessful: 0,
    profilesFailed: 0,
    profilesPartial: 0,
    followersReturned: 0,
    followingReturned: 0,
    totalRelationshipsReturned: 0,
    rawItemsReceived: 0,
    uniqueItemsProduced: 0,
    duplicatesRemoved: 0,
    requestsMade: 0,
    requestsFailed: 0,
    requestsRetried: 0,
    bytesTransferred: null,
    runtimeMs: 0,
  });
}
