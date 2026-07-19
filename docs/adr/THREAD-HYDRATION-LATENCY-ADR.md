# THREAD-HYDRATION-LATENCY-ADR

**Status:** Accepted · 2026-07-17
**Scope:** `gateway/src/routes/post-thread.ts`, `gateway/src/lib/external-hydration.ts`, `gateway/src/lib/nostr-relay.ts`, `web/src/hooks/usePostThread.ts`
**Relates to:** UNIVERSAL-POST-ADR §8 (unified thread engine), EXTERNAL-AUTHOR-HISTORY-ADR

## Context

Expanding an external Nostr card frequently stalls for ~60 s and recovers only
after repeated clicks; occasionally it is instant. This is not relay flakiness —
it is a deterministic interaction of three timing constants:

1. **Client merge schedule is fixed.** `usePostThread` refetches at 3 s and 8 s
   (`HYDRATION_MERGE_DELAYS_MS`) after a `hydrating: true` response, then stops.
2. **Nostr hydration is usually slower than 8 s.** `fetchNostrEvents` runs
   `Promise.all` across relays and each relay resolves only at EOSE, socket
   error/close, **or full timeout** — so a *hung* relay (connected, silent) pins
   the phase at its full timeout. Phases are sequential: focal (6 s) → broad
   net (6 s) → ancestor walk → profiles (6 s). The realistic slow-relay cost is
   **~18 s** (the three 6 s phases); the ancestor walk is usually ~0 s because
   replies tag the root and the broad net already holds the parents — its
   `≤12 × 4 s` (48 s) is a pathological cap that only bites when parents tag only
   their immediate predecessor and each hop misses. Either way it clears 8 s, so
   one hung relay guarantees the 8 s merge lands on an empty DB.
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

The map entry MUST be deleted in a `finally` when the promise settles (success
*or* failure) — otherwise `hydrating` reads stale-`true` forever and the map
leaks one entry per thread. With the entry gone, a settled hydration reports
`hydrating: false` (absent from the map) while the 60 s guard still throttles
re-triggers; a *failed* one both clears the map (→ `false`) and clears the guard
(→ re-triggerable on the next poll).

### D2 — Poll until settled, don't cache partials (client)

Replace the fixed `[3000, 8000]` merge offsets with polling-with-backoff
(1.5 s, 3 s, 6 s, 12 s, cap ~30 s) that stops when a response arrives with
`hydrating: false`, bounded by a total poll budget (~45 s) so a hydrate that
never settles can't poll forever. Do **not** write `hydrating: true` responses
into the module cache (or give them a ≤5 s TTL).

**D2 depends on D1, it does not stand in for it.** The response that poisons the
cache *today* is a `hydrating: false` one — the guard-suppressed refetch — so
withholding only `hydrating: true` responses does not, on its own, break the
deadlock: D2's polling *stops* on `hydrating: false` and *caches* it, which
under the current server would re-create the exact stall. D2 is safe only once
D1 makes `hydrating: false` mean "the job is genuinely done" (never "throttled
mid-flight"). Ship D1 first, or with it; never D2 alone.

### D3 — Stop waiting for the slowest relay

In `fetchNostrEvents`, three modes (opt-in per call; the **default stays
exhaustive/full-EOSE** so no existing caller silently changes behaviour):
- **Content-addressed lookups (`{ ids: [x] }`) — resolve on first hit.** An
  event id uniquely identifies its content, so the first relay to return it is
  authoritative; there is no "newer" copy to wait for. This is the focal fetch
  and the per-hop ancestor fetches — the safe, high-value early-resolve.
- **Replaceable-by-author lookups (kind 0/3/10002) — must NOT resolve on first
  hit.** These are the *opposite* case: a relay may return a stale replaceable
  event, and every caller (`fetchNostrContacts`, `fetchNostrWriteRelays`,
  `fetchNostrAuthorProfile`, and the thread's kind-0 profile REQ) reduces to
  newest-by-`created_at`. First-hit here imports the wrong follow set / a stale
  relay list / a stale bio. Keep these full-EOSE, or at most k-of-n with the
  newest-wins reduction preserved across whatever relays answered.
- **Broad-net REQs** (the `#e`-tag reply nets): resolve when *k*-of-*n* relays
  have EOSE'd (e.g. 2 of 6) or a soft deadline (~2.5 s) elapses, whichever
  first. Stragglers may continue to merge into the result until the hard timeout
  if the collection map is kept.

This is the largest single latency win: it converts per-phase cost from
`max(relay latencies, timeout)` to roughly the median relay's latency — **on the
content-addressed and broad-net phases only.** The replaceable-event phases keep
paying for correctness; D4 hides their cost by overlapping them instead.

### D4 — Parallelise hydration phases

Run the kind-0 profile REQ concurrently with the ancestor walk (most pubkeys
are known after the broad net; fetch stragglers' profiles in a small follow-up
REQ). The saving is **conditional**: the walk only makes relay calls for parents
the broad net didn't already hold, which — because replies tag the root — is
usually *none*, so a cheap walk overlaps with nothing and D4 buys ~0 s. Its real
value is the *other* case: it hides the exhaustive replaceable-event profile
phase (kept full-EOSE by D3) behind whatever walk hops do occur, so the two slow
phases cost `max` instead of `sum`. Expect a real win only on threads with a
deep, sparsely-tagged ancestor chain; treat D3 as the primary latency lever.

### D5 — Short synchronous await on first expand

Give the initial `/thread` request a ~2 s budget to `Promise.race` the
in-flight hydration. If it completes inside the budget, return the full
projection in one round trip — no polling at all on fast relays. Otherwise fall
through to `hydrating: true` + D2 polling.

### D6 — Viewport prefetch

Fire a debounced `POST /thread/:id/prefetch` when an external card enters the
viewport (IntersectionObserver). It invokes the same
`hydrateExternalThreadContext`; the guard prevents stampedes. By click time the
pure-DB projector answers warm. No response body; fire-and-forget. This is the
one decision that touches the card component itself (`web/src/components/post/`,
to host the IntersectionObserver), not just `usePostThread` — add it to the
scope when this slice lands.

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
- D3 adds a "sufficient within deadline" mode to `fetchNostrEvents` alongside
  the existing "exhaustive within timeout" default, selected by an opt-in flag
  per call. Early-resolve is enabled **only** for content-addressed
  (`{ ids: [x] }`) and broad-net lookups; the replaceable-by-author callers
  (`fetchNostrContacts`/`fetchNostrWriteRelays`/`fetchNostrAuthorProfile` and
  the kind-0 profile REQ) stay on the exhaustive default so newest-wins is not
  defeated. Because the default is unchanged, `routes/author.ts` and the other
  higher-level helpers need no edit.
- D6 adds background relay traffic proportional to scroll depth; the existing
  `HYDRATE_TTL_MS` guard and context-GC bound the cost.

## Sequencing

1. **✅ SHIPPED 2026-07-19** — D1 + D2, the deadlock kill. Server in-flight
   registry (`isThreadHydrating`/`getInFlightHydration` + guard-clear-on-failure)
   drives `hydrating`; client polls with backoff until settled and never caches a
   partial. Mutation-verified tests: `gateway/tests/thread-hydration-guard.test.ts`,
   `web/src/hooks/usePostThread.cache.test.ts`. (FIX-PROGRAMME 2026-07-19.)
2. **✅ SHIPPED 2026-07-19** — D3 + D4, the latency levers. `fetchNostrEvents`
   gained the opt-in `resolve` param (`NostrFetchResolve`): `first-event` for the
   content-addressed focal + ancestor-walk hops, `k-of-n` (2-of-n, 2.5 s soft
   deadline) for the broad `#e` reply nets; the default stays `exhaustive` so the
   replaceable-by-author callers (kind 0/3/10002 newest-wins) are untouched. D4
   overlaps the kind-0 profile REQ with the ancestor walk (a straggler follow-up
   REQ covers authors the walk newly finds), so the two slow phases cost `max`,
   not `sum`. Mutation-verified test: `gateway/tests/nostr-relay-resolve.test.ts`
   (first-event, k-of-n at k EOSEs, k-of-n soft-deadline fallback, exhaustive
   preserved). (FIX-PROGRAMME 2026-07-19.)
3. **✅ SHIPPED 2026-07-19** — D5, the sync-await lever. `/thread`'s external
   branch kicks off (or finds, via `getInFlightHydration`) the hydration and
   races it against `THREAD_HYDRATE_SYNC_BUDGET_MS` (2 s) with the pure helper
   `awaitHydrationWithinBudget(job, budgetMs)`: settled-in-time ⇒ assemble the
   now-committed full thread and return `hydrating: false` (no client poll on a
   fast relay); budget-exceeded ⇒ `hydrating: true` and the client polls (D2).
   `hydrating = !settled` still derives from the in-flight registry (D1), never
   `willHydrateThread`. Mutation-verified test: `awaitHydrationWithinBudget`
   cases in `gateway/tests/thread-hydration-guard.test.ts`. (FIX-PROGRAMME
   2026-07-19.) **D6 (viewport prefetch) remains** — the one decision touching
   the card component (`web/src/components/post/`).
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
