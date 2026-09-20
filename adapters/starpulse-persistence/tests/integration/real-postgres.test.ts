/**
 * Real-PostgreSQL integration (Phase 4 T4). Runs only when
 * PERSISTENCE_TEST_DATABASE_URL points at a dedicated test database; the
 * suite truncates all tables between cases. Locally without a database the
 * suite skips (standard `Tests skipped` output on the Mac).
 */
import { Client, Pool } from "pg";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  StarpulseScanAdapter,
  advisoryLockKey,
  type CollectionSummary,
  type ScanRequest,
  type StagingRowInput,
} from "../../src/index.js";

const DATABASE_URL = process.env["PERSISTENCE_TEST_DATABASE_URL"];
const enabled = DATABASE_URL !== undefined && DATABASE_URL !== "";

describe.skipIf(!enabled)("persistence integration (real PostgreSQL)", () => {
  let pool: Pool;
  let lockClient: Client;

  const request: ScanRequest = {
    targetId: "11111111-1111-1111-1111-111111111111",
    platform: "instagram",
    username: "idol",
    requestedRelationships: ["following"],
  };

  function complete(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
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

  function row(stableId: string, username: string): StagingRowInput {
    return {
      relationshipType: "FOLLOWING",
      dedupeKey: stableId,
      sourcePlatformId: request.targetId,
      relatedPlatformId: stableId,
      username,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    lockClient = new Client({ connectionString: DATABASE_URL });
    await lockClient.connect();
    const migration = readFileSync(
      join(import.meta.dirname, "../../migrations/0001_init.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(
      `INSERT INTO targets (id, platform, platform_username, status, created_at, updated_at)
       VALUES ($1, 'instagram', 'idol', 'ACTIVE', now(), now())`,
      [request.targetId],
    );
  });

  afterEach(async () => {
    await pool.query(`TRUNCATE relationship_changes, snapshot_edges, snapshots,
      relationship_edges, staging_relationships, scrape_runs, social_profiles, targets CASCADE`);
    await pool.query(
      `INSERT INTO targets (id, platform, platform_username, status, created_at, updated_at)
       VALUES ($1, 'instagram', 'idol', 'ACTIVE', now(), now())`,
      [request.targetId],
    );
  });

  afterAll(async () => {
    await lockClient.end();
    await pool.end();
  });

  const dedicated = new Map<unknown, Client>();

  function adapter(): StarpulseScanAdapter {
    return new StarpulseScanAdapter({
      pool: {
        query: (sql: string, params?: unknown[]) =>
          pool.query(sql, params as unknown[] | undefined),
      },
      lockConnections: {
        acquire: async () => {
          const client = new Client({ connectionString: DATABASE_URL });
          await client.connect();
          const wrapper = {
            query: (sql: string, params?: unknown[]) =>
              client.query(sql, params as unknown[] | undefined),
          };
          dedicated.set(wrapper, client);
          return wrapper;
        },
        release: async (wrapper) => {
          const client = dedicated.get(wrapper);
          dedicated.delete(wrapper);
          await client?.end();
        },
      },
    });
  }

  it("baseline scan records the snapshot and no changes", async () => {
    const result = await adapter().runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      await emit(row("s2", "two"));
      return complete();
    });
    expect(result).toMatchObject({ status: "SUCCESS", changes: 0 });

    const snapshots = await pool.query("SELECT * FROM snapshots");
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0]).toMatchObject({ following_is_baseline: true, following_complete: true });
    const changes = await pool.query("SELECT * FROM relationship_changes");
    expect(changes.rows).toHaveLength(0);
    const edges = await pool.query("SELECT * FROM relationship_edges WHERE active");
    expect(edges.rows).toHaveLength(2);
  });

  it("second scan diffs: NEW_FOLLOWING + UNFOLLOWED and edge deactivation", async () => {
    const sut = adapter();
    await sut.runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      await emit(row("s2", "two"));
      return complete();
    });
    const result = await sut.runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      await emit(row("s3", "three"));
      return complete();
    });
    expect(result).toMatchObject({ status: "SUCCESS", changes: 2 });

    const changes = await pool.query("SELECT change_type FROM relationship_changes ORDER BY change_type");
    expect(changes.rows.map((r) => r.change_type)).toEqual(["NEW_FOLLOWING", "UNFOLLOWED"]);
    const active = await pool.query(
      `SELECT sp.username FROM relationship_edges e
       JOIN social_profiles sp ON sp.id = e.related_profile_id
       WHERE e.target_id = $1 AND e.active`,
      [request.targetId],
    );
    expect(active.rows.map((r) => r.username).sort()).toEqual(["one", "three"]);
  });

  it("RUN_ALREADY_ACTIVE when another connection holds the advisory lock", async () => {
    const key = advisoryLockKey(request.targetId);
    await lockClient.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      const result = await adapter().runScan(request, async () => complete());
      expect(result).toEqual({ status: "RUN_ALREADY_ACTIVE" });
      const runs = await pool.query("SELECT count(*)::int AS n FROM scrape_runs");
      expect(runs.rows[0].n).toBe(0);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  });

  it("incomplete collection promotes nothing and reports FAILED", async () => {
    const result = await adapter().runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      return complete({ followingComplete: false, followingTermination: "ABORTED" });
    });
    expect(result).toMatchObject({ status: "FAILED", snapshotId: null });
    const snapshots = await pool.query("SELECT * FROM snapshots");
    expect(snapshots.rows).toHaveLength(0);
    const staged = await pool.query("SELECT count(*)::int AS n FROM staging_relationships");
    expect(staged.rows[0].n).toBe(1);
  });

  it("identical rescan is idempotent: zero new changes", async () => {
    const sut = adapter();
    await sut.runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      return complete();
    });
    const second = await sut.runScan(request, async (emit) => {
      await emit(row("s1", "one"));
      return complete();
    });
    expect(second).toMatchObject({ status: "SUCCESS", changes: 0 });
    const changes = await pool.query("SELECT count(*)::int AS n FROM relationship_changes");
    expect(changes.rows[0].n).toBe(0);
  });
});
