# Network Concierge — Nostr root + optional satellite presences

**Status:** Accepted (2026-06-09). **Phase 0 + Phase 1 shipped** (2026-06-10): `network_presences` table (migration 109, subsuming `linked_accounts`), key-custody gated secret-key export + nsec backfill in `/account/export`, and the per-user Nostr public-presence opt-in `accounts.discovery_enabled` (migration 110). **UI reframe shipped** (2026-06-10, §10): `NetworkReachPanel` replaces `LinkedAccountsPanel` — per-network reach model, Nostr root folded in as the live (degenerate) concierge, atproto/AP concierge affordances rendered disabled ("coming soon"); dual-path contextual prompt in `InlineReplyBox`. Phases 2–3 (atproto/AP concierge backend) remain gated by §8.1; **proposed resolutions to the §8.1 gates are in §8.2 (pending operator ratification), and the Phase 2 build is planned in §13.** This document records the model and the decisions taken in design discussion.
**Scope:** Generalise all.haus from "custodial Nostr identity + read/link of other networks" to "custodial **Nostr root** identity + optional, on-demand, custodial presences on other networks that all.haus provisions on the user's behalf." This document specifies the model in full and the **atproto** satellite concretely; **ActivityPub** is named as a future phase with a stub (§9). NIP-46 remote signing and paywalled-content unlock across networks are out of scope.

---

## 1. Thesis

Signing up to all.haus means getting a **Nostr keypair**. That is the canonical identity and it does not change: minted eagerly at signup, custodial, free, mandatory (`accounts.nostr_pubkey` / `nostr_privkey_enc`, generated in `key-custody`). Every account *is* a Nostr identity.

Every other network — Bluesky/atproto, the fediverse/ActivityPub — is a **satellite presence**: optional, opt-in, and provisioned on demand. When a user wants to reach one of those networks, all.haus acts as **concierge**: it does the grubby setup work (mint the keys, register the identity, wire the handle, request federation) so the user never visits that network's signup flow. The user keeps one front door — all.haus — and reaches outward from it.

This is the natural completion of the existing custodial-Nostr model and answers `PRINCIPLES.md` ("writers own their identity") and the omnivorous-input commitment ("all means all"). It is **not** "be everywhere by default" — satellites are materialised only when asked.

---

## 2. The central distinction: LINKED vs CONCIERGE

A non-root presence arrives one of two ways. The model keeps them rigorously separate because their key custody and posting paths differ:

| | **LINKED** (exists today) | **CONCIERGE** (new) |
|---|---|---|
| Origin | user already has the account elsewhere | all.haus mints it for them |
| Who holds the keys | the user (we hold an OAuth grant) | all.haus, custodial, in `key-custody` |
| atproto secret store | `atproto_oauth_sessions` (OAuth session + DPoP) | `key-custody` (repo signing key + rotation key) |
| Handle example | `@me.bsky.social` (theirs) | `me.all.haus` (ours, on our PDS) |
| Posting path | restore OAuth session → post to *their* PDS | sign via key-custody → post to *our* PDS |

Concierge is **additive** to linking, not a replacement. A user who already has a Bluesky account links it (today's path, unchanged). A user who doesn't, and wants one, gets the concierge. Both produce a cross-post target; the dispatcher branches on `provenance`.

---

## 3. Current-state baseline (verified)

| Capability | State | Evidence |
|---|---|---|
| Custodial Nostr keypair minted at signup | ✅ | `auth.ts` `/auth/signup` → key-custody `generateKeypair()` → `accounts.nostr_pubkey`/`nostr_privkey_enc` (`shared/src/auth/accounts.ts`) |
| Protocol-aware custodial signing | ⚠️ Nostr only | `key-custody/src/lib/crypto.ts::signEvent` hardwired to nostr-tools `finalizeEvent`; keyed `(signerId, signerType)` |
| Private-key / nsec export | ❌ | `gateway/src/routes/export.ts` exports pubkey + articles + wrapped content keys, **never** the private key |
| Link an existing Bluesky account | ✅ | `gateway/src/routes/linked-accounts.ts` (`@atproto/oauth-client-node`, PKCE+DPoP); session in `atproto_oauth_sessions`, public id in `linked_accounts` |
| Link an existing Mastodon account | ✅ | same route, per-instance OAuth; token in `linked_accounts.credentials_enc` |
| Outbound cross-post to linked accounts | ✅ | `feed-ingest/src/tasks/outbound-cross-post.ts` + `adapters/atproto-outbound.ts` (`client.restore(did)`, DPoP); `outbound_posts` queue |
| Mint our own DIDs / run a PDS | ❌ | no `@atproto/pds`, `@atproto/identity`, `@atproto/crypto`; `atproto-resolve.ts` only *reads* the public AppView; zero `com.atproto.server.createAccount` |
| Nostr discovery (kind 0/3/10002 + NIP-05) | ✅ dark | `gateway/src/lib/discovery-publish.ts`, NIP-05 at `/.well-known/nostr.json`, flag `DISCOVERY_PUBLISH_ENABLED` |

**Reusable primitives:** key-custody's mint/encrypt/sign/zero pattern (AES-256-GCM under `ACCOUNT_KEY_HEX`); `enqueueRelayPublish` + `relay_outbox` worker; the `outbound_posts` dispatch queue; `@atproto/oauth-client-node` (kept for LINKED).

---

## 4. Invariants (also added to CLAUDE.md)

1. **Nostr-root.** Exactly one custodial Nostr keypair per account, minted at signup; it is the canonical identity. Satellite presences never replace or precede it.
2. **Concierge is lazy.** A concierge presence is minted only on explicit per-network opt-in — never at signup. (Eager minting would write to `plc.directory` and create dormant PDS repos for users who never asked.)
3. **Custody parity.** Concierge secrets live in `key-custody` under the same AES-256-GCM/`ACCOUNT_KEY_HEX` regime as `nostr_privkey_enc`; never plaintext in the app DB.
4. **Export-mandatory.** Every concierge identity is exportable from day one (for atproto: repo signing key **and** the did:plc rotation key — the migration anchor). Shipped together with a **backfill of nsec export for the Nostr root**, closing the standing contradiction in `export.ts`.
5. **Concierge presence is native, not external.** A concierge atproto/AP identity is a facet of the `accounts` row, not an `external_authors` (tier-A) record. Its posts originate from the account and must **not** re-ingest as external twins — the same native-vs-external id-space discipline already enforced for Nostr (`feed_items.author_id` vs `external_author_id`).

---

## 5. Data model

### 5.1 `accounts` — unchanged
The Nostr root stays inline (`nostr_pubkey`, `nostr_privkey_enc`, `hosting_type`, `self_hosted_relay_url`, the discovery columns). It is special; it is not a satellite.

### 5.2 `network_presences` — new, subsumes `linked_accounts`
One table for **both** linked and concierge satellites, keyed `(account_id, protocol)`. `linked_accounts` is migrated into it so cross-post targeting is a single uniform query.

```
network_presences (
  id                uuid pk,
  account_id        uuid not null → accounts,
  protocol          external_protocol not null,   -- 'atproto' | 'activitypub' | 'nostr_external'
  provenance        text not null,                 -- 'linked' | 'concierge'
  external_id       text not null,                 -- atproto: DID; AP: actor URI
  handle            text,                           -- atproto: username.all.haus; AP: @username@all.haus
  service_url       text,                           -- atproto: pds_url; AP: instance_url
  lifecycle_state   text not null default 'active', -- 'provisioning' | 'active' | 'suspended' | 'deprovisioned'
  is_valid          boolean not null default true,
  cross_post_default boolean not null default true,
  -- LINKED secrets stay where they are (atproto_oauth_sessions / credentials_enc-equivalent);
  -- CONCIERGE secrets live in key-custody, referenced by (account_id, protocol).
  created_at, updated_at,
  unique (account_id, protocol)                    -- one presence per network per account (deliberate, v1)
)
```

Migration folds existing `linked_accounts` rows in as `provenance='linked'`, `lifecycle_state='active'` (atproto `external_id`=DID with secrets still in `atproto_oauth_sessions`; activitypub token migrated alongside).

**`lifecycle_state` vs `is_valid`.** `is_valid` is a health bit (credentials still work / handle still resolves); `lifecycle_state` is the presence's place in its provisioning arc. A boolean can't express "minted but not yet crawled," "user paused cross-posting," or "torn down but DID-doc tombstoned," which the concierge path (with its multi-step §6 provisioning and the dormancy concern in §11) genuinely passes through. Outbound dispatch targets only `lifecycle_state='active' AND is_valid`.

**One presence per protocol.** The `unique (account_id, protocol)` constraint is a deliberate v1 limit: no multiple personas (e.g. two Bluesky identities) on one network per account. Lifting it later means dropping the constraint and teaching the dispatcher to fan out per-presence; recorded here so it isn't relitigated as an accident.

### 5.3 key-custody — generalised secret store
Today: `(signerId, signerType)` → `nostr_privkey_enc`, signer hardwired to `finalizeEvent`. Generalise to `(owner_id, protocol, purpose)` → encrypted secret, with:
- a **protocol-aware signer** — `finalizeEvent` for nostr, **k256 repo-commit signer** for atproto, actor-key signer for AP;
- a **provision** call (mint a keypair for a protocol, return public identifier);
- a **gated export** call (returns the decrypted secret to the authenticated owner only — backs invariant 4).

---

## 6. atproto concierge flow (the concrete satellite)

**DID method: `did:plc`** (decided — federates cleanly and gives a real migration story via rotation keys; accepts the `plc.directory` dependency). **PDS: run `@atproto/pds` as a sibling service** (the strfry pattern); `network_presences` is its projection, not the source of truth for repo data.

Provisioning, on opt-in:
1. key-custody mints the **signing key** + **rotation key** (k256), encrypted under `ACCOUNT_KEY_HEX`.
2. Register a `did:plc` at `plc.directory` (rotation key authorises future DID-doc changes — the ownership anchor).
3. Create the repo on our PDS; set handle `username.all.haus`.
4. Serve handle resolution at `https://username.all.haus/.well-known/atproto-did` (per-`Host` across a wildcard cert — the direct analog of the existing DB-driven `/.well-known/nostr.json`).
5. `requestCrawl` to Bluesky's Relay so the AppView indexes us and content appears on bsky.app.
6. Write the `network_presences` row (`provenance='concierge'`, `external_id`=DID, `handle`, `service_url`=our PDS).

Handle follows username changes (DID stable, handle mutable — `accounts.username_changed_at`/`previous_username` already exist). Outbound dispatch (`outbound-cross-post.ts`) branches on `provenance`: **linked** → restore OAuth session, post to their PDS; **concierge** → sign via key-custody, post to our PDS.

**Deprovisioning (shipped with P2, not deferred).** A concierge presence is a live federating identity, so teardown is a first-class path, not a GC afterthought (it answers the dormancy risk in §11). On user request (or lifecycle GC of an abandoned presence): set `lifecycle_state='deprovisioned'`, stop outbound dispatch, and tombstone the identity rather than silently abandoning it — for atproto, update the DID doc (authorised by the rotation key) to deactivate the account so it can't be impersonated-by-silence, and stop serving its handle resolution. The export escape hatch (invariant 4) must be offered *before* teardown so the user can migrate the identity off-platform via the rotation key if they want to keep it. key-custody secrets are zeroed only after export is declined or confirmed complete.

---

## 7. Nostr "concierge" is degenerate

Nostr needs no new provisioning — it's the root, already minted. "Go public on Nostr" simply means flipping the **existing** `DISCOVERY_PUBLISH_ENABLED` machinery (kind 0/3/10002 + NIP-05) to a **per-user opt-in toggle**. The producers and outbox path already exist (`NOSTR-OUTBOUND-INTEROP-ADR`); this phase only exposes the switch.

---

## 8. Phasing (dark-ship, per-network flags)

- **Phase 0 — foundation (no user-facing change).** `network_presences` table + `linked_accounts` migration; key-custody generalisation; **export incl. nsec backfill** (invariant 4).
- **Phase 1 — Nostr public presence.** Wire existing discovery to a per-user opt-in (§7).
- **Phase 2 — atproto concierge.** PDS service, `did:plc` mint, `username.all.haus` handles, Relay crawl, concierge branch in outbound dispatch. Behind a flag.
- **Phase 3 — ActivityPub concierge.** See §9.

Each phase ships dark behind its own flag, mirroring `DISCOVERY_PUBLISH_ENABLED`.

### 8.1 Phase 2 entry criteria (gating, not "revisit later")

Minting `did:plc` identities and running a PDS converts all.haus from "publishes signed events" into "custodies cross-network identities and persists their canonical repos." That is qualitatively heavier than the relay, so the following are **prerequisites to P2 shipping**, promoted out of §11's open-questions list:

1. **Rotation-key custody posture decided.** A compromise of `ACCOUNT_KEY_HEX` after P2 leaks did:plc rotation keys — i.e. permanent theft of cross-network identities, not just relay impersonation. Invariant 3 ("custody parity") is convenient but pulls against this: rotation keys may warrant a stronger envelope than parity-of-mechanism (separate key, HSM, or split custody). Resolve before, not during, P2. **→ proposed resolution in §8.2.**
2. **Deprovision/tombstone path implemented** (§6) and wired to lifecycle GC for abandoned presences. No P2 ship with provision-only. **→ build work, specified as §13 W6.**
3. **PDS durability SLA stated and met.** `network_presences` is a projection; the PDS store now holds canonical identity repos. Backups, blob storage, and uptime are part of users' identity persistence — losing the PDS loses their Bluesky presence. Define the durability/restore story explicitly (§11 names the impedance; this makes it a gate). **→ proposed targets in §8.2.**

### 8.2 Phase 2 entry-criteria — resolutions (**Proposed — pending operator ratification**)

Gates §8.1.1 and §8.1.3 are security/infra decisions, not code. The resolutions below are **proposed with rationale and must be ratified by the operator before P2 build starts** (W0 of §13); they are not yet Accepted. Gate §8.1.2 (deprovision) is build work — see §13 W6.

**§8.1.1 — Rotation-key custody. → Proposed: split custody by key *role*, not parity-for-all.**
The tension between invariant 3 (parity, simple) and blast radius (rotation key = permanent cross-network identity) dissolves once the two atproto keys are *not* treated alike:
- **Signing key (hot, per-post).** Reached by the dispatcher on every outbound post. Keep at **parity** — AES-256-GCM under `ACCOUNT_KEY_HEX`, exactly like `nostr_privkey_enc`. Its compromise is bounded: impersonated posts, recoverable by rotating the signing key *via* the rotation key.
- **Rotation key (cold, lifecycle-only).** Touched only at provision, handle/DID-doc change, and deprovision — never on the post path. Give it the **elevated envelope**: encrypted under a *separate* `ROTATION_KEY_HEX` (distinct secret, distinct storage + rotation lifecycle from `ACCOUNT_KEY_HEX`) so a compromise of the app's primary account-key does **not** by itself leak rotation keys. Documented migration path to a cloud KMS / HSM-backed wrap (decrypt-on-use, key never resident in app memory) once volume justifies the operational cost.

This refines invariant 3 *for atproto*: parity for the hot signing key, elevation for the cold rotation key. CLAUDE.md's custody-parity line gets a one-line carve-out pointer here. **Operator decision needed:** ratify the two-tier split, and whether the launch floor is `ROTATION_KEY_HEX` separate-envelope (software) or KMS/HSM from day one. Recommendation: separate-envelope at launch, KMS migration as a tracked fast-follow.

**§8.1.3 — PDS durability. → Proposed targets** (ratify against infra budget; these are launch *floors*, not aspirations — if budget can't meet them, P2 does not ship):
- **Repo store (PDS SQLite/Postgres):** WAL archiving / streaming replication for point-in-time recovery, **RPO ≤ 5 min**; nightly encrypted off-box full backup, **30-day retention**.
- **Blobs (media):** durable object storage with replication; same backup cadence.
- **Restore:** documented, *tested* runbook, **RTO ≤ 4 h**.
- **Uptime:** **99.5%** target for the PDS *and* the handle-resolution endpoint (handle resolution down ⇒ the identity stops resolving on bsky.app).
- **Pre-mint gate:** provisioning refuses to mint a `did:plc` unless backups are confirmed healthy — never create an identity we can't durably keep.

---

## 9. ActivityPub concierge (future — stub)

Deferred, recorded for completeness. all.haus would lazily materialise an actor `@username@all.haus` (i.e. become a federating instance): actor keypair in key-custody, serve actor/inbox/outbox + WebFinger, `network_presences` row `provenance='concierge'`, `protocol='activitypub'`. Heavier than atproto on the operational axis (moderation, deliverability, abuse handling as a full instance; weaker account-migration/portability than atproto's rotation-key story). Designed in a follow-up ADR before any code.

---

## 10. UI reframe

`LinkedAccountsPanel` → **"Reach other networks."** Two affordances per network: **"I already have one"** (link/OAuth — today's path) and **"Set one up for me"** (one-click concierge). Honest about custody and surfacing the export escape hatch, so the concierge metaphor doesn't hide that we hold the keys.

**As built (2026-06-10).** `web/src/components/account/NetworkReachPanel.tsx` (replaces `LinkedAccountsPanel`; old `PrivacyPreferences.tsx` retired into it). Per-network rows: **Nostr** is first-class (the root) with a `Public / Private` discovery toggle (the degenerate concierge, §7 — relocated wholesale from `PrivacyPreferences`, including the nested follow-list sub-toggle); **Bluesky / Mastodon** show `Link yours` (existing OAuth, unchanged) plus a **disabled "Set one up · soon"** concierge affordance carrying the custody/export honesty line. The two satellite concierge buttons stay stubbed until their backend phase clears §8.1. The contextual entry point — `InlineReplyBox`'s no-presence prompt on an external card — is now dual-path: "Connect your {network} account → Settings" **and** "Don't have one? all.haus can set one up for you — coming soon." This ships the full journey *shape* (Nostr working, atproto/AP honestly pending); wiring the satellite buttons to real provisioning is the only remaining UI change when Phase 2/3 land.

**Expectation-setting (atproto).** Whether a concierge post actually *appears* on bsky.app depends on Bluesky's Relay/AppView choosing to index us (`requestCrawl`, §6 step 5 / §11) — outside our control. The UI must say so: a concierge presence reports its `lifecycle_state` ("setting up… / active") and frames publishing as "your posts are published to your all.haus PDS; Bluesky may take time to index them, or decline." Without this the concierge reads as broken whenever the Relay rate-limits or lags. Likewise surface `is_valid=false` (handle/credential breakage) distinctly from a healthy-but-unindexed presence.

---

## 11. Risks / open questions

- **`plc.directory` dependency** — soft-centralised registry run by Bluesky PBC; rate limits and availability are external.
- **Relay-crawl refusal** — appearing on bsky.app depends on Bluesky's Relay/AppView choosing to index us; they can rate-limit or decline.
- **Custody blast radius** — holding rotation keys widens what a compromise of `ACCOUNT_KEY_HEX` exposes (now cross-network identities, not just Nostr). **Now a P2 entry criterion (§8.1.1), not a deferral.**
- **Dormant presences** — provision-then-abandon needs a GC/lifecycle story. **Addressed by the `lifecycle_state` column (§5.2) + deprovision/tombstone path (§6), gated into P2 (§8.1.2).**
- **Legal posture** — operating network identities on users' behalf; ToS and abuse liability.
- **`@atproto/pds` ↔ single-Postgres impedance** — the PDS keeps its own store and keys; accepted as a sibling-service seam (like strfry), with `network_presences` as a mirror, not the source of truth.

---

## 12. CLAUDE.md additions (on acceptance)

Add an invariant block under "Architecture → Invariants" stating: Nostr-root (signup mints the canonical custodial Nostr key); LINKED vs CONCIERGE distinction; concierge-is-lazy; custody-parity in key-custody; export-mandatory; concierge-presence-is-native-not-external. Rule-plus-pointer to this ADR.

---

## 13. Phase 2 atproto concierge — implementation plan

Builds the §6 flow into ordered workstreams. **Status: not started** — gated on §8.2 ratification (W0). Ships dark behind its own flag `ATPROTO_CONCIERGE_ENABLED` (mirroring `DISCOVERY_PUBLISH_ENABLED`, §8). The schema already receives it: `network_presences.provenance`/`lifecycle_state` exist (P0), and the dispatcher has the `provenance='linked'` path with an empty slot for the concierge branch (W5). Sequencing: **W0 → (W1 ∥ W2) → W3 → W4 → W5 → W6 → W7 → W8.** W6 is non-optional for first ship (§8.1.2).

**W0 — Ratify §8.2 + provision infra (no app code).** Operator ratifies the two-tier custody split (§8.1.1) and durability targets (§8.1.3). Stand up: `ROTATION_KEY_HEX`; the PDS host + durable volume; wildcard DNS `*.all.haus` + TLS cert; object storage for blobs; the WAL/backup pipeline. **Gate: backups proven restorable before any mint.**

**W1 — PDS sibling service.** Add `@atproto/pds` as a docker service (the strfry pattern; §4 / §11 "sibling-service seam"). Own store + blobstore on the W0 volume; into the backup pipeline + a health check. Config: service DID, hostname, admin auth. `network_presences` is its *projection*, not its source of truth. No all.haus wiring yet — stand it up, verify it serves `com.atproto.*` locally. *(New deps: `@atproto/pds`.)*

**W2 — key-custody generalisation.** Generalise the secret store from `(signerId, signerType)`→nostr to `(owner_id, protocol, purpose)`→secret (§5.3):
- `purpose ∈ {nostr_sign, atproto_sign, atproto_rotation}`; signing secrets under `ACCOUNT_KEY_HEX`, rotation secrets under `ROTATION_KEY_HEX` (§8.2).
- Protocol-aware signer: keep `finalizeEvent` for nostr; add a **k256 repo-commit signer** for atproto (`@atproto/crypto`).
- `provision(owner, protocol)` → mints signing + rotation keypair, returns public material.
- Extend the gated `POST /keypairs/export` (already shipped for nsec) to also return the atproto signing key **and** rotation key (invariant 4 — the rotation key is the migration anchor).
- Unit-test signer + export round-trip; **the existing nostr path must be unchanged** (regression guard). *(New deps: `@atproto/crypto`.)*

**W3 — did:plc mint + repo creation.** Server-side provisioning job, lazy per invariant 2, idempotent + resumable (each step checkpointed in `lifecycle_state` so a mid-flight failure never orphans a half-registered DID):
1. key-custody `provision` (W2) → signing + rotation keys.
2. Register `did:plc` at `plc.directory` (rotation key as DID-doc rotation authority; `@atproto/identity`). Rate-limit aware — external dependency (§11).
3. `com.atproto.server.createAccount` on our PDS (W1); set handle `username.all.haus`.
4. Write the `network_presences` row `provenance='concierge'`, `lifecycle_state` `provisioning`→`active`, `external_id=did`, `handle`, `service_url`=our PDS. *(New deps: `@atproto/identity`.)*

**W4 — handle resolution.** Serve `https://username.all.haus/.well-known/atproto-did` per-`Host` over the W0 wildcard cert — the direct analog of the DB-driven `/.well-known/nostr.json`. Driven from `network_presences` (handle→did). Follows username changes (DID stable, handle mutable; `accounts.username_changed_at`/`previous_username` already exist): rename republishes resolution + updates the PDS handle.

**W5 — Relay crawl + outbound dispatch.**
- `requestCrawl` to Bluesky's Relay after provision so the AppView indexes us (§6.5; may rate-limit/decline — surfaced via lifecycle/UI, §10).
- Add the **concierge branch** to `feed-ingest/src/tasks/outbound-cross-post.ts`: `provenance='concierge'` → sign the commit via key-custody (W2) → write to our PDS. `provenance='linked'` stays the existing OAuth-session path. Dispatch already gates on `lifecycle_state='active' AND is_valid`.

**W6 — Deprovision / tombstone (§8.1.2 — ships *with* P2, not after).** On user request or lifecycle GC of an abandoned presence:
1. **Offer export first** (invariant 4) — rotation key out before teardown, so the user can migrate the identity off-platform.
2. `lifecycle_state='deprovisioned'`; stop outbound dispatch; stop serving handle resolution (W4).
3. Tombstone: DID-doc deactivation at `plc.directory` (authorised by the rotation key) so the identity can't be impersonated-by-silence.
4. Zero key-custody secrets only **after** export is declined or confirmed complete.
Wire to a lifecycle GC sweep for dormant `provisioning`/abandoned presences (the §11 dormancy risk).

**W7 — Frontend.** Wire the stubbed "Set one up · soon" button (§10 as-built) to the provision API. Show `lifecycle_state` ("Setting up… / Active") and `is_valid=false` (handle/credential breakage) **distinctly** from healthy-but-unindexed; carry the §10 expectation-setting copy ("published to your all.haus PDS; Bluesky may take time to index them, or decline"). Surface the export + deprovision affordances.

**W8 — Validation + dark→live.** Schema/lint/hairline guards; integration-test the full arc (provision → post appears via our PDS → resolves on bsky.app → deprovision tombstones). Ship dark behind `ATPROTO_CONCIERGE_ENABLED`; enable for internal accounts first; document the operator runbook in `DEPLOYMENT.md`.
