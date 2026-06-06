# Nostr Outbound Interop — public-content discoverability

**Status:** Proposed (2026-06-06)
**Scope:** Make all.haus users and their *public* content discoverable and readable by the wider Nostr network, using the existing `relay_outbox` worker. Paywalled-content unlock and custodial-key portability (NIP-46) are explicitly out of scope.

---

## 1. Motivation

all.haus already publishes valid, signed, verifiable Nostr events (articles = kind 30023, notes = kind 1, replies = kind 1/NIP-10, deletes = kind 5) and runs a **publicly reachable relay** at `wss://all.haus/relay` (nginx `location /relay` → `strfry`, `nginx.conf:80`). Public article/note bodies are full cleartext in the event `content` field.

So the *content* is already interoperable. What's missing is **discovery**: an outside Nostr client cannot

1. resolve `alice@all.haus` → a pubkey (no NIP-05 endpoint), nor
2. learn *where* to read a known pubkey's events (no kind 10002 relay list), nor
3. see a user's profile (kind 0) or follow graph (kind 3) at all — both are DB-only today.

And signed events are only written to the in-house relay: `relay_outbox.target_relay_urls` is always `[]`, so the worker falls back to `defaultRelayUrls()` = `[PLATFORM_RELAY_WS_URL]` = `ws://strfry:7777` (`feed-ingest/src/tasks/relay-publish.ts:77,171`). Nothing reaches the public relay mesh.

This ADR closes the discovery gap with three replaceable events (kind 0/3/10002) + a NIP-05 endpoint, fanned out through the existing outbox. The bulk of the work is new *producers* for a pipeline that already exists — but Phase A is not purely additive: making discovery delivery durable on the public mesh requires one scoped change to the worker's success model (per-relay ACK accounting for the three discovery entity types, §3.3). That is the only pipeline surgery; everything else is producers + a NIP-05 route + config.

---

## 2. Current-state baseline (verified)

| Capability | State | Evidence |
|---|---|---|
| Signed content events on a public relay | ✅ | articles/notes via `enqueueRelayPublish`; relay public at `wss://all.haus/relay` (`nginx.conf:80`) |
| Outbound fan-out to *public* relays | ❌ | `target_relay_urls` always `[]`; `defaultRelayUrls()` = in-house only (`relay-publish.ts:171`) |
| NIP-05 (`/.well-known/nostr.json`) | ❌ | gateway serves only `oauth-client-metadata.json` + `jwks.json` (`gateway/src/index.ts:263`) |
| Profile metadata (kind 0) | ❌ | profile lives in `accounts` (`schema.sql:980`); never published |
| Follow list (kind 3) | ❌ | `follows(follower_id, followee_id, followed_at)` DB-only (`schema.sql:1484`) |
| Relay list / outbox (kind 10002) | ❌ | not produced anywhere |
| Custodial signing for *user* events | ✅ available | `keyCustody.signEvent(signerId, template, 'account')` (`gateway/src/lib/key-custody-client.ts:44`) |
| Outbox enqueue API | ✅ available | `enqueueRelayPublish(client, {entityType, entityId, signedEvent, targetRelayUrls, maxAttempts})` (`shared/src/lib/relay-outbox.ts:53`) |

**Reusable primitives we build on:**
- `enqueueRelayPublish` dedups on `signed_event.id`, schedules the `relay_publish` graphile job in-txn.
- The worker takes a per-event `target_relay_urls`, publishes via `publishNostrToRelays(event, urls)` with a **one-accepts-is-success** rule, and owns retry/backoff (`relay-publish.ts:77–110`).
- The advisory lock is per `(entity_type, entity_id)` — so keying discovery events on the **account id** serialises a user's republishes.

---

## 3. Design

### 3.1 The three discovery events

All are **replaceable** (one-per-author per kind), signed with the user's **custodial key** via `keyCustody.signEvent(account.id, template, 'account')` — they are authored *by the user*, not the platform service key.

**kind 0 — profile metadata.** Built from the `accounts` row:
```json
{
  "name":         "<username>",
  "display_name": "<display_name>",
  "about":        "<bio>",
  "picture":      "<avatar_blossom_url>",
  "nip05":        "<username>@all.haus"
}
```
Omit empty fields. `tags: []`, `created_at: now`.

**kind 3 — follow list (NIP-02).** One `p` tag per followee:
```
tags = [ ['p', followeePubkey], … ]   // content: ""
```
The list has **two sources**, and both belong in it — a list built from internal follows alone would tell the outside Nostr world that an all.haus user follows *only* other all.haus users, which inverts the "all means all" premise:
- **Internal follows.** `follows f JOIN accounts a ON a.id = f.followee_id WHERE f.follower_id = $1 AND a.status='active'` → `a.nostr_pubkey` (stored hex, `key-custody-client.ts:40` — no bech32 conversion needed).
- **External Nostr follows.** Users follow external Nostr accounts via `external_subscriptions → external_sources`; include rows where `external_sources.protocol = 'nostr_external'`, mapping each to its pubkey. Omitting these is the single biggest fidelity gap in the list — they are real Nostr pubkeys the user genuinely follows.

`publication_follows` (publications carry `nostr_pubkey`, `schema.sql:1951`) is recommended **off** for v1 to keep kind 3 person-only — that one is a deliberate scope cut; external Nostr follows are not.

**kind 10002 — relay list (NIP-65).** Where this user's events live:
```
tags = [ ['r', <writeReadRelay>] ]    // 'r' with no marker = read+write
```
`writeReadRelay` = `self_hosted_relay_url` when `hosting_type='self_hosted'`, else `wss://all.haus/relay` (from `NEXT_PUBLIC_RELAY_URL`). This is the keystone: it is what lets an outbox-model client (Damus, Amethyst, nostr.band) discover that a known pubkey should be read from the all.haus relay.

### 3.2 NIP-05 endpoint

`GET /.well-known/nostr.json?name=<username>` served by the **gateway**, mounted exactly like the existing `oauth-client-metadata.json` (`gateway/src/index.ts:263`):
```json
{
  "names":  { "alice": "<hex-pubkey>" },
  "relays": { "<hex-pubkey>": ["wss://all.haus/relay"] }
}
```
Rules:
- Lowercase-normalise `name`; exact match on `accounts.username` where `status='active'`. Unknown / missing name → `{ "names": {} }` (200, never 404 — NIP-05 clients expect 200).
- **Must** set `Access-Control-Allow-Origin: *` (NIP-05 requirement). Set it explicitly in the handler.
- **Cache conservatively.** A username change (Risk #5) must propagate quickly, so send `Cache-Control: no-store` (or a short `max-age`, ≤60s) — a long-lived CDN/proxy cache on `/.well-known/nostr.json` would strand clients on a stale `name → pubkey` mapping past the redirect window. Do not let nginx/any CDN cache this route by default.
- `relays[pubkey]` mirrors the kind 10002 logic (self-hosted relay when applicable). This bootstraps clients that resolve NIP-05 but don't do NIP-65.
- Optional niceties (defer): honour `previous_username`/`username_redirect_until` (`schema.sql:1003`); serve `_` → platform service pubkey.

**nginx:** add an exact-match location mirroring the oauth one (`nginx.conf:54`):
```nginx
location = /.well-known/nostr.json { proxy_pass http://gateway:3000; }
```

### 3.3 Outbox integration & fan-out

Add three `entity_type` values to `relay_outbox` and the TS union: `profile`, `follow_list`, `relay_list` (`relay-outbox.ts:17`, CHECK constraint `schema.sql:1971`).

Introduce a fan-out helper + env:
```
PUBLIC_FANOUT_RELAY_URLS = wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net   # comma-sep, opt-in
```
```ts
function discoveryRelayTargets(): string[] {
  const pub = (process.env.PUBLIC_FANOUT_RELAY_URLS ?? '').split(',').map(s=>s.trim()).filter(Boolean)
  return [PLATFORM_RELAY_WS_URL, ...pub]   // in-house first, then public
}
```
Each discovery enqueue passes `targetRelayUrls: discoveryRelayTargets()`, `entityId: account.id`. With `PUBLIC_FANOUT_RELAY_URLS` empty the behaviour is identical to today (in-house only) — so this ships dark and is enabled by config.

**Delivery durability (must-fix for Phase A, not best-effort).** The worker marks a row `sent` when *any* target accepts (`relay-publish.ts:91`), and the in-house relay always accepts — so under the naive design a public relay that is flaky, rate-limiting, or slow **silently drops the discovery event with no retry**. That is acceptable for high-volume content (Phase B) but *not* for the three discovery events, whose successful landing on the public mesh is the entire value of Phase A. Discovery events are tiny and low-volume, so the cost objection that gates content fan-out does not apply. Two layers close the gap:

1. **Per-relay delivery accounting for discovery rows.** Track per-target ACK so a public relay that didn't ACK is retried independently of the in-house success. **This is a real change to the worker, not just a new producer** (see the cost note below) — and the obvious "cheap" shape for it does not exist:
   - *Rejected — one outbox row per target relay.* `relay_outbox` has a **UNIQUE index on `signed_event->>'id'`** (`relay_outbox_event_id_idx`, `schema.sql:4818`), and `enqueueRelayPublish` is built on it (`ON CONFLICT ((signed_event->>'id')) DO NOTHING`). The same signed event therefore cannot occupy N rows — the 2nd…Nth inserts silently no-op. Splitting per relay would require *either* re-signing the event per relay (distinct `id`s — multiplies key-custody load and mints N replaceable events that fight each other on `created_at`) *or* changing the dedup key to `(signed_event_id, target_relay)`, which alters dedup semantics for **all eleven** existing entity types. Neither is "free."
   - *Chosen — per-relay success set on the row.* Add a per-target ACK set (e.g. a `relayed_to text[]` / jsonb column) the worker writes after each publish, and treat a discovery row as fully `sent` only when every target in `target_relay_urls` is ACKed; otherwise re-enqueue with the un-ACKed subset. This is a scoped change to the worker's success/UPDATE logic gated on the three discovery entity types — the rest of the pipeline is untouched.
2. **Self-heal republish.** Re-enqueue kind 0/3/10002 on login and on a light periodic sweep (reuse the backfill task, §3.5) so a pubkey that missed the mesh converges without user action. This must be specced concretely, not assumed — a user who rarely logs in otherwise never self-heals.

> **v1 fallback if (1) slips:** because discovery events are low-volume and idempotent, the self-heal sweep (2) alone delivers *eventual* convergence without any worker change — each sweep re-publishes to all targets, and a target that ACKs once is permanently covered until the next replace. Shipping (2) first and (1) second is a legitimate sequencing if the worker change isn't ready; what is **not** acceptable is shipping neither and relying on the naive one-accepts path.

> **Why discovery events must hit public relays (and content need not):** Once kind 10002 + NIP-05 land on the public mesh, a client that knows (or resolves) a pubkey learns to read `wss://all.haus/relay` and pulls notes/articles *directly from us*. So Phase A makes content reachable **without** copying every article/note onto third-party relays. Phase B (below) only serves the long tail of clients that read a fixed relay set and ignore NIP-65/NIP-05 hints.

### 3.4 Triggers (when to (re)publish)

| Event | Trigger | Code site |
|---|---|---|
| kind 0 | account creation; profile edit; **username change** | `PATCH /auth/profile` in `gateway/src/routes/auth.ts` → `shared/src/auth/accounts.ts:206 updateProfile()` (display_name/bio/avatar). **Username changes go through a *different* site** — `updateProfile()` does not touch `username`; pin the kind-0 re-publish wherever username mutation happens. |
| kind 3 | follow / unfollow | `gateway/src/routes/follows.ts` (both handlers). Also fire on external-Nostr subscribe/unsubscribe in `gateway/src/routes/external-feeds.ts` once external follows are in the list (§3.1). |
| kind 10002 | account creation; hosting/relay change | account-create path (both, below); profile/settings handler if relay settings change |

> **Note — the profile handler is NOT `my-account.ts`.** `gateway/src/routes/my-account.ts` only serves `GET /my/tab` + `GET /my/account-statement`; it does no profile editing. Profile mutation lives in `auth.ts`/`accounts.ts` as above.

> **Account creation has two paths — wire both.** `createGoogleAccount()` (`gateway/src/routes/google-auth.ts:272`) *and* the generic `signup()` (`shared/src/auth/accounts.ts:55`) each `INSERT INTO accounts`; kind 0 + kind 10002 must be enqueued from both, or Google vs. email signups diverge.

Each trigger: build template → `keyCustody.signEvent(account.id, template)` → `enqueueRelayPublish(client, {...})` inside the request's transaction (mirrors how `notes.ts`/`publication-publisher.ts` already sign-then-enqueue). Because the events are replaceable and re-signed with a fresh `created_at`, each enqueue is a new `signed_event.id` (new row); strfry and public relays keep only the latest per (pubkey, kind).

**Coalesce kind-3 republishes; rebuild-from-state, don't snapshot.** A bulk follow/unfollow produces one full-list re-sign + re-publish *per action* — N signings for N follows. Worse, replaceable-event resolution keys on `created_at` at **1-second resolution**: two kind-3 events minted in the same second carry equal `created_at`, and relays tie-break on the lexically-larger `id` (NIP-01), so the *older* follow state can non-deterministically win. The per-`(entity_type, entity_id)` advisory lock serialises a user's republishes but does **not** coalesce them. Fix: debounce the kind-3 job and have it **rebuild the list from current DB state at run time** rather than snapshotting the list in the request. That both collapses a burst into one publish and guarantees the surviving event reflects final state.

**Where the debounce lives — at enqueue, not in the worker.** The worker-side advisory lock cannot coalesce, because by the time the job runs the outbox rows already exist (each is a distinct `signed_event.id`). So the follow/unfollow handler must **not** sign-and-`enqueueRelayPublish` inline; it schedules a deferred *"rebuild + publish kind 3 for account X"* graphile job whose `job_key` is keyed on the account (e.g. `republish_follow_list_<accountId>`) so a burst of N actions collapses to **one** pending job (graphile replaces the existing job_key). Only that job — running once, after the burst settles — fetches current follows, signs once, and enqueues. This is the one place kind 3 diverges from the sign-then-enqueue pattern the other two discovery events follow.

### 3.5 Backfill

One-off feed-ingest task (or a gated script): for every `accounts` row with `status='active'` and a `nostr_pubkey`, sign+enqueue kind 0, kind 3 (if they follow anyone, internal or external), kind 10002. Batch through key-custody (it already supports batch crypto ops); cap concurrency. Idempotent — safe to re-run. **The same task doubles as the periodic self-heal sweep** (§3.3, Risk #1): running it on a light cron re-converges any pubkey whose discovery events missed the public mesh.

---

## 4. Phasing

- **Phase A — discoverability (this ADR's core).** NIP-05 endpoint + kind 0/3/10002 producers + per-relay ACK accounting for the discovery entity types + `PUBLIC_FANOUT_RELAY_URLS` + backfill. Outcome: `alice@all.haus` resolves; outbox/NIP-05-aware clients read her public notes/articles from the all.haus relay. Ships dark behind config; the one non-additive piece is the worker's per-relay success change (§3.3), which only engages for the three discovery entity types — content publishing is untouched.
- **Phase B — content fan-out (optional, later).** Add `PUBLIC_FANOUT_RELAY_URLS` (or a separate `CONTENT_FANOUT_*`) to the *article/note* enqueue sites too, so non-outbox clients reading fixed relays also see content. Bigger surface (volume, relay rate-limits, spam etiquette) — gate per-writer (`accounts.broadcast_to_public`?) and start with notes only. Decide separately.

---

## 5. Risks & decisions

1. **One-accepts success semantics — must-fix for discovery, see §3.3 "Delivery durability".** The worker marks a row `sent` if *any* target relay accepts (`relay-publish.ts:91`), and the in-house relay always accepts, so a flaky public relay silently misses the event and is **not** retried. Phase A's entire value is that these three events land on the *public* mesh, so best-effort is **not** acceptable for them (it is fine for Phase B content volume). **Decision (resolved):** Phase A ships with a per-relay success set on the discovery outbox rows **plus** login/periodic self-heal republish (§3.3). Note the cheap "one row per target relay" shape is **blocked by the UNIQUE `signed_event->>'id'` index** — the worker gains a real (if scoped) per-relay-ACK change; see §3.3 for why, and for the self-heal-only v1 fallback if that change slips. This supersedes the earlier "accept best-effort" framing.
2. **Custodial signing load.** Every follow/unfollow re-signs kind 3 via key-custody. Volume is low; fine. Backfill must batch.
3. **Privacy.** Publishing kind 3 exposes a user's follow graph publicly (it already is, per Nostr norms, but today it's DB-private). **Decision needed:** publish follows for everyone, or opt-in? (Recommended: platform default on, with a settings toggle, since discoverability is the goal.) Default-on is defensible under "all means all," but flipping a previously DB-private graph to world-readable is a material change that warrants an **explicit user-facing disclosure** at rollout (and at signup), not merely a buried settings toggle — make the default and its reach legible to the user.
4. **Public-relay etiquette / spam.** Fanning content (Phase B) to big relays at volume can get the platform pubkey/users rate-limited or filtered. Keep Phase B opt-in and modest.
5. **Username changes.** kind 0 `nip05` and the NIP-05 record must follow `username` changes; re-enqueue kind 0 on username change and rely on the redirect window for stale resolves. (Trigger site differs from profile edit — `updateProfile()` doesn't touch `username`; see §3.4.)
6. **Stale events after deregistration.** NIP-05 correctly stops resolving once an account leaves `status='active'`, but the already-published kind 0/3/10002 persist on public relays indefinitely. **Decision needed:** on account deletion/deactivation, emit a kind 0 tombstone and/or a kind 5 deletion for the discovery events? **Recommended: lead with a kind-0 tombstone** (re-publish an empty/"deactivated" profile) — relays honour replaceable-event *replacement* uniformly, whereas NIP-09 (kind 5) deletion of replaceable events is honoured **inconsistently** across the mesh (many relays keep the latest replaceable version regardless). Emit kind 5 for 0/3/10002 as a best-effort secondary, not the primary lever; defer both for mere deactivation. **Caveat:** the `account_deletion` value exists in the `RelayOutboxEntityType` union today but is **not yet wired** — nothing emits it and it is **not** in the schema `relay_outbox_entity_type_check` CHECK (`schema.sql:1971`), so "hang it on the existing type" still means adding the emit site *and* the CHECK value.
7. **NIP-05 enumeration / rate-limiting.** `?name=` resolution is anonymous and unauthenticated (inherent to NIP-05, acceptable) but enables username→pubkey enumeration. Apply the gateway's standard public-route rate-limiting to the endpoint.
8. **Out of scope (unchanged):** paywalled unlock (NIP-44 `payload` tag stays proprietary), custodial-key export / NIP-46, mention `p`-tags, reactions/votes (kind 7). Mention `p`-tags are a natural adjacent follow-up.

---

## 6. Implementation checklist

**Migration `108_relay_outbox_discovery_types.sql`** — extend the `relay_outbox_entity_type_check` CHECK to add `'profile'`,`'follow_list'`,`'relay_list'`. Then regenerate `schema.sql` via `pg_dump`, re-append the `_migrations` seed, and run `scripts/check-schema-drift.sh` (per CLAUDE.md schema discipline).

**shared** — add the three values to `RelayOutboxEntityType` (`relay-outbox.ts:17`).

**gateway**
- `lib/nostr-events.ts` (new): `buildProfileEvent(account)`, `buildFollowListEvent(account, followeePubkeys)`, `buildRelayListEvent(account)` → templates.
- `lib/discovery-publish.ts` (new): `republishProfile(client, accountId)`, `republishFollowList(client, accountId)`, `republishRelayList(client, accountId)` — fetch row(s) **from current DB state**, `keyCustody.signEvent`, `enqueueRelayPublish` with `discoveryRelayTargets()` + `entityId: accountId`. `republishFollowList` unions internal `follows`→`accounts` with external `nostr_external` subscriptions (§3.1).
- `routes/.well-known nostr.json` handler (mount beside `gateway/src/index.ts:263`), with ACAO `*` and standard public-route rate-limiting.
- wire triggers (correct sites — **not** `my-account.ts`):
  - kind 0 / 10002 → `PATCH /auth/profile` in `routes/auth.ts` (→ `shared/src/auth/accounts.ts updateProfile()`); kind 0 also on username change at its own mutation site.
  - kind 3 → `routes/follows.ts` (both handlers) and external follow/unfollow in `routes/external-feeds.ts` — each **schedules a deferred `republish_follow_list_<accountId>` job** (job_key-coalesced), does **not** sign-and-enqueue inline (§3.4).
  - kind 0 + 10002 at account creation in **both** `routes/google-auth.ts` (`createGoogleAccount`, ~:272) **and** `shared/src/auth/accounts.ts` (`signup`, ~:55).
- delivery durability: add a per-relay success set to discovery outbox rows + the scoped worker change that re-enqueues the un-ACKed subset for the three discovery entity types (§3.3 — **not** "one row per target": blocked by the UNIQUE `signed_event->>'id'` index); the kind-3 deferred job above provides the coalescing.

**feed-ingest** — `discoveryRelayTargets()` helper next to `defaultRelayUrls()`; optional one-off `backfill_discovery_events` task.

**nginx** — `location = /.well-known/nostr.json` → gateway (`nginx.conf`, beside `:54`).

**docker-compose / DEPLOYMENT.md** — document `PUBLIC_FANOUT_RELAY_URLS` (default empty = in-house only); add kind 0/3/10002 to the supported-kinds list; note the NIP-05 endpoint.

**CLAUDE.md** — under Nostr integration, note: profile/follow/relay-list events are produced from DB triggers via `relay_outbox`; NIP-05 is served at `/.well-known/nostr.json`; `PUBLIC_FANOUT_RELAY_URLS` controls public fan-out.

---

## 7. Acceptance check

With Phase A deployed and `PUBLIC_FANOUT_RELAY_URLS` set:
1. `curl https://all.haus/.well-known/nostr.json?name=<user>` returns the pubkey + relay, with `Access-Control-Allow-Origin: *`.
2. A stock Nostr client (e.g. Damus) can add `<user>@all.haus`, see their profile (kind 0), and load their public notes/articles — fetched from `wss://all.haus/relay` via the kind 10002 hint.
3. Querying a public relay (e.g. `wss://nos.lol`) for `authors:[<pubkey>], kinds:[0,3,10002]` returns the three discovery events.
4. Paywalled articles still show only the free portion externally (unchanged).
