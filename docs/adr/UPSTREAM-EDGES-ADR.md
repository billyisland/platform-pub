# Upstream Edges — Tribute, Citation & Dispute

**Status:** Proposed (consolidated 2026-06-20; money model revised 2026-06-20 — tribute reframed from held reserve to payout-time deduction, see §Revision note; consent model revised 2026-06-20 — the named credit needs no consent, only money does, see §Revision note (consent model))
**Date:** 2026-06-20
**Depends on:** `articles`, `ledger_entries` (unified append-only ledger), `repost_edges`, `comments`, `external_items`, strfry canonical store.
**Hard prerequisites (not yet built):** (a) **writer-side accrual in the ledger.** The deduction nets the tribute against *what the writer earned*, but the ledger does **not currently model writer-side accrual** — `writer_payout`/`publication_split` entries record money *already paid out* (`+amount`, NULL counterparty), and `getWriterEarnings()` sums `read_events` (earned-incl-pending), a different quantity the CLAUDE.md money-ledger invariant explicitly keeps "reconciliation-only until the ledger models writer-side accrual." So a `SUM(ledger_entries)` per account today yields reader-debt + past payouts, not current earnings; modelling writer-side accrual is itself unbuilt and is the deepest dependency here. (b) a **unified net-position read** over `ledger_entries` — `SUM(amount_pence)` per `account_id` across all triggers — so a payout can net what a writer earned against what they owe and what they tribute *in one figure*; today reader debt settles by Stripe card charge and writer earnings transfer out by Connect on separate rails with no offset (`settlement.ts` / `payout.ts`). And deeper still: the percentage is "of net earnings from *this piece*", so the read must attribute net **per piece per payout cycle** — piece-granular writer accrual, a notch beyond even an account-level net position (nothing in the `read_events`→payout path attributes net per piece per cycle today). (c) the ledger being **read-authoritative for balances** — migrations 119–121 are Phases 0/2/3-prereq; the Phase-3 cutover is not done, and the ledger began empty. The tribute's correctness depends on all three; none is a new subsystem, but none exists yet — and (a) is further off than the "Phase-3 cutover" framing alone implies.
**Supersedes / parks:** folds the in-design *inspirer-credit / upstream-reserve* model and the *Span-Pinned Citations & Disputes* ADR into one document. Does **not** route through the parked `trust_*` subsystem.

## Revision note (money model)

The original draft modelled the tribute as a **held reserve** — a lien moving the tribute share into a `tribute_pending` sub-account that "the withdrawal hold falls out of for free." That assumed an on-platform author spendable balance the architecture does not maintain: authors do not hold a withdrawable wallet; their net earnings are pushed out by Stripe Connect transfer on a weekly/monthly cadence (`payout.ts`). With nothing to lien and the payout clock far shorter than the tribute clock, a held reserve could only be realised by retaining third-party-destined funds across payout cycles — which *is* custody, whatever it is labelled.

This revision drops the held reserve. **The tribute is a deduction in the net-payout computation, biting only on *future* payouts once the inspirer has consented.** Pre-consent, the figure is a **non-binding estimate** that motivates the cold-contact — it holds no money. The named credit (the moneyless axis) still stands immediately and needs no consent at all — it is the author's claim of their own influence, not an assertion the inspirer can veto (§The core distinction). The cost, accepted in v1: a piece that earns before the inspirer responds returns nothing to them for that period (§Edge cases, §Consequences). This is the price of never holding third-party funds — the posture this platform wants while the cross-border payout question is unresolved.

## Revision note (consent model)

The original draft ran **two consent models** — citation was "characterise the record freely; recourse is dispute, not removal," while tribute was a "gift: declinable, credit strikable," letting the inspirer strike the public credit (`public_credit_visible = false`). This revision **collapses them to one**. Crediting a source as an *influence* is a claim the author makes about their *own* intellectual debt, not an assertion about the inspirer that the inspirer gets to veto — the same kind of speech act as characterising the record. So the **named credit needs no consent and stands on publish**; an inspirer who dislikes the work, rejects responsibility, or objects to being named answers with a **public disclaimer** (a counter-edge reusing the dispute primitive, §Design B), never a silent strike. Consent gates **money only**: funds cannot be forced on a payee, and the public fact "X is a paid beneficiary" only becomes true once X has taken the tribute up. The `public_credit_visible` strike flag is dropped; §A.5 reduces to a money decision (accept / decline / ignore); the "pre-consent display" open question dissolves (the credit was never consent-gated). One guardrail survives: the credit must read as *influence* ("this work draws on X"), never as the inspirer's *endorsement* ("X supports this"), since the latter would be a claim about X's stance rather than the author's debt.

---

## Consolidation note

This document folds two primitives that were specified apart into one, and makes the logic that
binds them explicit — because the binding is the interesting part and was previously implicit.

- **Tribute** — voluntary upstream payment. An author directs a share of a piece's earnings to a
  source the piece depends on (the *inspirer*). Developed in design; written up in full here for the
  first time (§Design A).
- **Citation & dispute** — span-pinned characterisation of a source, exposed to the source author's
  counter-claim (§Design B). Carried over from the revised citation ADR.
- **Composition** — how the two relate, co-occur, and stay decoupled (§Design C). This is the seam.

What is **decided**: the tribute is contingent author-money realised as a deduction from the
author's *future* net payouts, not escrow and not a held reserve; the author sets the percentage; the
**money** binds only after the inspirer consents, while the **named credit needs no consent** — it is
the author's claim of their own debt, not an assertion the inspirer can veto, and recourse to an
unwanted credit is a public disclaimer, not a strike; the pre-consent figure is a non-binding estimate
that holds no money; credit and payment are independently engageable; citation and tribute are
separate edges that may reference one another. What is **open** is collected in §Open questions —
chiefly the still-unresolved UI forks (authoring granularity, percentage on an unreachable target) and
one rendering judgement call.

---

## Context

all.haus carries a market of generalist *synthesists* who graze across specialist silos and sell
higher-level representations of what others have said. Such a market depends on prior work in two
distinct ways, and owes that prior work two distinct things:

1. **Value.** A synthesis stands on work it did not do. The author may wish to return a share of
   what the piece earns to the people whose work it stands on — whether or not any specific sentence
   is quoted, and whether or not those people are on all.haus at all. This is the **tribute**.
2. **Faithfulness.** Where a synthesis attributes a *specific, checkable claim* to a source, that
   attribution can be accurate or not. The market does not supply faithfulness on its own — per-piece
   reader payment selects for what a paying silo wants to hear. A rival "revisionist" summoned by an
   aggrieved silo is selected the same way; two demand-trained accounts ground each other in the
   other's blind spots, not in the record. (In ML terms: rival synthesists are a GAN, and the GAN
   mode-collapses onto whatever flatters the buyer.) This is the **citation/dispute** layer.

The two needs are related — both are about a synthesis's debt to its sources — but they are not the
same relationship, and conflating them was the prior design's mistake. **§The core distinction**
keeps them apart on purpose; **§Design C** wires them back together where, and only where, it pays.

A note on what the faithfulness layer can and cannot do. The GAN diagnosis explains why the market
will not self-ground; it does not follow that any mechanism corrects it. The mode-collapse failure is
largely *selection* — a synthesist can quote every passage perfectly and still assemble a wholly
cherry-picked, vindicating synthesis. **We do not fix that and do not claim to.** What is cheaply
decidable, without an editor or a truth oracle, is the narrow question:

> Did this synthesis accurately represent a *specific, checkable claim* it attributed to a source?

That catches fabrication, doctored quotes, and context-stripping. It is a **floor against
misrepresentation, not a cure for bias.** Everything above it forks freely.

### Why this is tractable here

The hard half is already built. **strfry is an append-only, signed, content-addressed event store** —
articles, notes, comments and payment receipts are immutable Nostr events whose `id` is the SHA-256
of their bytes. That *is* the ledger; Postgres is only an index over it. We add a small number of
event kinds and index tables that mirror `repost_edges` / `comments`, one render affordance, and a
single `tribute_payout` trigger on the unified ledger. No new transport, store, or moderation surface.
(Caveat: the unified Postgres ledger that the tribute deduction reads is built but **not yet
read-authoritative** — migrations 119–121 are Phases 0/2/3-prereq, Phase-3 cutover pending — and has
no net-position read yet. See prerequisites. strfry as event store is done; the balance spine is not.)

---

## The core distinction

Both primitives are **upstream edges**: directed links from a synthesis to a source it depends on.
They differ on three independent axes, and it is the independence that the design must preserve.

| Axis | Tribute | Citation |
|---|---|---|
| Question answered | *Do I owe this source a share of value?* | *Did I represent this source's claim faithfully?* |
| Granularity | The whole piece (earnings aren't per-passage) | A specific pinned span |
| Needs a quotable claim? | No — a whole tradition, a dead author, an institution all qualify | Yes — span + excerpt + hash + characterisation |
| Recipient must be reachable? | No — name-only credit if unaddressable | No — the source need not be on all.haus to be characterised |
| Consent to publish? | Name: **no** (the author's claim of their own influence; recourse is the inspirer's disclaimer, not a veto). Money: **yes** (funds can't be forced on a payee; "X is a paid beneficiary" is only true post-consent) | No — characterising the record needs no consent; recourse is dispute, not removal |
| Carries money? | Yes (or zero, for name-only) | Never on its own |

Two further axes sit *inside* tribute and are themselves independent (this realises the earlier
decision that credit and payment are separately engageable):

- **Name** — whether the author publicly credits the source as an **influence** on the work. This is
  the author's claim about their own debt; it is framed as influence ("this work draws on X"), never as
  the inspirer's endorsement ("X supports this"), and so needs no consent — the inspirer's recourse to
  an unwanted credit is a public disclaimer (a counter-edge, §Design B), not a veto.
- **Money** — whether a percentage is directed to the source (deducted at payout, never reserved). This
  *does* need consent: funds cannot be forced on a payee, and the public fact "X is a paid beneficiary"
  only becomes true once X has taken the tribute up.

Name-only is a tribute with `percentage = 0` (or simply an endnote, see §Design A) and stands on
publish. Money-only is a tribute the author directs without publishing the influence claim. Either
axis on, either off.

---

## Decision

1. **Tribute is contingent author-money, realised as a payout deduction — not escrow, not a held
   reserve.** The share is the author's own money, carrying a contingent gift. It is never
   segregated and never held back across payout cycles. It binds only *after* the inspirer consents,
   and from that point it is a standing instruction: on each subsequent payout the tribute share is
   deducted from the author's net and routed to the inspirer in the same cycle. Before consent it is a
   non-binding estimate that moves no money. all.haus never custodies third-party funds because it
   never holds them — the deduction happens at the moment money would otherwise transfer out.
2. **Citation is free.** A span-pinned citation carries no payment. Synthesists emit citations
   because that is how they graze and ground, not because they are paying to do so.
3. **Dispute is a counter-edge, not a verdict.** It `e`-tags a citation and renders alongside it. The
   platform exposes characterisation, span, and counter-claim side by side; the reader adjudicates by
   looking. No score, no oracle, no takedown.
4. **Composition, not fusion.** Tribute and citation are separate edges. A tribute MAY reference a
   citation (`citation_edge_id`); a citation MAY be referenced by a tribute; neither requires the
   other. The funded-auditor loop is opt-in per citation, not forced onto all provenance.
5. **One consent model: two free claims, one gated transfer.** You may always characterise what a
   source *said* (record: disputable, not removable), and you may always credit a source as an
   *influence* on your work (your claim of your own debt: disputable by a disclaimer, not removable).
   Consent is required for one thing only: **routing money** to the source — funds cannot be forced on
   a payee, and "X is a paid beneficiary" is only true once X consents. Declining the money erases
   neither the citation nor the credit; disputing either does not depend on the money.
6. **The canonical store is the ledger.** Citations, disputes, and payment receipts are signed
   events keyed by pubkey. A synthesist's standing record is a query, not a new store, and consequence
   is emergent — readers and tribute-paying authors discount for themselves — never platform-assigned.

Design principles, in two lines: **proceduralise exposure, not verdict** — and — **characterise the
record and credit your influences freely; route money to a beneficiary only with their consent, and
hold no money on their behalf until they have taken it up.**

---

## Design A — Tribute

### A.1 What it is

While publishing, an author may attach a tribute to a source: a percentage of the author's **net**
earnings from this piece (after the platform cut), directed to the source. The source is the
*inspirer*. It works whether or not the inspirer holds an all.haus account — the federation posture
applied to money, not just content. The percentage does not move money on its own; it becomes a live
deduction on the author's payouts only once the inspirer has taken the tribute up (§A.3).

### A.2 Contingent author-money via a payout deduction

The tribute share is never segregated and never held. It is realised at the **payout-computation**
step on the unified append-only ledger, by netting:

- A writer's payout nets gross piece earnings against the platform cut today; netting it against the
  writer's *own reader debt* does **not** happen yet (the two settle on separate Stripe rails — see
  prerequisites) and lands only with the unified net-position read. The tribute joins that same
  computation as a further deduction: at each payout cycle, once the tribute is `live`, the share is
  subtracted from the author's net *for that cycle* and routed to the inspirer in the same cycle. Note
  the percentage is "of net earnings from *this piece*," so the deduction needs **per-piece earnings
  attributed within the cycle**, not just the author's whole-payout net — an input the net-position
  read must expose at piece granularity. **The exact entries are pinned to keep the SUM-is-balance
  model correct:** the author's `writer_payout` entry records the **full net** (unchanged from a
  no-tribute cycle) and the `tribute_payout` pair carries the share on top — `−share` on the author,
  `+share` on the inspirer — so the author's balance nets to `net − share` from two rows, never from a
  pre-reduced `writer_payout` (reducing `writer_payout` *and* writing the debit would double-subtract).
- **There is no withdrawal hold, because there is nothing held.** The money never enters a pending
  sub-account and never waits across cycles. The author is paid their earnings minus the live tribute
  share; the inspirer is paid the share; both happen at the normal payout cadence. This keeps the
  light legal posture (still the author's money, right up until the cycle in which it transfers) and
  needs no custody.
- **Before consent, no ledger entry is written.** The running figure is a *notional estimate*
  computed from the piece's earnings to date (§A.3) — it motivates the cold-contact and shows the
  author what they are offering, but it moves nothing and reserves nothing. Earnings made before the
  inspirer consents are paid out to the author in the ordinary way and are not recoverable for the
  tribute (the v1 cost, §Edge cases 7).
- On consent: the tribute goes `live` and each subsequent payout writes a `tribute_payout` pair
  (debit the author, credit the inspirer). On decline or lapse: nothing is written, because nothing
  was held — the estimate is simply discarded.

```
trigger_type = 'tribute_payout'      -- written only while the tribute is live, at each payout
ref_table    = 'tributes'
ref_id       = <tributes.id>
```

(One movement, **two rows**: a debit on the author's account with `counterparty_id` = the inspirer,
and the mirror credit on the inspirer's account with `counterparty_id` = the author. This is the
ledger's first explicit double-entry pair — see the integration facts below for why that departs from
the existing single-row convention. No `tribute_accrual`, no `tribute_pending`, no `tribute_revert`.)

Three integration facts this implies, none of them free:

- **`tribute_payout` is a new `LedgerTriggerType`.** The union in `shared/src/lib/ledger.ts`
  (`read_accrual | tab_settlement | writer_payout | publication_split | vote_charge | pledge_fulfil |
  subscription_credit | opening_balance`) must gain `tribute_payout`, and the writing file must be
  added to the `REGISTRY` in `scripts/check-ledger-adjacency.sh` (CI-enforced, `backend` job) or it
  trips the no-unregistered-money-site scan.
- **It is the ledger's first *mirrored* (double-entry) movement.** Non-NULL account counterparties
  already exist — an upvote `vote_charge` sets `counterparty_id` to the credited author (the
  `ledger_platform_tax` view keys off the NULL-counterparty *downvote* case to tell the two apart), so
  a non-NULL counterparty is not the novelty. What is new is writing **two rows for one movement**:
  today every movement is a *single* entry whose other leg is implicit — the platform fee is the gap
  between charge and payout, and an upvoted author's revenue is *derived*, not a stored credit row
  (`ledger.ts`: the platform "is always the NULL counterparty … implicit"). `tribute_payout` instead
  posts an explicit pair — a debit on the author (`counterparty_id` = inspirer) and the mirror credit
  on the inspirer (`counterparty_id` = author), with **no platform leg**. That breaks the
  one-row-per-movement assumption the migration-120 read-model views and `scripts/reconcile-ledger.sql`
  encode (and the implicit-platform-fee derivation built on it), so both must be extended to count the
  pair, or it silently mis-reconciles.
- **The inspirer must be a real `account_id`** (`ledger_entries.account_id` is `NOT NULL`). This is
  why money can only move *after* consent yields a `resolved_account_id` (§A.3–A.6); see §A.4 for the
  reachable-vs-payable distinction this forces.

### A.3 Resolution timing

Resolution (finding/notifying/consenting) and disbursement (moving money) are different clocks, and in
this revision only the disbursement clock moves money — and only after consent.

- **Estimate silently.** While the *notional* tally is below a payout-viable threshold, contact no
  one. You do not ping someone about £0.03; the notification, when it fires, carries a real number
  that motivates a reply; and the piece has proven it earns before anyone is approached. The tally is
  an estimate computed from earnings to date — those earnings are meanwhile paid out to the author as
  normal; nothing is withheld.
- **Resolve on threshold crossing.** When the estimate clears the threshold (above transaction-fee
  noise), notify the inspirer over whatever rail addresses them (§A.4).
- **The window starts at first contact, not publication.** Running it from publish punishes a piece
  that earns nothing for months then takes off. Suggested window: 60 days, one reminder — you may be
  reaching a non-user over a slow channel (email, a Nostr DM that sits unread).
- **On consent, the edge goes live, and only then does money move.** From the next payout cycle the
  tribute share is deducted and routed, ongoing, no further window. It is now a standing instruction.
  Earnings from *before* consent stay with the author (§A.6, §Edge cases 7).

### A.4 Identity targeting

The author points at the inspirer via npub / ATProto handle / ActivityPub actor / DID / email / or a
bare name, resolved through the universal resolver (`POST /api/resolve`, UNIVERSAL-FEED-ADR §V.5 —
the omnivorous-input commitment; a tribute target uses the `general` context, there being no `pay`
context today). The resolver's output is binary: **reachable** (we can *notify* them) or
**unreachable** (name-only; payment impossible).

**Reachable-to-notify is not the same as payable.** An npub or email can be *contacted*, but a GBP
payout needs the inspirer onboarded to Stripe Connect — i.e. holding an all.haus `account_id` — which
the `account_id NOT NULL` ledger column requires for the credit leg. So "payment possible" really
means "the inspirer can be reached, then consents and onboards" (§A.3 → `resolved_account_id`). The
federation-posture-applied-to-money framing (§A.1) is aspirational in exactly this sense: the offer
travels over any rail, but money moves only once the payee becomes an account. The
dead-folk-musician and whole-tradition cases fall out for free — unaddressable, so the named credit
stands and the money cannot.

### A.5 Decline granularity

The claim page governs the **money only** — the named credit is the author's claim and is not the
inspirer's to grant or revoke (§The core distinction). So the inspirer may: (i) accept the money; (ii)
decline the money (no money ever moves; the credit stands); (iii) ignore (→ lapse; the credit stands).
There is no "strike the credit" action — an inspirer who objects to *being named* answers with a
**public disclaimer** (a counter-edge reusing the dispute primitive, §Design B), which is on-record
and visible, not a silent removal. This is the same posture as citation: the record — and a
credit-of-influence is the author's record of their own debt — is contestable, not suppressible.

### A.6 Late claimants

Because nothing is held before consent, a lapse moves no money — the earnings to date already went to
the author, and there is no pending balance to revert (no indefinite liability by construction). The
attribution may stand and the tribute stays claimable: if the inspirer later surfaces and claims,
*future* earnings route to them from the next cycle. `resolved_account_id` can be set after a lapse;
the door stays open, and no money ever sat in limbo waiting for it.

### A.7 Schema

```sql
CREATE TABLE public.tributes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    piece_article_id uuid NOT NULL,           -- the synthesis whose earnings are shared
    author_id uuid NOT NULL,                  -- who set the tribute (whose earnings)
    percentage numeric(5,2) NOT NULL
        CHECK (percentage >= 0 AND percentage <= 100),  -- share of author's net piece earnings (0 = name-only)

    -- recipient targeting (the inspirer). Protocol values MUST match the
    -- `external_protocol` enum spelling (so `nostr_external`, NOT `nostr`),
    -- plus two sentinels that are not protocols: `native` (an all.haus account)
    -- and `unaddressable` (name-only, no payee). Kept as text rather than the
    -- enum precisely because of those two sentinels — but do not drift the
    -- protocol spellings from the enum.
    target_kind text NOT NULL,                -- native | unaddressable | <external_protocol value>
    target_identifier text,                   -- npub / DID / handle / email; null when unaddressable
    resolved_account_id uuid,                 -- set when the inspirer claims / is matched (may post-date lapse)

    -- optional coupling to a citation (null = span-less tribute)
    citation_edge_id uuid,                    -- FK -> citation_edges.id

    -- the named-credit axis (always stands on publish; the author's claim, not
    -- the inspirer's to revoke — §A.5). There is deliberately NO strike-credit
    -- flag: an objecting inspirer answers with a disclaimer counter-edge
    -- (§Design B), not a column. (A money-only tribute — pay without publishing
    -- the credit — is the author's editorial choice in the authoring UI, not a
    -- consent state; it needs no column either.)

    -- lifecycle — governs the MONEY only (the credit needs no consent, so it has
    -- no state). States:
    --   credit_only (percentage = 0: nothing to consent to; credit stands, no money ever moves)
    --   proposed    (notional estimate, below threshold, no contact)
    --   → resolving (threshold crossed, inspirer notified, window running)
    --   → live      (money consented; deducts each payout cycle)
    --   → declined  (inspirer refused the money; the credit still stands)
    --   → lapsed    (window expired with no response; the credit still stands).
    -- The late-claim path (§A.6) is a legal `lapsed → live` (or `declined → live`)
    -- transition: set resolved_account_id and route FUTURE earnings from the next
    -- cycle.
    state text NOT NULL,                      -- credit_only|proposed|resolving|live|declined|lapsed
    first_contact_at timestamp with time zone,        -- window starts here, not at publish
    window_expires_at timestamp with time zone,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);
```

(No balance is held against this row. While `proposed`/`resolving` the offered share is a notional
estimate over the piece's earnings to date; while `live` it is a deduction applied at each payout. The
only authoritative money record is the stream of `tribute_payout` ledger entries written once live.)

---

## Design B — Citation & Dispute

### B.1 The citation edge

Authored in the TipTap editor: the synthesist selects a passage in the source and attaches a claim
about it. Emits an **addressable** Nostr event (provisional kind `30100` — confirm against NIP
ranges) and indexes a row. No payment is implied here.

```
["d", "<stable citation id>"]                 # addressable, so it can be corrected in place
["span", "<char_start>", "<char_end>", "<sha256(excerpt)>"]
# source reference + notification — native / Nostr sources ONLY (see note below):
["source", "<naddr of source article>"]       # kind:pubkey:d-tag — survives source edits
["source_version", "<source nostr_event_id>"] # the exact bytes characterised
["p", "<source author pubkey>"]               # standing + notification, as comments already do
content: "<the characterisation: 'P argues X'>"
```

**The `source` / `source_version` / `p` tags are present only when the cited source is native or
Nostr** — only those carry an `naddr` and an author pubkey. A citation of an ATProto / ActivityPub /
RSS / email source has no `naddr`, and tier-C/D (RSS / email) sources have no author pubkey at all, so
such a citation emits the `d`, `span`, and `content` tags only; the source reference and pinned
snapshot live in the `citation_edges` row (`source_protocol`, `source_uri`, `source_external_item_id`,
`excerpt` / `excerpt_sha256` — §Edge cases 2), not in event tags. The `p`-tag notification path
therefore reaches native / Nostr cited authors only; other-protocol authors are not Nostr-notifiable.

```sql
CREATE TABLE public.citation_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    citing_article_id uuid NOT NULL,
    citing_author_id uuid NOT NULL,
    nostr_event_id text NOT NULL,
    nostr_d_tag text NOT NULL,                 -- addressable: corrections replace in place

    -- NB: source_protocol is NULLABLE because the existing `external_protocol`
    -- enum has NO `native` member (and spells Nostr `nostr_external`, not
    -- `nostr`). A citation of a native all.haus NIP-23 article — the primary
    -- case in §B.1 — has no enum value, so NULL means "native source" and a
    -- non-null value is the external protocol. Do NOT make this NOT NULL.
    source_protocol public.external_protocol,  -- NULL = native all.haus source
    source_naddr text,
    source_version_event_id text,              -- exact bytes characterised
    source_external_item_id uuid,
    source_uri text,

    excerpt text NOT NULL,                      -- carried with the edge
    excerpt_sha256 text NOT NULL,               -- self-contained: survives source supersession
    char_start integer,
    char_end integer,
    characterisation text NOT NULL,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);
```

**Pin the version, not just the article.** Articles are NIP-23 replaceable events. Pin only the
addressable coordinate and the source author can edit after the fact to make a fair quote look like a
misquote, or bury one. Pinning `source_version_event_id` *and* carrying `excerpt` + `excerpt_sha256`
makes the citation self-contained even if strfry drops the superseded version. **Context-stripping is
mechanically exposed:** the span is a range inside known bytes, so the reader can expand and read
around it. The bytes are fixed; the framing is not.

### B.2 The dispute edge

Emitted by the source author (notified via `p`) or by any reader. **Addressable** event (provisional
kind `30101`, so a disputant can revise their counter-claim in place) that `e`-tags the citation and
may re-pin a wider span:

```
["d", "<stable dispute id>"]                  # addressable: the disputant can revise in place
["e", "<citation nostr_event_id>"]            # the citation being disputed
["span", "<char_start>", "<char_end>", "<sha256(wider_excerpt)>"]  # optional: re-pin a wider span
["p", "<citing author pubkey>"]               # notify the synthesist whose citation is disputed
content: "<the counter-characterisation>"
```

```sql
CREATE TABLE public.dispute_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    disputant_id uuid,                          -- nullable: source author or any reader
    nostr_event_id text NOT NULL,
    nostr_d_tag text NOT NULL,                  -- addressable: revisions replace in place
    target_citation_event_id text NOT NULL,
    wider_excerpt text,
    wider_excerpt_sha256 text,
    counter_characterisation text NOT NULL,

    is_by_cited_author boolean NOT NULL,         -- true iff disputant == the citation's p-tagged source
    stake_ledger_entry_id uuid,                  -- nullable; required for third-party disputes

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);
```

### B.3 Rendering — exposure, not verdict; standing, not score

- **Glance-level marker is reserved for the cited author.** A citation disputed by the party whose
  work it characterises renders a **contested** marker inline at the citation point. High signal — the
  person you quoted says you misread them — and inherently bounded: one such party per citation. It
  cannot be manufactured by volume.
- **Third-party disputes are visible on inspection, not at a glance.** Anyone may dispute, but a
  third-party dispute does not flip the inline marker and does not stack as glance-level flags. It
  appears on expansion. This denies marker-*density* as a smear — a coordinated silo cannot litter a
  rival's accurate citations — while preserving open contestation for anyone who looks.
- Expanding shows, side by side: the characterisation, the pinned excerpt (expandable to surrounding
  context), and every counter-characterisation (cited-author first, then others).
- **Symmetric on inspection.** A frivolous dispute is itself a span-pinned claim rendered next to the
  bytes that refute it; a bad dispute is self-refuting in situ. No separate anti-troll system.
- **Never a ranking signal.** Neither marker nor dispute feeds `feed_scores` or any "For You"
  ranking. Routing it into engagement would reintroduce the inflammation lever the platform refuses —
  which is why the marker is standing-bounded rather than count-driven.
- **Not moderation.** A dispute is never a `moderation_reports` row; no takedown, suspension, or
  hiding. It only renders alongside.

### B.4 The record — emergent, not scored

A synthesist's standing record is a query over signed events: characterisations that drew span-pinned
disputes, and whether the synthesist **corrected** (replaced the addressable citation), **defended**
(a reply standing by the reading — legitimate interpretive disagreement), or **ignored**. The
platform records all three and assigns no truth-verdict.

> **Hard constraint.** Do not compute a "credibility score" and do not route this through `trust_*`,
> `vouches`, or `votes`. A learned/aggregated judge is exactly the capturable oracle this design
> avoids. The signal is the rendered record, read by humans.

---

## Design C — Composition (the connection logic)

This is where the two primitives meet. The seam is a single nullable reference:
`tributes.citation_edge_id`.

### C.1 They are orthogonal, and that is the point

A dependence can warrant a tribute with no quotable claim (a whole tradition shaped the piece), and a
citation can warrant no tribute (you characterise a source critically and owe it nothing). Most
citations are free provenance; most tributes are span-less gratitude. Keeping them separate is what
lets each exist without the other — and it is the only way to express the span-less inspirer at all,
since the citation schema requires a span.

### C.2 Where they co-occur, the loop closes

When a synthesist chooses to put money behind a *specific* characterisation, the tribute references
that citation (`citation_edge_id` set; recipient = the cited author). The effect is the one the prior
fused design wanted, now opt-in:

- The synthesist pays the very person most motivated to check the characterisation, and gives them
  standing to dispute it. Funding and accountability reinforce each other — on the citations the
  author chose to back, not on all of them.
- Resolution is cheaper in this case: the recipient is already identified by the citation's `p` tag
  and is often already addressable over the protocol the source came in on, so the cold-contact
  problem of §A.3 is reduced or eliminated.

### C.3 The consent model is uniform across both edges

The single consent rule (Decision 5) interacts cleanly precisely because the edges are separate, and
because consent gates *only* money:

- The **dispute right is independent of money.** A cited author may dispute whether or not a tribute
  is attached, and the right does not expire when the tribute money lapses.
- The **credit right is the author's, independent of consent.** Naming a source as an influence stands
  whether or not money is attached and whether or not the inspirer likes it; the inspirer's recourse is
  a disclaimer counter-edge (§Design B), not a removal.
- If a tribute references a citation and the cited author **declines the money** (§A.5 (ii)), the
  **citation and the credit both survive** — only the money is withheld (the tribute never goes live,
  or if already live, stops deducting from future payouts; no held funds to return). The record of what
  they said, the author's record of their own debt, and the right to contest both, are untouched.

In one line: **you cannot buy the right to characterise someone, you do not need their leave to credit
them, and they can suppress neither an accurate characterisation nor your account of your own
influences by refusing the money.**

### C.4 The ledger keeps citation free

Payment is written only by the tribute (`tribute_payout` at each payout, once the tribute is `live`),
never by the citation. Coupling a tribute to a citation does not make the citation cost anything; it
attaches a separately-governed payout deduction that happens to point at the same source. The two
clocks (citation publish; tribute consent → per-cycle payout) never merge.

---

## Scope & non-goals

- **In scope:** voluntary upstream payment (tribute); misrepresentation of a specific pinned passage
  (citation/dispute) — doctored quotes, fabricated positions, context-stripping.
- **Out of scope, by design:**
  - whether a synthesis is *fair*, *true*, or *well-judged* — forks forever, and should;
  - **selection bias** — an all-accurate but cherry-picked, vindicating synthesis. This is the larger
    part of the demand-driven mode-collapse named in Context, and this mechanism does not address it.
- **Tribute is a gift, not escrow.** all.haus never holds third-party funds; the share is the
  author's money, deducted at the payout in which it would otherwise transfer out — nothing is
  reserved, segregated, or held across cycles.
- **Not** a moderation tool, a ranking input, or a reputation score.
- **Self-crediting is not laundering uplift.** A sybil tribute routes the author's own money to the
  author's own alt — it moves money in a circle, it does not extract value from the platform. Noted as
  a limit, not a hole to plug.

---

## Edge cases & limits

1. **Paywalled / vault spans — the floor's known hole, where the money is.** A citation into a gated
   region cannot expose plaintext to a reader who has not unlocked it. v1: restrict span-citation to
   `content_free` and the unlocked viewer's own decrypted copy. **Accept that this leaves paid
   specialist content — the highest-value material to ground — uncitable for grounding in v1.**
   Post-v1 target: pin `excerpt_sha256` and reveal plaintext on the viewer's own unlock.
2. **Ingested sources (`external_items`).** Native Nostr pins to immutable signed bytes; for
   ATProto / ActivityPub / RSS, pin to the stored snapshot (`content_text`, `fetched_at`) and its
   hash. The UI is honest about the snapshot ("as fetched 2026-06-20"); the live original may drift.
3. **Replaceable-event supersession.** Covered by carrying `excerpt` + `excerpt_sha256` in the edge;
   do not rely on strfry retaining superseded versions.
4. **Dispute spam / DoS — resolved at design time.** The cited author disputes free; any third-party
   dispute requires a small **refundable** friction stake via the existing tab / `ledger_entries`
   machinery (`stake_ledger_entry_id`). Refundable, **not** rewarded-if-correct — a reward-on-correct
   stake would smuggle a verdict back in. With standing-bounded rendering (§B.3), neither volume nor
   anonymity converts disputes into a glance-level smear.
   **This is a second money movement, not free.** A hold-then-refund touches the tab balance twice, so
   it needs its own trigger type(s) — `dispute_stake` (hold, `−amount`) and its refund (`+amount`) —
   *both* registered alongside `tribute_payout` in `scripts/check-ledger-adjacency.sh`; the
   hold/credit-back markers (`balance_pence = balance_pence [-+]`) already in that scan will flag the
   write site otherwise. The one fixed constraint: the stake is **never forfeited** (forfeiture-on-wrong
   would be the reward-on-correct verdict this design refuses, inverted), so the friction is the
   temporary lock-up alone. **What triggers the refund is left open** (§Open questions 4).
5. **Unaddressable inspirer.** Name stands; money disabled. There is no payee to consent, so the
   tribute can never go `live` and no deduction is ever written. See §Open questions for whether to
   permit setting a percentage at all on an unreachable target.
6. **Dead inspirer / estate.** A pure-tribute case that cannot resolve to a living payee; the named
   credit may stand while the money never becomes live (no one to take it up). Routing to an estate is
   out of scope.
7. **Pre-consent earnings are not recoverable — the deliberate v1 cost.** Because nothing is held
   before consent, whatever a piece earns between publication and the inspirer's consent is paid out
   to the author in the ordinary cycles and cannot be retrospectively shared. A piece that earns big,
   fast, before a cold-contacted non-user replies returns nothing to them for that period. This is the
   price of never holding third-party funds; the threshold-and-window flow (§A.3) shortens the gap but
   does not close it. Post-v1, an opt-in held reserve could close it — but only once the platform runs
   a custody/escrow posture it deliberately avoids today.

---

## Consequences

**Buys:**
- Voluntary upstream redistribution as gift, expressing the social-power domain on top of the market
  rail, with no third-party custody.
- A grounded floor that catches fabrication, doctored quotes, and context-stripping without an editor,
  an algorithm, or a truth oracle — plus an *ascending error* channel the demand market cannot supply.
- Credit, payment, and characterisation kept as three separable facts about one source, so each can
  exist without the others — and the span-less inspirer remains expressible.
- The funded-auditor loop, retained as an opt-in composition rather than a forced fusion.
- The tribute realised as a payout-time deduction, not a held reserve and not a special case —
  coheres with the unified append-only ledger keystone and adds no custody surface.
- Reuse: a handful of event kinds and index tables mirroring existing ones, one render affordance,
  a single `tribute_payout` ledger trigger, and a unified net-position read. No new transport, store,
  custody, or moderation surface.

**Costs / accepts:**
- The faithfulness layer grounds only the narrow floor; selection bias and bad interpretation pass.
- v1 cannot ground paywalled spans — the hole sits where the highest-value content is.
- A small refundable stake adds friction to third-party disputes (the cited author is exempt).
- Tribute resolution may cold-contact non-users over slow channels; the threshold and window mitigate
  but do not eliminate the latency.
- Earnings made before the inspirer consents are not recoverable for the tribute (§Edge cases 7) —
  the accepted cost of holding no third-party funds.
- Depends on two not-yet-built pieces of the ledger keystone: a unified net-position read, and the
  Phase-3 cutover that makes the ledger read-authoritative for balances. Until both land, the tribute
  deduction cannot be computed correctly at payout.
- Bindingness is local: it holds for readers still looking at the claim, not for a reader who leaves.

---

## Open questions

1. **Authoring granularity.** Tribute is per-piece (settled — earnings aren't per-passage). The
   *named* credit could be passage-anchored ("this section draws on X") using the endnote system.
   Adopt passage-anchored endnotes, or keep credit piece-level for v1?
   (The *display* of the credit is no longer open — it stands on publish, needing no consent; §A.5.)
2. **Percentage on an unreachable target.** Permit attaching a percentage to an unaddressable inspirer
   (it can never go `live` — there is no payee to consent — so it would only ever show an estimate
   that pays nothing) — or hard-disable the percentage field when there is no address?
3. **The standing-marker judgement call.** Privileging the cited author's dispute at glance-level is a
   *standing* distinction (who was characterised vs bystander), not a truth-verdict — same logic as
   the existing `p` tag. It is the one place a reader could squint and read platform weighting. If that
   is unacceptable, the fallback is no glance-level marker at all (all disputes on expansion), at the
   cost of making "you misread me" easy to miss.
4. **Dispute-stake refund trigger.** The third-party dispute stake (§Edge cases 4) is *never forfeited*
   — that much is fixed. What is open is **when it is credited back**: on the disputant withdrawing the
   dispute, after a fixed dwell (the §A.3 60-day clock is the obvious candidate), on the citation being
   corrected, or some combination. Each shapes the friction differently (a withdraw-only refund locks
   the stake for the life of a standing dispute; a dwell refund makes the friction purely momentary).
   Decide before wiring the `dispute_stake` refund trigger.

---

## Implementation sketch (execution order)

0. **Prerequisite (ledger keystone, not part of this ADR):** (a) **writer-side accrual modelled in the
   ledger** (does not exist today — `getWriterEarnings()` sums `read_events`, not the ledger; see
   prerequisites), (b) the unified net-position read over `ledger_entries` (`SUM(amount_pence)` per
   `account_id`, all triggers, **at piece granularity** so a per-piece percentage is computable), and
   (c) the Phase-3 cutover that makes the ledger read-authoritative for balances. The tribute deduction
   (step 3) cannot be computed correctly until all three land; sequence accordingly — (a) is the long
   pole.
1. **Migration + ledger wiring:** `tributes`, `citation_edges`, `dispute_edges`. Extend the
   `LedgerTriggerType` union in `shared/src/lib/ledger.ts` with `tribute_payout` (written per cycle
   while a tribute is `live`; a **mirrored double-entry pair** — two rows, both legs non-NULL
   `counterparty_id`, no platform leg) and the `dispute_stake` hold/refund pair; **register the writing
   files in `scripts/check-ledger-adjacency.sh`'s `REGISTRY`** (or the new-site scan fails CI) and
   **extend the migration-120 read-model views + `scripts/reconcile-ledger.sql`** to account for the new
   triggers (the two-rows-per-movement shape breaks the one-row-per-movement / implicit-platform-leg
   assumption those views encode).
   No `tribute_pending`, no accrual/revert triggers. Index `citing_article_id`,
   `target_citation_event_id`, `(citing_author_id)`, `(source_naddr)`, `(piece_article_id)`,
   `(resolved_account_id)`. Declare PKs + FKs on the new tables (the §A.7/§B SQL is a sketch; the
   `citation_edge_id`/`piece_article_id`/`author_id`/`resolved_account_id` references must become real
   `REFERENCES` constraints in the migration).
2. **Event kinds:** register provisional `30100` (citation), `30101` (dispute); confirm NIP range and
   document in `shared`.
3. **Tribute lifecycle:** notional estimate over earnings-to-date (no ledger writes); threshold
   detector → notification over the recipient's rail; window timer from `first_contact_at`; consent →
   `live`, after which each payout cycle deducts the share from the author's net and writes the
   `tribute_payout` pair; decline/lapse → no money moved (estimate discarded); late-claim → set
   `resolved_account_id` and route future earnings from the next cycle.
4. **Gateway:** `POST /citations`, `POST /disputes` (third-party requires a stake hold);
   `GET /articles/:id/citations` returning citations + disputes with cited-author disputes flagged for
   glance-level render; tribute claim/decline endpoints for the recipient.
5. **Composition seam:** `tributes.citation_edge_id`; on consent, a coupled tribute resolves the
   recipient from the citation's `p` tag. The ledger entry is written at each payout once `live`, not
   at tribute creation. Citation publish writes no ledger entry.
6. **Web editor & claim page:** span selection + characterisation in TipTap; standing-bounded
   contested-marker render in the NIP-23 renderer; expand-context viewer; the cold claim page for a
   possibly account-less inspirer — a **money decision only** (accept / decline / ignore); the credit
   is not on the claim page since it needs no consent (§A.5), and an objection to being named is a
   disclaimer counter-edge, not a claim-page action.
7. **Record view:** author-profile query of citations/disputes by pubkey, rendered as the standing
   record (no score).

Step 0 is a prerequisite owed to the ledger keystone, not to this ADR. Steps 1–4 are the substance;
5 is the seam; 6–7 are surface. None of it adds a subsystem; none of it adds a custody surface.
