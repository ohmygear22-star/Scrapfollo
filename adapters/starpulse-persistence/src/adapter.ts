/**
 * StarPulse scan adapter (V1 design §8): the ONLY entry point through which
 * collection results reach the authoritative tables.
 *
 * Flow: acquire the per-target advisory lock on a dedicated connection (else
 * RUN_ALREADY_ACTIVE) → record scrape_run RUNNING → stream rows into
 * staging with incremental commits → one short atomic promotion transaction
 * per relationship type guided by the §6 diff governance → finalize the run
 * → release the lock in a finally path. Network collection never runs inside
 * the authoritative transaction.
 */

import { decideDiffAction, diffSnapshotMembership, type RelationshipDirection } from "./diff.js";

export interface PgQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Provides the dedicated lock-owning connection (never the shared pool). */
export interface PgLockConnectionFactory {
  acquire(): Promise<PgQueryClient>;
  release(client: PgQueryClient): Promise<void>;
}

export type StagingRowInput = {
  relationshipType: "FOLLOWER" | "FOLLOWING";
  dedupeKey: string;
  sourcePlatformId: string;
  relatedPlatformId?: string;
  username: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
};

export type CollectionSummary = {
  followersComplete: boolean;
  followersTermination: string | null;
  followingComplete: boolean;
  followingTermination: string | null;
  followersCount: number | null;
  followingCount: number | null;
  resultsCollected: number;
  requestCount: number;
  failedRequestCount: number;
  retryCount: number;
};

export type ScanRequest = {
  targetId: string;
  platform: string;
  username: string;
  requestedRelationships: Array<"followers" | "following">;
};

export type ScanOutcome =
  | { status: "RUN_ALREADY_ACTIVE" }
  | { status: "SUCCESS" | "PARTIAL" | "FAILED"; runId: string; snapshotId: string | null; changes: number };

export type AdapterIds = {
  uuid(): string;
  now(): Date;
};

const STAGING_BATCH = 200;

/** Deterministic signed-64-bit advisory-lock key from the target UUID. */
export function advisoryLockKey(targetUuid: string): string {
  let hash = 0xcbf29ce4n;
  for (let i = 0; i < targetUuid.length; i += 1) {
    hash ^= BigInt(targetUuid.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const signed = BigInt.asIntN(64, hash & 0x7fffffffffffffffn);
  return signed.toString();
}

export class StarpulseScanAdapter {
  readonly #pool: PgQueryClient;
  readonly #lockConnections: PgLockConnectionFactory;
  readonly #ids: AdapterIds;

  constructor(deps: { pool: PgQueryClient; lockConnections: PgLockConnectionFactory; ids?: AdapterIds }) {
    this.#pool = deps.pool;
    this.#lockConnections = deps.lockConnections;
    this.#ids = deps.ids ?? { uuid: () => crypto.randomUUID(), now: () => new Date() };
  }

  async runScan(
    request: ScanRequest,
    collect: (emit: (row: StagingRowInput) => Promise<void>) => Promise<CollectionSummary>,
  ): Promise<ScanOutcome> {
    const lockConnection = await this.#lockConnections.acquire();
    let locked = false;
    try {
      const lockResult = await lockConnection.query(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [advisoryLockKey(request.targetId)],
      );
      locked = lockResult.rows[0]?.["acquired"] === true;
      if (!locked) {
        return { status: "RUN_ALREADY_ACTIVE" };
      }

      const runId = this.#ids.uuid();
      const startedAt = this.#ids.now();
      await this.#pool.query(
        `INSERT INTO scrape_runs (id, target_id, started_at, status, requested_relationships,
           results_collected, request_count, failed_request_count, retry_count, cost_data_status)
         VALUES ($1, $2, $3, 'RUNNING', $4, 0, 0, 0, 0, 'unavailable')`,
        [runId, request.targetId, startedAt, request.requestedRelationships],
      );

      let summary: CollectionSummary;
      try {
        let batch: StagingRowInput[] = [];
        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          await this.#insertStaging(runId, batch, request.platform);
          batch = [];
        };
        summary = await collect(async (row) => {
          batch.push(row);
          if (batch.length >= STAGING_BATCH) {
            await this.#insertStaging(runId, batch, request.platform);
            batch = [];
          }
        });
        await flush();
      } catch {
        await this.#finalizeRun(runId, "FAILED", { errorCategory: "UNKNOWN_ERROR" });
        return { status: "FAILED", runId, snapshotId: null, changes: 0 };
      }

      const outcome = await this.#promote(runId, request, summary, startedAt);
      return outcome;
    } finally {
      if (locked) {
        await lockConnection.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey(request.targetId)]).catch(() => undefined);
      }
      await this.#lockConnections.release(lockConnection).catch(() => undefined);
    }
  }

  async #insertStaging(runId: string, rows: StagingRowInput[], platform: string): Promise<void> {
    const values: unknown[] = [];
    const tuples: string[] = [];
    rows.forEach((row, index) => {
      const base = index * 11;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
      );
      values.push(
        runId,
        row.relationshipType,
        row.dedupeKey,
        row.sourcePlatformId,
        row.relatedPlatformId ?? null,
        row.username,
        row.fullName ?? null,
        row.isPrivate ?? null,
        row.isVerified ?? null,
        row.profilePicUrl ?? null,
        index,
      );
    });
    void platform;
    await this.#pool.query(
      `INSERT INTO staging_relationships (run_id, relationship_type, dedupe_key, source_platform_id,
         related_platform_id, username, full_name, is_private, is_verified, profile_pic_url, position, scraped_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (run_id, relationship_type, dedupe_key) DO NOTHING`,
      values,
    );
  }

  async #promote(
    runId: string,
    request: ScanRequest,
    summary: CollectionSummary,
    startedAt: Date,
  ): Promise<ScanOutcome> {
    const capturedAt = this.#ids.now();
    let changes = 0;
    let snapshotId: string | null = null;

    await this.#pool.query("BEGIN");
    try {
      const previous = await this.#previousSnapshots(request.targetId, capturedAt);
      const baselineUsed: Record<string, boolean> = {};
      const directions: RelationshipDirection[] = ["followers", "following"];
      const promotedAny: boolean[] = [];

      for (const direction of directions) {
        if (!request.requestedRelationships.includes(direction)) continue;
        const complete = direction === "followers" ? summary.followersComplete : summary.followingComplete;
        const termination = direction === "followers" ? summary.followersTermination : summary.followingTermination;
        const relationshipType = direction === "followers" ? "FOLLOWER" : "FOLLOWING";
        const previousSnapshot = previous[direction];

        const decision = decideDiffAction({
          direction,
          currentComplete: complete,
          currentTermination: termination ?? "",
          previousSnapshotComplete: previousSnapshot?.complete ?? false,
          isBaseline: previousSnapshot === undefined,
        });
        if (decision.action === "skip") {
          promotedAny.push(false);
          continue;
        }

        if (snapshotId === null) {
          snapshotId = this.#ids.uuid();
          await this.#pool.query(
            `INSERT INTO snapshots (id, target_id, scrape_run_id, captured_at, followers_count, following_count,
               followers_complete, following_complete)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [snapshotId, request.targetId, runId, capturedAt, summary.followersCount, summary.followingCount,
              summary.followersComplete, summary.followingComplete],
          );
        }

        const currentMembership = await this.#stageAndPromoteProfiles(
          runId,
          relationshipType,
          request,
          snapshotId,
          { deactivateAbsent: decision.action === "diff" },
        );

        if (decision.action === "baseline") {
          baselineUsed[direction] = true;
          promotedAny.push(true);
          continue;
        }
        if (previousSnapshot === undefined) {
          // Unreachable by construction: a missing comparison snapshot makes
          // decideDiffAction return baseline. Guarded for type safety.
          promotedAny.push(false);
          continue;
        }
        const previousSnapshotId = previousSnapshot.id;
        const previousMembership = await this.#snapshotMembership(previousSnapshotId);
        const diff = diffSnapshotMembership({
          direction,
          previousMembership,
          currentMembership: currentMembership.keys,
        });
        await this.#insertChanges({
          targetId: request.targetId,
          snapshotId,
          previousSnapshotId,
          relationshipType,
          addedIds: diff.added,
          removedIds: decision.action === "diff" ? diff.removed : [],
          edgeLookup: currentMembership.byStableId,
          previousEdgeLookup: await this.#edgeIdsByStableId(previousSnapshotId),
        });
        changes += diff.added.length + (decision.action === "diff" ? diff.removed.length : 0);
        promotedAny.push(true);
      }

      if (snapshotId !== null) {
        const baselineFollowers = baselineUsed["followers"] === true;
        const baselineFollowing = baselineUsed["following"] === true;
        if (baselineFollowers || baselineFollowing) {
          await this.#pool.query(
            `UPDATE snapshots SET followers_is_baseline = $2, following_is_baseline = $3 WHERE id = $1`,
            [snapshotId, baselineFollowers, baselineFollowing],
          );
        }
      }

      const anyComplete = summary.followersComplete || summary.followingComplete;
      const allComplete = request.requestedRelationships.every((direction) =>
        direction === "followers" ? summary.followersComplete : summary.followingComplete);
      const status = allComplete ? "SUCCESS" : anyComplete ? "PARTIAL" : "FAILED";
      await this.#finalizeRun(runId, status, {
        completedAt: this.#ids.now(),
        summary,
        runtimeMs: Date.now() - startedAt.getTime(),
      });
      await this.#pool.query("COMMIT");
      return { status, runId, snapshotId, changes };
    } catch {
      await this.#pool.query("ROLLBACK").catch(() => undefined);
      await this.#finalizeRun(runId, "FAILED", { errorCategory: "UNKNOWN_ERROR" });
      return { status: "FAILED", runId, snapshotId: null, changes: 0 };
    }
  }

  async #previousSnapshots(
    targetId: string,
    before: Date,
  ): Promise<Partial<Record<RelationshipDirection, { id: string; complete: boolean }>>> {
    const result = await this.#pool.query(
      `SELECT id, followers_complete, following_complete FROM snapshots
       WHERE target_id = $1 AND captured_at < $2
       ORDER BY captured_at DESC LIMIT 1`,
      [targetId, before],
    );
    const row = result.rows[0];
    if (row === undefined) return {};
    const snapshots: Partial<Record<RelationshipDirection, { id: string; complete: boolean }>> = {};
    if (row["following_complete"] === true) {
      snapshots["following"] = { id: String(row["id"]), complete: true };
    }
    if (row["followers_complete"] === true) {
      snapshots["followers"] = { id: String(row["id"]), complete: true };
    }
    return snapshots;
  }

  /**
   * Promotes staging rows of one relationship type: upserts social_profiles,
   * upserts relationship_edges (activating present members), records snapshot
   * membership, and deactivates edges that are absent from this snapshot.
   */
  async #stageAndPromoteProfiles(
    runId: string,
    relationshipType: "FOLLOWER" | "FOLLOWING",
    request: ScanRequest,
    snapshotId: string,
    options: { deactivateAbsent: boolean },
  ): Promise<{ keys: string[]; edgeIdsAddedOrAll: string[]; byStableId: Map<string, string> }> {
    const staged = await this.#pool.query(
      `SELECT * FROM staging_relationships WHERE run_id = $1 AND relationship_type = $2 ORDER BY position`,
      [runId, relationshipType],
    );
    const byStableId = new Map<string, string>();
    const keys: string[] = [];
    for (const row of staged.rows) {
      const stableIdRaw = row["related_platform_id"] ?? row["username"];
      const stableId = typeof stableIdRaw === "string" ? stableIdRaw : String(stableIdRaw ?? "");
      const profileId = await this.#upsertProfile(request.platform, row);
      const edgeId = await this.#upsertEdge(request.targetId, profileId, relationshipType);
      await this.#pool.query(
        `INSERT INTO snapshot_edges (snapshot_id, relationship_edge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [snapshotId, edgeId],
      );
      keys.push(stableId);
      byStableId.set(stableId, edgeId);
    }
    // Deactivate edges absent from a COMPLETE snapshot only. On skip-removals
    // (e.g. MAX_LIMIT_REACHED) the unfetched tail must stay active —
    // deactivating it would fabricate unfollow events.
    if (options.deactivateAbsent) {
      await this.#pool.query(
        `UPDATE relationship_edges SET active = false, last_seen_at = $3
         WHERE target_id = $1 AND relationship_type = $2 AND active
           AND id NOT IN (SELECT relationship_edge_id FROM snapshot_edges WHERE snapshot_id = $4)`,
        [request.targetId, relationshipType, this.#ids.now(), snapshotId],
      );
    }
    return { keys: currentKeys(byStableId), edgeIdsAddedOrAll: Array.from(byStableId.values()), byStableId };
  }

  async #upsertProfile(platform: string, row: Record<string, unknown>): Promise<string> {
    const stableId = row["related_platform_id"] ?? null;
    const existing = await this.#pool.query(
      `SELECT id FROM social_profiles WHERE platform = $1 AND platform_user_id = $2`,
      [platform, stableId],
    );
    const found = existing.rows[0]?.["id"];
    if (found !== undefined) {
      await this.#pool.query(
        `UPDATE social_profiles SET username = $2, full_name = $3, is_private = $4, is_verified = $5,
           profile_pic_url = $6, last_seen_at = $7 WHERE id = $1`,
        [found, row["username"], row["full_name"], row["is_private"], row["is_verified"], row["profile_pic_url"], this.#ids.now()],
      );
      return String(found);
    }
    const id = this.#ids.uuid();
    await this.#pool.query(
      `INSERT INTO social_profiles (id, platform, platform_user_id, username, full_name, is_private,
         is_verified, profile_pic_url, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, platform, stableId, row["username"], row["full_name"], row["is_private"], row["is_verified"],
        row["profile_pic_url"], this.#ids.now()],
    );
    return id;
  }

  async #upsertEdge(
    targetId: string,
    profileId: string,
    relationshipType: "FOLLOWER" | "FOLLOWING",
  ): Promise<string> {
    const existing = await this.#pool.query(
      `SELECT id FROM relationship_edges
       WHERE target_id = $1 AND related_profile_id = $2 AND relationship_type = $3`,
      [targetId, profileId, relationshipType],
    );
    const found = existing.rows[0]?.["id"];
    if (found !== undefined) {
      await this.#pool.query(
        `UPDATE relationship_edges SET active = true, last_seen_at = $2 WHERE id = $1`,
        [found, this.#ids.now()],
      );
      return String(found);
    }
    const id = this.#ids.uuid();
    await this.#pool.query(
      `INSERT INTO relationship_edges (id, target_id, related_profile_id, relationship_type,
         first_seen_at, last_seen_at, active)
       VALUES ($1, $2, $3, $4, $5, $5, true)`,
      [id, targetId, profileId, relationshipType, this.#ids.now()],
    );
    return id;
  }

  async #snapshotMembership(snapshotId: string): Promise<string[]> {
    const result = await this.#pool.query(
      `SELECT sp.platform_user_id, sp.username
       FROM snapshot_edges se
       JOIN relationship_edges e ON e.id = se.relationship_edge_id
       JOIN social_profiles sp ON sp.id = e.related_profile_id
       WHERE se.snapshot_id = $1`,
      [snapshotId],
    );
    return result.rows.map((row) => {
      const stableId = row["platform_user_id"];
      return typeof stableId === "string" ? stableId : String(row["username"] ?? "");
    });
  }

  async #edgeIdsByStableId(snapshotId: string): Promise<Map<string, string>> {
    const result = await this.#pool.query(
      `SELECT sp.platform_user_id, sp.username, e.id AS edge_id
       FROM snapshot_edges se
       JOIN relationship_edges e ON e.id = se.relationship_edge_id
       JOIN social_profiles sp ON sp.id = e.related_profile_id
       WHERE se.snapshot_id = $1`,
      [snapshotId],
    );
    const map = new Map<string, string>();
    for (const row of result.rows) {
      const stableId = typeof row["platform_user_id"] === "string" ? row["platform_user_id"] : String(row["username"] ?? "");
      map.set(stableId, String(row["edge_id"]));
    }
    return map;
  }

  async #insertChanges(input: {
    targetId: string;
    snapshotId: string;
    previousSnapshotId: string;
    relationshipType: "FOLLOWER" | "FOLLOWING";
    addedIds: string[];
    removedIds: string[];
    edgeLookup: Map<string, string>;
    previousEdgeLookup: Map<string, string>;
  }): Promise<void> {
    const detectedAt = this.#ids.now();
    for (const stableId of input.addedIds) {
      const edgeId = input.edgeLookup.get(stableId);
      if (edgeId === undefined) continue;
      await this.#pool.query(
        `INSERT INTO relationship_changes (id, target_id, related_profile_id, relationship_type, change_type,
           previous_snapshot_id, current_snapshot_id, detected_at)
         SELECT $1, $2, related_profile_id, $3, $4, $5, $6, $7
         FROM relationship_edges WHERE id = $8`,
        [this.#ids.uuid(), input.targetId, input.relationshipType,
          input.relationshipType === "FOLLOWING" ? "NEW_FOLLOWING" : "NEW_FOLLOWER",
          input.previousSnapshotId, input.snapshotId, detectedAt, edgeId],
      );
    }
    for (const stableId of input.removedIds) {
      const edgeId = input.previousEdgeLookup.get(stableId);
      if (edgeId === undefined) continue;
      await this.#pool.query(
        `INSERT INTO relationship_changes (id, target_id, related_profile_id, relationship_type, change_type,
           previous_snapshot_id, current_snapshot_id, detected_at)
         SELECT $1, $2, related_profile_id, $3, $4, $5, $6, $7
         FROM relationship_edges WHERE id = $8`,
        [this.#ids.uuid(), input.targetId, input.relationshipType,
          input.relationshipType === "FOLLOWING" ? "UNFOLLOWED" : "LOST_FOLLOWER",
          input.previousSnapshotId, input.snapshotId, detectedAt, edgeId],
      );
    }
  }

  async #finalizeRun(
    runId: string,
    status: string,
    options: { completedAt?: Date; summary?: CollectionSummary; runtimeMs?: number; errorCategory?: string },
  ): Promise<void> {
    const summary = options.summary;
    await this.#pool.query(
      `UPDATE scrape_runs SET status = $2, completed_at = $3, followers_complete = $4,
         followers_termination = $5, following_complete = $6, following_termination = $7,
         followers_count = $8, following_count = $9, results_collected = $10, runtime_ms = $11,
         error_category = $12
       WHERE id = $1`,
      [runId, status, options.completedAt ?? this.#ids.now(),
        summary?.followersComplete ?? null, summary?.followersTermination ?? null,
        summary?.followingComplete ?? null, summary?.followingTermination ?? null,
        summary?.followersCount ?? null, summary?.followingCount ?? null,
        summary?.resultsCollected ?? 0, options.runtimeMs ?? null, options.errorCategory ?? null],
    );
  }
}

function currentKeys(map: Map<string, string>): string[] {
  return Array.from(map.keys());
}
