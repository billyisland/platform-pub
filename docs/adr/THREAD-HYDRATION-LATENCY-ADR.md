# THREAD-HYDRATION-LATENCY-ADR

**Status:** Proposed · 2026-07-17
**Scope:** `gateway/src/routes/post-thread.ts`, `gateway/src/lib/external-hydration.ts`, `gateway/src/lib/nostr-relay.ts`, `web/src/hooks/usePostThread.ts`
**Relates to:** UNIVERSAL-POST-ADR §8 (unified thread engine), EXTERNAL-AUTHOR-HISTORY-ADR

## Context

Expanding an external Nostr card frequently stalls for ~60 s and recovers only
after repeated clicks; occasionally it is instant. This is not relay flakiness —
it is a deterministic interaction of three timing constants:

1. **Client merge schedule is fixed.** `usePostThread` refetches at 3 s and 8 s
   (`HYDRATION_MERGE_DELAYS_MS`) after a `hydrating: true` response, then stops.
2. **Nostr hydration is usually slower than 8 s.** `fetchNostrEvents` runs
   `Promise.all` across relays and each relay resolves only at EOSE **or full
   timeout** — every phase runs at the speed of the slowest relay. Phases are
   sequential: focal (6 s) → broad net (6 s) → ancestor walk (≤12 × 4 s) →
   profiles (6 s). One hung relay guarantees the 8 s merge lands on an empty DB.
3. **The `hydrating` flag conflates "in flight" with "not throttled".**
   `willHydrateThread` returns false once `hydrateGuard` (60 s TTL) is set, so
   the 8 s refetch — arriving mid-hydration — is answered `hydrating: false` and
   written to the client cache (60 s TTL). Every re-click within the next minute
   serves that stale, empty, non-hydrating cache entry and schedules nothing.
   After ~60 s both TTLs expire, a fresh fetch hits the now-hydrated DB, and the
   thread appears "instantly" — hence the observed ritual.

Secondary defect: `hydrateGuard` is set *before* the hydrate runs and never
cleared on failure, so a failed hydrate blocks retries for a full minute.

The instant-open cases are threads already ingested, or relays that EOSE inside
the 3 s window.

## Decision

### D1 — `hydrating` means "job in flight" (server)

Keep a module-level `Map<itemId, Promise<void>>` of in-flight hydrations.
`/thread/:postId` reports `hydrating: true` while the promise is pending,
independent of the throttle guard. The guard remains solely a re-*trigger*
throttle. Clear the guard on hydration failure so a retry is possible
immediately.

### D2 — Poll until settled, don't cache partials (client)

Replace the fixed `[3000, 8000]` merge offsets with polling-with-backoff
(1.5 s, 3 s, 6 s, 12 s, cap ~30 s) that stops when a response arrives with
`hydrating: false`. Do **not** write `hydrating: true` responses into the
module cache (or give them a ≤5 s TTL). This removes the poisoned-cache leg of
the deadlock even if D1 slips.

### D3 — Stop waiting for the slowest relay

In `fetchNostrEvents`:
- Single-event lookups (`{ ids: [x] }`; kind 0/3/10002 with `limit: 1`):
  resolve on **first hit** across relays.
- Broad-net REQs: resolve when *k*-of-*n* relays have EOSE'd (e.g. 2 of 6) or a
  soft deadline (~2.5 s) elapses, whichever first. Stragglers may continue to
  merge into the result until the hard timeout if the collection map is kept.

This is the largest single latency win: it converts per-phase cost from
`max(relay latencies, timeout)` to roughly the median relay's latency.

### D4 — Parallelise hydration phases

Run the kind-0 profile REQ concurrently with the ancestor walk (most pubkeys
are known after the broad net; fetch stragglers' profiles in a small follow-up
REQ). Saves ~6 s of serial time.

### D5 — Short synchronous await on first expand

Give the initial `/thread` request a ~2 s budget to `Promise.race` the
in-flight hydration. If it completes inside the budget, return the full
projection in one round trip — no polling at all on fast relays. Otherwise fall
through to `hydrating: true` + D2 polling.

### D6 — Viewport prefetch

Fire a debounced `POST /thread/:id/prefetch` when an external card enters the
viewport (IntersectionObserver). It invokes the same
`hydrateExternalThreadContext`; the guard prevents stampedes. By click time the
pure-DB projector answers warm. No response body; fire-and-forget.

### D7 (later) — Relay health scoring

Track per-relay EOSE latency and failure rate; deprioritise chronically slow
relays when assembling the capped relay set, rather than paying their timeout
on every phase. Not launch-blocking.

## Consequences

- Warm expands (prefetched or previously ingested) become sub-second; cold
  expands settle in ~2–8 s with an honest "gathering the conversation…" state
  instead of a dead card.
- The 60 s failure mode is eliminated by construction: no response can claim
  `hydrating: false` while a hydrate is running (D1), and no partial response
  can pin the cache (D2).
- D3 changes `fetchNostrEvents` semantics from "exhaustive within timeout" to
  "sufficient within deadline". Callers that want exhaustiveness (contact-list
  fetch, where the *newest* kind-3 across relays matters) should keep the
  full-EOSE mode — make early-resolve an opt-in flag per call.
- D6 adds background relay traffic proportional to scroll depth; the existing
  `HYDRATE_TTL_MS` guard and context-GC bound the cost.

## Sequencing

1. D1 + D2 — small diffs, kill the deadlock. Ship together.
2. D3 + D4 — latency. D3 behind a per-call flag.
3. D5 + D6 — perceived instantaneity.
4. D7 — post-launch.

## Test battery

- **Deadlock regression:** stub a hydrate that takes 15 s; assert the client
  keeps polling past 8 s and renders the thread without a re-click.
- **Guard-on-failure:** failed hydrate → `willHydrateThread` true again
  immediately.
- **Cache hygiene:** `hydrating: true` response is not served from cache on
  re-expand.
- **k-of-n:** with one relay that never EOSEs, broad net resolves at the soft
  deadline with the fast relays' events.
- **Exhaustive mode preserved:** kind-3 contact fetch still waits all relays.
