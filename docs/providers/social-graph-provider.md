# Social Graph Provider Development Guide

This guide describes how to implement a platform provider for the
provider-neutral social-graph collection core. It documents the architecture
that exists after Phase 1 Tasks 1–15, including the corrections approved
during execution. A developer can implement a compliant provider from this
document without reading core internals.

## Scope

- Supported Phase 1 platform identities are exactly `instagram`, `x`, and `tiktok`.
- **YouTube is excluded.** It must not enter the platform contract, provider
  registry, or normalized output. The public API lock and architecture tests
  reject a `youtube` platform identity at typecheck time.
- Phase 1 contains no live provider. `providers/fake-provider` is the reference
  implementation used by the contract suite and the integration tests; the
  same `FakeProvider` class is configured per platform through scenario data,
  never subclassed per platform.
- Providers must not implement account/session automation, login flows,
  private-profile access, or any security, authentication, or rate-limit
  bypass behavior. Such behavior is out of scope permanently, not just in
  Phase 1.

## The `SocialGraphProvider` interface

A provider implements three operations against its own platform:

```ts
interface SocialGraphProvider {
  readonly providerName: string;
  readonly platform: Platform; // "instagram" | "x" | "tiktok"
  readonly capabilities: SocialGraphProviderCapabilities;

  resolveProfile(input: ResolveProfileInput, context: ProviderRequestContext): Promise<ProviderProfile>;
  fetchFollowersPage(input: FetchRelationshipPageInput, context: ProviderRequestContext): Promise<ProviderRelationshipPage>;
  fetchFollowingPage(input: FetchRelationshipPageInput, context: ProviderRequestContext): Promise<ProviderRelationshipPage>;
}
```

- `ResolveProfileInput` carries `{ platform, username }`.
- `FetchRelationshipPageInput` carries `{ profileId, cursor?, limit }`.
- `ProviderRequestContext` carries `{ runId, targetId, signal?: AbortSignal }`.
- Providers must honor the `AbortSignal` in `context`: reject in-flight work
  promptly when it aborts, and never start new work on an already-aborted signal.

## Capability declarations

Capabilities are authoritative declarations. Core and consumers never infer
capabilities from the provider name, platform, or method presence. All seven
fields are required:

```ts
type SocialGraphProviderCapabilities = {
  profileLookup: boolean;      // resolveProfile is supported
  followerCount: boolean;      // profile followerCount values are meaningful
  followingCount: boolean;     // profile followingCount values are meaningful
  followerIdentities: boolean; // fetchFollowersPage is supported
  followingIdentities: boolean;// fetchFollowingPage is supported
  pagination: boolean;         // multi-page cursors are supported
  stableUserIds: boolean;      // platformUserId values are stable identifiers
};
```

Requesting an operation whose capability is `false` terminates with a
`CAPABILITY_UNSUPPORTED` collection summary and makes no provider call.

## Lifecycle: profile resolution happens first

Collection is a two-stage lifecycle:

```text
target request
→ resolve profile
    failure → target-level FAILED summary (no relationship work at all)
    success → real resolved ProviderProfile
→ relationship collections begin (followers, following, or both)
→ each begun collection ends with exactly one terminal summary
```

- Profile resolution occurs **before any relationship collection begins**. A
  profile-resolution failure (for example `PROFILE_NOT_FOUND`) is a
  **target-level** failure: the target stream emits no profile event, no
  relationship event, no collection summary, and invokes no followers or
  following page operation.
- `RelationshipCollectionSummary.sourceProfile` is required and always
  contains the real resolved profile. Providers and core never fabricate a
  profile, invent a `platformUserId`, or create a placeholder to satisfy the
  summary contract.
- Failures after a relationship collection has begun — a relationship-page
  provider error, retry exhaustion, a pagination error, or an external abort
  while the iterator is still consumed — terminate that one collection with
  exactly one terminal summary. In `both` mode the two collections are
  independent: one may complete while the other fails.

## Completeness and termination reasons

Core authoritatively maps every terminal outcome; consumers must not infer
completeness themselves:

| Termination reason | Complete | Error attached | Meaning |
| --- | --- | --- | --- |
| `SOURCE_EXHAUSTED` | `true` | no | the proven end of the source; the only complete outcome |
| `MAX_LIMIT_REACHED` | `false` | no | non-error truncation at the requested `maxResults` |
| `ERROR` | `false` | yes | a normalized provider/collection failure |
| `ABORTED` | `false` | no | external cancellation |

When a max limit is reached, core never fetches another page just to prove
completeness; it inspects only the already-fetched terminal-page remainder;
`SOURCE_EXHAUSTED` wins only when that remainder contains no new unique row.

## Pages and opaque cursors

`ProviderRelationshipPage` returns `{ items, hasMore, nextCursor?, requestMetadata }`.

Valid multi-page pagination uses **opaque cursors**:

- Core treats `nextCursor` as an opaque token. It never parses cursor
  structure and never exposes cursors in public output.
- `hasMore: true` with a valid `nextCursor` and `capabilities.pagination`
  `true` continues to the next page only after every unique current-page row
  has been consumed (native AsyncGenerator backpressure).
- `hasMore: true` with a missing cursor, a repeated cursor, a
  non-progressing cursor, or a next-page signal while `pagination` is `false`
  terminates with a `PAGINATION_FAILED` summary.
- The historical Task 4 interim behavior (treating every `hasMore: true` as a
  pagination failure) was replaced in Task 5 and is not system behavior.

## Cancellation semantics

Two closure paths exist and providers must respect both through the
`AbortSignal` in `context`:

- **External abort** (`AbortSignal` passed by the caller) while the iterator
  remains consumed terminates each active relationship collection with an
  `ABORTED` terminal summary.
- **Consumer `return()`** on the iterator aborts and cleans up all
  outstanding provider work, retry sleeps, timers, and listeners, but the
  consumer that initiated closure receives no later summary — it owns
  recording the aborted run state itself.

No provider request, retry sleep, listener, or timer may leak after closure.

## Error mapping

Providers throw errors carrying normalized fields:

```ts
{ category: PublicCollectionErrorCategory, message: string, retryable: boolean, retryAfterMs?: number }
```

Categories: `PROFILE_NOT_FOUND`, `PROFILE_UNAVAILABLE`,
`PRIVATE_PROFILE_UNSUPPORTED`, `CAPABILITY_UNSUPPORTED`,
`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `SOURCE_TEMPORARILY_UNAVAILABLE`,
`PAGINATION_FAILED`, `INVALID_INPUT`, `UNKNOWN_ERROR`. Unknown thrown objects
normalize to `UNKNOWN_ERROR` with a safe message; provider messages are never
propagated un-sanitized. `retryable: true` marks transient failures eligible
for core retry; `retryAfterMs` (for example from a `RATE_LIMITED` response)
acts as a minimum backoff delay. Never mark permanent failures retryable.

## Retry behavior

Core — not providers — owns retry. Profile resolution and relationship-page
requests go through the same bounded retry orchestration: exponential delay
capped at `maxDelayMs`, symmetric jitter, `retryAfterMs` minimum, injectable
sleep/clock/randomness, abortable at every step, and never retrying permanent
failures. Providers must not add their own retry loops.

## Request metadata and metrics

`ProviderRelationshipPage.requestMetadata` carries
`{ requestId?, statusCode?, attempts, bytesTransferred?, durationMs, proxyBytes? }`.

`attempts` is **diagnostic provider metadata only**. It may describe
provider-internal work core did not invoke; core request counters
(`requestsMade`, `requestsFailed`, `requestsRetried`) are derived exclusively
from core's own retry-orchestration hooks. `bytesTransferred` is summed into
metrics only when the provider reports it; unmeasured bytes stay `null` and
are never fabricated as zero.

## Raw-response containment

Providers may keep raw platform payloads internally, but a raw response never
crosses the provider boundary into normalized output. Normalization copies an
explicit allow-list of fields (`username`, `fullName`, `isPrivate`,
`isVerified`, `profilePicUrl`, `platformUserId`, `platform`); it never
spreads a provider item. Architecture tests verify normalized rows expose no
`rawResponse`/payload/cursor/metadata keys.

## Provider registry

Multi-target collection selects providers only through the
`SocialGraphProviderRegistry` — a `ReadonlyMap<Platform, SocialGraphProvider>`:

```ts
const registry = new Map<Platform, SocialGraphProvider>([
  ["instagram", instagramProvider],
  ["x", xProvider],
  ["tiktok", tiktokProvider],
]);
```

The registry key must equal `provider.platform`; a mismatch or a missing
provider fails only that target with `PROVIDER_UNAVAILABLE` while other
targets continue. There is no provider failover in Phase 1.

## Conformance testing

Every provider — the fake provider today, future live providers — runs
through the same reusable contract suite. Import it in the provider package's
own test file and configure it per platform:

```ts
import { describe } from "vitest";
import { defineSocialGraphProviderContract } from "../../../tests/contracts/provider-contract.js";

describe("my instagram provider contract", () => {
  defineSocialGraphProviderContract({
    platform: "instagram",
    capabilities: { /* the provider's true declarations */ },
    createProvider: () => myInstagramProvider,
  });
});
```

The workspace-level integration suite (`pnpm test:integration`) additionally
exercises the public contract end-to-end across `instagram`, `x`, and
`tiktok`: registry routing, profile resolution and failure, capability
gating, multi-page pagination, backpressure, deduplication, both mode,
retry, target isolation, completeness, metrics, platform-bearing output,
raw-response containment, and YouTube exclusion.

## Platform source expectations (Phase 1)

- **instagram**: follower/following identity lists are provider-dependent;
  there is no official public API for full lists in Phase 1 scope.
- **x**: identity lists are provider-dependent; an official API provider may
  be evaluated in a later phase. Phase 1 implements none.
- **tiktok**: identity lists are provider-dependent; no live provider exists
  in Phase 1.

Live providers, Apify deployment, store listing, pricing, and any production
consumer integration all require separate later approval.
