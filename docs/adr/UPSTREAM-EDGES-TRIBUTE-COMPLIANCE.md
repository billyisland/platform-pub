# Upstream Edges — Tribute Held-Funds Compliance Position

**Status:** Position drafted 2026-06-23 — resolves the open compliance gate on `UPSTREAM-EDGES-BUILD-PLAN.md` Phase 3 (and the ADR's *Edge cases › Holding third-party funds*) to the point where Phase 3 code may be written. **This is a structured engineering position for whoever owns compliance to confirm, not a legal sign-off.** It identifies the regulatory hooks, states a defensible structure, and lists the few things a compliance reviewer must verify before the money flag is enabled.

**Companions:** `UPSTREAM-EDGES-ADR.md` (what/why), `UPSTREAM-EDGES-BUILD-PLAN.md` (Phase 3 = the gated money phase).

## The question, precisely

Phase 3 apportions a tributed read's writer-side net at settlement and freezes the inspirer's share into a `tribute_accruals` row (`state='held'`) **from tribute creation, regardless of the inspirer's consent** — the inspirer may not have consented, may have no account, may not yet exist. The ADR flagged this as "closer to client-money / e-money territory" than holding an onboarded writer's earnings, and gated the money phase on resolving it.

## Decisive codebase fact: the platform already holds the float

The payment model is **Stripe Connect "separate charges and transfers"** (verified 2026-06-23):

- **Settlement** (`payment-service/src/services/settlement.ts::completeSettlement`) charges the reader with a **plain `PaymentIntent` to the platform's own Stripe account** — no `transfer_data`, no `on_behalf_of`, no `application_fee`. The reader's money lands in the **platform's Stripe balance**.
- **Payout** (`payout.ts::runPayoutCycle`) is a **separate, later** `stripe.transfers.create({ destination: stripeConnectId })` to each writer's connected account.

So between settlement and the £20-threshold payout sweep, **every** unpaid writer earning already sits in the platform's Stripe balance under the platform's control. The held tribute share is **mechanically identical** money in the same balance. The hold introduces no new *kind* of fund-holding — only a different *payee characterisation*. Whatever the platform's posture is for unpaid writer earnings, the tribute hold inherits it; the marginal question is purely whether earmarking a slice for a **non-consented** party changes that characterisation.

## The regulatory frame (UK)

The platform settles in GBP via Stripe, so this is FCA territory: the **Payment Services Regulations 2017 (PSR 2017)** and **Electronic Money Regulations 2011 (EMR 2011)**, with the strengthened safeguarding regime in **PS25/12** (in force 7 May 2026).

The load-bearing rule for a marketplace acting for **both** buyer and seller (which this is — readers and writers): under PSD2/PSR 2017 such a platform **avoids becoming a licensed/regulated payment business only if it does not *possess or control* the funds**, relying instead on a licensed PSP (Stripe). The old "commercial agent" exemption narrowed to exactly this — it survives only where the agent does not possess/control funds. ([Stripe — how PSD2 impacts marketplaces](https://stripe.com/guides/how-psd2-impacts-marketplaces-and-platforms))

Two consequences:

1. **This is a pre-existing, platform-wide question, not one tributes create.** "Separate charges and transfers" means the platform *does* exercise control over allocation of funds in its Stripe balance for the whole reading-tab→payout model. The standard mitigation the entire Connect ecosystem relies on is that the funds never leave **Stripe's** regulated, safeguarded custody until they reach either the platform's own bank (its fee) or a connected account — Stripe (a licensed EMI/PI) *possesses* the funds; the platform *instructs* their allocation. The platform's reliance on Stripe as the regulated entity is the existing posture for **all** writer earnings. Tributes sit entirely inside it.
2. **The only genuinely new element** is holding a share earmarked for a party who has not consented and may never become a connected account, plus a contact narrative ("someone wants to pay you") that could be *read* as "we hold money in your name." That representation — not the mechanism — is what would pull the arrangement toward client-money characterisation.

## The resolution: it is the author's money until release

The clean answer turns on **whose money it is**, which is a question of contract and representation, not mechanism:

- **Unpaid writer earnings** are the platform's **payable (a debt) to the writer** — owed because the writer earned them — held in the platform's Stripe-custodied float. That is the existing, defensible posture (the platform already holds un-onboarded writers' earnings "until verification completes").
- **A held tribute share, before the inspirer consents, creates no payable to the inspirer.** The inspirer has no contract, no account, and has accepted nothing — an **unaccepted offer creates no enforceable claim**. The money is therefore **still the author's payable**: the author earned it; the platform owes the author; the author has merely lodged a **revocable standing instruction** to redirect a slice *if and when* the named party accepts within the window. It is the author's money throughout the hold.
- **Only at consent does an inspirer-payable spring into existence** — and at that instant the inspirer is an onboarded connected account, regulatorily identical to any writer. The decline/lapse path returns the slice to the author because **it was always the author's**.

Under this characterisation the held share is **not third-party client money**; it is the author's deferred earnings, indistinguishable in regulatory substance from every other unpaid writer earning the platform already holds. The marginal question collapses to zero — *provided the framing is made true and is represented consistently.*

## Conditions that make the framing true (build + product requirements)

These are not optional gloss; they are what keeps the characterisation honest. Phase 3 must ship with all of them.

1. **Author-side terms.** The tribute is the author's **standing, revocable instruction** to redirect a portion of the author's *own* earnings on the piece to a named party **if and when that party accepts and onboards within the window**. Until then the share remains the author's earnings, held on the **same basis as all other unpaid earnings**; on decline or lapse it stays the author's. No trust is declared in favour of the inspirer; no custody is promised to the inspirer.
2. **Inspirer-side representation (the contact email + in-app offer).** Present an **offer of a future payment conditional on acceptance and onboarding** — never "we are holding £X for you" or "funds are reserved in your name." The money is not the inspirer's until they accept. (This is also the less scam-shaped, more honest message, and it is exactly what the ADR's contact copy should say.) **Audited and corrected 2026-06-23** — every Phase-2 contact/render surface now uses conditional-offer wording: the public render line says *"X% will go to Y if they accept"* for a proposed tribute and *"goes to Y"* only once `live` (`UpstreamEdges.tsx` `earningsVerb`); the proposed status phrase dropped "accruing/held" (no longer asserts money held in the payee's name); the author-side helper + reference email say the share *"stays part of your earnings, reserved pending their reply"* rather than "set aside for them"; the inspirer offer/reminder emails and claim page already framed it as a conditional offer ("nothing is held in your name").
3. **No ring-fencing / no separate trust account for the suspense.** Treat the held share **exactly** like other unpaid writer earnings in the platform's float — same Stripe balance, no segregated "inspirer money" account. Ring-fencing it would *assert* it is third-party money and defeat the characterisation. (`tribute_accruals` is an internal accounting projection over the author's payable, deliberately **outside `ledger_entries`** until release — keep it that way; build-plan guard #7.)
4. **Honest display, consistent with "still the author's."** Author dashboard: the carve shows as *"reserved from your earnings, pending redirect"* (the author's money, conditionally directed), never *"paid to X."* Public render line: *"X% will go to Y if they accept"* for a proposed/held tribute, *"X% goes to Y"* only once `live`. The Phase-3 author-display carve-out (build-plan §Phase 3 "Author *display* must carve too") must show the reduction as **conditional/reserved**, not as a completed transfer.
5. **Window discipline stays.** The 60-day window + lapse→swept→author already encode "the author gets it back if the offer isn't taken up" — that is the contractual proof the money never left the author. Keep it.

## What a compliance reviewer must confirm (the residual checklist)

The structure above is defensible, but these are the points only the compliance owner can sign:

1. **The platform's *baseline* posture** — that relying on Stripe as the regulated EMI/PI for the existing "separate charges and transfers" reading-tab→payout float keeps the platform itself outside PSR/EMR authorisation. This is **pre-existing** and bigger than tributes; if it is *not* already settled, settle it independently. Tributes do not change the answer, but they should not be the first feature to surface an unaddressed baseline gap.
2. **The "author's money until acceptance" characterisation** holds for a hold of up to 60 days for a *named but non-consenting* third party — i.e. that a revocable redirect instruction over the author's own payable does not itself constitute receiving/holding funds "on behalf of" the inspirer before acceptance.
3. **Disclosure adequacy** — that conditions 1–4 above (author terms + inspirer offer wording) are sufficient, and whether anything further is needed in the platform's published terms.
4. **Self-crediting / AML surface** — the ADR already notes sybil self-tribute is "the author's own money, a circle not extraction." Confirm that routing the author's earnings to an author-controlled alt via the onboarding magic-link raises no money-laundering/KYC concern beyond the existing writer-onboarding KYC (`stripe_connect_kyc_complete`).

## If the reviewer wants more conservatism: two dials

The recommended structure is the **accrue-from-creation** model already chosen (ADR rewrite 2026-06-22), now made defensible by framing. If compliance is risk-averse, two strictly-more-conservative dials are available without abandoning the feature:

- **Dial A — consent-gated accrual.** Do **not** freeze/apportion at settlement until consent. Show the author a *projected* reduction, but keep the full amount as the author's ordinary payable; on consent, carve **from that point forward** (or retroactively recompute the in-window reads). Eliminates any earmark-and-hold for a non-consenting party entirely — there is never a `held` row keyed to an unconsented tribute. **Cost:** a late-consenting inspirer earns only post-consent reads unless you retroactively recompute, and retroactive recompute reintroduces a (smaller, in-window) hold. Weakens the "the money was always waiting for you" cushion.
- **Dial B — Stripe funds segregation** ([docs](https://docs.stripe.com/connect/funds-segregation), GB-eligible). Demonstrably ring-fences allocated funds inside Stripe's custody, out of the platform's spendable balance, transferable **only** to connected accounts. This is belt-and-braces for the *baseline* float question (#1 above) more than for tributes, and it has a real constraint: segregated funds can only move to a connected account, never back to platform payouts/refunds. It does **not** compose cleanly with treating the suspense as the author's payable (it would assert segregation = third-party money), so it is an alternative architecture for the whole float, not a tribute add-on. Note as available, not recommended for tributes.

## Recommendation

Keep the **accrue-from-creation** model (no design change to the ADR), **enable Phase 3 only after** (a) the compliance owner confirms baseline-posture point #1 and characterisation point #2, and ~~(b) the Phase 2 contact/render copy is audited and corrected to condition #2's "conditional offer, not held-in-your-name" wording~~ **(b) — done 2026-06-23** (see condition #2 above). The sole remaining gate is the human sign-off (a). Dial A is the fallback if #2 cannot be confirmed; Dial B is parked as a baseline-float option, not a tribute mechanism.
