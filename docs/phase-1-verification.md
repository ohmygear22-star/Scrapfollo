# Phase 1 Verification Evidence

This file records only actual measured evidence from the Phase 1 final gate.
Results below were produced by running the commands on the stated date,
runtime, and commit; no value is pre-filled or estimated.

## Environment

- Date:
- Final commit:
- Branch:
- Node runtime:
- pnpm version:

## Final gate

Run from a clean checkout of the final commit:

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | | |
| `pnpm build` | | |
| `pnpm typecheck` | | |
| `pnpm lint` | | |
| `pnpm test` | | core + provider test counts |
| `pnpm test:integration` | | integration test count |
| `git diff --check` | | |

## Documentation and workspace verification

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm --filter @social-graph/core test -- documentation-contract.test.ts` | | |
| `pnpm test` (post-evidence rerun) | | |
| `git diff --check` (post-evidence rerun) | | |

## Test counts

- Core unit tests:
- Fake-provider contract tests:
- Integration tests:

## Working tree

- `git status --short`:
- `git diff --check`:
