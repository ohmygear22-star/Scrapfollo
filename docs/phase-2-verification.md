# Phase 2 Verification Evidence

This file records only actual measured evidence from the Phase 2 gate.
Results were produced by running the commands on the stated date, runtime,
and commit; no value is pre-filled or estimated.

P2-T6 (the one private `apify push`) is pending owner approval and is NOT
covered by this evidence; the gate below verifies P2-T1 through P2-T5.

## Environment

- Date: 2026-09-16
- Gate commit: ca9d050 (test(actor): enforce actor dependency boundaries)
- Branch: feature/social-graph-phase-2
- Node runtime: v22.23.2
- pnpm version: 11.19.0

## Task commits

| Task | Commit | Review |
| --- | --- | --- |
| P2-T1 design + plan (owner approved) | cf2bfdf, ef6320c | PASS (7 minors fixed) |
| P2-T2 input validation | c0370d4 | PASS (4 minors fixed) |
| P2-T3 dataset streaming | bc0bed9 | FAIL→RESOLVED (unhandled-rejection blocker, fix load-bearing-proven) |
| P2-T4 run summary + cost + logging | 042d0a4 | PASS (1 major + 3 minors fixed) |
| P2-T5 architecture extension | ca9d050 | PASS (dynamic-import gap closed) |

## Phase gate

Run from a fresh clean clone on the verification host at the gate commit:

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS (exit 0) | Done in 2.1s; zero new external dependencies added in P2-T2..T5 |
| `pnpm build` | PASS (exit 0) | core + fake-provider + actor |
| `pnpm typecheck` | PASS (exit 0) | all packages + root check config (covers all package tests) |
| `pnpm lint` | PASS (exit 0) | `eslint . --max-warnings=0`; restricted-import rules for core and actor src proven firing |
| `pnpm test` | PASS (exit 0) | 129/129 core + 26/26 fake-provider + 61/61 actor |
| `pnpm test:integration` | PASS (exit 0) | 1/1 black-box Phase 1 flow (unchanged, still green) |
| `git diff --check` | PASS (exit 0) | no whitespace errors |
| `git status --short` | CLEAN | no output |

## Test counts

- Core unit tests: 129 passed (16 files)
- Fake-provider contract tests: 26 passed (1 file)
- Actor tests: 61 passed (6 files: input 35, actor-flow 10, dataset-writer 3, run-summary 4, logging 7, architecture 2)
- Integration tests: 1 passed (1 file)

## Boundary proofs during Phase 2 (all fixtures removed after proof)

- Actor src importing `@social-graph/fake-provider` → both actor architecture tests fail naming the specifier.
- Dynamic `import("@social-graph/fake-provider")` in actor src → both actor architecture tests fail (regex covers dynamic imports).
- Core src importing `@social-graph/actor` → core architecture tests fail.
- ESLint restricted-import blocks for core src and actor src fire with their documented messages.

## Pending (not covered by this gate)

- P2-T6: one private `apify push` (dev actor, zero runs) — awaiting owner approval.
- After P2-T6 (when approved): re-run this gate at the final Phase 2 commit.
- Phase 3 start: requires the phase gate to pass at the final Phase 2 commit AND explicit owner approval.

## Working tree

- `git status --short`: clean (no output) at the gate commit
- `git diff --check`: clean (no output)
