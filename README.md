# Scrapfollo — Social Graph Collection Core

A provider-neutral, streaming social-graph relationship core for Instagram,
X, and TikTok. Phase 1 delivers the TypeScript collection engine, a
deterministic configurable fake provider, complete test coverage, and
provider-development documentation. No live platform provider, deployment,
or production consumer integration is included.

## Workspace layout

```text
packages/social-graph-core   consumer-neutral core: contracts, streaming,
                             pagination, deduplication, retry, cancellation,
                             completeness, orchestration, metrics
providers/fake-provider      deterministic reference provider (one class,
                             configured per platform via scenarios)
tests/contracts              reusable provider contract suite
tests/integration            black-box Phase 1 acceptance flow
docs/                        provider guide + Phase 1 verification evidence
```

## Public API (summary)

- `collectRelationships(request, sourceProfile, provider)` — streams
  normalized relationship rows with native backpressure and exactly one
  terminal summary per begun collection.
- `collectTarget(request, provider)` — resolves the profile exactly once,
  then runs the requested relationship collections (`followers`,
  `following`, or `both`) with independent summaries.
- `collectTargets(request, registry)` — bounded-concurrency multi-target
  streaming through the provider registry with failure isolation and a
  bounded event buffer.
- `resolveProfile`, `retryOperation`, `completeCollection`, metrics helpers.
- Platforms are exactly `instagram`, `x`, `tiktok` — YouTube is excluded.

## Development

Requires Node 22 and pnpm 11.19.0 (`corepack prepare pnpm@11.19.0 --activate`).

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

Verification evidence for the Phase 1 gate lives in
[docs/phase-1-verification.md](docs/phase-1-verification.md). To implement a
new platform provider, read
[docs/providers/social-graph-provider.md](docs/providers/social-graph-provider.md).

## Phase 1 scope

Phase 1 intentionally excludes live providers, provider failover, Apify
deployment and store listings, Starpulse/PostgreSQL persistence, schedulers,
notifications, billing, dashboards, private-profile access, and any
security/login/rate-limit bypass behavior. Those require separate approval.
