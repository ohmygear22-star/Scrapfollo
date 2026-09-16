import { describe, expect, it } from "vitest";
import { buildRunSummary } from "../src/run-summary.js";
import type { ActorRunOutcome } from "../src/main.js";
import type { CoreRunMetrics } from "@social-graph/core";

const metrics: CoreRunMetrics = {
  profilesRequested: 4,
  profilesSuccessful: 2,
  profilesFailed: 1,
  profilesPartial: 1,
  followersReturned: 250,
  followingReturned: 50,
  totalRelationshipsReturned: 300,
  rawItemsReceived: 320,
  uniqueItemsProduced: 300,
  duplicatesRemoved: 20,
  requestsMade: 12,
  requestsFailed: 2,
  requestsRetried: 1,
  bytesTransferred: 60_000,
  runtimeMs: 30_000,
};

function outcome(overrides: Partial<ActorRunOutcome> = {}): ActorRunOutcome {
  return {
    runId: "run-1",
    input: {
      targets: [{ targetId: "t1", platform: "instagram", username: "alpha" }],
      scrapeType: "both",
      concurrency: 2,
      eventBufferSize: 8,
    },
    targets: [],
    rowsWritten: 300,
    rowsDropped: 0,
    aborted: false,
    metrics,
    ...overrides,
  } as ActorRunOutcome;
}

describe("buildRunSummary", () => {
  it("assembles identity, timing, per-target outcomes, and metrics", () => {
    const summary = buildRunSummary(outcome(), {
      startedAt: "2026-09-16T10:00:00.000Z",
      finishedAt: "2026-09-16T10:00:42.000Z",
      actorRuntimeMs: 42_000,
      datasetOperations: 305,
    });

    expect(summary).toMatchObject({
      run_id: "run-1",
      started_at: "2026-09-16T10:00:00.000Z",
      finished_at: "2026-09-16T10:00:42.000Z",
      requested: {
        scrapeType: "both",
        targets: [{ targetId: "t1", platform: "instagram", username: "alpha" }],
      },
      core_run_metrics: metrics,
    });
    expect(summary.apify).toMatchObject({
      dataset_operations: 305,
      actor_runtime_ms: 42_000,
      cost_data_status: "unavailable",
    });
  });

  it("derives per-thousand metrics from measured work", () => {
    const summary = buildRunSummary(outcome(), {
      startedAt: "2026-09-16T10:00:00.000Z",
      finishedAt: "2026-09-16T10:00:42.000Z",
      actorRuntimeMs: 42_000,
      datasetOperations: 305,
      measuredCost: { estimatedCostUsd: 6.0, currency: "USD", status: "estimated" },
    });

    expect(summary.derived).toEqual({
      SUCCESS_RATE: 2 / 4,
      COST_PER_1000_RESULTS: 20,
      REQUESTS_PER_1000_RESULTS: 40,
      SECONDS_PER_1000_RESULTS: 100,
    });
    expect(summary.apify).toMatchObject({
      estimated_cost: 6.0,
      currency: "USD",
      cost_data_status: "estimated",
    });
  });

  it("returns null per-thousand metrics when no relationships were returned", () => {
    const zero = { ...metrics, totalRelationshipsReturned: 0 };
    const summary = buildRunSummary(outcome({ metrics: zero }), {
      startedAt: "2026-09-16T10:00:00.000Z",
      finishedAt: "2026-09-16T10:00:01.000Z",
      actorRuntimeMs: 1_000,
      datasetOperations: 0,
    });

    expect(summary.derived).toEqual({
      SUCCESS_RATE: 2 / 4,
      COST_PER_1000_RESULTS: null,
      REQUESTS_PER_1000_RESULTS: null,
      SECONDS_PER_1000_RESULTS: null,
    });
  });

  it("never fabricates unmeasured cost values", () => {
    const summary = buildRunSummary(outcome(), {
      startedAt: "2026-09-16T10:00:00.000Z",
      finishedAt: "2026-09-16T10:00:42.000Z",
      actorRuntimeMs: 42_000,
      datasetOperations: 305,
    });

    expect(summary.apify.compute_units).toBeNull();
    expect(summary.apify.proxy_bytes).toBeNull();
    expect(summary.apify.proxy_cost).toBeNull();
    expect(summary.apify.estimated_cost).toBeNull();
    expect(summary.apify.cost_data_status).toBe("unavailable");
    expect(summary.derived.COST_PER_1000_RESULTS).toBeNull();
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
