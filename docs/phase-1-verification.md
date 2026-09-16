# Phase 1 Verification Evidence

This file records only actual measured evidence from the Phase 1 final gate.
Results below were produced by running the commands on the stated date,
runtime, and commit; no value is pre-filled or estimated.

## Environment

- Date: 2026-09-16
- Final commit: fd4cef5 (docs: document provider development and Phase 1 verification)
- Branch: feature/social-graph-phase-1
- Node runtime: v22.23.2
- pnpm version: 11.19.0

## Final gate

Run from a clean checkout of the final commit (fresh clone, no cached state)
on the verification host:

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS (exit 0) | Done in 4.8s |
| `pnpm build` | PASS (exit 0) | core + fake-provider compiled |
| `pnpm typecheck` | PASS (exit 0) | both packages + root check config |
| `pnpm lint` | PASS (exit 0) | `eslint . --max-warnings=0`, zero warnings |
| `pnpm test` | PASS (exit 0) | 127/127 core tests (15 files) + 26/26 fake-provider contract tests |
| `pnpm test:integration` | PASS (exit 0) | 1/1 black-box integration test |
| `git diff --check` | PASS (exit 0) | no whitespace errors |

## Documentation and workspace verification

Re-run after recording the evidence above:

| Command | Result: | Notes |
| --- | --- | --- |
| `pnpm --filter @social-graph/core test -- documentation-contract.test.ts` | PASS | 4/4 documentation contract tests |
| `pnpm test` (post-evidence rerun) | PASS | 127 + 26 tests, all green |
| `git diff --check` (post-evidence rerun) | PASS | silent |

## Test counts

- Core unit tests: 127 passed (15 test files)
- Fake-provider contract tests: 26 passed (1 test file)
- Integration tests: 1 passed (1 test file)

## Working tree

- `git status --short`: clean (no output)
- `git diff --check`: clean (no output)

## Gate host

The final gate ran on a DigitalOcean droplet under Node v22.23.2 /
pnpm 11.19.0 from a fresh `git clone` of
`feature/social-graph-phase-1` at commit `fd4cef5`.
