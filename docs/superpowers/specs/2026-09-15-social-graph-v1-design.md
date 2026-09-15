# Multi-Platform Social Graph V1 Architecture Design

**Status:** Approved

**Date:** 2026-09-15

**Scope:** V1 architecture baseline and Phase 1 provider-neutral core

**Language/runtime direction:** TypeScript monorepo; exact runtime and dependency versions will be pinned in the implementation plan.

## 1. Objective and boundaries

Build one reusable, provider-neutral public-profile relationship collection engine for Instagram, X, and TikTok, serving two independent consumers:

1. An Apify Actor that streams normalized follower/following rows into an Apify Dataset and measures usage and cost.
2. A Starpulse adapter that persists complete observations, establishes baselines, and detects relationship changes in PostgreSQL.

The core must not depend on a platform endpoint, a single data vendor, Apify, Starpulse, or PostgreSQL. V1 does not implement a live Instagram, X, or TikTok provider. One configurable deterministic `FakeProvider` must exercise the complete collection flow for all three platforms through the same core contract. YouTube is explicitly outside V1 scope.

V1 must not access private-only information, private messages, other users' credentials or sessions, or bypass login, security, rate limits, or platform controls.

## 2. Architecture

```text
                          Consumer-neutral contracts
                                     │
                       ┌─────────────▼─────────────┐
                       │      social-graph-core       │
                       │ orchestration / streaming │
                       │ pagination / retry        │
                       │ normalization / dedupe    │
                       │ completeness / metrics    │
                       └─────────────┬─────────────┘
                                     │
                            SocialGraphProvider
                                     │
                      ┌──────────────┴──────────────┐
                      │                             │
                 FakeProvider             Future live providers
          instagram / x / tiktok     separately approved compliant sources
               ┌──────┴──────┐
               │             │
          Apify Actor   Starpulse Adapter
               │             │
       streaming Dataset   PostgreSQL
                           snapshots / diff
```

The repository is a monorepo so contracts and tests can be shared without coupling deployments:

```text
social-graph/
├── packages/
│   └── social-graph-core/
│       ├── src/
│       │   ├── contracts/
│       │   ├── collection/
│       │   ├── normalization/
│       │   ├── deduplication/
│       │   ├── retry/
│       │   ├── errors/
│       │   └── metrics/
│       └── tests/
├── providers/
│   └── fake-provider/
├── apps/
│   ├── apify-actor/
│   └── starpulse-adapter/
├── database/
│   ├── migrations/
│   └── schema.sql
├── docs/
└── tests/
    └── integration/
```

## 3. Module boundaries

### 3.1 `social-graph-core/contracts`

Defines provider interfaces, normalized domain types, streaming events, collection requests, collection completeness, standard errors, and metrics. It must contain no endpoint URLs, Apify Dataset types, SQL models, or Starpulse change events.

### 3.2 `social-graph-core/collection`

Resolves profiles and orchestrates followers, following, or both. It owns pagination, maximum-result enforcement, cursor anomaly detection, retry invocation, cancellation, multi-target isolation, streaming delivery, and final completeness status.

### 3.3 `social-graph-core/normalization`

Converts provider items into stable internal relationships. Provider raw objects must never escape this boundary.

### 3.4 `social-graph-core/deduplication`

Uses the relationship account's stable platform user ID when available. Its key is `platform + relationship + platformUserId`. The fallback key is `platform + sourceProfileId + relationship + normalizedUsername`. Platform is always part of the identity boundary so IDs or usernames from different networks cannot collide. Username normalization is for comparison only; output preserves the provider's normalized display value.

Deduplication is streaming and run-scoped. It keeps only deduplication keys and counters in memory, not the full relationship objects. Exact deduplication is required in V1; if memory benchmarks later show the key set is too large, any probabilistic or externalized strategy requires a separate design decision because it could alter output correctness.

### 3.5 `social-graph-core/retry`

Retries only errors classified as transient. It uses a bounded attempt count, exponential backoff, jitter, provider-supplied `retryAfterMs`, and an injectable clock/sleeper. Permanent errors stop immediately. Core cancellation interrupts both requests and backoff.

### 3.6 `social-graph-core/metrics`

Records measured core activity and derives rate metrics. Consumer-specific usage, such as Apify compute units and proxy prices, is added by the consumer without changing core contracts.

### 3.7 `fake-provider`

Provides deterministic scenarios for Instagram, X, and TikTok, including different capability sets, multiple pages, overlapping pages, missing IDs, transient and terminal failures, unavailable profiles, private profiles, cursor loops, empty pages, request bytes, and abort behavior. One configurable implementation uses a scenario-level `platform`; three separate fake implementations are not required. It must pass the same provider contract suite required of every future live provider.

### 3.8 Consumer boundaries

The Apify Actor maps streamed normalized records to Dataset rows. The Starpulse adapter persists normalized observations and performs database transactions and diffs. Neither imports a provider implementation directly; composition roots inject a `SocialGraphProvider` into core.

## 4. Provider adapter contract

The provider interface is page-oriented because source-specific cursor handling belongs at the collection boundary:

```ts
interface SocialGraphProvider {
  readonly providerName: string;
  readonly platform: Platform;
  readonly capabilities: SocialGraphProviderCapabilities;

  resolveProfile(
    input: ResolveProfileInput,
    context: ProviderRequestContext,
  ): Promise<ProviderProfile>;

  fetchFollowersPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage>;

  fetchFollowingPage(
    input: FetchRelationshipPageInput,
    context: ProviderRequestContext,
  ): Promise<ProviderRelationshipPage>;
}

type SocialGraphProviderRegistry = ReadonlyMap<Platform, SocialGraphProvider>;
```

```ts
type Platform =
  | "instagram"
  | "x"
  | "tiktok";

type SocialGraphProviderCapabilities = {
  profileLookup: boolean;
  followerCount: boolean;
  followingCount: boolean;
  followerIdentities: boolean;
  followingIdentities: boolean;
  pagination: boolean;
  stableUserIds: boolean;
};

type ResolveProfileInput = {
  platform: Platform;
  username: string;
};

type FetchRelationshipPageInput = {
  profileId: string;
  cursor?: string;
  limit: number;
};

type ProviderRequestContext = {
  runId: string;
  targetId: string;
  signal?: AbortSignal;
};

type ProviderProfile = {
  platform: Platform;
  platformUserId: string;
  username: string;
  followerCount?: number;
  followingCount?: number;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
};

type ProviderRelationshipItem = {
  platform: Platform;
  platformUserId?: string;
  username: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
};

type ProviderRelationshipPage = {
  items: ProviderRelationshipItem[];
  nextCursor?: string;
  hasMore: boolean;
  requestMetadata: {
    requestId?: string;
    statusCode?: number;
    attempts: number;
    bytesTransferred?: number;
    durationMs: number;
    proxyBytes?: number;
  };
};
```

`ResolveProfileInput.platform` must equal the injected provider's `platform`; a mismatch is `INVALID_INPUT`. Every returned profile and relationship item must carry that same platform. Core rejects inconsistent provider output rather than silently relabeling it.

Provider capabilities are authoritative declarations from the injected provider. Consumers and core must not infer support from platform names, provider names, method presence, or previous results. Core validates the requested operation before invoking it and returns a normalized `CAPABILITY_UNSUPPORTED` error when the required capability is false. `followerIdentities` and `followingIdentities` govern relationship identity streams; `followerCount` and `followingCount` govern profile count availability independently. `stableUserIds: true` means non-null IDs supplied by that provider are stable and may be primary dedupe keys; individual items can still omit an ID and use fallback. When `stableUserIds` is false, core does not trust item IDs for exact deduplication and uses the documented username fallback without inventing identifiers. `pagination: false` means the provider can return at most one terminal page for a supported identity operation.

Single-target and single-relationship collection receive one `SocialGraphProvider`. Multi-target orchestration receives a `SocialGraphProviderRegistry`, selects the provider by the target's explicit `platform`, and validates that the registry key equals `provider.platform`. A missing provider produces `PROVIDER_UNAVAILABLE` for that target without terminating unrelated targets. The registry is consumer-neutral dependency injection; it contains no endpoint selection or provider-specific response logic.

Cursor values are opaque. Consumers cannot parse or persist them as public business data. Core treats repeated cursors, `hasMore: true` without a next cursor, and non-progressing pagination as `PAGINATION_FAILED`.

### 4.1 Platform source expectations

- **Instagram:** follower/following identity collection is provider-dependent. Core contains no Instagram endpoint or extraction technique.
- **X:** a future provider may use official X APIs that support follower/following lookup, but no live X provider is part of Phase 1.
- **TikTok:** follower/following identity collection is provider-dependent. TikTok Research APIs are not hardcoded into the commercial architecture because Research Tools eligibility does not cover the intended commercial product use. Live source selection requires a later commercial, policy, and provider decision.
- **YouTube:** out of scope. It is not included in the `Platform` union, fake scenarios, acceptance tests, or provider selection work.

## 5. Streaming collection contract

Core must not accumulate a complete follower/following collection before returning it. Its primary API is an `AsyncGenerator`, which is also an `AsyncIterable`:

```ts
type RelationshipType = "followers" | "following";

type TerminationReason =
  | "SOURCE_EXHAUSTED"
  | "MAX_LIMIT_REACHED"
  | "ERROR"
  | "ABORTED";

type NormalizedRelationship = {
  platform: Platform;
  sourceUsername: string;
  sourceUserId: string;
  relationship: RelationshipType;
  userId?: string;
  username: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
  position: number;
  scrapedAt: string;
};

type CollectionCompleteness = {
  complete: boolean;
  terminationReason: TerminationReason;
  error?: PublicCollectionError;
};

type RelationshipCollectionSummary = {
  runId: string;
  targetId: string;
  sourceProfile: ProviderProfile;
  relationship: RelationshipType;
  completeness: CollectionCompleteness;
  metrics: RelationshipCollectionMetrics;
};

type RelationshipStreamEvent =
  | { type: "relationship"; value: NormalizedRelationship }
  | { type: "summary"; value: RelationshipCollectionSummary };

function collectRelationships(
  request: CollectRelationshipsRequest,
  provider: SocialGraphProvider,
): AsyncGenerator<RelationshipStreamEvent>;
```

Contract rules:

1. Core yields each unique normalized relationship as soon as it is available.
2. Exactly one terminal `summary` event is yielded for every relationship collection whose iterator is consumed to termination, including provider error and externally triggered abort outcomes. Core catches normalized collection errors so they become summaries instead of escaping as unclassified exceptions.
3. No relationship event may occur after its terminal summary.
4. If the consumer itself stops iteration early, it must call iterator `return()`; core aborts outstanding work and closes internal metrics as `ABORTED`. Because the consumer has closed the iterator, it cannot require a subsequently yielded summary; the consumer that initiated closure must record the abort in its own run status.
5. Backpressure is native: core does not fetch the next page until the consumer has accepted yielded items from the current page. Apify can therefore await Dataset writes without unbounded buffering.
6. Positions are one-based and contiguous over unique emitted rows. Duplicates do not consume positions.
7. `scrapedAt` is the observation time assigned during normalization, not an inferred platform event time.
8. Both-mode creates two independently summarized streams under the target result, so followers can complete while following fails.
9. Multi-target orchestration may interleave events with a bounded concurrency limit, but every event carries `runId`, `targetId`, and relationship context either directly or through its value.

The convenience batch orchestrator is also streaming:

```ts
type TargetStreamEvent =
  | { type: "profile"; runId: string; targetId: string; value: ProviderProfile }
  | { type: "relationship"; runId: string; targetId: string; value: NormalizedRelationship }
  | { type: "collectionSummary"; runId: string; targetId: string; value: RelationshipCollectionSummary }
  | { type: "targetSummary"; runId: string; targetId: string; value: TargetCollectionSummary };

function collectTargets(
  request: CollectTargetsRequest,
  providers: SocialGraphProviderRegistry,
): AsyncGenerator<TargetStreamEvent>;
```

This contract permits streaming consumers while retaining an authoritative terminal state. A helper may materialize results only for tests or explicitly small callers; it is not the production default.

### 5.1 `userId` contract decision

The requested public Actor schema lists `userId` as required, while provider-neutral normalization must handle sources that may omit it. Internally, `userId` remains optional so fallback deduplication can be tested. A provider is commercially eligible for an Actor configuration only if it satisfies the Actor's final row contract. Before Store publication, either the selected provider must guarantee stable IDs or the public schema must explicitly make `userId` optional. The Actor must not invent IDs.

## 6. Completeness contract

Completeness is decided by core, never inferred by Apify or Starpulse.

| Termination reason | `complete` | Meaning |
|---|---:|---|
| `SOURCE_EXHAUSTED` | `true` | Core reached a valid provider terminal page and observed the full source collection. |
| `MAX_LIMIT_REACHED` | `false` | Core emitted the requested maximum before source exhaustion; the observation is intentionally truncated. |
| `ERROR` | `false` | A terminal provider, pagination, consumer-delivery, or core error prevented completion. |
| `ABORTED` | `false` | Cancellation, timeout, shutdown, or early consumer termination stopped collection. |

Additional rules:

- An empty collection is complete only when the provider validly reports source exhaustion.
- Core reports separate completeness for followers and following.
- Target-level status is `SUCCESS` only when every requested relationship collection is complete, `PARTIAL` when at least one requested collection emitted usable data or completed while another did not, and `FAILED` when no requested collection completed successfully.
- `MAX_LIMIT_REACHED` is not an error, but it is incomplete for historical removal detection.
- Metrics are final even when completeness is false and describe only work actually performed.
- A consumer write failure can convert the consumer's run status to failed even if core reached `SOURCE_EXHAUSTED`. Starpulse must commit a snapshot only after both core completeness and persistence success are confirmed.
- Starpulse may create removal changes only for a relationship type whose current core summary has `complete: true` and `terminationReason: "SOURCE_EXHAUSTED"`, and whose comparison snapshot for that relationship type was also complete.
- Starpulse must not inspect counts, cursors, requested maxima, or provider metadata to override this decision.

## 7. Apify Actor flow

```text
Actor start
  → validate input
  → create run_id, metrics collector, provider and bounded target scheduler
  → consume collectTargets()
      relationship event → await Dataset.pushData(row)
      collection summary → record authoritative completeness
      target summary → record success/partial/failure
  → store RUN_SUMMARY in Key-Value Store
  → finalize Apify usage and cost metrics
  → Actor exit
```

Input supports multiple `{ platform, username }` targets, `followers`, `following`, or `both`, plus optional `maxFollowers` and `maxFollowing`. Platform must be one of `instagram`, `x`, or `tiktok`. Usernames are trimmed, a leading `@` is removed, duplicates are rejected or collapsed by `(platform, normalizedUsername)`, and maxima must be positive integers within configured safety limits. The Actor composition root injects a provider registry; core validates provider presence, platform identity, and requested capabilities before collection.

The default Dataset contains only normalized relationship rows. Provider raw responses, cursors, stack traces, credentials, cookies, tokens, and proxy secrets are forbidden. Failed targets remain visible in the run summary without terminating successful targets unnecessarily.

Dataset writes are awaited per streamed item or bounded batch. If a Dataset write fails, the Actor aborts the affected stream, records `ABORTED` or a consumer persistence error at the Actor layer, and never reports that collection as successfully delivered.

## 8. Starpulse adapter flow

```text
request target scan
  → acquire PostgreSQL session-level per-target advisory lock on a dedicated connection
  → if unavailable, mark/return RUN_ALREADY_ACTIVE
  → create scrape_run = RUNNING
  → consume core stream into a normal run-scoped staging table keyed by run_id
  → commit staging writes incrementally while the advisory lock remains held
  → do not hold the authoritative snapshot transaction during network collection
  → receive final core completeness summaries
  → open one short atomic PostgreSQL transaction
  → for each requested relationship type:
      incomplete → retain staging data for diagnostics and later cleanup,
                   but do not promote authoritative snapshot edges or create removals
      complete   → promote valid staging data into social_profiles,
                   relationship_edges, snapshots, snapshot_edges,
                   and relationship_changes
  → for the first complete observation of each relationship type:
      mark that type's baseline and create no relationship changes
  → for a later comparable complete observation:
      create additions and removals
  → update scrape_run status in the same atomic transaction
  → commit
  → release advisory lock
```

Followers and following completeness are independent. A following-only scan cannot modify follower edges. A max-limited, errored, or aborted collection cannot generate removal changes.

### 8.1 Concurrent run protection

V1 uses a PostgreSQL session-level advisory lock keyed by target UUID:

```sql
SELECT pg_try_advisory_lock(:target_lock_key);
```

The adapter deterministically hashes the target UUID into the signed 64-bit advisory-lock key space. It acquires the lock on a dedicated pooled connection before collection begins and holds that connection for the scan. Network collection does not run inside a long-lived database transaction. Streamed relationship rows are inserted into a normal staging table keyed by `run_id`; those staging writes may be committed incrementally while the advisory lock remains held. After final core completeness summaries arrive, promotion into authoritative profile, edge, snapshot, snapshot-membership, and change tables uses one short atomic transaction while the same session-level lock remains held.

If the lock is unavailable, the adapter does not wait indefinitely and does not begin collection. It returns the normalized run outcome `RUN_ALREADY_ACTIVE`; depending on orchestration policy, the scheduler may skip or retry later. The rejected attempt may be recorded outside the authoritative snapshot transaction for operations auditing, but it cannot create a snapshot.

The adapter releases the lock in a `finally` path with `pg_advisory_unlock` before returning the dedicated connection to the pool. PostgreSQL also releases a session lock if that connection is lost. A locked connection must never be returned to the general pool.

The advisory lock is defense in depth, not the only consistency control. The database also enforces unique constraints on snapshot/run identities and relationship edges. All code paths, including manual runs, must enter through the same lock-owning adapter service.

## 9. PostgreSQL schema

The initial deployment uses a dedicated `starpulse_db` and least-privilege `starpulse_app` user. PostgreSQL binds only to `127.0.0.1` or an approved private network and is not publicly exposed on port 5432. Phase 1 does not perform this deployment.

### 9.1 `targets`

```text
id                  uuid primary key
platform            text not null
platform_username   text not null
platform_user_id    text
status              text not null
created_at          timestamptz not null
updated_at          timestamptz not null
```

Use a case-insensitive unique key for `(platform, platform_username)` and a partial unique key for non-null `(platform, platform_user_id)`.

### 9.2 `social_profiles`

```text
id                  uuid primary key
platform            text not null
platform_user_id    text
username            text not null
full_name           text
is_private          boolean
is_verified         boolean
profile_pic_url     text
first_seen_at       timestamptz not null
last_seen_at        timestamptz not null
```

Stable platform ID is the primary identity. A controlled case-insensitive username fallback applies only when no platform ID exists.

### 9.3 `scrape_runs`

```text
id                       uuid primary key
target_id                uuid not null references targets(id)
started_at               timestamptz not null
completed_at             timestamptz
status                   text not null
requested_relationships  text[] not null
followers_complete       boolean
followers_termination    text
following_complete       boolean
following_termination    text
followers_count          bigint
following_count          bigint
results_collected        bigint not null
request_count            integer not null
failed_request_count     integer not null
retry_count              integer not null
bytes_transferred        bigint
runtime_ms               bigint
compute_units            numeric
proxy_cost               numeric
estimated_cost           numeric
cost_data_status         text not null
error_category           text
```

### 9.4 `snapshots`

```text
id                  uuid primary key
target_id           uuid not null references targets(id)
scrape_run_id       uuid not null unique references scrape_runs(id)
captured_at         timestamptz not null
followers_count     bigint
following_count     bigint
followers_complete   boolean not null
following_complete   boolean not null
followers_is_baseline boolean not null default false
following_is_baseline boolean not null default false
```

### 9.5 `staging_relationships`

```text
run_id               uuid not null references scrape_runs(id)
relationship_type    text not null check in ('FOLLOWER', 'FOLLOWING')
dedupe_key            text not null
source_platform_id    text not null
related_platform_id   text
username              text not null
full_name             text
is_private            boolean
is_verified           boolean
profile_pic_url       text
position              bigint not null
scraped_at            timestamptz not null
primary key(run_id, relationship_type, dedupe_key)
```

V1 uses a normal table rather than a temporary session table. This permits incremental commits during streaming, crash recovery, inspection of failed or partial runs, and later retention cleanup of orphaned staging rows. Staging rows are run-scoped and are not authoritative history. A later persistence implementation must define retention and cleanup behavior before production use.

### 9.6 `relationship_edges`

```text
id                  uuid primary key
target_id           uuid not null references targets(id)
related_profile_id  uuid not null references social_profiles(id)
relationship_type   text not null check in ('FOLLOWER', 'FOLLOWING')
first_seen_at       timestamptz not null
last_seen_at        timestamptz not null
active              boolean not null
```

Enforce uniqueness on `(target_id, related_profile_id, relationship_type)`.

### 9.7 `snapshot_edges`

```text
snapshot_id          uuid not null references snapshots(id)
relationship_edge_id uuid not null references relationship_edges(id)
primary key(snapshot_id, relationship_edge_id)
```

V1 intentionally retains this thin historical membership table. It duplicates neither profile fields nor provider raw data and allows exact historical reconstruction and auditable diffs. Membership rows are created only for the relationship types marked complete in that snapshot.

### 9.8 `relationship_changes`

```text
id                    uuid primary key
target_id             uuid not null references targets(id)
related_profile_id    uuid not null references social_profiles(id)
relationship_type     text not null
change_type           text not null
previous_snapshot_id  uuid references snapshots(id)
current_snapshot_id   uuid not null references snapshots(id)
detected_at           timestamptz not null
```

Allowed V1 changes are `NEW_FOLLOWING`, `UNFOLLOWED`, `NEW_FOLLOWER`, and `LOST_FOLLOWER`. Baselines are represented by `snapshots.followers_is_baseline` and `snapshots.following_is_baseline`, not thousands of synthetic change records.

Indexes support active edges by target/type, snapshots by target/time, changes by target/time, profile platform IDs, scrape runs by target/time, and snapshot membership in both join directions.

## 10. Snapshot diff semantics

Diff keys use stable platform IDs where available, with the same controlled fallback identity used by core. For each relationship type:

```text
added   = current complete membership - previous complete membership
removed = previous complete membership - current complete membership
```

Following additions map to `NEW_FOLLOWING`; following removals map to `UNFOLLOWED`. Follower additions map to `NEW_FOLLOWER`; follower removals map to `LOST_FOLLOWER`.

The first complete scan of each relationship type creates that type's baseline and no changes. Followers and following can therefore establish baselines in different runs. `detected_at` is the observation time. Starpulse must never claim it is the exact platform event time.

Reprocessing the same successful run is idempotent through unique run/snapshot identities and deterministic edge keys. Snapshot creation, membership, edge activation/deactivation, change creation, and run completion are one atomic transaction protected by the target advisory lock.

## 11. Error handling

Core categories are:

```text
PROFILE_NOT_FOUND
PROFILE_UNAVAILABLE
PRIVATE_PROFILE_UNSUPPORTED
CAPABILITY_UNSUPPORTED
PROVIDER_UNAVAILABLE
RATE_LIMITED
SOURCE_TEMPORARILY_UNAVAILABLE
PAGINATION_FAILED
INVALID_INPUT
UNKNOWN_ERROR
```

Internal errors include category, safe message, retryability, safe details, provider name, request ID, target ID, and an internal cause. Customer output excludes implementation stack traces and secrets.

Invalid Actor input fails before work starts. Target errors remain isolated. In both-mode, one relationship stream may terminate with `ERROR` while the other continues. Cursor anomalies are terminal pagination errors. Abort and timeout finalize measured metrics and produce `complete: false`, `terminationReason: "ABORTED"`.

Logs carry `run_id`, `target_id`, relationship type, page ordinal, request ID, retry ordinal, and outcome. Authorization headers, cookies, tokens, passwords, API keys, proxy credentials, and excessive raw response data are redacted or omitted.

## 12. Metrics and cost measurement

Core records:

```text
profiles_requested
profiles_successful
profiles_failed
profiles_partial
followers_returned
following_returned
total_relationships_returned
raw_items_received
unique_items_produced
duplicates_removed
requests_made
requests_failed
requests_retried
bytes_transferred
runtime_ms
```

Apify adds:

```text
compute_units
proxy_bytes
proxy_cost
dataset_operations
actor_runtime_ms
estimated_cost
currency
cost_data_status
```

Derived metrics are:

```text
SUCCESS_RATE = profiles_successful / profiles_requested
COST_PER_1000_RESULTS = cost / total_relationships_returned * 1000
REQUESTS_PER_1000_RESULTS = requests_made / total_relationships_returned * 1000
SECONDS_PER_1000_RESULTS = runtime_ms / total_relationships_returned
```

All per-1,000 metrics are `null` when no relationships were returned. Cost status is `actual`, `estimated`, or `unavailable`. Unavailable inputs remain `null`; they are never fabricated. Fake-provider benchmarks validate accounting and formulas but cannot set a commercial price.

Core summaries retain platform identity, and run metrics can be grouped by platform without inferring platform from usernames or provider names.

## 13. Testing strategy

### 13.1 Provider contract tests

Every provider must pass the same suite for platform identity, capability reporting, profile resolution, controlled unsupported-capability and not-found errors, follower/following page shape, opaque cursor continuation where supported, request metadata, error normalization, retry classification, and abort behavior.

### 13.2 Core unit tests

Tests cover followers, following, both, exact maximum truncation, termination reasons, source exhaustion, page overlap, stable-ID and username fallback deduplication, contiguous positions, multi-target isolation, retry success/exhaustion, non-retryable errors, cursor loops, empty terminal pages, cancellation, backpressure, terminal-summary uniqueness, metrics aggregation, and zero-denominator formulas.

Streaming tests must prove that the first normalized item is consumable before the provider's final page is requested and that slow consumers bound provider progress.

### 13.3 Fake-provider integration tests

Exercise `FakeProvider → core → pagination → normalization → deduplication → streaming events → summaries → metrics`, including fake Instagram, fake X, and fake TikTok targets through the same core, different capability sets, and one isolated failure.

### 13.4 Apify Actor tests

Validate input schema, Dataset rows, streaming writes, bounded buffering, run summary, partial success, error sanitization, Dataset write failure, timeout/abort, and absence of provider raw objects.

### 13.5 Starpulse adapter and PostgreSQL tests

Use a real isolated PostgreSQL instance to verify baseline behavior, second-snapshot additions/removals, independent relationship types, partial/max-limited scans producing no false removals, core-completeness enforcement, rollback, idempotency, historical reconstruction, and advisory-lock contention. A concurrency test starts two scans for the same target and proves exactly one can enter the authoritative update transaction.

Migration tests verify constraints, indexes, allowed values, clean-database installation, and least-privilege roles.

### 13.6 Architectural dependency tests

Enforce that core does not depend on Apify or PostgreSQL, Actor does not depend on Starpulse persistence, Starpulse does not import a provider implementation, and fixtures/logs contain no secrets.

## 14. Phase 1 implementation scope

Phase 1 delivers only the provider-neutral, fully testable core foundation:

- TypeScript monorepo foundation.
- `social-graph-core` contracts and `SocialGraphProvider` interface.
- AsyncIterable streaming collection and terminal summary contract.
- Formal completeness and termination reasons.
- Profile resolution orchestration.
- Followers, following, and both modes.
- Opaque cursor pagination and anomaly detection.
- Exact maximum handling.
- Streaming normalization and deduplication.
- Bounded retry and cancellation.
- Error taxonomy and core metrics.
- One deterministic, configurable `FakeProvider` capable of simulating Instagram, X, and TikTok.
- Provider contract, core unit, and fake-provider integration tests.
- Architecture and provider-development documentation.

Phase 1 does not implement a live Instagram, X, TikTok, or YouTube provider; login/session automation; Apify production deployment; Store listing or pricing; Starpulse database deployment; DigitalOcean changes; scheduled monitoring; notifications; billing; UI; mobile applications; private-profile access; or security-control bypasses.

Phase 1 is complete when one configurable fake provider proves Instagram, X, and TikTok scenarios through the same core; capability enforcement; multi-page streaming; all three scrape modes; isolated multi-target failure; exact deduplication; bounded memory behavior apart from the exact key set; authoritative completeness; retry and abort behavior; platform-bearing safe normalized output; correct metrics; and provider replaceability through the shared contract suite.

## 15. Later phases

### Phase 2: Apify wrapper

Build input validation, Actor composition, streaming Dataset output, safe logging, run summaries, Apify usage metrics, and local Actor tests against `FakeProvider`. This still does not authorize Store publication.

### Phase 3: Provider selection and live benchmark

Evaluate compliant providers separately per platform. A selected provider must pass the contract suite and documented legal, platform-policy, data-quality, capability, reliability, stable-ID, cost, eligibility, and operational review. Run approximately 100, 1,000, 5,000, and 10,000-result benchmarks. Official X APIs may be evaluated; Instagram and TikTok identity sources remain provider-dependent; TikTok Research Tools are not assumed commercially eligible.

### Phase 4: Starpulse persistence

Create migrations, dedicated credentials, private PostgreSQL configuration, advisory locking, streamed staging, baselines, snapshot membership, diffs, and integration tests. Production DigitalOcean changes require separate explicit approval.

### Phase 5: Production-readiness and commercial gate

Do not publish commercially until success rate, cost per 1,000 results, requests per 1,000 results, average runtime, proxy cost, and customer-safe failure behavior are measured.

Because V1 retains `snapshot_edges`, production readiness must also include a storage benchmark using representative target sizes and monitoring frequencies. Record:

- bytes per snapshot and per relationship membership;
- index overhead and write amplification;
- projected storage at 30, 90, 180, and 365 days;
- snapshot creation and diff-query latency;
- vacuum/maintenance behavior;
- backup and restore impact.

Before production monitoring is enabled, approve and document a retention policy covering successful, partial, and failed runs. Define a compaction/archive threshold and an operational trigger based on measured storage or latency. V1 does not implement temporal-table optimization or compaction, but commercial/production readiness cannot be approved without benchmark results, a retention decision, and a tested compaction/archive plan.

The initial commercial reliability target is at least 95% successful runs for explicitly supported public profiles under defined normal conditions. Fake-provider results do not satisfy this gate.

## 16. Security and operational constraints

- Secrets live only in environment variables or approved secret stores and are never committed.
- Development and production configuration are separate.
- PostgreSQL uses a dedicated database and application user and is not exposed publicly.
- Logs are structured, traceable, sanitized, and limited to necessary metadata.
- Provider implementations are replaceable and separately reviewed.
- Apify commercial functionality remains separate from Starpulse proprietary monitoring, history, subscriptions, alerts, and correlation logic.
- No new infrastructure such as Redis, Kafka, Supabase, another VPS, or managed PostgreSQL is introduced without benchmark evidence and separate approval.

## 17. Acceptance and approval gates

This document is the V1 architecture baseline only. Final approval of this design authorizes creation of an implementation plan, not implementation itself. Implementation begins only after the plan and execution approach are separately approved.

Any live provider, DigitalOcean production change, Apify deployment, Store publication, pricing decision, retention deletion, or compaction operation requires its applicable later-phase approval and evidence.
