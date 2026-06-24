# Upstream Edges — Credit, Tribute, Citation

**Status:** Accepted (rewrite 2026-06-22). Supersedes the 2026-06-21 draft: tribute is reworked from a payout-time deduction (mirrored double-entry pair, per-cycle) to **settlement-time apportionment with a held accrual** — the inspirer becomes a co-earner, paid through the ordinary writer flow. Also supersedes the separate Span-Pinned Citations ADR.
**Depends on:** `articles`, `accounts`, `ledger_entries` (append-only), `read_events`, `external_items`, strfry event store, the universal resolver (`POST /api/resolve`).
**Companion:** `UPSTREAM-EDGES-BUILD-PLAN.md` (what to build, in order).

## Summary

A piece stands on prior work. This ADR defines three independent ways to mark that debt, each a directed edge from the piece to a source:

- **Credit** — *"this work draws on X."* The author's public acknowledgement of intellectual debt. No money, no consent, piece-level.
- **Tribute** — money. A share of the writer-side earnings on the piece, routed to the source as a **co-earner**. Apportioned at the point of sale, held until the source resolves, never lost.
- **Citation** — *"X argues Y."* A faithfulness claim about a specific, checkable thing a source said, pinned to source bytes. No money, no consent.

They are orthogonal: any one can occur without the others. A whole tradition can warrant a credit with nothing quotable; a rival's claim can warrant a citation you owe nothing for; gratitude can warrant a tribute with no specific quote.

## The distinction (terminology, used consistently below)

| | Credit | Tribute | Citation |
|---|---|---|---|
| Question | Do I owe this source? | Am I paying that debt? | Did I quote this source correctly? |
| Carries money | No | Yes | No |
| Needs consent | No | To *receive*, yes | No |
| Granularity | Whole piece | Whole piece | A pinned span |
| Needs a quotable claim | No | No | Yes |
| Source must be reachable | No | To be *paid*, yes — unreachable share is held, then returned to the author | No |
| Recourse for the source | Disclaimer | Decline the money (it returns to the author) | Dispute |

- **Inspirer** — a tribute's recipient (the co-earner).
- **Disclaimer** — a counter-edge against a credit ("I reject this attribution").
- **Dispute** — a counter-edge against a citation ("you misread me").

Disclaimer and dispute are the same primitive (`dispute_edges`); they differ only in target and rendering.

## Decisions

1. **Three separate edges, three tables.** Credit, tribute, and citation are first-class and independent. (The prior draft folded credit into the tribute as a "name axis"; that is replaced — credit is now its own edge.)
2. **Credit is piece-level only.** It renders as an endnote; no span anchoring on the author's own piece.
3. **Tribute is apportioned at settlement, not deducted at payout.** When a paywalled read settles on a tributed piece, the writer-side net is partitioned at that moment: the author's share flows the ordinary writer payout; the inspirer's share is frozen into a held `tribute_accruals` row. The inspirer is treated as a **co-earner of the piece**, exactly as a second author on a revenue split would be — structurally the same mechanic publications already use to split an article's revenue among members. There is no per-cycle deduction and no reconstruction of per-piece earnings at payout time.
4. **The inspirer's share is held until it resolves — money is never lost.** *(Reverses the prior draft's "never a held reserve".)* A held accrual is money the platform has collected but not yet attributed to a final owner. While held it **reduces the author's payable** (the author can't be paid money that may go to the inspirer). On consent → it is paid to the inspirer through the ordinary writer flow. On decline / window-lapse → it is **swept back to the author's payable**. The author is always the terminal home. This is the same posture the platform **already** runs: an un-onboarded writer's earnings sit collected-but-unpaid in `read_events`/`platform_settled` ("earnings accrue and are held until verification completes") until they connect a bank. The held tribute share is the same idea, keyed to the tribute rather than an account.
5. **Consent gates the destination of the held share, not whether it is apportioned.** Apportionment starts at tribute **creation**. Consent decides only whether the held share is released to the inspirer or swept back to the author. To *receive*, the inspirer must be (or become) a native account with completed Stripe Connect onboarding — consent and bank-onboarding are the two gates on release, never on apportionment.
6. **Identify omnivorously; contact narrowly.** The "who is the inspirer" field is the universal resolver (accepts username / email / npub / DID / handle / URL). But a money *offer* is delivered only over sober channels — **in-app for an existing member, email for an external person — never the source network's DMs** (a money offer in a social DM reads as a scam, and would feel unserious). An external inspirer for whom no email can be obtained is unreachable: the share is held, then returned to the author.
7. **No double-entry pair.** The author's payout is simply smaller (net of any non-swept accruals); the inspirer's income is one ordinary single-entry credit (`tribute_payout`, `counterparty_id = author`, the same shape as a `vote_charge` upvote). Money is conserved per read: author-share + Σ(tribute accruals) == the read's writer-side net.
8. **Native/Nostr citations and disputes are signed events; other sources are Postgres-only.** Native and Nostr sources emit addressable events (correct-in-place, `p`-tag notification). ATProto / ActivityPub / RSS / email sources carry no `naddr` or pubkey, so those citations live only in the index row.
9. **A dispute may be filed only by an account holder (account + pubkey).** No anonymous disputes — a third-party dispute requires a refundable stake, a stake requires a ledger entry, and that requires an account.
10. **A dispute may re-pin a wider span.** The disputant can quote a wider excerpt + hash to expose context-stripping.
11. **The dispute stake refunds on withdrawal only, and is never forfeited.** No dwell-refund, no correction-refund, no forfeiture-on-"losing" — each would smuggle a verdict in.
12. **Not moderation, not ranking, not reputation.** No takedowns, no `feed_scores` input, no computed credibility score. Do not route through `trust_*`.

## Schema

Sketch; the build plan fixes indexes, PKs, and FK constraints.

### credit_edges
```sql
CREATE TABLE credit_edges (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id),
  target_kind text NOT NULL,                    -- native | unaddressable | <external_protocol>
  target_protocol public.external_protocol,     -- NULL for native/unaddressable; CHECK consistent with target_kind
  target_external_id text,                      -- npub / DID / handle / email
  target_display_name text,                     -- fallback for unaddressable
  resolved_account_id uuid REFERENCES accounts(id),
  note text,                                    -- the author's gloss on the debt
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
```
`target_kind` (free text) and `target_protocol` (enum, NULL = native) overlap — the build plan adds a CHECK tying them, or drops `target_kind` in favour of the NULL-protocol-means-native convention `citation_edges` uses.

### tributes
```sql
CREATE TABLE tributes (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id),
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  percentage_bps int NOT NULL CHECK (percentage_bps BETWEEN 1 AND 10000),  -- share of the piece's writer-side net
  target_kind text NOT NULL,                    -- native | unaddressable | <external_protocol>
  target_protocol public.external_protocol,
  target_external_id text,
  target_display_name text,
  resolved_account_id uuid REFERENCES accounts(id),    -- set when the inspirer is a known/onboarded account
  status text NOT NULL,                         -- proposed | live | declined | lapsed
  invite_email text,                            -- external-contact branch only
  first_contact_at timestamptz,
  window_expires_at timestamptz,
  consent_at timestamptz,
  citation_edge_id uuid REFERENCES citation_edges(id),  -- optional composition seam (wired last)
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
```
The sum of a piece's live+proposed `percentage_bps` must leave the author a meaningful share — the build plan adds the cross-row ceiling (no per-row CHECK can express it). `proposed` = created and accruing, awaiting the inspirer; `live` = consented + onboarded; `declined`/`lapsed` = resolved against the inspirer. An unreachable external inspirer stays `proposed` until the window lapses.

### tribute_accruals
```sql
CREATE TABLE tribute_accruals (
  id uuid PRIMARY KEY,
  tribute_id uuid NOT NULL REFERENCES tributes(id),
  read_event_id uuid NOT NULL REFERENCES read_events(id),
  amount_pence bigint NOT NULL,                 -- frozen at settlement (fee bps of the moment), never recomputed
  beneficiary_account_id uuid REFERENCES accounts(id),  -- NULL while held (inspirer not yet resolved)
  state text NOT NULL,                          -- held | released | paid | swept
  created_at timestamptz NOT NULL DEFAULT now()
);
```
This is the inspirer's **suspense**, and it lives **here, not in `ledger_entries`** — `ledger_entries.account_id` is `NOT NULL` and a held share has no final owner yet, so (exactly as unpaid writer earnings sit in `read_events` until payout) the held share sits in this domain table and only touches the ledger when it reaches a real account. Lifecycle: `held` (accruing, reduces author payable) → `released` (inspirer consented + onboarded; will pay out to them) → `paid` (transferred; `tribute_payout` ledger entry posted) | `swept` (declined/lapsed; returned to the author's payable in a later cycle). One row per (live tribute, settled read).

### citation_edges
```sql
CREATE TABLE citation_edges (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id),
  source_protocol public.external_protocol,     -- NULL = native all.haus source
  source_author_pubkey text,                    -- native/Nostr only; for p-tag + dispute privilege (joined from accounts for native)
  nostr_event_id text,                          -- native/Nostr only
  nostr_d_tag text,                             -- native/Nostr only; addressable, corrects in place
  source_naddr text,                            -- native/Nostr only; synthesised 30023:<pubkey>:<d_tag> for native
  source_version_event_id text,                 -- best-effort; see note — NOT a byte-stable guarantee for native
  source_external_item_id uuid,                 -- non-Nostr ingested source
  source_uri text,
  excerpt text NOT NULL,                        -- carried with the edge — the actual integrity anchor
  excerpt_sha256 bytea NOT NULL,                -- self-contained: survives source supersession
  char_start int,
  char_end int,
  characterisation text NOT NULL,               -- "X argues Y"
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
```
**The `excerpt` + `excerpt_sha256` ARE the integrity mechanism** — store them at citation time and the edge is self-contained. `source_version_event_id` is *best-effort, not a guarantee*: native NIP-23 articles are replaceable and `articles.nostr_event_id` is overwritten in place on every republish, signed bytes are never retained in Postgres, and the original `created_at` per version is not stored — so a byte-identical native version generally **cannot** be reproduced or pinned. Treat the field as a hint, nullable. (Persisting signed event bytes per version — an `article_event_versions` table written at publish — is the only way to make it a true guarantee; deferred, see Deferred.) For native sources `source_protocol` is NULL; `source_author_pubkey`/`source_naddr` are derived by joining `accounts` and synthesising the coordinate (no native naddr is stored today).

### dispute_edges
```sql
CREATE TABLE dispute_edges (
  id uuid PRIMARY KEY,
  citation_edge_id uuid REFERENCES citation_edges(id),
  credit_edge_id uuid REFERENCES credit_edges(id),
  disputant_account_id uuid NOT NULL REFERENCES accounts(id),
  disputant_pubkey text NOT NULL,
  is_by_cited_author boolean NOT NULL,          -- pubkey match vs citation_edges.source_author_pubkey
  nostr_event_id text,                          -- native/Nostr targets only
  nostr_d_tag text,                             -- addressable: disputant revises in place
  wider_excerpt text,                           -- optional re-pin to expose stripped context
  wider_excerpt_sha256 bytea,
  counter_characterisation text NOT NULL,
  stake_ledger_entry_id uuid REFERENCES ledger_entries(id),  -- required for third-party disputes
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((citation_edge_id IS NULL) <> (credit_edge_id IS NULL))  -- exactly one target
);
```
A dispute against a credit renders as a disclaimer; against a citation, as a dispute. The cited author is identified by `is_by_cited_author` (pubkey match) and stakes nothing; anyone else holds a stake.

## Ledger

**Three** new `LedgerTriggerType` values (down from the prior draft's four — `writer_accrual` is no longer needed, and the `tribute_payout` *pair* is replaced by a single entry). Register each writing file in `scripts/check-ledger-adjacency.sh`'s `REGISTRY`, **extend its `MARKERS` regex** to match the new write sites (today it keys off `balance_pence` writes and three specific `INSERT INTO` tables — it would not otherwise see `tribute_accruals`/`tributes`/`dispute_edges` inserts or direct `ledger_entries` inserts, so registration would not be enforced), and extend the migration-120 views + `scripts/reconcile-ledger.sql`, or CI fails.

- `tribute_payout` — a **single** entry, `+share`, `counterparty_id = author` (provenance; same shape as a `vote_charge` upvote, which already carries a non-NULL counterparty). Written when a tribute's `released` accruals are paid out to the inspirer through the ordinary writer flow. **No mirrored debit** — the author's reduction is implicit in their smaller `writer_payout`.
- `dispute_stake` — `−amount`, `counterparty_id = NULL`. Hold against a third-party disputant's tab.
- `dispute_stake_refund` — `+amount`, `counterparty_id = NULL`. Fires on dispute withdrawal only.

**Accounting rule — do not deviate.** The writer-side net of a tributed read is partitioned at settlement among the author and the live tributes; the partition is *conserved* (author-share + Σ accruals == the read's net, no clamp, no rounding loss outside the platform's existing per-row dust rule). The author's `writer_payout` is the ordinary net **minus** any `held`/`released`/`paid` accrual carved off their reads, **plus** any `swept` accrual returned to them — never the full pre-tribute net alongside a separate debit (that would double-subtract). The inspirer's `tribute_payout` equals the `released`→`paid` accruals for that tribute. Because the author is paid net-of-tribute, `writer_payouts.amount_pence` already equals the actual Stripe transfer and the ledger entry — reconcile A4 holds unchanged.

**Held accruals are not platform income and not yet writer earnings.** They sit outside `ledger_entries` entirely, so the views need no carve-out for them; `ledger_platform_tax` (already filtered to `vote_charge`) is unaffected. **`ledger_writer_earnings` must add `tribute_payout`** to its hardcoded trigger list so the inspirer's income counts as earnings (the author's reduced `writer_payout` already reflects the carve-out). Reconcile must assert: every `paid` accrual maps to a `tribute_payout` entry and Σ(a tribute's `paid` accruals) == its `tribute_payout` total; no `held` accrual has a ledger entry; and per-read conservation (author-share + Σ accruals == net). Stake↔refund pairing (every withdrawn dispute with a stake has a paired refund) is likewise net-new.

## Prerequisites

Far smaller than the prior draft (which demanded per-piece-per-cycle writer accrual and a unified piece-granularity ledger read — both dissolved by apportioning at settlement instead of payout). Tribute writes need only:

1. **Settlement-time apportionment.** When a paywalled read settles on a tributed piece, partition the writer-side net and write a frozen `tribute_accruals` row per live tribute. This is the one genuinely new primitive; it is the same "credit N co-earners of a piece, not just `writer_id`" attribution that real co-authorship would need, so building it as a general per-read attribution layer (rather than a tribute-only side-table) is worth weighing in the build plan.
2. **Payout nets accruals + an inspirer payout path.** The writer sweep pays the author net of non-swept accruals on their reads and returns swept accruals to them; a released tribute's accruals pay out to the inspirer (a native, Connect-onboarded account) and post `tribute_payout`.

Credit, citation, and dispute schema + reads ship before these and need none of them.

## Endpoints (gateway)

- `POST /credits` — author; publishes with the piece.
- `POST /citations` — author; pins source bytes + hash.
- `POST /tributes` — author. Identifies the inspirer via `POST /api/resolve` (omnivorous). Starts `proposed`; accrual begins at the next settlement. If the resolver matches an existing member → in-app offer immediately. If not → the author supplies `invite_email` and we send the onboarding mail (below). The author-visible result is uniform regardless of whether an internal match was found (no account-existence oracle).
- `POST /tributes/:id/consent` / `/decline` — inspirer. Consent (and Connect onboarding) → `live`, sets `resolved_account_id` + `consent_at`, flips the tribute's `held` accruals to `released`. Decline → `declined`, accruals `swept`.
- `POST /disputes` — citation or credit target. Cited author (pubkey match): no stake. Anyone else: hold a `dispute_stake`, store its ledger entry id.
- `DELETE /disputes/:id` — disputant only; fires `dispute_stake_refund` if a stake was held.
- `GET /articles/:id/credits` — credits with any disclaimers.
- `GET /articles/:id/citations` — citations with dispute counts; cited-author disputes flagged for inline render.

## Inspirer contact

Identification is omnivorous (the resolver); delivery of the offer is deliberately narrow and sober.

- **Existing member** → an in-app notification of the offer, which **also grants free comp access to the piece** so the inspirer can read what they're being credited for before deciding. Accept → the released share lands in their existing balance. (Comp access is kept, not revoked on decline — it would be petty to claw back a courtesy read from someone you tried to pay.)
- **External, with an email** → an auto-generated email to the inspirer carrying a unique magic-link that, on signup, binds the new account to this tribute (and grants the same comp read). The author is **CC'd a token-redacted reference copy** (transparency without handing the author the claim link), and is encouraged to follow with a personal note — both to convey the spirit of the tribute and to help the offer past spam filters, machine and psychological.
- **External, no email obtainable** → unreachable. The share is held and, at window's end, returned to the author. We do not downgrade to a social DM.

Window: 60 days from `first_contact_at`, one reminder at 30. No response → `lapsed`; the credit (if any) still stands, and the held share is swept to the author. A lapsed or declined tribute goes `live` later only on the inspirer's own initiative; the author cannot re-ping. **Deliverability is a real risk** — an unsolicited "someone is giving you money" email reads exactly like a scam — but the held-accrual model is the cushion: a slow, skeptical, or spam-foldered inspirer loses nothing, because the money waits for them.

## Rendering

- **Credit** — endnote block at the piece foot. Disclaimers render adjacent to the credit they reject.
- **Citation** — at the citation point. A cited-author dispute shows one inline marker (max one — high-signal, can't be manufactured by volume). Third-party disputes are visible on expansion only, never as glance-level badges regardless of count. Expansion shows the characterisation, the pinned excerpt (expandable to surrounding context), and counter-claims (cited-author first).
- **Tribute** — a static metadata line ("X% of this piece's earnings goes to Y"), status shown honestly (proposed-and-accruing / live / declined / lapsed). An unaddressable or unreachable target is shown as accruing-and-held with no live payee.

## Edge cases & limits

- **Paywalled spans — v1 hole, where the value is.** A citation can't expose plaintext a reader hasn't unlocked. v1 restricts span-citation to `content_free` and the viewer's own decrypted copy — the server never holds the paid half (it's NIP-44/xchacha, decrypted client-side only), so paid-content spans are checkable only on the viewer's own copy. Paid specialist content — the highest-value material to ground — is uncitable for grounding in v1.
- **Holding third-party funds — compliance position drafted (`UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`, 2026-06-23).** The mechanism is identical to holding an un-onboarded writer's earnings — the platform runs Stripe Connect *separate charges and transfers*, so every unpaid earning already sits in the platform's Stripe float between settlement and payout; the tribute hold is the same money in the same balance. The resolution turns on **whose money it is**: until the inspirer consents there is no payable to them (an unaccepted offer creates no claim), so the held share is **still the author's deferred earnings under a revocable redirect instruction**, not third-party client money — defensible *provided* it is framed and represented that way (author terms = revocable redirect of the author's own earnings; inspirer contact = a *conditional offer*, never "funds held in your name"; no separate ring-fenced account; honest "reserved, pending redirect" display). The memo keeps the accrue-from-creation model, lists the residual points only a compliance owner can sign (chiefly the platform's pre-existing baseline reliance on Stripe as the regulated PI/EMI), and gives two conservative fallback dials (consent-gated accrual; Stripe funds segregation). The Phase-2 contact/render copy audit to the "conditional offer" wording is **done (2026-06-23)**; **Phase 3 now stays gated solely on the compliance owner confirming the memo's residual checklist.**
- **Ingested sources.** For ATProto / ActivityPub / RSS, pin the stored snapshot + the hash computed at citation time; the UI is honest ("as fetched 2026-06-20"). Note the stored snapshot is the ingester's normalised parse, not the origin's raw bytes, and the live original may drift.
- **Publication interaction.** A tributed piece may also be inside a publication, which *already* splits that article's revenue. Two splitters on the same money would double-count — the build plan must define precedence (e.g. tribute comes off the writer-side net first, the publication splits the remainder).
- **Refund / chargeback.** A reversal must unwind both the author's credit and any tribute accruals on the reversed read.
- **Self-crediting is not uplift.** A sybil tribute routes the author's own money to their own alt — a circle, not extraction. The onboarding magic-link is no defence (the author controls the email they entered), but it does not need to be: it is the author's money. Noted as a limit, not plugged.

## Non-goals

Ranking signals or reputation scores from any of these tables; escrow/custody of tribute *beyond* the defined hold-and-resolve flow; adjudication of citation accuracy; takedowns; forfeiture of stakes; span-level credit on the author's piece; reviving `trust_*`.

## Deferred (documented, not dropped)

- **Standing-record view** — an author-profile query of citations/disputes showing corrected / defended / ignored, no score. Later phase.
- **Byte-stable native citation** — an `article_event_versions` table persisting signed event bytes at publish, so `source_version_event_id` becomes a true guarantee rather than a hint. Until then, native citations rely on the stored `excerpt` + `excerpt_sha256`.
- **General per-read co-earner attribution** — building Prerequisite 1 as a first-class attribution layer (any piece can credit N co-earners) rather than a tribute-only side-table, which would also let net earnings be stored per read instead of recomputed from gross.

## Build order

1. `credit_edges`, `citation_edges`, `dispute_edges` + dispute mechanics (`dispute_stake` / `dispute_stake_refund`). Independent of tribute; the only money is the dispute stake, so this phase already touches the ledger triggers, views, reconcile, and adjacency markers. — ✅ **Complete** (migration 125, `gateway/src/routes/upstream-edges.ts`, `UpstreamEdges` reader apparatus, shipped 2026-06-22; authoring UI + the inline-prose citation marker shipped 2026-06-23 — see `UPSTREAM-EDGES-BUILD-PLAN.md` › *Phase 1 — as built*). The marker realises the "one inline marker at the citation point" of Render rules above: it anchors at `char_start` (free body only — the paid-span hole stays deferred) and turns crimson on a cited-author dispute.
2. `tributes` + `tribute_accruals` schema, the resolver-driven authoring UI, and the inspirer-contact pipeline (in-app + email branches). Accrual writes are dark until step 3. — ✅ **Shipped 2026-06-23** behind `TRIBUTES_ENABLED` / `NEXT_PUBLIC_TRIBUTES_ENABLED` (migration 126, `gateway/src/routes/tributes.ts` + `gateway/src/lib/tribute-sweep.ts` lifecycle worker, the `UpstreamEdges` Tributes section + `/tribute/claim`). See `UPSTREAM-EDGES-BUILD-PLAN.md` › *Phase 2 — as built*. No money moves yet; `tribute_accruals` stays empty until step 3.
3. Settlement-time apportionment (`settlement.ts`) and the payout changes (`payout.ts`): author paid net of accruals, inspirer payout posts `tribute_payout`, reconcile assertions live. — ✅ **Code shipped 2026-06-24** dark behind `TRIBUTES_ENABLED` (migration 127; settlement apportionment, author carve + swept-return, `runTributePayoutCycle`, display carve, the per-read-net shared helper). The realized carve subtracts **Σ(all accruals)** per read with `released→paid` / `swept→returned` as the second leg (the named reconcile `author-share + Σ accruals == read net`; the "non-swept" framing double-counted a pre-payout sweep) — see `UPSTREAM-EDGES-BUILD-PLAN.md` › *Phase 3 — as built*. The production money flag stays OFF: enabling it is the compliance owner's call (memo residual #1).
4. Composition: wire the `tributes.citation_edge_id` UX last. — ✅ **Shipped 2026-06-24** (dark behind `TRIBUTES_ENABLED`). A tribute can be offered **from a citation** ("I cited X here, and X earns a share"): `POST /tributes` takes an optional `citationEdgeId` (validated as a citation on the same piece) and records the link; the payee is the cited source, **seeded into the composer but author-confirmable** (the link is provenance, not a hard payee identity); the apparatus offers `+ Offer a tribute to this source` on each addressable citation and renders `· for the source cited at [N]` back-links. No DDL (the column shipped in migration 126), no money/ledger change. The optional publication × tribute composition (D1 revisit) stays deferred. See `UPSTREAM-EDGES-BUILD-PLAN.md` › *Phase 4 — as built*.
```
