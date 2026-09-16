# Social Graph Phase 2 Implementation Plan

**Design:** `docs/superpowers/specs/2026-09-16-social-graph-phase-2-actor-design.md`
**Branch:** `feature/social-graph-phase-2`
**Rule of the phase:** strict TDD (focused RED with the intended cause →
minimal implementation → focused GREEN) and every task passes the
verification ladder and the phase gate below. If any step fails, stop
and fix within the phase. Do not start Phase 3 until the phase gate
passes AND the owner approves.

## Task-level verification ladder (applies to every task)

```text
1. focused tests (intended RED cause first, then GREEN)
2. workspace regression suite (pnpm test)
3. pnpm typecheck
4. pnpm lint
5. pnpm build
6. git diff --check
7. git status --short clean
8. independent review (subagent) → fix verified findings → re-verify
9. commit (conventional message) → push → droplet sync
10. baseline report: commit hash, review PASS, worktree clean,
    Node/pnpm runtime, next task not started
```

## Phase gate (after the last task; blocks Phase 3)

```text
1. All tasks committed in order
2. Fresh clean checkout on the droplet: install --frozen-lockfile, build,
   typecheck, lint, test, test:integration (+ actor suite), git diff --check
3. Evidence document with measured results only
   (docs/phase-2-verification.md)
4. Independent phase review = PASS
5. Working tree clean; local == origin == droplet
6. Explicit owner approval — completing Phase 2 authorizes nothing further
```

---

### P2-T1: Design document and phase plan

**Goal:** Approvable design for the Apify Actor wrapper before any code.

**Steps:** Write the failing documentation-contract test
(`tests/phase2-design-contract.test.ts`) → confirm RED (docs missing) →
write the design + this plan → focused GREEN → verification ladder →
independent review → commit.

**Completion criteria:** Both documents exist, satisfy the documentation
contract, cover input schema, Dataset/RUN_SUMMARY/cost/logging contracts,
FakeProvider-only testing, dependency policy, environment assumptions,
and the in-phase approval gates; owner approves the design.

### P2-T2: Actor package scaffolding and input validation

**Goal:** Validated actor input before any collection work.

**Files:** `actor/social-graph-actor/` package skeleton; `src/input.ts`
with the pure validation function; table-driven unit tests (valid
minimal, `@` strip, trim, duplicate collapse, all invalid shapes,
safety limits, unknown keys, `youtube` rejection); REQUIRED workspace
edit: add `actor/*` to `pnpm-workspace.yaml` packages (not currently
covered).

**Completion criteria:** Validation is pure and fully tested; invalid
input fails before any provider work; actor package typechecks/lints
within the workspace; no Apify dependency needed yet.

### P2-T3: Composition root and Dataset streaming

**Goal:** `collectTargets()` consumed with awaited Dataset writes and
correct failure conversion.

**Files:** `src/main.ts` (composition root injecting the FakeProvider
registry), `src/dataset-writer.ts` (per-item and bounded-batch awaited
writes; write-failure → affected stream `ABORTED`, never fake success),
containment tests (no cursors/raw/secrets in rows), actor-flow test vs
FakeProvider scenarios (profile failure, capability gating, pagination,
dedup, retry, both mode, isolation, actor-run-timeout conversion).

**Completion criteria:** Streaming backpressure preserved; write-failure
semantics per design §4; core untouched (architecture tests green).

### P2-T4: RUN_SUMMARY, cost layer, and safe logging

**Goal:** One authoritative run summary with measured-only costs and
redacted logs.

**Files:** `src/run-summary.ts` (RUN_SUMMARY assembly, Apify cost-layer
fields, derived metrics with null/`unavailable` rules), `src/logging.ts`
(structured fields + redaction), unit tests with hand-computed formula
cases and a redaction test over every forbidden shape.

**Completion criteria:** Derived metrics match spec §12 formulas; local
FakeProvider runs report `cost_data_status: "unavailable"` with null
costs; logs carry run_id/target_id/page ordinal/retry ordinal/outcome
and never leak forbidden shapes.

### P2-T5: Local actor suite and architecture extension

**Goal:** The complete actor behavior proven locally with no network.

**Files:** `tests/actor-flow.test.ts` completed against the full
FakeProvider scenario set; architecture tests extended to the actor
package boundary (actor may import core; core may not import actor;
no Apify SDK inside core).

**Completion criteria:** All Phase 1 integration scenarios pass through
the actor pipeline; dependency boundaries executable; full workspace
ladder green.

### P2-T6: One private dev deployment (approval-gated)

**Goal:** The actor exists on the owner's account as a private dev
actor, running nothing.

**Steps:** Owner approves → `apify push` from the droplet using the env
token → verify actor exists and is private via read-only API → record
actor ID/name in the phase evidence.

**Completion criteria:** Private actor created under
`eloquent_filbert_uwi`; zero runs executed; no Store publication; token
never printed.

---

## Phase 2 final gate

Run the phase gate defined at the top of this document, record evidence
in `docs/phase-2-verification.md`, obtain the independent phase review,
and stop for owner approval. Do not start Phase 3 (provider selection,
live benchmarks) without it.
