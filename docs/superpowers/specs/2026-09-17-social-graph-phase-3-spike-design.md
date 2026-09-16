# Social Graph Phase 3 — Provider Spike & Selection Design

**Status:** Pending owner approval (P3-T1 deliverable)
**Baseline:** V1 spec §4.1/§15 Phase 3; Phase 2 complete (actor deployed, empty registry)
**Branch:** `feature/social-graph-phase-3` (from Phase 2 HEAD `f91129f`)
**Owner directive (2026-09-17, revised same day):**
if an Instagram or TikTok scrape attempt gets caught, do NOT stop —
autonomously process the four escalation rungs in order:
(1) header rotation, (2) residential proxy, (3) provider swap,
(4) platform rotation. Rungs 1–3 are fully autonomous (existing quotas
only). Rungs 4–5-class steps that spend money or create external
commitments (renting Store actors, signing up for the X official API)
still require explicit owner approval first. Report per-platform verdicts
after the ladder completes.

## 1. Objective

Answer the owner's decisive question first: **can we collect follower/following
identity lists from Instagram and TikTok anonymously (no login, no session,
no bypass) — and if yes, at what success rate and cost?** Only after a
viable verdict does Phase 3 continue into provider implementation and the
spec's 100/1k/5k/10k benchmarks.

## 2. "Got caught" taxonomy (defined before any request)

Every probe response is classified exactly once:

| Verdict | Signals | Consequence |
| --- | --- | --- |
| `OK` | Per-step success: RESOLVE step = 200 + expected profile signals (counts / secUid, no login wall); LIST step = 200 + parseable follower/following identity rows | continue within budget |
| `CAUGHT` | HTTP 401/403; 429 with block headers; redirect to login; challenge/CAPTCHA page; 200 with login-wall HTML instead of data; empty payload with block signatures | record evidence, end the current rung, advance to the next escalation rung autonomously (rungs 1–3); money/commitment rungs ask the owner |
| `SOFT_LIMITED` | 429/5xx with `Retry-After` and no block signature | treat as caught: end the current rung, advance the ladder (one polite retry inside the same rung is allowed when `Retry-After` is honored) |
| `NOT_FOUND` | 404 / profile-missing payload | pick a different PUBLIC test profile (does not count as caught; one re-pick allowed) |
| `NETWORK_ERROR` | DNS/TLS/timeout | report, do not retry |

Ambiguous responses default to `CAUGHT`. Classification is a pure function
unit-tested in P3-T2 before any live request exists.

## 3. Spike protocol (per platform)

- **Request budget**: Instagram ≤ 3 requests TOTAL; TikTok ≤ 4 requests
  TOTAL (resolve + list pages + any NOT_FOUND re-pick all count against the
  same total). The budget is enforced in code — the probe tool refuses to
  exceed it.
- **Single-shot per attempt**: each request is sent once; a `CAUGHT`/`SOFT_LIMITED`
  verdict ends the current RUNG (not the spike) and advances the ladder.
- **Escalation ladder** (each rung has its own bounded budget, re-using the
  classifier and evidence recorder):
  1. Direct request, plain browser-like headers (weakest rung).
  2. Header rotation: vary realistic browser header sets between attempts.
  3. Residential proxy: route through the Apify plan's included residential
     proxy quota (10 GB/month) — no additional spend.
  4. Provider swap: rent a compliant Store actor — SPENDS credit and is
     Creator-plan-restricted (Universal Actors only) → owner approval first.
  5. Platform rotation: evaluate the X official API — external signup and
     possibly paid → owner approval first.
- **Origin**: the droplet's own IP (no Apify datacenter proxy) so the probe
  cannot pollute platform views of Apify IP ranges.
- **Test subjects**: well-known large PUBLIC accounts, one per platform.
- **Evidence**: every request/response (status, headers subset, body
  excerpt, timing) recorded to a local JSON evidence file, sanitized of any
  secret-looking content; verdict + rationale per response.
- **No login, no private profiles, no rate-limit bypass, no account
  automation** — red lines from the V1 spec §1, unchanged.

### 3.1 Desk-research prior (recorded 2026-09-17, no requests made)

- Instagram: follower COUNTS remain publicly visible; follower LISTS are
  widely reported login-walled in 2026 — the spike expects `CAUGHT` unless
  an anonymous GraphQL/embed path still responds.
- TikTok: `www.tiktok.com/api/user/list/` (secUid-parameterized) has a
  history of anonymous access; signature enforcement (X-Bogus/msToken)
  varies — a genuine unknown worth one bounded probe.

## 4. Probe targets

| Platform | Step 1 (resolve) | Step 2+ (list) | Budget |
| --- | --- | --- | --- |
| Instagram | profile page GET (public HTML) → extract embedded identity/count signals | GraphQL follower-list query with page tokens if step 1 exposes any anonymous path | ≤ 3 |
| TikTok | profile page GET → extract `secUid` | `GET /api/user/list/` (listType=followers/following, secUid, cursor) | ≤ 4 |

Exact URLs and payloads are fixed in the probe script and listed in the
shot plan the owner approves before P3-T3/T4 fire.

## 5. Task plan

- **P3-T1** This design + task plan + documentation-contract test.
- **P3-T2** Probe tooling: `spike/probe.mjs` (bounded fetcher + classifier
  + evidence recorder) with pure-function unit tests; zero live requests;
  budget guard proven by test. Ladder + review + commit.
- **P3-T3 ⛔** Instagram spike (live): owner approves the exact shot plan
  once; then the escalation ladder runs autonomously rung 1→3 without
  stopping on caught; rungs 4–5 pause for owner approval if reached.
  Per-rung budgets: rung 1 ≤ 3 requests; rung 2 ≤ 6; rung 3 ≤ 6.
- **P3-T4 ⛔** TikTok spike (live): same structure (rung 1 ≤ 4, rung 2 ≤ 8,
  rung 3 ≤ 8). One platform exhausting its ladder does not stop the other.
- **P3-T5** Findings report: per-platform per-rung verdicts + evidence +
  next-step options; owner picks direction.
- **P3-T6+ (conditional)** Only on a viable verdict + owner approval:
  live provider implementation through the Phase 1 contract suite,
  provider review criteria (legal, platform-policy, data quality,
  stable-ID, cost, eligibility, operational — spec §15), then
  100/1k/5k/10k benchmarks through the Phase 2 actor, cost model against
  the confirmed $500 credit, and wiring the provider into the deployed
  actor's registry.

## 6. Phase gate (unchanged pattern)

All tasks committed → clean-checkout verification on the droplet → evidence
document with measured results only → independent phase review → owner
approval before Phase 4. A caught outcome is NOT a phase failure — it is a
valid, reportable result; the phase gate fails only on process defects.

## 7. Working rules recap

- Caught → escalate autonomously through rungs 1–3; rungs 4–5 are
  money/commitment gates (owner, 2026-09-17 revised).
- Task-level verification ladder + baseline reports; phase-gate before
  Phase 4; no live request without its gate; budgets enforced in code.
- No Store publication, no X work in this phase beyond noting the official
  API option in the decision tree.
