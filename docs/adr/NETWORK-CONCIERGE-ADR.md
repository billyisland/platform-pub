# Network Concierge — Nostr root + optional satellite presences

**Status:** Accepted (2026-06-09); **three-tier model (LINKED / ASSISTED / CONCIERGE) accepted 2026-06-10** (§2). **Phase 0 + Phase 1 shipped** (2026-06-10): `network_presences` table (migration 109, subsuming `linked_accounts`), key-custody gated secret-key export + nsec backfill in `/account/export`, and the per-user Nostr public-presence opt-in `accounts.discovery_enabled` (migration 110). **UI reframe shipped** (2026-06-10, §10): `NetworkReachPanel` replaces `LinkedAccountsPanel` — per-network reach model, Nostr root folded in as the live (degenerate) concierge, atproto/AP concierge affordances rendered disabled ("coming soon"); dual-path contextual prompt in `InlineReplyBox`. **Phase 2 (ASSISTED atproto) built dark** (2026-06-10): seams S1–S6 of §6.1.1 implemented behind `ATPROTO_ASSISTED_ENABLED` (gateway `POST /linked-accounts/bluesky/assisted` reusing the LINKED OAuth path; provenance threaded through the shared callback; capability surfaced from `GET /linked-accounts`; consent gate + enabled "Set one up" wired in `NetworkReachPanel` and `InlineReplyBox`). **No DB migration, no dispatcher change** (verified). **S0 (the de-risk spike — confirm `bsky.social` renders native signup when `authorize()` is seeded with a bare PDS URL) is still outstanding and must pass against the real server before the flag is enabled.** The custodial concierge backend (now **Phase 4**) remains gated by §8.1; **proposed resolutions to the §8.1 gates are in §8.2 (pending operator ratification), and the build is planned in §13.**

**Model refinement (Accepted 2026-06-10, design review):** added a third provenance, **ASSISTED** (§2) — all.haus guides the user through the *target network's own* native signup and auto-links the result, so **the network (not all.haus) custodies the keys**. atproto's OAuth account-creation-in-flow (shipped upstream 2025-05-09) makes this a *one-redirect reuse of the existing LINKED path* — no PDS, no `did:plc`, and **none of the §8.1 custody/durability/legal gates**. ASSISTED is the default "set one up for me" (Phase 2); the custodial **CONCIERGE** path (§6.2, gated by §8.1/§8.2, built per §13) is **demoted to an optional Phase 4 justified only by the branded `username.all.haus` handle**. This document records the model and the decisions taken in design discussion.
**Scope:** Generalise all.haus from "custodial Nostr identity + read/link of other networks" to "custodial **Nostr root** identity + optional, on-demand, custodial presences on other networks that all.haus provisions on the user's behalf." This document specifies the model in full and the **atproto** satellite concretely; **ActivityPub** is named as a future phase with a stub (§9). NIP-46 remote signing and paywalled-content unlock across networks are out of scope.

---

## 1. Thesis

Signing up to all.haus means getting a **Nostr keypair**. That is the canonical identity and it does not change: minted eagerly at signup, custodial, free, mandatory (`accounts.nostr_pubkey` / `nostr_privkey_enc`, generated in `key-custody`). Every account *is* a Nostr identity.

Every other network — Bluesky/atproto, the fediverse/ActivityPub — is a **satellite presence**: optional, opt-in, and provisioned on demand. When a user wants to reach one of those networks, all.haus acts as **concierge**: it does the grubby setup work (mint the keys, register the identity, wire the handle, request federation) so the user never visits that network's signup flow. The user keeps one front door — all.haus — and reaches outward from it.

This is the natural completion of the existing custodial-Nostr model and answers `PRINCIPLES.md` ("writers own their identity") and the omnivorous-input commitment ("all means all"). It is **not** "be everywhere by default" — satellites are materialised only when asked.

---

## 2. Three ways a satellite arrives: LINKED, ASSISTED, CONCIERGE

A non-root presence arrives one of three ways. The model keeps them separate because their **key custody and posting paths** differ — though LINKED and ASSISTED differ only in *origin*, not in custody:

| | **LINKED** (today) | **ASSISTED** (new default) | **CONCIERGE** (custodial — future, §8) |
|---|---|---|---|
| Origin | user already has the account | all.haus guides them through the target network's *own* native signup | all.haus mints it on our infra |
| Who holds the keys | the network's PDS/instance (user has the password); we hold an OAuth grant | **same as LINKED** — the network custodies; we hold an OAuth grant | all.haus, custodial, in `key-custody` |
| atproto secret store | `atproto_oauth_sessions` (OAuth session + DPoP) | `atproto_oauth_sessions` (identical) | `key-custody` (signing + rotation key) |
| Handle example | `@me.bsky.social` (theirs) | `@me.bsky.social` (theirs, on Bluesky) | `me.all.haus` (ours, on our PDS) |
| Posting path | restore OAuth session → *their* PDS | restore OAuth session → *their* PDS (identical) | sign via key-custody → *our* PDS |
| `provenance` | `'linked'` | `'assisted'` | `'concierge'` |

**ASSISTED is the central move.** all.haus still "holds the door open" — one front door, reach outward — but the user signs up *on the network's own surface*, so **the network custodies the keys, not us.** The user becomes a normal, portable Bluesky/Mastodon user whose identity isn't hostage to all.haus. This dissolves the §8.1 custody/durability gate complex for the common case: no `did:plc` mint, no PDS to run, no rotation-key envelope, no durability SLA — and the §11 legal/custody posture largely evaporates.

**Enabler (verified).** atproto OAuth supports **account creation *during* the authorization flow** (shipped upstream 2025-05-09): a client initiates the *existing* OAuth flow pointed at a PDS *hostname* (no handle required), the PDS presents the full native signup (handle selection, ToS, anti-abuse), and redirects back **already authorized**. So ASSISTED-atproto **reuses the LINKED machinery verbatim** (`@atproto/oauth-client-node`, §3) — the only delta is seeding the flow with a PDS hostname instead of a user handle. Create-and-link is **one redirect chain**, not two manual steps. (Refs: [atproto.com/blog/network-account-management](https://atproto.com/blog/network-account-management), [docs.bsky.app/blog/account-management](https://docs.bsky.app/blog/account-management).)

**Custody branch is 2-way; provenance is a 3-way label.** Because ASSISTED is operationally identical to LINKED (same OAuth secret store, same dispatch path), the outbound dispatcher branches **only on custody**: OAuth-session (`linked` ∪ `assisted`) → restore session, post to the network's PDS; key-custody (`concierge`) → sign locally, post to our PDS. `provenance` keeps the three-way value to record *origin* (for support, trust, and UI honesty about who set the account up), not to fork the post path.

**CONCIERGE is demoted.** The custodial path (we mint a `did:plc`, run a PDS, hold rotation keys) survives only as an **optional future phase**, justified by the one thing ASSISTED can't deliver: a **branded `username.all.haus` handle**. It carries the full §8.1/§8.2 custody+durability gates and the §13 build. It is no longer the default and no longer on the critical path.

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
2. **Satellites are lazy.** Any non-root presence (ASSISTED or CONCIERGE) is materialised only on explicit per-network opt-in — never at signup. For custodial concierge this is doubly load-bearing: eager minting would write to `plc.directory` and create dormant PDS repos for users who never asked.
3. **Custody parity.** Concierge secrets live in `key-custody` under the same AES-256-GCM/`ACCOUNT_KEY_HEX` regime as `nostr_privkey_enc`; never plaintext in the app DB.
4. **Export-mandatory.** Every concierge identity is exportable from day one (for atproto: repo signing key **and** the did:plc rotation key — the migration anchor). Shipped together with a **backfill of nsec export for the Nostr root**, closing the standing contradiction in `export.ts`.
5. **Custodial concierge presence is native, not external.** A *custodial* concierge atproto/AP identity (on **our** PDS) is a facet of the `accounts` row, not an `external_authors` (tier-A) record. Its posts originate from the account and must **not** re-ingest as external twins — the same native-vs-external id-space discipline already enforced for Nostr (`feed_items.author_id` vs `external_author_id`). **This scopes to `provenance='concierge'` only.** A LINKED *or* ASSISTED presence lives on the *network's own* PDS/instance, so it **is** a genuine external account whose posts ride the firehose; it inherits LINKED's existing self-post dedup posture (do not treat it as native).

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
  provenance        text not null,                 -- 'linked' | 'assisted' | 'concierge' (§2)
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

**`lifecycle_state` vs `is_valid`.** `is_valid` is a health bit (credentials still work / handle still resolves); `lifecycle_state` is the presence's place in its provisioning arc. A boolean can't express "minted but not yet crawled," "user paused cross-posting," or "torn down but DID-doc tombstoned," which the custodial concierge path (with its multi-step §6.2 provisioning and the dormancy concern in §11) genuinely passes through. Outbound dispatch targets only `lifecycle_state='active' AND is_valid`, then branches **on custody, not provenance**: OAuth-session (`linked` ∪ `assisted`) → restore session, post to the network's PDS; key-custody (`concierge`) → sign locally, post to our PDS (§2).

**One presence per protocol.** The `unique (account_id, protocol)` constraint is a deliberate v1 limit: no multiple personas (e.g. two Bluesky identities) on one network per account. Lifting it later means dropping the constraint and teaching the dispatcher to fan out per-presence; recorded here so it isn't relitigated as an accident.

### 5.3 key-custody — generalised secret store
Today: `(signerId, signerType)` → `nostr_privkey_enc`, signer hardwired to `finalizeEvent`. Generalise to `(owner_id, protocol, purpose)` → encrypted secret, with:
- a **protocol-aware signer** — `finalizeEvent` for nostr, **k256 repo-commit signer** for atproto, actor-key signer for AP;
- a **provision** call (mint a keypair for a protocol, return public identifier);
- a **gated export** call (returns the decrypted secret to the authenticated owner only — backs invariant 4).

---

## 6. atproto satellite — the concrete flows

### 6.1 ASSISTED (default — §8 Phase 2)

Reuses the existing LINKED OAuth path (`@atproto/oauth-client-node`, `atproto_oauth_sessions`); the only deltas are *how the flow is seeded* and *the provenance written*. On "set one up for me" → Bluesky:

1. Begin the **existing OAuth authorization flow**, seeded with the **PDS hostname** (`bsky.social`) instead of the user's handle (atproto's account-creation-in-flow, §2).
2. Hand off to Bluesky's hosted auth surface; the user completes native signup there (handle, ToS, anti-abuse). **Bluesky custodies the keys.**
3. The PDS redirects back **already authorized**; persist the OAuth session exactly as LINKED does.
4. Write the `network_presences` row `provenance='assisted'`, `lifecycle_state='active'`, `external_id`=DID, `handle`=`@chosen.bsky.social`, `service_url`=Bluesky's PDS.

No `did:plc` mint, no PDS, no key-custody secret, **none of the §8.1 gates**. Outbound dispatch uses the unchanged LINKED branch (restore OAuth session → post to Bluesky's PDS). Deprovision is just OAuth-grant revocation + row teardown — the user's Bluesky account persists (it's theirs), so there is **no tombstone obligation** (contrast §6.2).

#### 6.1.1 Implementation seams (build checklist)

This phase is **reuse, not new machinery** — verified against the tree (2026-06-10). The premise holds: the installed `@atproto/oauth-client-node@0.3.17` resolver accepts a **PDS URL** as `authorize()` input (not only a handle/DID), so the create-and-link flow is the *existing* OAuth path seeded differently. The `network_presences` write path, the OAuth session store (`atproto_oauth_sessions`), and the outbound dispatcher all already exist and already handle `'atproto'`. Six seams, ordered; everything else is unchanged.

Sequencing: **S0 (spike) → S4 (flag) → S1 ∥ S2 ∥ S3 (backend) → S5 ∥ S6 (frontend)**. No DB migration (the `provenance` column already takes `'assisted'`; `network_presences.provenance` is free-text per §5.2). No dispatcher change (confirmed below).

**Build status (2026-06-10): S1–S6 implemented dark behind `ATPROTO_ASSISTED_ENABLED`; S0 still outstanding (external — must run against the real `bsky.social` before flag-on).** One refinement landed vs. the plan: the S4 flag is surfaced to the UI as a `capabilities.assistedBluesky` field on the existing `GET /linked-accounts` response (single source of truth — the gateway env), rather than mirroring the flag into a `NEXT_PUBLIC_*` web var; the panel reads it from the list it already fetches, and `InlineReplyBox` reads it via a session-cached `getNetworkCapabilities()`.

- **S0 — De-risk spike (do first, before any code).** The one thing un-verifiable from the installed lib: does `bsky.social`'s authorization server actually render *native signup* (handle/ToS/anti-abuse) when handed a bare PDS URL with no existing session, then redirect back authorized? Drive `client.authorize('https://bsky.social', { state, scope })` once against the real server (or a test PDS) and confirm the round-trip. If signup-in-flow is gated/changed upstream, the whole phase re-plans — so this is W0, not a detail.

- **S1 — Entry endpoint.** Add `POST /linked-accounts/bluesky/assisted` in `gateway/src/routes/linked-accounts.ts` (sibling to the `:362` link route). It is the link route with two deltas: (a) **skip the handle-normalisation block** (`:372–385`) — seed `client.authorize(...)` with the PDS URL from a new env `ATPROTO_DEFAULT_PDS` (default `https://bsky.social`) instead of a user handle; (b) write the intent into the state cookie (S2). Same PAR+PKCE+DPoP, same `redirect_uri`, same `scope: "atproto transition:generic"`, same returned `{ authorizeUrl }`. Gate on the S4 flag (503 when off).

- **S2 — State cookie carries provenance.** Add `provenance: 'assisted'` to the `oauth_state_bluesky` JSON payload (`:393`). The link route keeps writing `'linked'` (or omits it). The cookie is the only channel that survives the redirect to tell the *shared* callback which flow returned.

- **S3 — Callback threads provenance.** The existing callback (`:436`) already serves both flows — `authorize()` returns to the one `redirect_uri` regardless of seeding — so **do not add a second callback**. Read `statePayload.provenance` (default `'linked'` for back-compat) and substitute it for the two hardcoded `'linked'` literals in the upsert (`:485` INSERT value, `:490` `DO UPDATE SET`). Session storage, the AppView profile lookup, and the `network_presences` upsert are byte-for-byte identical. The DID + chosen handle come back from Bluesky exactly as in the link flow.

- **S4 — Flag.** `ATPROTO_ASSISTED_ENABLED` (mirrors `DISCOVERY_PUBLISH_ENABLED` / `ATPROTO_CONCIERGE_ENABLED`). Gates the S1 endpoint and the S6 button. Phase ships dark behind it per §8.

- **S5 — Consent gate (not just copy).** The user is creating a *real Bluesky account* mid-redirect, so §10's honesty must be an **explicit acknowledgement step** before `window.location.href = authorizeUrl`, not ambient helper text: "You're about to create a real Bluesky account on bsky.social. Bluesky holds the keys; all.haus just connects it. You can disconnect anytime." Confirm-to-proceed.

- **S6 — Frontend wiring.** Flip the disabled **"Set one up · soon"** button in `web/src/components/account/NetworkReachPanel.tsx` (`:248–253`) to an enabled action that runs the S5 consent gate then calls a new `linkedAccounts.assistedBluesky()` client method → S1 endpoint → `window.location.href` redirect (mirror `handleConnectBluesky`, `:103–115`). Point the `InlineReplyBox` dual-path prompt's "all.haus can set one up" branch (§10) at the same entry. Both gated on the S4 flag (keep "· soon" when off). Mastodon's button stays disabled (Phase 3, §9).

**Dispatch needs no change (verified).** `feed-ingest/src/tasks/outbound-cross-post.ts` selects targets by `la_is_valid && la_lifecycle_state === 'active'` (`:124`) and branches on *credential type* (OAuth session vs `credentials_enc`), **never on `provenance`** — so an `'assisted'` atproto row, whose OAuth session sits in `atproto_oauth_sessions` identically to a linked one, flows through the existing atproto branch untouched. This is the §2 "branch on custody, not provenance" invariant already realised in code.

**Residual after S0–S6:** an `'assisted'` row is operationally a linked row with a different origin label, so disconnect = OAuth-grant revoke + row teardown (the user's Bluesky account persists) — the existing `DELETE` path (`:125`) already covers it. No tombstone, no key-custody, no export obligation (the keys were never ours). Estimated: half a day of code behind the S0 spike.

### 6.2 CONCIERGE (custodial — future, gated; §8 Phase 4)

The optional branded-handle path: only here does all.haus mint and custody the identity. It exists solely to deliver `username.all.haus` (the one thing ASSISTED can't), and carries the full §8.1/§8.2 custody+durability gates and the §13 build. Everything below is this path.

**DID method: `did:plc`** (decided — federates cleanly and gives a real migration story via rotation keys; accepts the `plc.directory` dependency). **PDS: run `@atproto/pds` as a sibling service** (the strfry pattern); `network_presences` is its projection, not the source of truth for repo data.

Provisioning, on opt-in:
1. key-custody mints the **signing key** + **rotation key** (k256), encrypted under `ACCOUNT_KEY_HEX`.
2. Register a `did:plc` at `plc.directory` (rotation key authorises future DID-doc changes — the ownership anchor).
3. Create the repo on our PDS; set handle `username.all.haus`.
4. Serve handle resolution at `https://username.all.haus/.well-known/atproto-did` (per-`Host` across a wildcard cert — the direct analog of the existing DB-driven `/.well-known/nostr.json`).
5. `requestCrawl` to Bluesky's Relay so the AppView indexes us and content appears on bsky.app.
6. Write the `network_presences` row (`provenance='concierge'`, `external_id`=DID, `handle`, `service_url`=our PDS).

Handle follows username changes (DID stable, handle mutable — `accounts.username_changed_at`/`previous_username` already exist). Outbound dispatch (`outbound-cross-post.ts`) branches on **custody, not provenance** (§2): **linked ∪ assisted** → restore OAuth session, post to the network's PDS; **concierge** → sign via key-custody, post to our PDS.

**Deprovisioning (shipped with P2, not deferred).** A concierge presence is a live federating identity, so teardown is a first-class path, not a GC afterthought (it answers the dormancy risk in §11). On user request (or lifecycle GC of an abandoned presence): set `lifecycle_state='deprovisioned'`, stop outbound dispatch, and tombstone the identity rather than silently abandoning it — for atproto, update the DID doc (authorised by the rotation key) to deactivate the account so it can't be impersonated-by-silence, and stop serving its handle resolution. The export escape hatch (invariant 4) must be offered *before* teardown so the user can migrate the identity off-platform via the rotation key if they want to keep it. key-custody secrets are zeroed only after export is declined or confirmed complete.

---

## 7. Nostr "concierge" is degenerate

Nostr needs no new provisioning — it's the root, already minted. "Go public on Nostr" simply means flipping the **existing** `DISCOVERY_PUBLISH_ENABLED` machinery (kind 0/3/10002 + NIP-05) to a **per-user opt-in toggle**. The producers and outbox path already exist (`NOSTR-OUTBOUND-INTEROP-ADR`); this phase only exposes the switch.

---

## 8. Phasing (dark-ship, per-network flags)

- **Phase 0 — foundation (no user-facing change).** ✅ shipped. `network_presences` table + `linked_accounts` migration; key-custody generalisation groundwork; **export incl. nsec backfill** (invariant 4).
- **Phase 1 — Nostr public presence.** ✅ shipped. Wire existing discovery to a per-user opt-in (§7).
- **Phase 2 — ASSISTED atproto.** ✅ **built dark** (2026-06-10; S1–S6 of §6.1.1). "Set one up for me" → Bluesky via OAuth account-creation-in-flow (§6.1). **Reuses the LINKED path** — no PDS, no `did:plc`, **no §8.1 gates**. Behind flag `ATPROTO_ASSISTED_ENABLED`. **This is the new default satellite path.** Remaining before flag-on: the **S0 de-risk spike** against the real `bsky.social` (§6.1.1).
- **Phase 3 — ASSISTED activitypub.** Same shape, but "which instance?" has no clean default (most instances gate registration) — likely a curated instance picker + hand-off, or ship AP linking only and defer. See §9.
- **Phase 4 — CONCIERGE (custodial, optional).** Branded `username.all.haus` handles: PDS service, `did:plc` mint, Relay crawl, custodial dispatch branch, deprovision/tombstone (§6.2). **Gated by §8.1/§8.2, built per §13.** Demoted — ships only if the branded handle proves worth the custody+durability burden. The atproto/AP concierge flags live here, not in Phases 2–3.

Each phase ships dark behind its own flag, mirroring `DISCOVERY_PUBLISH_ENABLED`.

### 8.1 Custodial-concierge entry criteria (gating, not "revisit later")

**(Renumber, 2026-06-10:** these gates and §8.2/§13 now attach to **Phase 4** — custodial concierge — since ASSISTED (Phases 2–3) needs no custody/PDS. Read every "P2" below as "the custodial phase.")

Minting `did:plc` identities and running a PDS converts all.haus from "publishes signed events" into "custodies cross-network identities and persists their canonical repos." That is qualitatively heavier than the relay, so the following are **prerequisites to P2 shipping**, promoted out of §11's open-questions list:

1. **Rotation-key custody posture decided.** A compromise of `ACCOUNT_KEY_HEX` after P2 leaks did:plc rotation keys — i.e. permanent theft of cross-network identities, not just relay impersonation. Invariant 3 ("custody parity") is convenient but pulls against this: rotation keys may warrant a stronger envelope than parity-of-mechanism (separate key, HSM, or split custody). Resolve before, not during, P2. **→ proposed resolution in §8.2.**
2. **Deprovision/tombstone path implemented** (§6.2) and wired to lifecycle GC for abandoned presences. No P2 ship with provision-only. **→ build work, specified as §13 W6.**
3. **PDS durability SLA stated and met.** `network_presences` is a projection; the PDS store now holds canonical identity repos. Backups, blob storage, and uptime are part of users' identity persistence — losing the PDS loses their Bluesky presence. Define the durability/restore story explicitly (§11 names the impedance; this makes it a gate). **→ proposed targets in §8.2.**

### 8.2 Custodial-concierge (Phase 4) entry-criteria — resolutions (**Proposed — pending operator ratification**)

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

## 9. ActivityPub satellite (future — stub)

Two tiers mirror §2, but the split is sharper than atproto's because AP has no single canonical instance:

- **ASSISTED (Phase 3, preferred).** Guide the user through native signup on an *existing* instance, then OAuth-link (`provenance='assisted'`) — the AP analog of §6.1. The hard part is "which instance?": most instances gate registration (approval/invite), and there's no `bsky.social`-equivalent default. Likely a curated instance picker + hand-off; where no instance permits programmatic create-and-link, fall back to AP **linking** only (LINKED).
- **CONCIERGE (custodial, deferred).** all.haus lazily materialises an actor `@username@all.haus` (i.e. becomes a federating instance): actor keypair in key-custody, serve actor/inbox/outbox + WebFinger, `network_presences` row `provenance='concierge'`, `protocol='activitypub'`. Heavier than atproto on the operational axis (moderation, deliverability, abuse handling as a full instance; weaker account-migration/portability than atproto's rotation-key story).

Designed in a follow-up ADR before any code.

---

## 10. UI reframe

`LinkedAccountsPanel` → **"Reach other networks."** Two affordances per network: **"I already have one"** (link/OAuth — today's path, LINKED) and **"Set one up for me"** (ASSISTED — guides the user through the network's own native signup and auto-links). For atproto the latter is a single OAuth hand-off (§6.1), so the honest framing is **"you'll create a normal Bluesky account; Bluesky holds the keys, all.haus just connects it"** — not custody-on-our-side. (The custodial branded-handle option, with its heavier "we hold the keys / export escape hatch" honesty, is a *future* Phase 4 add, §6.2.)

**As built (2026-06-10).** `web/src/components/account/NetworkReachPanel.tsx` (replaces `LinkedAccountsPanel`; old `PrivacyPreferences.tsx` retired into it). Per-network rows: **Nostr** is first-class (the root) with a `Public / Private` discovery toggle (the degenerate concierge, §7 — relocated wholesale from `PrivacyPreferences`, including the nested follow-list sub-toggle); **Bluesky / Mastodon** show `Link yours` (existing OAuth, unchanged) plus a **disabled "Set one up · soon"** affordance. *Model refinement (§2):* the Bluesky "set one up" button now clears on **Phase 2 (ASSISTED, §6.1)** — it is **no longer gated on §8.1** and wires to the OAuth account-creation hand-off, not to custodial provisioning. Mastodon stays "soon" pending Phase 3's instance question. The contextual entry point — `InlineReplyBox`'s no-presence prompt on an external card — is dual-path: "Connect your {network} account → Settings" **and** "Don't have one? all.haus can set one up for you." This ships the full journey *shape* (Nostr working, atproto next, AP pending); wiring the Bluesky button to the ASSISTED OAuth flow is the only remaining UI change when Phase 2 lands.

**Expectation-setting (atproto — *custodial* concierge only).** This caveat applies to the Phase 4 custodial path (our PDS); ASSISTED accounts live on Bluesky's own PDS and index normally. Whether a *custodial* concierge post actually *appears* on bsky.app depends on Bluesky's Relay/AppView choosing to index us (`requestCrawl`, §6.2 step 5 / §11) — outside our control. The UI must say so: a concierge presence reports its `lifecycle_state` ("setting up… / active") and frames publishing as "your posts are published to your all.haus PDS; Bluesky may take time to index them, or decline." Without this the concierge reads as broken whenever the Relay rate-limits or lags. Likewise surface `is_valid=false` (handle/credential breakage) distinctly from a healthy-but-unindexed presence.

---

## 11. Risks / open questions

- **`plc.directory` dependency** — soft-centralised registry run by Bluesky PBC; rate limits and availability are external.
- **Relay-crawl refusal** — appearing on bsky.app depends on Bluesky's Relay/AppView choosing to index us; they can rate-limit or decline.
- **Custody blast radius** *(Phase 4 / custodial only)* — holding rotation keys widens what a compromise of `ACCOUNT_KEY_HEX` exposes (cross-network identities, not just Nostr). **A Phase 4 entry criterion (§8.1.1), not a deferral. ASSISTED holds no keys and sidesteps this entirely.**
- **Dormant presences** *(Phase 4 / custodial only)* — provision-then-abandon needs a GC/lifecycle story. **Addressed by the `lifecycle_state` column (§5.2) + deprovision/tombstone path (§6.2), gated into Phase 4 (§8.1.2).** ASSISTED's "dormancy" is just an unused OAuth grant — revoke + delete the row, the user's own account persists.
- **Legal posture** *(Phase 4 / custodial only)* — operating network identities on users' behalf; ToS and abuse liability. **ASSISTED avoids this: the user signs the network's own ToS during native signup and owns the account; all.haus is merely a connected OAuth client, as with LINKED today.**
- **`@atproto/pds` ↔ single-Postgres impedance** — the PDS keeps its own store and keys; accepted as a sibling-service seam (like strfry), with `network_presences` as a mirror, not the source of truth.

---

## 12. CLAUDE.md additions (on acceptance)

Add an invariant block under "Architecture → Invariants" stating: Nostr-root (signup mints the canonical custodial Nostr key); the three-tier LINKED / ASSISTED / CONCIERGE distinction (§2 — ASSISTED is the default satellite path, custody on the network's side; CONCIERGE is custodial and demoted to the branded-handle Phase 4); satellites-are-lazy; custody-parity in key-custody (concierge only); export-mandatory; **custodial**-concierge-presence-is-native-not-external (ASSISTED/LINKED are genuine external accounts). Dispatch branches on custody, not provenance. Rule-plus-pointer to this ADR.

---

## 13. Phase 4 — custodial atproto concierge — implementation plan

> **Note (2026-06-10):** this is the *custodial branded-handle* path (`provenance='concierge'`), now **Phase 4** — not the default. The default atproto reach is **ASSISTED** (§6.1, Phase 2), which reuses the LINKED OAuth path and needs none of the workstreams below. Build this only if the branded `username.all.haus` handle proves worth the custody+durability burden.

Builds the §6.2 flow into ordered workstreams. **Status: not started** — gated on §8.2 ratification (W0). Ships dark behind its own flag `ATPROTO_CONCIERGE_ENABLED` (mirroring `DISCOVERY_PUBLISH_ENABLED`, §8). The schema already receives it: `network_presences.provenance`/`lifecycle_state` exist (P0), and the dispatcher has the OAuth-session path (`linked` ∪ `assisted`) with an empty slot for the custodial branch (W5). Sequencing: **W0 → (W1 ∥ W2) → W3 → W4 → W5 → W6 → W7 → W8.** W6 is non-optional for first ship (§8.1.2).

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
