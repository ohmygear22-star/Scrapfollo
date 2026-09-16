# Phase 2 Verification Evidence

This file records only actual measured evidence from the Phase 2 gate.
Results were produced by running the commands on the stated date, runtime,
and commit; no value is pre-filled or estimated.

P2-T6 was owner-approved and completed on 2026-09-16; this evidence covers
the FULL phase P2-T1 through P2-T6, re-verified at the final Phase 2 commit.

## Environment

- Date: 2026-09-16
- Initial gate commit (T1–T5): ca9d050
- Final gate commit (T1–T6): 0164e80
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
| P2-T6 apify binding + private push (owner approved) | 9a22801 + 0164e80 | FAIL→RESOLVED (vi.hoisted mock-collection blocker; binding behavior re-verified) |

## Phase gate

Run from a fresh clean clone on the verification host at the gate commit:

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS (exit 0) | Done in 2.1s; zero new external dependencies added in P2-T2..T5 |
| `pnpm build` | PASS (exit 0) | core + fake-provider + actor |
| `pnpm typecheck` | PASS (exit 0) | all packages + root check config (covers all package tests) |
| `pnpm lint` | PASS (exit 0) | `eslint . --max-warnings=0`; restricted-import rules for core and actor src proven firing |
| `pnpm test` | PASS (exit 0) | 129/129 core + 26/26 fake-provider + 67/67 actor (16+1+8 test files) |
| `pnpm test:integration` | PASS (exit 0) | 1/1 black-box Phase 1 flow (unchanged, still green) |
| `git diff --check` | PASS (exit 0) | no whitespace errors |
| `git status --short` | CLEAN | no output |

## Test counts (final gate, commit 0164e80)

- Core unit tests: 129 passed (16 files)
- Fake-provider contract tests: 26 passed (1 file)
- Actor tests: 67 passed (8 files: input 35, actor-flow 10, dataset-writer 3, run-summary 4, logging 7, architecture 3, apify-binding 4, apify-entry 1)
- Integration tests: 1 passed (1 file)

## Boundary proofs during Phase 2 (all fixtures removed after proof)

- Actor src importing `@social-graph/fake-provider` → both actor architecture tests fail naming the specifier.
- Dynamic `import("@social-graph/fake-provider")` in actor src → both actor architecture tests fail (regex covers dynamic imports).
- Core src importing `@social-graph/actor` → core architecture tests fail.
- ESLint restricted-import blocks for core src and actor src fire with their documented messages.

## P2-T6 deployment record

- Actor: `eloquent_filbert_uwi/social-graph-actor` (Actor ID `NqsdObuHobtiIKZxL`)
- Build `0.1.8` SUCCEEDED (8 build attempts total; iterations were input-schema
  conformance fixes — two-part version, schemaVersion, field titles/descriptions,
  scalar-only platform schema with code-side targets validation authoritative)
- Verified via read-only API: `isPublic: false`, `totalRuns: 0` — private dev
  actor, zero runs, zero quota consumed
- Deployment path: droplet `/opt/scrapfollo/actor/social-graph-actor` via
  `apify-cli@1.10.0` with the env token (login state stored only in the
  droplet keyring); bundle strategy: everything bundled except the Apify SDK
  (external, installed from `bundle/package.json` inside the image)
- Apify account credit confirmed by owner: $500 (not $1,500)

## Pending

- Phase 3 start: requires owner approval (provider selection + live benchmark —
  first live platform contact and first quota usage).

## Working tree

- `git status --short`: clean (no output) at the gate commit
- `git diff --check`: clean (no output)
