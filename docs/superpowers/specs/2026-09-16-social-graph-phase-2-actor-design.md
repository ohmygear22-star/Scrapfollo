# Social Graph Phase 2 — Apify Actor Design

**Status:** Pending owner approval (P2-T1 deliverable)
**Baseline:** V1 spec `docs/superpowers/specs/2026-09-15-social-graph-v1-design.md` §7, §11, §12, §13.4, §15
**Branch:** `feature/social-graph-phase-2` (from Phase 1 HEAD `4847154`)

## 1. Objective and boundaries

Phase 2 builds the Apify Actor wrapper around the Phase 1 core: input
validation, the Actor composition root, streaming Dataset output, run
summaries, the Apify cost layer, and safe logging — **all tested locally
against `FakeProvider` only** (spec §15 Phase 2). No live platform call,
no provider selection, no Store publication, no Starpulse persistence.
Live provider work belongs to Phase 3 and requires its own approval.

Out of scope (each requires a separate later-phase approval): live
Instagram/X/TikTok providers, provider failover, `apify push` beyond the
one private dev deployment in P2-T6, any Store listing or pricing,
PostgreSQL/Starpulse persistence, scheduler, notifications, billing, UI,
private-profile access, and any login/session/security/rate-limit bypass.

## 2. Architecture

The Actor embeds `@social-graph/core` and runs one complete collection
batch per actor run:

```text
Actor start
  → validate input (fail before any work on invalid input)
  → create run_id, inject the provider registry (a
    SocialGraphProviderRegistry containing only FakeProvider instances)
    at the composition root
  → consume collectTargets()
      relationship event  → await Dataset.pushData(row)
      collection summary  → record authoritative completeness
      target summary      → record SUCCESS / PARTIAL / FAILED
  → store RUN_SUMMARY in Key-Value Store
  → finalize Apify usage and cost metrics
  → Actor exit
```

One actor run = one `collectTargets` batch. Backpressure is inherited
from core: Dataset writes are awaited per streamed item or in a bounded
batch, so the actor never buffers the full result set in memory. The
registry key must equal `provider.platform`; a missing provider isolates
that target with `PROVIDER_UNAVAILABLE` (Phase 1 semantics, unchanged).

Repository layout (new, outside `packages/social-graph-core`):

```text
actor/social-graph-actor/        Actor package (Apify runtime + tests)
  src/main.ts                    composition root: input → registry → stream
  src/input.ts                   input validation (pure, unit-testable)
  src/run-summary.ts             RUN_SUMMARY + cost layer assembly
  src/dataset-writer.ts          awaited/bounded-batch Dataset writes
  src/logging.ts                 structured, redacted logging
  tests/*.test.ts                unit tests (input, summary, writer, logging)
  tests/actor-flow.test.ts       local end-to-end flow vs FakeProvider
  .actor/                        actor metadata
package.json                     workspace member
```

The core package remains untouched except additive exports if a gap is
proven; its architecture tests (relative-imports-only, public API lock)
continue to gate every Phase 2 commit.

## 3. Input schema and validation

```json
{
  "targets": [{ "platform": "instagram", "username": "alpha" }],
  "scrapeType": "followers | following | both",
  "maxFollowers": 1000,
  "maxFollowing": 1000,
  "concurrency": 2,
  "eventBufferSize": 8
}
```

Validation happens before any provider work and fails the whole run on
invalid input (`INVALID_INPUT`, no Dataset rows, no summaries):

- `targets`: non-empty array; each `targetId` server-generated as
  `t<index>`, `platform` ∈ {`instagram`, `x`, `tiktok`} (YouTube
  rejected), `username` non-empty.
- Usernames are trimmed and a leading `@` is removed; duplicates are
  rejected or collapsed by `(platform, normalizedUsername)` where
  normalization is `toLocaleLowerCase("en-US").trim()`.
- `scrapeType` required; `maxFollowers`/`maxFollowing`, when present,
  must be positive safe integers within configured safety limits
  (defaults: maxima ≤ 100,000; `targets.length` ≤ 100; `concurrency`
  ∈ [1, 8]; `eventBufferSize` ∈ [1, 64]).
- Unknown keys are rejected (strict schema).

## 4. Dataset output contract

The default Dataset contains only normalized relationship rows (the
Phase 1 `NormalizedRelationship` shape). Provider raw responses,
cursors, stack traces, credentials, cookies, tokens, and proxy secrets
are forbidden — verified by a containment test over every emitted row.

Writes are awaited per item or bounded batch (batch ≤ `eventBufferSize`).
If a Dataset write fails, the Actor aborts the affected stream, records
`ABORTED` (or a consumer persistence error) for that target in the run
summary, and never reports the collection as successfully delivered.
Other targets continue per Phase 1 isolation rules.

## 5. RUN_SUMMARY and the Apify cost layer

`RUN_SUMMARY` is stored once per run in the default Key-Value Store:

```text
run_id, started_at, finished_at
requested: { targets, scrapeType, maxima }
per-target: { targetId, platform, username, status,
              collections: [ { relationship, completeness, metrics } ] }
core run metrics: CoreRunMetrics (Phase 1 contract, unchanged)
apify cost layer: compute_units, proxy_bytes, proxy_cost,
                  dataset_operations, actor_runtime_ms,
                  estimated_cost, currency, cost_data_status
derived: SUCCESS_RATE, COST_PER_1000_RESULTS,
         REQUESTS_PER_1000_RESULTS, SECONDS_PER_1000_RESULTS
```

Truncation is not an error: a `MAX_LIMIT_REACHED` collection is
incomplete without an error and can never turn its target `FAILED`
(expressed as `SUCCESS`/`PARTIAL` status per Phase 1 derivation).

Cost rules (spec §12): `cost_data_status` ∈ {`actual`, `estimated`,
`unavailable`}; unavailable inputs stay `null` and are never fabricated;
all per-1,000 metrics are `null` when no relationships were returned;
formulas are validated against FakeProvider benchmarks but never set a
commercial price. In local FakeProvider runs the cost layer reports
`cost_data_status: "unavailable"` with null costs (nothing is measured
by Apify locally); the field wiring and formulas are still fully tested.

## 6. Logging

Structured logs carry `run_id`, `target_id`, relationship type,
page ordinal, request ID, retry ordinal, and outcome. The logging module must
redact or omit authorization headers, cookies, tokens, passwords, API
keys, proxy credentials, and excessive raw response data — enforced by a
redaction unit test that pushes each forbidden shape through the logger.

## 7. Dependencies and toolchain policy

- Runtime: Node 22 / pnpm 11.19.0 / TypeScript strict, same as Phase 1.
- The platform layer is an interface (`DatasetWriter`, `KeyValueStore`,
  structured logger). P2-T2 through P2-T5 run entirely against local
  in-memory implementations — **zero new dependencies**. The real
  Apify SDK (`apify` or `@apify/actor`) is added only in P2-T6 to bind
  the deployment entry point, confining any dependency-approval risk to
  the final gated task.
- Any package requesting a lifecycle/build script other than the
  approved `esbuild@0.28.2` stops the task for an owner decision — no
  approve-all, per the standing toolchain constraint.
- The actor package must not import Apify SDK symbols into
  `packages/social-graph-core` (core stays consumer-neutral; enforced by
  the Phase 1 architecture tests, extended to the actor boundary in
  P2-T5).

## 8. Testing strategy (spec §13.4)

All tests run locally with FakeProvider scenarios — no network, no
account quota:

1. **Input validation unit tests** — table-driven: valid minimal, `@`
   stripping, trim, duplicate collapse, every invalid shape (empty
   targets, bad platform, non-positive/non-integer maxima, over-limit
   values, unknown keys, `youtube`).
2. **Dataset writer unit tests** — awaited per-item and bounded-batch
   modes; write-failure converts the affected stream to `ABORTED` and
   never marks delivery successful; containment (no cursor/raw fields).
3. **Run-summary/cost unit tests** — field assembly, derived formulas
   against hand-computed cases, null and `unavailable` rules.
4. **Logging unit tests** — redaction of every forbidden shape.
5. **Actor flow test** — the full input → collectTargets(FakeProvider
   registry) → Dataset/RUN_SUMMARY pipeline against the Phase 1
   integration scenario set (profile failure, capability gating,
   pagination, dedup, retry, both mode, isolation, abort, and
   actor-run-timeout conversion to an aborted outcome).
6. **Architecture tests** — actor package dependency boundaries.

Each task follows the task-level discipline: focused RED (intended
cause) → minimal implementation → focused GREEN → workspace regression →
typecheck → lint → build → `git diff --check` → clean status →
independent review → commit → baseline report. The phase gate
(clean-checkout full verification, evidence doc, independent phase
review, owner approval) must pass before Phase 3 begins; a failed gate
stops the phase and is never carried forward.

## 9. Environment assumptions (recorded for Phase 3 use)

- Apify account `eloquent_filbert_uwi` (ID `cmfFqiN8gNitjHIEX`), paid
  Creator-type plan; `$85` monthly usage cap observed via API; token in
  `/opt/scrapfollo/.env` on the droplet (gitignored, chmod 600, never in
  chat/commits/logs).
- Creator plan restricts Store rentals to Universal Actors — irrelevant
  to Phase 2 (no rentals), decisive for the Phase 3 sourcing decision.
- The single `apify push` in P2-T6 creates a private dev actor only; it
  runs nothing. First real invocation is a Phase 3 approval.

## 10. Approval gates inside Phase 2

| Gate | Trigger | Rule |
| --- | --- | --- |
| Design approval | End of P2-T1 | Owner approves this document before P2-T2 |
| Deployment approval | P2-T6 `apify push` | Owner confirms the one private push |
| Phase gate | After P2-T5 (and P2-T6 when approved) | Clean-checkout verification + evidence + independent review; **do not start Phase 3** until owner approves |
