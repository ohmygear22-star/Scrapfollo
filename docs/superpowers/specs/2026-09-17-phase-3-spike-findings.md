# Phase 3 Spike Findings (P3-T3/T4) — Can we scrape Instagram / TikTok?

**Date:** 2026-09-17 · **Branch:** `feature/social-graph-phase-3` · **Method:**
bounded single-shot probes (droplet IP + in-actor Apify proxy), full
evidence in `docs/spike-evidence/`, sanitized.

## Executive answer

| Platform | Profile data (counts, secUid) | Follower/following IDENTITY LISTS | Verdict |
| --- | --- | --- | --- |
| **Instagram** | ❌ anonymous = login-wall JS shell at every rung | ❌ no anonymous path exists | **NOT VIABLE** without login or rented providers (rung 4+) |
| **TikTok** | ✅ **VIABLE anonymously via Apify datacenter proxy** (real secUid + counts obtained; WAF did not block proxy IPs) | ⚠️ endpoint ALIVE and 200-responding, but returns empty JSON without **msToken/X-Bogus signature params** | **VIABLE at profile level; lists are signature-gated (policy decision)** |

## Evidence per rung

### Instagram (`@natgeo`)

| Rung | Origin | Result |
| --- | --- | --- |
| 1 direct (droplet IP) | curl | 200 HTML JS-shell, no profile JSON signals → CAUGHT |
| 2 header rotation ×2 (droplet IP) | curl | identical shell → CAUGHT |
| 3 residential proxy (as designed) | — | **UNAVAILABLE ON CREATOR PLAN**: proxy external-HTTP-client access disabled; RESIDENTIAL group hard-407 even in-actor (`auto,groups-RESIDENTIAL`) |
| 3 datacenter proxy (substitute, in-actor, `auto`) | actor run | auth OK, 200 same login shell → CAUGHT |

Instagram serves anonymous visitors a JavaScript shell without embedded
profile data regardless of IP class. Identity lists require a session or a
third-party provider.

### TikTok (`@khaby.lame`)

| Rung | Origin | Result |
| --- | --- | --- |
| 1 direct (droplet IP) | curl | SlardarWAF challenge page → CAUGHT |
| 2 header rotation ×2 (droplet IP) | curl | same challenge → CAUGHT |
| 3 datacenter proxy (in-actor, `auto`) | actor run | **resolve 200 OK — real profile data with secUid + follower signals**; list call `GET /api/user/list/?secUid=…` → **200, `application/json`, `content-length: 0`** + server-issued `x-ms-token` header → signature-gated |

TikTok blocks the droplet's datacenter IP class at the WAF but serves real
data to Apify datacenter proxy IPs. The list endpoint exists, responds 200,
and is not WAF-blocked from the proxy — it returns an empty body when the
request lacks the browser-computed signature parameters (`msToken`,
`X-Bogus`).

## Incidents and corrections during the spike

1. **Token exposure (remediated)**: a curl error message once printed the
   proxy URL including the API token. Evidence files scrubbed; runner now
   applies value-level `apify_api_*` redaction everywhere and isolates proxy
   credentials out of URLs; owner rotated the token; token re-verified.
2. **Rung-3 mis-fire (corrected)**: the first IG rung-3 attempt silently ran
   direct (missing env). Now fails loudly; re-run properly through the proxy.
3. **Plan discovery**: Creator plan allows Apify Proxy ONLY inside Actor
   runs (external HTTP clients 407) and does not include the RESIDENTIAL
   group despite listing it — datacenter (`auto`) is the included group.
   Rung 3 was therefore executed as an in-actor datacenter-proxy probe.

## Decision tree (owner gate — rungs 4/5 spend money or change policy)

**Instagram lists:**
- A. Rent a compliant IG Store actor (rung 4 — spends credit; Creator plan
  restricts rentals to Universal Actors, may require plan upgrade)
- B. Official IG Graph API — does not expose third-party follower lists; not an option
- C. Drop IG identity lists; keep target as capability-declared `false` (graceful degradation per spec)

**TikTok lists (the signature question):**
- A. Implement the open-source msToken/X-Bogus signature algorithm in our
  provider — mimics exactly what a real browser sends; the ecosystem
  standard (TikTok-Api et al.); **gray zone** vs the spec's
  "no platform-control bypass" red line — owner policy call
- B. Rent a TikTok Store actor that already implements signatures (rung 4 — spends credit)
- C. TikTok Research API — not commercially eligible per V1 spec
- D. Profile-level monitoring only (counts/secUid already viable) — lists dropped

## Cost of the spike

~9 actor runs (4 failed input-format/CA iterations + 5 probe runs), each
seconds of 1 GB compute ≈ **well under $0.05 total**; proxy transfer
kilobytes. First real quota usage of the account, all within the approved
rung-1–3 envelope.
