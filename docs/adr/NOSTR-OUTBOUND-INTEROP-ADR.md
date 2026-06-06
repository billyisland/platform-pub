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

This ADR closes the discovery gap with three replaceable events (kind 0/3/10002) + a NIP-05 endpoint, fanned out through the existing outbox. None of it is new infrastructure — it is new *producers* for a pipeline that already exists.

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

**kind 3 — follow list (NIP-02).** One `p` tag per *active* followee:
```
tags = [ ['p', followeePubkey], … ]   // content: ""
```
Query: `follows f JOIN accounts a ON a.id = f.followee_id WHERE f.follower_id = $1 AND a.status='active'`. Optionally also include `publication_follows` (publications carry `nostr_pubkey`, `schema.sql:3205`) — recommended off for v1 to keep kind 3 person-only.

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

> **Why discovery events must hit public relays (and content need not):** Once kind 10002 + NIP-05 land on the public mesh, a client that knows (or resolves) a pubkey learns to read `wss://all.haus/relay` and pulls notes/articles *directly from us*. So Phase A makes content reachable **without** copying every article/note onto third-party relays. Phase B (below) only serves the long tail of clients that read a fixed relay set and ignore NIP-65/NIP-05 hints.

### 3.4 Triggers (when to (re)publish)

| Event | Trigger | Code site |
|---|---|---|
| kind 0 | account creation; profile edit | `gateway/src/routes/my-account.ts` (profile update handler) |
| kind 3 | follow / unfollow | `gateway/src/routes/follows.ts` (both handlers) |
| kind 10002 | account creation; hosting/relay change | account-create path; `my-account.ts` if relay settings change |

Each trigger: build template → `keyCustody.signEvent(account.id, template)` → `enqueueRelayPublish(client, {...})` inside the request's transaction (mirrors how `notes.ts`/`publication-publisher.ts` already sign-then-enqueue). Because the events are replaceable and re-signed with a fresh `created_at`, each enqueue is a new `signed_event.id` (new row); strfry and public relays keep only the latest per (pubkey, kind).

### 3.5 Backfill

One-off feed-ingest task (or a gated script): for every `accounts` row with `status='active'` and a `nostr_pubkey`, sign+enqueue kind 0, kind 3 (if they follow anyone), kind 10002. Batch through key-custody (it already supports batch crypto ops); cap concurrency. Idempotent — safe to re-run.

---

## 4. Phasing

- **Phase A — discoverability (this ADR's core).** NIP-05 endpoint + kind 0/3/10002 producers + `PUBLIC_FANOUT_RELAY_URLS` + backfill. Outcome: `alice@all.haus` resolves; outbox/NIP-05-aware clients read her public notes/articles from the all.haus relay. Low risk, ships dark behind config.
- **Phase B — content fan-out (optional, later).** Add `PUBLIC_FANOUT_RELAY_URLS` (or a separate `CONTENT_FANOUT_*`) to the *article/note* enqueue sites too, so non-outbox clients reading fixed relays also see content. Bigger surface (volume, relay rate-limits, spam etiquette) — gate per-writer (`accounts.broadcast_to_public`?) and start with notes only. Decide separately.

---

## 5. Risks & decisions

1. **One-accepts success semantics.** The worker marks a row `sent` if *any* target relay accepts (`relay-publish.ts:91`). With `targets=[in-house,…public]`, the in-house relay always accepts, so a flaky public relay silently misses the event and is **not** retried. Acceptable for best-effort discovery in v1; mitigations if we want stronger delivery: (a) re-publish kind 10002/0 on a light schedule or on login to self-heal; (b) a later enhancement splits per-relay outbox rows. **Decision needed:** accept best-effort for Phase A? (Recommended: yes.)
2. **Custodial signing load.** Every follow/unfollow re-signs kind 3 via key-custody. Volume is low; fine. Backfill must batch.
3. **Privacy.** Publishing kind 3 exposes a user's follow graph publicly (it already is, per Nostr norms, but today it's DB-private). **Decision needed:** publish follows for everyone, or opt-in? (Recommended: platform default on, with a settings toggle, since discoverability is the goal.)
4. **Public-relay etiquette / spam.** Fanning content (Phase B) to big relays at volume can get the platform pubkey/users rate-limited or filtered. Keep Phase B opt-in and modest.
5. **Username changes.** kind 0 `nip05` and the NIP-05 record must follow `username` changes; re-enqueue kind 0 on username change and rely on the redirect window for stale resolves.
6. **Out of scope (unchanged):** paywalled unlock (NIP-44 `payload` tag stays proprietary), custodial-key export / NIP-46, mention `p`-tags, reactions/votes (kind 7). Mention `p`-tags are a natural adjacent follow-up.

---

## 6. Implementation checklist

**Migration `108_relay_outbox_discovery_types.sql`** — extend the `relay_outbox_entity_type_check` CHECK to add `'profile'`,`'follow_list'`,`'relay_list'`. Then regenerate `schema.sql` via `pg_dump`, re-append the `_migrations` seed, and run `scripts/check-schema-drift.sh` (per CLAUDE.md schema discipline).

**shared** — add the three values to `RelayOutboxEntityType` (`relay-outbox.ts:17`).

**gateway**
- `lib/nostr-events.ts` (new): `buildProfileEvent(account)`, `buildFollowListEvent(account, followeePubkeys)`, `buildRelayListEvent(account)` → templates.
- `lib/discovery-publish.ts` (new): `republishProfile(client, accountId)`, `republishFollowList(client, accountId)`, `republishRelayList(client, accountId)` — fetch row(s), `keyCustody.signEvent`, `enqueueRelayPublish` with `discoveryRelayTargets()` + `entityId: accountId`.
- `routes/.well-known nostr.json` handler (mount beside `gateway/src/index.ts:263`), with ACAO `*`.
- wire triggers into `routes/my-account.ts` (kind 0 / 10002) and `routes/follows.ts` (kind 3, both follow + unfollow), and the account-creation path (kind 0 + 10002).

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
