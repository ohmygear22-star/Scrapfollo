import { describe, expect, it } from "vitest";
import {
  advisoryLockKey,
  StarpulseScanAdapter,
  type CollectionSummary,
  type PgLockConnectionFactory,
  type PgQueryClient,
  type ScanRequest,
  type StagingRowInput,
} from "../src/adapter.js";

type Recorded = { sql: string; params: unknown[] | undefined };

type Rule = { match: RegExp; responses: Array<Record<string, unknown>[]> };

function mockDeps(rules: Rule[], options: { lockAcquired?: boolean } = {}) {
  const queries: Recorded[] = [];
  const queues = new Map(rules.map((rule) => [rule, [...rule.responses]]));
  const respond = (sql: string): Record<string, unknown>[] => {
    for (const rule of rules) {
      if (rule.match.test(sql)) {
        const queue = queues.get(rule);
        return queue?.shift() ?? [];
      }
    }
    return [];
  };
  const pool: PgQueryClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: respond(sql) };
    },
  };
  const lockQueries: Recorded[] = [];
  const lockClient: PgQueryClient = {
    async query(sql, params) {
      lockQueries.push({ sql, params });
      return { rows: [{ acquired: options.lockAcquired ?? true }] };
    },
  };
  const factory: PgLockConnectionFactory = {
    acquire: async () => lockClient,
    release: async () => undefined,
  };
  let uuidCounter = 0;
  const adapter = new StarpulseScanAdapter({
    pool,
    lockConnections: factory,
    ids: {
      uuid: () => `uuid-${(uuidCounter += 1)}`,
      now: () => new Date("2026-09-18T00:00:00Z"),
    },
  });
  return { adapter, queries, lockQueries, pool };
}

const REQUEST: ScanRequest = {
  targetId: "11111111-1111-1111-1111-111111111111",
  platform: "instagram",
  username: "idol",
  requestedRelationships: ["following"],
};

function completeSummary(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    followersComplete: false,
    followersTermination: null,
    followingComplete: true,
    followingTermination: "SOURCE_EXHAUSTED",
    followersCount: null,
    followingCount: 3,
    resultsCollected: 3,
    requestCount: 2,
    failedRequestCount: 0,
    retryCount: 0,
    ...overrides,
  };
}

function followingRow(stableId: string, username: string): StagingRowInput {
  return {
    relationshipType: "FOLLOWING",
    dedupeKey: stableId,
    sourcePlatformId: REQUEST.targetId,
    relatedPlatformId: stableId,
    username,
  };
}

describe("advisoryLockKey", () => {
  it("is deterministic and inside the signed 64-bit positive range", () => {
    const a = advisoryLockKey(REQUEST.targetId);
    expect(a).toBe(advisoryLockKey(REQUEST.targetId));
    expect(advisoryLockKey("22222222-2222-2222-2222-222222222222")).not.toBe(a);
    expect(BigInt(a)).toBeGreaterThan(0n);
  });
});

describe("StarpulseScanAdapter.runScan", () => {
  it("returns RUN_ALREADY_ACTIVE and never unlocks another holder's lock", async () => {
    const { adapter, queries, lockQueries } = mockDeps([], { lockAcquired: false });
    const outcome = await adapter.runScan(REQUEST, async () => completeSummary());
    expect(outcome).toEqual({ status: "RUN_ALREADY_ACTIVE" });
    expect(queries).toEqual([]);
    expect(lockQueries.map((q) => q.sql)).toEqual(["SELECT pg_try_advisory_lock($1) AS acquired"]);
  });

  it("baseline: records the snapshot with is_baseline and no changes", async () => {
    const rules: Rule[] = [
      { match: /FROM snapshots\s+WHERE target_id/, responses: [[]] },
      { match: /FROM staging_relationships/, responses: [[
        { related_platform_id: "s1", username: "one", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
        { related_platform_id: "s2", username: "two", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
      ]] },
      { match: /FROM social_profiles WHERE/, responses: [[], []] },
      { match: /FROM relationship_edges\s+WHERE target_id/, responses: [[], []] },
    ];
    const { adapter, queries, lockQueries } = mockDeps(rules);
    const outcome = await adapter.runScan(REQUEST, async (emit) => {
      await emit(followingRow("s1", "one"));
      await emit(followingRow("s2", "two"));
      return completeSummary();
    });

    expect(outcome).toMatchObject({ status: "SUCCESS", changes: 0 });
    expect(outcome).toHaveProperty("snapshotId");
    const sql = queries.map((q) => q.sql).join("\n");
    expect(sql).toContain("INSERT INTO scrape_runs");
    expect(sql).toContain("INSERT INTO staging_relationships");
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("INSERT INTO snapshots");
    expect(sql).toContain("UPDATE snapshots SET followers_is_baseline");
    expect(sql).not.toContain("INSERT INTO relationship_changes");
    expect(sql).toContain("COMMIT");
    expect(lockQueries.some((q) => q.sql.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("diff: emits NEW_FOLLOWING and UNFOLLOWED changes with edge deactivation", async () => {
    const rules: Rule[] = [
      { match: /FROM snapshots\s+WHERE target_id/, responses: [[
        { id: "prev-snap", followers_complete: false, following_complete: true },
      ]] },
      { match: /FROM staging_relationships/, responses: [[
        { related_platform_id: "s1", username: "one", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
        { related_platform_id: "s3", username: "three", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
      ]] },
      { match: /FROM social_profiles WHERE/, responses: [[], []] },
      { match: /FROM relationship_edges\s+WHERE target_id/, responses: [[], []] },
      // previous membership query (diff) and edge lookup run on prev-snap
      { match: /JOIN social_profiles sp ON sp\.id = e\.related_profile_id\s+WHERE se\.snapshot_id/, responses: [
        [{ platform_user_id: "s1", username: "one" }, { platform_user_id: "s2", username: "two" }],
        [{ platform_user_id: "s1", username: "one", edge_id: "edge-1" }, { platform_user_id: "s2", username: "two", edge_id: "edge-2" }],
      ] },
    ];
    const { adapter, queries } = mockDeps(rules);
    const outcome = await adapter.runScan(REQUEST, async (emit) => {
      await emit(followingRow("s1", "one"));
      await emit(followingRow("s3", "three"));
      return completeSummary();
    });

    expect(outcome).toMatchObject({ status: "SUCCESS", changes: 2 });
    const changeInserts = queries.filter((q) => q.sql.startsWith("INSERT INTO relationship_changes"));
    expect(changeInserts).toHaveLength(2);
    const changeTypes = changeInserts.map((q) => q.params?.[3]);
    expect(changeTypes).toContain("NEW_FOLLOWING");
    expect(changeTypes).toContain("UNFOLLOWED");
    expect(queries.some((q) => q.sql.startsWith("UPDATE relationship_edges SET active = false"))).toBe(true);
  });

  it("MAX_LIMIT_REACHED: snapshot promoted but no UNFOLLOWED changes and no deactivation", async () => {
    const rules: Rule[] = [
      { match: /FROM snapshots\s+WHERE target_id/, responses: [[
        { id: "prev-snap", followers_complete: false, following_complete: true },
      ]] },
      { match: /FROM staging_relationships/, responses: [[
        { related_platform_id: "s1", username: "one", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
        { related_platform_id: "s3", username: "three", full_name: null, is_private: null, is_verified: null, profile_pic_url: null },
      ]] },
      { match: /FROM social_profiles WHERE/, responses: [[], []] },
      { match: /FROM relationship_edges\s+WHERE target_id/, responses: [[], []] },
      { match: /JOIN social_profiles sp ON sp\.id = e\.related_profile_id\s+WHERE se\.snapshot_id/, responses: [
        [{ platform_user_id: "s1", username: "one" }, { platform_user_id: "s2", username: "two" }],
        [{ platform_user_id: "s1", username: "one", edge_id: "edge-1" }, { platform_user_id: "s2", username: "two", edge_id: "edge-2" }],
      ] },
    ];
    const { adapter, queries } = mockDeps(rules);
    const outcome = await adapter.runScan(REQUEST, async (emit) => {
      await emit(followingRow("s1", "one"));
      await emit(followingRow("s3", "three"));
      return completeSummary({ followingTermination: "MAX_LIMIT_REACHED" });
    });

    expect(outcome).toMatchObject({ status: "SUCCESS", snapshotId: expect.any(String), changes: 1 });
    const changeTypes = queries
      .filter((q) => q.sql.startsWith("INSERT INTO relationship_changes"))
      .map((q) => q.params?.[3]);
    expect(changeTypes).toEqual(["NEW_FOLLOWING"]);
    expect(queries.some((q) => q.sql.startsWith("UPDATE relationship_edges SET active = false"))).toBe(false);
  });

  it("incomplete current collection: FAILED run, no snapshot, staging retained", async () => {
    const rules: Rule[] = [];
    const { adapter, queries } = mockDeps(rules);
    const outcome = await adapter.runScan(REQUEST, async (emit) => {
      await emit(followingRow("s1", "one"));
      return completeSummary({ followingComplete: false, followingTermination: "ABORTED" });
    });

    expect(outcome).toMatchObject({ status: "FAILED", snapshotId: null });
    const sql = queries.map((q) => q.sql).join("\n");
    expect(sql).not.toContain("INSERT INTO snapshots");
    expect(sql).toContain("INSERT INTO staging_relationships");
    const failedUpdate = queries.find((q) => q.sql.startsWith("UPDATE scrape_runs SET status"));
    expect(failedUpdate?.params?.[1]).toBe("FAILED");
  });

  it("collector crash: FAILED recorded and the lock is still released", async () => {
    const { adapter, lockQueries } = mockDeps([]);
    const outcome = await adapter.runScan(REQUEST, async () => {
      throw new Error("network exploded");
    });
    expect(outcome).toMatchObject({ status: "FAILED" });
    expect(lockQueries.some((q) => q.sql.includes("pg_advisory_unlock"))).toBe(true);
  });
});
