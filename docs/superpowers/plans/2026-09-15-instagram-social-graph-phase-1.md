# Instagram Social Graph Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully test a provider-neutral, streaming Instagram relationship collection core and deterministic `FakeProvider`, without connecting to Instagram or any production consumer.

**Architecture:** A TypeScript pnpm workspace contains `@instagram-social-graph/core` and `@instagram-social-graph/fake-provider`. Core owns consumer-neutral contracts, orchestration, streaming, pagination, normalization, exact run-scoped deduplication, retry, cancellation, completeness, and metrics; the fake provider implements the same `InstagramProvider` interface and contract suite required of future providers.

**Tech Stack:** Node.js 22, pnpm 11.19.0, TypeScript 5.9.3, Vitest 3.2.4, ESLint 9.35.0, `@typescript-eslint` 8.42.0.

**Spec:** `docs/superpowers/specs/2026-09-15-instagram-social-graph-v1-design.md`

## Global Constraints

- Phase 1 includes only the provider-neutral core, deterministic fake provider, tests, and provider-development documentation.
- Do not add a real Instagram provider, Instagram login/session automation, Apify deployment, Store publication, pricing, PostgreSQL deployment, DigitalOcean changes, Starpulse persistence, scheduler, notifications, billing, UI/dashboard, private-profile access, or control-bypass behavior.
- `packages/instagram-core` must not import Apify SDK, PostgreSQL libraries, Starpulse code, or a provider implementation.
- Consumers depend only on core contracts; provider cursors remain opaque and provider raw responses never appear in normalized output.
- Production collection APIs are `AsyncGenerator`/`AsyncIterable` APIs with backpressure; no full follower/following result list may be accumulated in memory.
- Exact run-scoped deduplication may retain only dedupe keys and counters in memory.
- Every fully consumed relationship stream ends with one authoritative completeness summary.
- `MAX_LIMIT_REACHED` is incomplete but is not an error. Reaching the numeric maximum still yields `SOURCE_EXHAUSTED` when the already-fetched terminal page proves that no unique source relationship was omitted.
- Followers and following are summarized independently.
- One target failure must not unnecessarily terminate other targets.
- `FakeProvider` and every future provider run through the same provider contract test factory.
- Core request counters come only from retry-orchestration hooks: one `requestsMade` per actual core-to-provider invocation, one `requestsFailed` per failed invocation, and one `requestsRetried` per invocation after the first attempt. `ProviderRelationshipPage.requestMetadata.attempts` is diagnostic provider metadata and must never be added to core request counters.
- Follow strict TDD for behavior: write one focused test, run it and observe the expected failure, add the minimal implementation, then verify the focused and workspace test suites.
- Do not start the next task until the current task's completion criteria are satisfied and its commit is created.

## Planned file map

```text
package.json                                  workspace scripts only
pnpm-workspace.yaml                           workspace package discovery
tsconfig.base.json                            shared strict TypeScript settings
eslint.config.mjs                             dependency-boundary and lint rules
packages/instagram-core/package.json          core package manifest
packages/instagram-core/tsconfig.json         core build configuration
packages/instagram-core/src/contracts/*       consumer-neutral public types
packages/instagram-core/src/errors/*          normalized errors and classification
packages/instagram-core/src/normalization/*   raw-item-to-domain mapping only
packages/instagram-core/src/deduplication/*   exact key set only
packages/instagram-core/src/retry/*           bounded retry and abortable delay
packages/instagram-core/src/metrics/*         counters and derived metrics
packages/instagram-core/src/collection/*      profile, relationship, and target streams
packages/instagram-core/src/index.ts          explicit public exports
packages/instagram-core/tests/*               core behavior and architecture tests
providers/fake-provider/package.json          fake provider manifest
providers/fake-provider/src/*                 deterministic scenario implementation
providers/fake-provider/tests/*               shared contract and integration tests
tests/contracts/provider-contract.ts          reusable provider contract suite
tests/integration/fake-provider-flow.test.ts   full Phase 1 stream test
docs/providers/instagram-provider.md           provider authoring contract
```

---

### Task 1: Workspace foundation and consumer-neutral contracts

**Goal:** Establish the strict TypeScript workspace and freeze the public Phase 1 contract names before behavior is implemented.

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `packages/instagram-core/package.json`
- Create: `packages/instagram-core/tsconfig.json`
- Create: `packages/instagram-core/src/contracts/provider.ts`
- Create: `packages/instagram-core/src/contracts/collection.ts`
- Create: `packages/instagram-core/src/contracts/errors.ts`
- Create: `packages/instagram-core/src/contracts/metrics.ts`
- Create: `packages/instagram-core/src/index.ts`
- Test: `packages/instagram-core/tests/contracts.test.ts`

**Interfaces:**

- Consumes: Node 22 built-in `AbortSignal`; no runtime dependencies.
- Produces: `InstagramProvider`, `ProviderProfile`, `ProviderRelationshipItem`, `ProviderRelationshipPage`, `CollectRelationshipRequest`, `CollectTargetsRequest`, `NormalizedRelationship`, `CollectionCompleteness`, `RelationshipCollectionSummary`, `RelationshipStreamEvent`, `TargetStreamEvent`, `PublicCollectionError`, `RelationshipCollectionMetrics`, and `CoreRunMetrics`.

- [ ] **Step 1: Create only workspace test tooling and the failing contract test**

Create the manifests/configuration, then write this compile-time/runtime test before any core contract implementation. The root manifest must be private and contain exactly these workspace commands and tool versions:

```json
{
  "name": "instagram-social-graph",
  "private": true,
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint . --max-warnings=0",
    "test": "pnpm -r test",
    "test:integration": "vitest run tests/integration"
  },
  "devDependencies": {
    "@eslint/js": "9.35.0",
    "@types/node": "22.18.1",
    "@typescript-eslint/eslint-plugin": "8.42.0",
    "@typescript-eslint/parser": "8.42.0",
    "eslint": "9.35.0",
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
```

`pnpm-workspace.yaml` includes `packages/*` and `providers/*`. `tsconfig.base.json` sets `target: "ES2022"`, `module` and `moduleResolution` to `"NodeNext"`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`, and `skipLibCheck: true`. The core package is ESM, private during Phase 1, and has scripts `tsc -p tsconfig.json`, `tsc -p tsconfig.json --noEmit`, and `vitest run` for build, typecheck, and test.

Then add the failing test:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CollectionCompleteness,
  InstagramProvider,
  RelationshipStreamEvent,
} from "../src/index.js";

describe("public contracts", () => {
  it("exposes provider and authoritative stream contracts", () => {
    expectTypeOf<InstagramProvider>().toBeObject();
    expectTypeOf<RelationshipStreamEvent>().toMatchTypeOf<
      | { type: "relationship"; value: unknown }
      | { type: "summary"; value: unknown }
    >();
    const value: CollectionCompleteness = {
      complete: false,
      terminationReason: "MAX_LIMIT_REACHED",
    };
    expect(value.complete).toBe(false);
  });
});
```

- [ ] **Step 2: Verify the test fails for the intended reason**

Run: `pnpm install && pnpm --filter @instagram-social-graph/core test -- contracts.test.ts`

Expected: FAIL because `../src/index.js` and its exported contracts do not exist; dependency installation itself must succeed.

- [ ] **Step 3: Add the minimal contract definitions and explicit exports**

Define the exact provider page contract from the spec, plus these discriminated unions:

```ts
export type RelationshipType = "followers" | "following";
export type ScrapeType = RelationshipType | "both";
export type TerminationReason =
  | "SOURCE_EXHAUSTED"
  | "MAX_LIMIT_REACHED"
  | "ERROR"
  | "ABORTED";

export type RelationshipStreamEvent =
  | { type: "relationship"; value: NormalizedRelationship }
  | { type: "summary"; value: RelationshipCollectionSummary };
```

On `ProviderRelationshipPage.requestMetadata.attempts`, add this contract documentation: `Provider diagnostic metadata only; never added to authoritative core requestsMade, requestsFailed, or requestsRetried counters.`

Use `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, declaration output, ESM, and explicit `.js` import suffixes. Root scripts are `build`, `test`, `typecheck`, and `lint`, each delegated recursively through pnpm.

- [ ] **Step 4: Verify contracts and workspace configuration**

Run: `pnpm --filter @instagram-social-graph/core test -- contracts.test.ts && pnpm typecheck && pnpm lint`

Expected: contract test passes; typecheck and lint exit 0 without warnings.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs packages/instagram-core
git commit -m "feat(core): define provider-neutral contracts"
```

**Completion criteria:** The workspace installs reproducibly, strict typecheck passes, and the core public entry point exports only consumer-neutral contracts with no Apify, PostgreSQL, Starpulse, or provider implementation imports.

---

### Task 2: Reusable provider contract suite and deterministic FakeProvider shell

**Goal:** Make provider conformance executable once and reusable unchanged by the fake provider and all future live providers.

**Files:**

- Create: `tests/contracts/provider-contract.ts`
- Create: `providers/fake-provider/package.json`
- Create: `providers/fake-provider/tsconfig.json`
- Create: `providers/fake-provider/src/scenario.ts`
- Create: `providers/fake-provider/src/fake-provider.ts`
- Create: `providers/fake-provider/src/index.ts`
- Test: `providers/fake-provider/tests/provider-contract.test.ts`

**Interfaces:**

- Consumes: `InstagramProvider` and provider DTOs from `@instagram-social-graph/core`.
- Produces: `defineInstagramProviderContract(createProvider)` and `FakeProvider.fromScenario(scenario)`.

- [ ] **Step 1: Write the shared contract test factory and fake-provider invocation first**

The factory must assert public profile resolution, controlled not-found failure, opaque follower cursor continuation, independent following pages, request metadata, and abort propagation. Start with:

```ts
import { defineInstagramProviderContract } from "../../../tests/contracts/provider-contract.js";
import { FakeProvider } from "../src/index.js";

defineInstagramProviderContract(() =>
  FakeProvider.fromScenario({
    profiles: {
      target: {
        profile: { platformUserId: "p1", username: "target" },
        followers: [[{ platformUserId: "u1", username: "one" }]],
        following: [[{ platformUserId: "u2", username: "two" }]],
      },
    },
  }),
);
```

- [ ] **Step 2: Verify the provider contract fails**

Run: `pnpm --filter @instagram-social-graph/fake-provider test -- provider-contract.test.ts`

Expected: FAIL because `FakeProvider`, scenario parsing, and shared contract implementation do not exist.

- [ ] **Step 3: Implement the smallest deterministic provider**

Use an in-memory scenario map. Encode fake cursors as opaque tokens such as `fake:p1:followers:1`; contract tests compare only round-trip behavior and must never parse the token. Count calls and throw normalized test errors configured by scenario. Do not import collection orchestration into the provider.

- [ ] **Step 4: Verify the shared contract**

Run: `pnpm --filter @instagram-social-graph/fake-provider test -- provider-contract.test.ts && pnpm typecheck`

Expected: all shared provider contract cases pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add tests/contracts providers/fake-provider pnpm-lock.yaml
git commit -m "test(provider): add reusable provider contract suite"
```

**Completion criteria:** `FakeProvider` passes the reusable factory without fake-specific assertions in the factory, and future providers can invoke the same suite by supplying only a factory function.

---

### Task 3: Normalized errors and profile resolution orchestration

**Goal:** Resolve one profile through core and convert provider failures into safe, normalized public errors.

**Files:**

- Create: `packages/instagram-core/src/errors/collection-error.ts`
- Create: `packages/instagram-core/src/errors/normalize-error.ts`
- Create: `packages/instagram-core/src/collection/resolve-profile.ts`
- Modify: `packages/instagram-core/src/index.ts`
- Test: `packages/instagram-core/tests/resolve-profile.test.ts`

**Interfaces:**

- Consumes: `InstagramProvider.resolveProfile`, `ProviderRequestContext`, and error contract types.
- Produces: `CollectionError`, `normalizeProviderError(error)`, and `resolveProfile(request, provider)`.

- [ ] **Step 1: Write failing success and safe-error tests**

```ts
it("resolves a profile without exposing provider fields", async () => {
  const profile = await resolveProfile(request, provider);
  expect(profile).toEqual({ platformUserId: "p1", username: "target" });
  expect(profile).not.toHaveProperty("rawResponse");
});

it("normalizes a not-found failure", async () => {
  await expect(resolveProfile(request, notFoundProvider)).rejects.toMatchObject({
    category: "PROFILE_NOT_FOUND",
    retryable: false,
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- resolve-profile.test.ts`

Expected: FAIL because `resolveProfile` and normalized error classes are absent.

- [ ] **Step 3: Implement minimal profile orchestration and error normalization**

Pass `runId`, `targetId`, and `AbortSignal` to the provider. Copy only allowed profile fields into a new object. Define all spec categories and preserve an internal `cause` without placing it in `toPublicError()`.

- [ ] **Step 4: Verify focused and regression tests**

Run: `pnpm --filter @instagram-social-graph/core test -- resolve-profile.test.ts && pnpm test`

Expected: success and safe-error tests pass; provider contract remains green.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests
git commit -m "feat(core): orchestrate safe profile resolution"
```

**Completion criteria:** Profile resolution passes tracing/cancellation context, exposes only normalized fields, and emits the documented safe error taxonomy.

---

### Task 4: Single-page relationship AsyncGenerator with backpressure

**Goal:** Stream normalized relationship rows immediately and end with one authoritative summary without materializing the complete collection.

**Files:**

- Create: `packages/instagram-core/src/normalization/normalize-relationship.ts`
- Create: `packages/instagram-core/src/collection/collect-relationships.ts`
- Modify: `packages/instagram-core/src/index.ts`
- Test: `packages/instagram-core/tests/collect-relationships-stream.test.ts`

**Interfaces:**

- Consumes: resolved `ProviderProfile`, `CollectRelationshipRequest`, `InstagramProvider`, and provider page DTOs.
- Produces: `collectRelationships(request, provider): AsyncGenerator<RelationshipStreamEvent>`.

- [ ] **Step 1: Write a failing lazy-stream test**

```ts
it("does not request data until the consumer pulls and yields rows before summary", async () => {
  const stream = collectRelationships(request, provider);
  expect(provider.pageCalls).toBe(0);
  const first = await stream.next();
  expect(provider.pageCalls).toBe(1);
  expect(first.value?.type).toBe("relationship");
  const second = await stream.next();
  expect(second.value?.type).toBe("summary");
  expect(second.value).toMatchObject({
    value: { completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" } },
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-relationships-stream.test.ts`

Expected: FAIL because the AsyncGenerator and normalizer do not exist.

- [ ] **Step 3: Implement one-page streaming only**

Fetch one page on the first consumer pull, normalize and yield each item individually, then yield exactly one `SOURCE_EXHAUSTED` summary when `hasMore` is false. Copy allow-listed fields; never spread a provider item into output. Assign one-based positions and an injected observation clock.

- [ ] **Step 4: Verify backpressure and output shape**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-relationships-stream.test.ts && pnpm typecheck`

Expected: provider is lazy, rows precede summary, and raw provider fields are absent.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests
git commit -m "feat(core): stream normalized relationship rows"
```

**Completion criteria:** The first production collection API is an AsyncGenerator, honors pull-based backpressure, and retains no full-result array.

---

### Task 5: Opaque multi-page pagination and anomaly detection

**Goal:** Continue through opaque cursors while terminating safely on invalid pagination behavior.

**Files:**

- Create: `packages/instagram-core/src/collection/pagination-state.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/pagination.test.ts`

**Interfaces:**

- Consumes: `ProviderRelationshipPage.nextCursor` and `hasMore` without parsing cursor contents.
- Produces: streamed rows across pages and `PAGINATION_FAILED` terminal summaries for missing, repeated, or non-progressing cursors.

- [ ] **Step 1: Write failing pagination tests**

```ts
it("requests the next page only after current-page rows are consumed", async () => {
  const iterator = collectRelationships(request, twoPageProvider);
  await iterator.next();
  expect(twoPageProvider.pageCalls).toBe(1);
  await iterator.next();
  expect(twoPageProvider.pageCalls).toBe(2);
});

it.each(["missing", "repeated"] as const)(
  "ends with PAGINATION_FAILED for a %s next cursor",
  async (mode) => {
    const events = await consume(makeAnomalousStream(mode));
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "ERROR",
        error: { category: "PAGINATION_FAILED" } } },
    });
  },
);
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- pagination.test.ts`

Expected: the two-page case stops after page one or cursor anomaly cases do not produce `PAGINATION_FAILED`.

- [ ] **Step 3: Implement minimal pagination state**

Keep only current cursor, a `Set<string>` of seen cursor tokens, page ordinal, and counters. Fetch a next page only after all unique current-page items have been yielded. Treat `hasMore: true` without `nextCursor` and any repeated cursor as terminal normalized pagination errors.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- pagination.test.ts && pnpm test`

Expected: multi-page order and lazy fetching pass; anomalies end with exactly one error summary.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src/collection packages/instagram-core/tests/pagination.test.ts
git commit -m "feat(core): paginate through opaque cursors"
```

**Completion criteria:** Cursor content is never parsed or exposed, pagination remains backpressured, and all specified non-progress anomalies terminate deterministically.

---

### Task 6: Exact streaming deduplication

**Goal:** Remove page-overlap duplicates exactly while retaining only keys and counters.

**Files:**

- Create: `packages/instagram-core/src/deduplication/relationship-key.ts`
- Create: `packages/instagram-core/src/deduplication/exact-deduplicator.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/deduplication.test.ts`

**Interfaces:**

- Consumes: source profile ID, relationship type, optional related platform ID, and username.
- Produces: `relationshipDedupeKey(input)` and `ExactDeduplicator.accept(key): boolean`.

- [ ] **Step 1: Write failing stable-ID, fallback, and position tests**

```ts
it("deduplicates overlapping pages by stable platform ID", async () => {
  const rows = relationships(await consume(overlappingPagesStream));
  expect(rows.map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
  expect(rows.map((row) => row.position)).toEqual([1, 2, 3]);
});

it("uses source, relationship, and normalized username only when ID is absent", () => {
  expect(relationshipDedupeKey(base({ username: " User " })))
    .toBe(relationshipDedupeKey(base({ username: "user" })));
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- deduplication.test.ts`

Expected: duplicate rows are emitted or key helpers are missing.

- [ ] **Step 3: Implement the exact key set**

Prefer `relationship:userId`; otherwise use `sourceUserId:relationship:username.toLocaleLowerCase("en-US").trim()`. Increment positions only after `accept` returns true. Increment raw, unique, and duplicate metrics at their exact decision points. Do not retain normalized relationship objects in the deduplicator.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- deduplication.test.ts && pnpm test`

Expected: duplicates disappear, positions remain contiguous, and fallback keys do not cross source or relationship boundaries.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/deduplication.test.ts
git commit -m "feat(core): deduplicate streamed relationships exactly"
```

**Completion criteria:** Exact overlap removal works by stable ID and fallback identity, with memory restricted to cursor state, keys, and counters rather than full results.

---

### Task 7: Exact maximum-result termination

**Goal:** Emit no more than the requested number of unique rows while distinguishing proven source exhaustion from a true truncating maximum.

**Files:**

- Modify: `packages/instagram-core/src/contracts/collection.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/max-results.test.ts`

**Interfaces:**

- Consumes: `CollectRelationshipRequest.maxResults?: number`.
- Produces: exact output limits, `SOURCE_EXHAUSTED` when the already-fetched terminal page proves no unique row was omitted, and non-error `MAX_LIMIT_REACHED` only when source relationships remain unobserved or un-emitted.

- [ ] **Step 1: Write failing boundary tests**

```ts
it("A: reports MAX_LIMIT_REACHED when the source has more results than max", async () => {
  const provider = providerWithPages([
    page([row("u1"), row("u2"), row("u3")], { hasMore: true, nextCursor: "opaque-next" }),
    terminalPage([row("u4")]),
  ]);
  const events = await consume(collectRelationships(
    { ...request, maxResults: 3 },
    provider,
  ));
  expect(relationships(events)).toHaveLength(3);
  expect(provider.pageCalls).toBe(1);
  expect(completeness(events)).toEqual({
    complete: false,
    terminationReason: "MAX_LIMIT_REACHED",
  });
});

it("B: reports SOURCE_EXHAUSTED when a terminal page contains exactly max unique rows", async () => {
  const events = await consume(collectRelationships(
    { ...request, maxResults: 3 },
    providerWithPages([terminalPage([row("u1"), row("u2"), row("u3")])]),
  ));
  expect(relationships(events)).toHaveLength(3);
  expect(completeness(events)).toEqual({
    complete: true,
    terminationReason: "SOURCE_EXHAUSTED",
  });
});

it("C: reports MAX_LIMIT_REACHED when a terminal page has a later unique row", async () => {
  const events = await consume(collectRelationships(
    { ...request, maxResults: 3 },
    providerWithPages([terminalPage([
      row("u1"), row("u2"), row("u3"), row("u4"),
    ])]),
  ));
  expect(relationships(events).map((row) => row.userId)).toEqual(["u1", "u2", "u3"]);
  expect(completeness(events).terminationReason).toBe("MAX_LIMIT_REACHED");
});

it("D: reports SOURCE_EXHAUSTED when terminal-page remainder contains only duplicates", async () => {
  const events = await consume(collectRelationships(
    { ...request, maxResults: 3 },
    providerWithPages([terminalPage([
      row("u1"), row("u2"), row("u3"), row("u2"), row("u1"),
    ])]),
  ));
  expect(relationships(events)).toHaveLength(3);
  expect(completeness(events)).toEqual({
    complete: true,
    terminationReason: "SOURCE_EXHAUSTED",
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- max-results.test.ts`

Expected: at least one of cases A-D reports the wrong terminal reason, emits too many rows, or fetches another page after a true max boundary.

- [ ] **Step 3: Implement the unique-row boundary**

Validate `maxResults` as a positive safe integer at the public boundary. Count only unique emitted rows. When the max-th row is emitted:

1. If the current page has `hasMore: true`, stop without another network request and report `MAX_LIMIT_REACHED`.
2. If the current page is terminal, inspect only its already-fetched remaining items through the same dedupe-key logic without emitting them.
3. If any remaining item has a new dedupe key, report `MAX_LIMIT_REACHED`.
4. If the remainder is empty or contains only duplicate keys, report `SOURCE_EXHAUSTED`.

Never fetch another page solely to decide completeness after reaching the maximum. Do not add inspected-but-unemitted unique rows to the accepted dedupe set or unique-output metrics; raw-item accounting still reflects every item received in the already-fetched page.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- max-results.test.ts && pnpm test`

Expected: cases A-D pass, no more than `maxResults` rows are emitted, and no network page is fetched after a true maximum boundary.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/max-results.test.ts
git commit -m "feat(core): enforce exact relationship limits"
```

**Completion criteria:** Limits count unique emitted rows; source exhaustion wins only when the already-fetched terminal page proves no unique omission; true truncation is non-error incomplete; and no extra network page is fetched to determine completeness.

---

### Task 8: Bounded retry with injectable backoff

**Goal:** Retry only transient provider operations with deterministic limits, backoff, jitter, and accounting.

**Files:**

- Create: `packages/instagram-core/src/retry/retry-operation.ts`
- Create: `packages/instagram-core/src/retry/retry-policy.ts`
- Modify: `packages/instagram-core/src/collection/resolve-profile.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/retry.test.ts`

**Interfaces:**

- Consumes: `RetryPolicy { maxAttempts, baseDelayMs, maxDelayMs, jitterRatio }`, `sleep(ms, signal)`, and normalized retryability.
- Produces: `retryOperation(operation, options)` with `onAttempt` and `onRetry` hooks.

- [ ] **Step 1: Write failing retry tests**

```ts
it("retries a transient operation up to success", async () => {
  const delays: number[] = [];
  const result = await retryOperation(failsTwiceThenSucceeds, {
    policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
    sleep: async (ms) => { delays.push(ms); },
  });
  expect(result).toBe("ok");
  expect(delays).toEqual([100, 200]);
});

it("does not retry a permanent error", async () => {
  await expect(retryOperation(permanentFailure, options)).rejects.toMatchObject({ retryable: false });
  expect(attempts).toBe(1);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- retry.test.ts`

Expected: `retryOperation` is absent and collection paths make only direct provider calls.

- [ ] **Step 3: Implement minimal retry and wire both provider operations**

Count the first call as attempt one. Cap exponential delay, apply injected random jitter, honor a normalized `retryAfterMs` minimum, and stop at `maxAttempts`. Invoke the same helper for profile and page requests.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- retry.test.ts && pnpm test`

Expected: retry timing, exhaustion, permanent errors, and call counters pass deterministically with no real sleep.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/retry.test.ts
git commit -m "feat(core): retry transient provider failures"
```

**Completion criteria:** Retries are bounded, deterministic under tests, shared by resolution and paging, and never retry permanent failures.

---

### Task 9: Cancellation and consumer-initiated iterator closure

**Goal:** Propagate `AbortSignal` through requests and backoff, and release generator resources on cancellation or early consumer closure.

**Files:**

- Create: `packages/instagram-core/src/retry/abortable-delay.ts`
- Modify: `packages/instagram-core/src/retry/retry-operation.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/cancellation.test.ts`

**Interfaces:**

- Consumes: `CollectRelationshipRequest.signal` and iterator `return()`.
- Produces: an `ABORTED` summary when an externally aborted iterator is still consumed, and internal cleanup when the consumer closes the iterator.

- [ ] **Step 1: Write failing abort tests**

```ts
it("ends an externally aborted consumed stream with ABORTED", async () => {
  const controller = new AbortController();
  const iterator = collectRelationships({ ...request, signal: controller.signal }, blockingProvider);
  const pending = iterator.next();
  controller.abort();
  const final = await pending;
  expect(final.value).toMatchObject({
    type: "summary",
    value: { completeness: { complete: false, terminationReason: "ABORTED" } },
  });
});

it("calls provider cleanup when the consumer closes early", async () => {
  const iterator = collectRelationships(request, provider);
  await iterator.next();
  await iterator.return(undefined);
  expect(provider.observedAbort).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- cancellation.test.ts`

Expected: pending work does not abort or iterator closure leaves provider work active.

- [ ] **Step 3: Implement abort propagation and cleanup**

Create an internal `AbortController`, link it to the caller signal, pass its signal to all provider calls and delays, and abort it in the generator `finally` block. Convert abort failures into `ABORTED` only when the iterator remains open for the summary; do not yield after consumer `return()`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- cancellation.test.ts && pnpm test`

Expected: provider calls and retry delay stop promptly; no relationship appears after terminal summary.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/cancellation.test.ts
git commit -m "feat(core): propagate collection cancellation"
```

**Completion criteria:** External abort and consumer closure follow the approved semantic distinction, with no leaked request or timer.

---

### Task 10: Authoritative completeness state machine

**Goal:** Centralize all terminal outcomes so every fully consumed relationship collection ends with exactly one valid summary.

**Files:**

- Create: `packages/instagram-core/src/collection/completeness.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Test: `packages/instagram-core/tests/completeness.test.ts`

**Interfaces:**

- Consumes: source terminal state, max boundary, normalized error, or abort.
- Produces: `completeCollection(outcome): CollectionCompleteness` and exactly one final summary event.

- [ ] **Step 1: Write the exhaustive failing table test**

```ts
it.each([
  ["source", { complete: true, terminationReason: "SOURCE_EXHAUSTED" }],
  ["max", { complete: false, terminationReason: "MAX_LIMIT_REACHED" }],
  ["error", { complete: false, terminationReason: "ERROR" }],
  ["abort", { complete: false, terminationReason: "ABORTED" }],
] as const)("maps %s to authoritative completeness", (outcome, expected) => {
  expect(completeCollection(makeOutcome(outcome))).toMatchObject(expected);
});

it("emits exactly one summary and no later relationship", async () => {
  const events = await consume(errorAfterRowsStream);
  expect(events.filter((event) => event.type === "summary")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("summary");
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- completeness.test.ts`

Expected: terminal logic is duplicated or one outcome violates the approved mapping.

- [ ] **Step 3: Implement the state machine and remove duplicate terminal branches**

Allow only one transition from `RUNNING` to a terminal outcome. Attach `PublicCollectionError` only to `ERROR`. Assert that `SOURCE_EXHAUSTED` is the sole complete outcome and `MAX_LIMIT_REACHED` is non-error incomplete.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- completeness.test.ts && pnpm test && pnpm typecheck`

Expected: all four mappings and terminal-event invariants pass.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/completeness.test.ts
git commit -m "feat(core): centralize completeness outcomes"
```

**Completion criteria:** Core, not consumers, authoritatively maps every normal terminal path; exactly one summary closes every fully consumed relationship stream.

---

### Task 11: Both mode with independent relationship summaries

**Goal:** Collect followers and following for one target without allowing one relationship failure to erase the other's result.

**Files:**

- Create: `packages/instagram-core/src/collection/collect-target.ts`
- Modify: `packages/instagram-core/src/index.ts`
- Test: `packages/instagram-core/tests/collect-target.test.ts`

**Interfaces:**

- Consumes: `CollectTargetRequest { scrapeType, maxFollowers?, maxFollowing? }` and `collectRelationships`.
- Produces: `collectTarget(request, provider): AsyncGenerator<TargetStreamEvent>` and `TargetCollectionSummary`.

- [ ] **Step 1: Write failing both-mode independence test**

```ts
it("summarizes followers and following independently", async () => {
  const events = await consume(collectTarget(bothRequest, followingFailsProvider));
  expect(collectionSummary(events, "followers").completeness)
    .toEqual({ complete: true, terminationReason: "SOURCE_EXHAUSTED" });
  expect(collectionSummary(events, "following").completeness)
    .toMatchObject({ complete: false, terminationReason: "ERROR" });
  expect(targetSummary(events).status).toBe("PARTIAL");
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-target.test.ts`

Expected: `collectTarget` is absent or following failure terminates the full target stream.

- [ ] **Step 3: Implement sequential per-target relationship orchestration**

Resolve the profile once. For `both`, run followers then following as independent relationship streams and forward their events with target context. Sequential execution is the V1 minimum and naturally bounds memory. Derive `SUCCESS`, `PARTIAL`, or `FAILED` only from requested collection summaries.

- [ ] **Step 4: Verify all modes**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-target.test.ts && pnpm test`

Expected: followers-only, following-only, both success, and one-side failure pass with independent summaries.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/collect-target.test.ts
git commit -m "feat(core): collect both relationship types independently"
```

**Completion criteria:** Profile resolves once, selected modes are respected, and both-mode always exposes separate authoritative summaries.

---

### Task 12: Bounded multi-target streaming orchestration

**Goal:** Process multiple targets with bounded concurrency and isolate target failures while preserving downstream backpressure.

**Files:**

- Create: `packages/instagram-core/src/collection/collect-targets.ts`
- Create: `packages/instagram-core/src/collection/bounded-event-queue.ts`
- Modify: `packages/instagram-core/src/index.ts`
- Test: `packages/instagram-core/tests/collect-targets.test.ts`

**Interfaces:**

- Consumes: `CollectTargetsRequest { targets, concurrency }` and `collectTarget`.
- Produces: `collectTargets(request, provider): AsyncGenerator<TargetStreamEvent>`.

- [ ] **Step 1: Write failing isolation and backpressure tests**

```ts
it("continues two successful targets when a third fails", async () => {
  const events = await consume(collectTargets(threeTargetRequest, provider));
  expect(targetStatuses(events)).toEqual(new Map([
    ["a", "SUCCESS"], ["b", "FAILED"], ["c", "SUCCESS"],
  ]));
});

it("never buffers more than the configured event capacity", async () => {
  const stream = collectTargets({ ...request, concurrency: 2, eventBufferSize: 2 }, provider);
  await pullSlowly(stream);
  expect(provider.maxUnconsumedRows).toBeLessThanOrEqual(2);
});

it("aborts producers without requiring summaries when the consumer closes early", async () => {
  const stream = collectTargets(request, blockingProvider);
  await stream.next();
  await stream.return(undefined);
  expect(blockingProvider.activeTargetCount).toBe(0);
  expect(blockingProvider.pendingOperationCount).toBe(0);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-targets.test.ts`

Expected: batch orchestration is absent, a failure escapes globally, or producer progress is unbounded.

- [ ] **Step 3: Implement bounded scheduling**

Validate unique non-empty targets and positive concurrency. Use at most `concurrency` active target iterators and a queue capped by `eventBufferSize`; producers await capacity. Catch target-level normalized failures, emit a failed target summary, and continue remaining targets. Every target receives one terminal target summary when the batch iterator is consumed normally to completion.

If the consumer closes the batch iterator early with `return()`, abort all active target iterators, wake and clean up blocked queue producers, remove signal listeners, and settle internal producer promises. Do not attempt to yield subsequent target summaries. The consumer that initiated closure owns recording the aborted outer-run state.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- collect-targets.test.ts && pnpm test`

Expected: concurrency cap, buffer cap, failure isolation, event context, normal-completion summaries, and early-closure cleanup all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/collect-targets.test.ts
git commit -m "feat(core): stream targets with bounded concurrency"
```

**Completion criteria:** Multi-target work is bounded and backpressured; every target is summarized when normal batch consumption completes; early consumer closure aborts and cleans all producers without requiring later summaries; and one target failure does not unnecessarily terminate peers.

---

### Task 13: Core metrics and derived rates

**Goal:** Measure actual core activity consistently across success, retry, duplicate, truncation, error, and abort paths.

**Files:**

- Create: `packages/instagram-core/src/metrics/relationship-metrics.ts`
- Create: `packages/instagram-core/src/metrics/run-metrics.ts`
- Create: `packages/instagram-core/src/metrics/derived-metrics.ts`
- Modify: `packages/instagram-core/src/collection/resolve-profile.ts`
- Modify: `packages/instagram-core/src/collection/collect-relationships.ts`
- Modify: `packages/instagram-core/src/collection/collect-targets.ts`
- Test: `packages/instagram-core/tests/metrics.test.ts`

**Interfaces:**

- Consumes: injected monotonic clock, retry-orchestration hooks, provider byte/duration metadata, dedupe decisions, and terminal summaries. `ProviderRelationshipPage.requestMetadata.attempts` remains diagnostic only.
- Produces: immutable `RelationshipCollectionMetrics`, `CoreRunMetrics`, and `derivePerThousand(metrics)`.

- [ ] **Step 1: Write failing accounting tests**

```ts
it("counts raw, unique, duplicate, failed, and retried work", async () => {
  const summary = await finalSummary(metricsScenarioStream);
  expect(summary.metrics).toMatchObject({
    rawItemsReceived: 4,
    uniqueItemsProduced: 3,
    duplicatesRemoved: 1,
    requestsMade: 3,
    requestsFailed: 1,
    requestsRetried: 1,
    bytesTransferred: 600,
  });
});

it("does not add provider diagnostic attempts to core request counters", async () => {
  const summary = await finalSummary(streamWhoseSingleSuccessfulPageReports({ attempts: 7 }));
  expect(summary.metrics).toMatchObject({
    requestsMade: 1,
    requestsFailed: 0,
    requestsRetried: 0,
  });
});

it("returns null per-thousand rates for zero results", () => {
  expect(derivePerThousand(zeroMetrics)).toEqual({
    requestsPer1000Results: null,
    secondsPer1000Results: null,
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- metrics.test.ts`

Expected: counters are zero/incomplete or derived functions do not exist.

- [ ] **Step 3: Implement event-point accounting**

Use retry orchestration hooks as the only source of truth for core request counters:

- increment `requestsMade` once for every actual core-to-provider operation invocation;
- increment `requestsFailed` once when that invocation throws or returns a failed attempt;
- increment `requestsRetried` once for every invocation after the first attempt of the same logical operation.

Do not add `ProviderRelationshipPage.requestMetadata.attempts` to any of these counters. That field is provider diagnostic metadata only and may describe provider-internal work that core did not invoke. Future hidden subrequest metrics require a separate contract and are outside Phase 1.

Increment raw items on page receipt, unique/duplicates at dedupe, and returned counts on yield. Sum measurable bytes only; represent unavailable bytes separately rather than as zero. Use injected monotonic time for runtime.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- metrics.test.ts && pnpm test`

Expected: exact counts pass for success, retry, and partial paths; diagnostic `attempts: 7` still counts as one successful core invocation; zero-result derived values are null.

- [ ] **Step 5: Commit**

```bash
git add packages/instagram-core/src packages/instagram-core/tests/metrics.test.ts
git commit -m "feat(core): measure collection activity"
```

**Completion criteria:** Metrics describe only observed work, retry hooks are the sole authoritative source for core invocation counters, provider diagnostic attempts cannot double-count requests, incomplete collections retain metrics, and no Apify compute, proxy, or cost values are invented.

---

### Task 14: Full FakeProvider Phase 1 integration suite

**Goal:** Prove the complete provider-neutral flow with deterministic multi-page, multi-mode, multi-target scenarios.

**Files:**

- Create: `tests/integration/fake-provider-flow.test.ts`
- Modify: `providers/fake-provider/src/scenario.ts`
- Modify: `providers/fake-provider/src/fake-provider.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: public exports from core and fake-provider only.
- Produces: workspace-level `test:integration` script and black-box acceptance coverage.

- [ ] **Step 1: Write the failing black-box scenario**

```ts
it("streams a mixed three-target run with authoritative summaries", async () => {
  const events = await consume(collectTargets(request, FakeProvider.fromScenario(scenario)));
  expect(rowsFor(events, "alpha", "followers")).toHaveLength(3);
  expect(rowsFor(events, "alpha", "following")).toHaveLength(2);
  expect(summaryFor(events, "beta").status).toBe("FAILED");
  expect(summaryFor(events, "gamma").status).toBe("SUCCESS");
  expect(events.some(containsRawProviderObject)).toBe(false);
});
```

Scenario requirements: `alpha` has overlapping two-page followers and following; `beta` is not found; `gamma` has one transient page failure then succeeds. Consume one event at a time and assert the second page is not requested early.

- [ ] **Step 2: Verify failure**

Run: `pnpm test:integration`

Expected: FAIL until the fake scenario supports the required transient schedule and black-box script is wired.

- [ ] **Step 3: Add only missing fake scenario controls**

Extend scenario data with per-operation failure schedules and observable call records. Keep them in the fake package's testing API; do not add fake-only concepts to core contracts.

- [ ] **Step 4: Verify the full acceptance flow**

Run: `pnpm test:integration && pnpm test && pnpm typecheck && pnpm lint`

Expected: all black-box acceptance assertions and the complete workspace suite pass without warnings.

- [ ] **Step 5: Commit**

```bash
git add tests/integration providers/fake-provider package.json pnpm-lock.yaml
git commit -m "test: cover the provider-neutral collection flow"
```

**Completion criteria:** One black-box suite demonstrates pagination, both mode, dedupe, retry, target isolation, streaming/backpressure, completeness, metrics, and raw-object containment.

---

### Task 15: Architectural dependency and public API enforcement

**Goal:** Make the approved module boundaries executable so later consumer or provider work cannot silently couple core.

**Files:**

- Create: `packages/instagram-core/tests/architecture.test.ts`
- Create: `packages/instagram-core/tests/public-api.test.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**

- Consumes: source import graph and `packages/instagram-core/src/index.ts` exports.
- Produces: tests/lint rules that reject forbidden dependencies and provider raw types in public normalized output.

- [ ] **Step 1: Write a failing architecture test with a temporary forbidden fixture**

```ts
it("forbids consumer and provider implementation imports from core", async () => {
  const imports = await scanImports("packages/instagram-core/src");
  expect(imports).not.toContainEqual(expect.stringMatching(/apify|pg|starpulse|fake-provider/));
});

it("exports no provider raw response field", () => {
  const row: NormalizedRelationship = normalizedFixture;
  expect(Object.keys(row)).not.toContain("rawResponse");
});
```

Before implementation, add a test fixture import of `@instagram-social-graph/fake-provider` under `packages/instagram-core/tests/fixtures/forbidden-import.ts` and confirm the scanner detects it; then delete the fixture before the green run.

- [ ] **Step 2: Verify the test can fail for the intended violation**

Run: `pnpm --filter @instagram-social-graph/core test -- architecture.test.ts`

Expected: FAIL naming `fake-provider` from the deliberate fixture, proving the guard detects a real forbidden edge.

- [ ] **Step 3: Remove the deliberate violation and enforce boundaries**

Limit scanning to production source after the failure proof, add ESLint restricted-import rules for `apify`, `pg`, Starpulse paths, and provider implementation paths, and lock the explicit public API export list in `public-api.test.ts`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @instagram-social-graph/core test -- architecture.test.ts public-api.test.ts && pnpm lint && pnpm test`

Expected: boundary tests pass, deliberate fixture is absent, and no forbidden package is present in core dependencies.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs packages/instagram-core/tests
git commit -m "test(core): enforce architecture boundaries"
```

**Completion criteria:** Automated checks reject Apify, PostgreSQL, Starpulse, and provider-implementation coupling and lock the intended core public surface.

---

### Task 16: Provider development documentation and Phase 1 verification

**Goal:** Document how a compliant future provider is implemented and run the complete Phase 1 acceptance gate.

**Files:**

- Create: `docs/providers/instagram-provider.md`
- Create: `docs/phase-1-verification.md`
- Create: `README.md`
- Test: `packages/instagram-core/tests/documentation-contract.test.ts`

**Interfaces:**

- Consumes: approved spec, actual public exports, shared provider contract factory, and verification scripts.
- Produces: a provider authoring guide and an evidence template for Phase 1 verification.

- [ ] **Step 1: Write a failing documentation-contract test**

```ts
it("documents every required provider operation and contract-suite entrypoint", async () => {
  const guide = await readFile("docs/providers/instagram-provider.md", "utf8");
  for (const term of [
    "resolveProfile",
    "fetchFollowersPage",
    "fetchFollowingPage",
    "defineInstagramProviderContract",
    "opaque cursor",
    "AbortSignal",
    "raw response",
  ]) expect(guide).toContain(term);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @instagram-social-graph/core test -- documentation-contract.test.ts`

Expected: FAIL because the provider guide does not exist.

- [ ] **Step 3: Write the minimum complete provider guide and repository README**

Document interface signatures, allowed normalized fields, opaque cursor rules, error mapping, retryability, abort duties, request metadata, raw-response containment, the shared contract test invocation, and the explicit prohibition on login/security/rate-limit bypasses. `docs/phase-1-verification.md` must list commands and blank evidence headings only where values are generated during execution; it must not claim tests passed before they run.

- [ ] **Step 4: Run the Phase 1 verification gate and record actual evidence**

Run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
git diff --check
```

Expected: every command exits 0 with no warnings. Record the date, commit, command, and actual pass counts in `docs/phase-1-verification.md`; never substitute estimates.

- [ ] **Step 5: Re-run documentation and workspace verification after recording evidence**

Run: `pnpm --filter @instagram-social-graph/core test -- documentation-contract.test.ts && pnpm test && git diff --check`

Expected: documentation contract and all regression tests pass; diff check is silent.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/providers docs/phase-1-verification.md packages/instagram-core/tests/documentation-contract.test.ts
git commit -m "docs: document provider development and Phase 1 verification"
```

**Completion criteria:** A developer can implement a future provider without reading core internals, shared conformance testing is explicit, and the recorded Phase 1 gate contains only fresh measured evidence.

## Phase 1 final gate

Phase 1 may be declared complete only when Tasks 1–16 are committed, the final verification commands pass from a clean checkout, the working tree is clean, and the implementation contains no out-of-scope consumer, production infrastructure, or live Instagram integration. Completion of Phase 1 does not authorize Phase 2, any live provider work, deployment, pricing, or publication.
