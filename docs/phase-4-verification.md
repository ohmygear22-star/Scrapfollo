# Phase 4 verification — StarPulse persistence (2026-09-20)

## Scope delivered

- **T1** `adapters/starpulse-persistence/migrations/0001_init.sql` — the V1
  design §9 schema (8 tables) with all spec-listed indexes, transactional and
  idempotent.
- **T2** Pure diff engine — §10 set semantics + §6 completeness governance
  (`diffSnapshotMembership`, `decideDiffAction`).
- **T3** `StarpulseScanAdapter` — §8 flow: advisory lock on a dedicated
  connection, streamed staging (batched, auto-committed), single atomic
  promotion transaction, lock release in finally.
- **T4** Real-PostgreSQL integration on the droplet (owner-approved install).

## Infrastructure (droplet 152.42.220.26)

- PostgreSQL 16.15 (Ubuntu), listening on **127.0.0.1/[::1] only**.
- Dedicated least-privilege user `starpulse_app`; databases `starpulse_db`
  (production, migrated, untouched) and `starpulse_test` (integration,
  owner `starpulse_app`, truncated between cases).
- Credentials in `/opt/scrapfollo/.env` (`STARPULSE_DATABASE_URL`,
  `PERSISTENCE_TEST_DATABASE_URL`), chmod 600, values never in chat/logs.

## Commands and results

```text
pnpm install --frozen-lockfile   Result: Done
pnpm build                       Result: all packages Done
pnpm test                        Result: 130+26+16+16+65+90 passed (343 unit tests)
PERSISTENCE_TEST_DATABASE_URL=... npx vitest run (adapter pkg)  Result: 21 passed incl. 5 real-PG
```

Real-PG integration cases (tests/integration/real-postgres.test.ts):

1. Baseline scan → snapshot row with `following_is_baseline = true`, zero
   `relationship_changes`, 2 active edges.
2. Second scan with changed membership → `NEW_FOLLOWING` + `UNFOLLOWED`
   change rows, deactivated edge for the removed account.
3. Advisory lock held elsewhere → `RUN_ALREADY_ACTIVE`, zero scrape_runs rows.
4. Incomplete collection → `FAILED` run, zero snapshots, staging retained.
5. Identical rescan → zero new changes (idempotence).

`git diff --check` Result: clean.

## Defects found by real-database testing (and fixed)

- Staging INSERT had 12 columns but 11 parameters (`scraped_at` missing) —
  impossible to catch with mock pools that do not parse SQL; surfaced by the
  real database, fixed in commit 1e8f03d.
- Mock-only counter ids (`uuid-1`) violate the uuid column type; integration
  uses real `crypto.randomUUID()`.
- Cross-run idempotence: suite setup now truncates before seeding.

## Operational notes

- Staging rows accumulate by design in V1; retention/cleanup is a
  pre-production decision per spec §9.5.
- The promotion path never holds the advisory-lock connection inside a
  transaction; the lock connection is ended on release, never pooled.
