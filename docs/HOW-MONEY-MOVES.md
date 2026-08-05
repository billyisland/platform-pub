# How money moves on all.haus

*A plain-English explanation of what actually happens, in the code, every time
money is involved on all.haus — written so basically anyone can follow it.*

*Checked against the code 2026-08-05. This page describes what runs **today**;
where something recently changed, the change is called out rather than quietly
overwritten, because a money explainer that silently drifts is worse than none —
three sections of it had gone stale before the previous pass, each describing
behaviour that had been fixed months earlier. If you change a money path, change
this too.*

*This pass follows a fortnight of Stripe work, most of it prompted by the first
time any of this was pointed at a **real Stripe account** rather than a test
double. That drive found two ways the code could not charge a card at all, or
could charge it twice; it also confirmed, by counting Stripe's own event log,
that two webhooks the code had been waiting for simply do not exist. All of that
is described below where it belongs, and the old wording is kept where it was
wrong so the correction is visible rather than silent.*

---

## The big idea: a bar tab

all.haus works like a bar tab. You don't pay for each article as you read it.
Instead, a little gets **chalked up on your tab** every time you read something
paid. Every so often, when the tab gets big enough, all.haus quietly charges
your card for the whole lot at once. Then later, the money is handed out to the
writers you read.

So there are really **three stages**, and the code is literally organised that
way (`accrual.ts` → `settlement.ts` → `payout.ts`):

1. **Chalk it up** — a debt is recorded when you read something paid.
2. **Settle the tab** — your card actually gets charged.
3. **Pay the writers** — the money is sent on to the people who earned it.

Behind all of this is one golden rule in the code: **every single time money
moves, a line is written in a permanent notebook called the *ledger***
(`ledger.ts`). Lines are *never erased*. If something needs undoing, they write
an *opposite* line. That notebook is how all.haus always knows, to the penny,
who owes what and who is owed what.

One more thing worth knowing up front: all.haus uses **Stripe** (the payment
company) for the actual card plumbing, and it trusts Stripe's **webhooks** —
little messages Stripe sends saying "this really happened" — as the truth,
rather than trusting the reply it gets the instant it asks. Stripe promises to
deliver those messages *at least once*, which is exactly the guarantee you want
for money.

---

## Before anything: do you have a card on file?

Everyone starts with a **£5 free allowance** (`free_allowance_pence: 500`). If
you have **not** added a card, your reads are marked **"provisional"** — pretend
money. The cost is just subtracted from your £5; nothing is chalked on a real
tab and the ledger stays silent (`classifyRead` in `accrual.ts`).

The £5 is a **dial**, not a constant: an operator can retune it without a code
change. What that means for you is that the figure is **stamped on your account
the day you sign up** (`accounts.free_allowance_granted_pence`), so if the dial
is later changed to £7.50, your statement still — correctly — says you were
given £5. The dial governs what happens next; your row records what happened.
(Until July 2026 the dial governed nothing at all: every place that mattered
carried its own hard-coded `500`, so an operator could change it, see no error,
and change nothing.)

To add a card, the code does a careful two-step dance with Stripe (`auth.ts`):

- **Step 1 (`setupIntents.create`, `usage: "off_session"`)** — all.haus makes
  you a Stripe "Customer" and asks Stripe for a *SetupIntent*. Your browser uses
  this to enter your card and pass any bank security check (the "verify it's
  you" 3-D Secure popup) *while you're sitting there*. Crucially, `off_session`
  means you're also giving permission for all.haus to charge that card **later,
  when you're not there** — which is the whole point of a tab.
- **Step 2 (`connect-card`)** — all.haus double-checks with Stripe that the card
  setup truly **succeeded** and that it belongs to you, then marks your account
  as "has a usable card." Only now do your provisional reads get moved onto a
  real tab (`convertProvisionalReads`).

**The £5 is a gift, and adding a card does not take it back.** This matters more
than it sounds. When those provisional reads move onto your tab, you are charged
only for the part the allowance *didn't* cover — every penny it did cover is
charged to nobody and earns nobody, permanently. So each read carries two
numbers: what the article cost (`amount_pence`) and what you actually owe on it
(`chargeable_pence`). Every money path uses the second.

> This was a real bug, live and silent from the day that conversion was written
> until July 2026: it converted every provisional read at the **full** price, so
> a reader who read on the house and later added a card was billed for the gift,
> and the writer earned on pence nobody had paid. The £5 was, in effect, a loan
> that adding a card called in.

This carefulness is deliberate: the comments note that an earlier, sloppier
version would happily accept a dud card and only discover it was broken weeks
later, the first time it tried to charge it.

---

## Stage 1 — Chalking it up (a debt is recorded)

### When you read a paid article

The key service confirms you're allowed in and calls `POST /gate-pass`. The code
(`recordGatePass`) then:

1. Looks at your account and decides: do you have a card?
2. **No card** → the read is "provisional," cost comes off your £5 allowance, no
   ledger line.
3. **Card on file** → the read is **"accrued."** Your tab balance goes **up** by
   the article's price (`reading_tabs.balance_pence += amount`), and a ledger
   line is written: *"reader owes this much"* (a **debit**, `read_accrual`).

That's it — no card is touched yet. You've just run up your tab a little.

(A private "receipt" is also signed and queued for the Nostr relay afterwards,
but that's record-keeping, not money.)

### When you subscribe to a writer or a publication

A subscription is **not** a separate card charge. It goes on the same tab: the
month's price is chalked up exactly like a read (`logSubscriptionCharge`), and
gets collected by the same settlement machinery. So subscribing simply makes
your tab reach £8 sooner.

Two consequences worth knowing:

- **A subscription needs a card.** Because a subscription charge is pure tab
  *debt* — there's no article to gate — subscribing with no card on file is
  refused outright (`402 card_required`), and a renewal on a reader who has
  since removed their card **expires the subscription rather than charging it**.
- **Your renewal date is a calendar date, and it stays put.** Signing up on the
  31st renews on the 31st, or the last day of a shorter month. Until August 2026
  it did not: the code added a flat "30 days," and the renewal worker advanced
  *the previous renewal date* by a month using a function that overflows instead
  of clamping (31 Jan + 1 month → 3 Mar). Because each month advanced the
  already-drifted date, the error compounded, and a subscriber taken out on the
  31st walked forward a few days every month until the renewal date had nothing
  to do with the day they agreed to. The day you signed up is now a stored fact
  on the row (`subscriptions.period_anchor_day`) and every renewal is counted
  from *that*, never from the last one. **Existing drift was deliberately left
  alone**: re-deriving the true date would push a live subscriber's next renewal
  *later* than the date they've already been told, and moving someone's billing
  date without telling them is a refund question, not a migration.

### When you vote

**Voting is free, and moves no money at all** (`votes.ts`). Nothing is added to
your tab, no ledger line is written, and no writer earns anything from a vote.
You get **one vote per thing per direction** — voting the same way on the same
post again just returns the current tally and changes nothing. You can't vote on
your own posts.

> Votes used to cost money, on a price that doubled each time you voted the same
> way (upvotes free then 10p, 20p, 40p…; downvotes from 10p). That was removed in
> July 2026. The `vote_charge` line still exists in the ledger's vocabulary, but
> only so the historical entries from that period still read correctly — nothing
> writes a new one.

---

## Stage 2 — Settling the tab (your card is actually charged)

This is the moment real money leaves your bank. It's handled by `settlement.ts`.

### What triggers it

Right after every read, and on a scheduled job, the code checks your tab
(`checkAndSettle`):

- **Tab reaches £8** (`tab_settlement_threshold_pence: 800`) → settle now, **or**
- **Tab is at least £2 and it's been ~30 days** since you last read (the "monthly
  fallback") → settle the leftover.

(Stripe won't process charges under **30p**, so a tiny tab just waits.) If a
previous charge was declined, your account gets a "card needs attention" flag
and settlement **backs off** until you re-add a card — so all.haus doesn't keep
hammering a dead card.

### How the charge is made — a careful four-step pattern

The code never just "charges the card and hopes." It uses a
**reserve → charge → confirm** pattern so a crash or a lost internet connection
can't charge you twice or lose track of a charge:

1. **Reserve** (`reserveSettlement`): in the database, it locks your tab, checks
   that no other settlement is already in flight on it (more on that below),
   works out the **8% platform fee** (`platform_fee_bps: 800`) and the rest "to
   writers," and writes a `tab_settlements` row marked **"pending."** This
   commits *before* talking to Stripe.
2. **Find the card** (`resolveDefaultPaymentMethod`): it asks Stripe which card
   you currently have on file, **every time**, rather than trusting a copy saved
   here. That way a card you've since swapped or updated is the one that gets
   charged, and there's no stale copy to quietly bill a dead card.
3. **Charge** (`paymentIntents.create`): it asks Stripe to charge that specific
   card — `confirm: true, off_session: true` (charge it now, you're not present)
   — and attaches a **stable idempotency key** (`settlement-<id>`). That key is
   the safety catch: if all.haus has to retry, Stripe recognises the key and
   **won't create a second charge.**
4. **Confirm**: marks the settlement "completed."

### Two things that were wrong here, and only a real Stripe could show it

Both of these had been on production for months. Both were invisible to every
test in the repo, for the same reason: a test stands in for Stripe and answers
the call, and Stripe is the only thing that knows Stripe's rules.

- **The charge named no card, so no charge could ever succeed.** Step 2 above is
  new. The code used to hand Stripe only the *customer*, on the reasonable-sounding
  assumption that a charge inherits the customer's default card. It does not —
  that setting governs invoices and subscriptions, not one-off charges. Stripe
  rejected every attempt with an error the code (correctly!) reads as "this card
  is no good," so the machinery did its job perfectly on a false premise: the
  settlement was marked failed and the reader was shown a *please fix your card*
  prompt, for a card that had never been anything but fine.
- **There was a window where you could be charged twice.** Your tab is not paid
  down when the charge is *sent* — only when Stripe's "it went through" message
  comes back. But the settlement stopped being marked "pending" the instant the
  charge was sent. In the gap between those two moments, the tab still read full
  and nothing was marked pending, so a second read could start a second charge
  for the same debt. Measured, not theorised: one £14 debt charged twice, 58ms
  apart, and then a third attempt 1.3 seconds later — **and nothing alerted**,
  because a tab going negative is legal here (it just means you're in credit).
  The "already in flight?" check now covers both states — pending *and* charged
  but not yet applied — so the worst case is a collection being **delayed**,
  never duplicated.

### When the safety catch itself jams

The stable idempotency key stops a retry from double-charging. But it has an
edge: Stripe only honours a repeated key if the request is **identical**. Since
the charge is rebuilt fresh each attempt (it looks your current card up), the
request can legitimately change between the first attempt and a retry — you
swapped cards, or the code was deployed. From then on, *every* retry returns
"you've used this key with different parameters," forever. The settlement stayed
"pending," and because a pending settlement blocks the tab, **your tab froze —
silently.** Three settlements were found wedged exactly this way.

That one error is now handled specially (`recoverIdempotencyConflict`), because
it's the one ambiguous error that is also *resolvable*: it proves the first
request did reach Stripe. So instead of retrying, the code goes and **looks the
charge up**, and then does whichever of four things is true:

- **Found and paid** → adopt it. That charge *is* this settlement.
- **Found and dead** (needs a new card, needs your action, cancelled) → treat it
  like any decline: mark failed, ask for a card.
- **Provably absent** → the first request errored before creating anything, so
  mark it failed **without** blaming the card, and let the next sweep start over
  with a fresh key.
- **Couldn't see the whole window** → absence isn't proven, so **change
  nothing**. Guessing here could charge you twice.

The lookup uses Stripe's plain *list* endpoint, deliberately not its *search*
endpoint: search runs on an index that lags, and a lagging index would report a
charge as absent when it exists — which is exactly the answer that leads to
charging you again. And any settlement still stuck pending after a full retry
cycle (~8 hours) now raises an alarm, so a frozen tab is loud rather than quiet.

### When the money is *really* counted

Here's a subtle but important bit: all.haus doesn't pay your tab *down* the
instant it sends the charge. It waits for Stripe to send back the
**`payment_intent.succeeded`** webhook (the "yes, it genuinely went through"
message). Only then (`confirmSettlement`):

- Your tab balance goes **down** by the amount charged, with a matching ledger
  **credit** (`tab_settlement`).
- The reads that this charge paid for are stamped **"platform_settled."**
- A ledger line is written for each writer recording what they've now **earned**
  — their share is the read price **minus the 8% fee** (`writer_accrual`). The
  8% gap is all.haus's cut, and the code never stores the platform as an
  "account" — its fee is simply *the difference* between what you paid and what
  writers get.
- Any subscription charges the same settlement collected are stamped as paid, so
  those writers' subscription earnings become payable too.

There's a fallback for the case where the charge succeeded but the record of
*which* charge it was never got saved (a crash in the wrong half-second): every
charge carries its settlement's id as a label, so the success message can find
its settlement by that label instead. Adopting a settlement this way also marks
it **completed** — a settlement whose money has been collected must not go on
wearing an "in flight" label, or the retry sweep keeps re-driving it and the
reader's next collection is held up behind it.

### If the card is declined

The code splits failures in two (`charge-errors.ts`):

- **Terminal** (card declined, expired, bank security failed, or the customer
  turns out to have no usable card at all) → mark the settlement **failed**,
  unfreeze the tab, flag your account to ask for a new card. *Don't retry.*
- **Ambiguous** (Stripe timed out, network blip — *maybe* the charge went
  through) → **leave it pending and retry later** with the same idempotency key.
  The code is deliberately careful **never to assume a failure here**, because
  assuming wrongly would charge you twice. (The one exception is the key-conflict
  case above, which is resolved by looking rather than by retrying.)

Whenever a settlement is failed for a card reason, your account gets a *card
needs attention* flag — and that flag is what the site shows you. It matters
that this is set on **every** such path, including the odd ones (a reader whose
Stripe customer record has vanished): a path that failed the settlement without
setting the flag left the tab unfrozen but the reader never told why collection
had stopped.

There's also a safety net (`reconcileSettlements`): if Stripe's "succeeded"
message ever goes missing, a sweep later asks Stripe directly "did this actually
pay?" and finishes the job — so you can never end up charged with your tab still
showing the debt. These sweeps run three times a day, and they also re-drive any
settlement stuck pending, so a settlement no longer waits for a service restart
to heal.

### Where the money is now

After settlement, the money sits in **all.haus's own Stripe account**. all.haus
has kept its 8%, and the rest is *owed* to writers but **not yet sent** to them.

---

## Stage 3 — Paying the writers

This is `payout.ts`, and it runs on a **daily** cycle (02:30 UTC) — actually
three cycles in sequence: writers, then publications, then tributes.

Before any of them moves a penny, there's a gate: if the ledger reconciliation
job (which runs three times a day) found that the tab balances and the ledger
disagree, **all outbound payments stop** until a human has looked. Money can
always wait; money paid out against books that don't add up cannot be recalled.

### Writers must "prove who they are" first

Before all.haus can send anyone money, that writer must finish **Stripe
Connect** onboarding — Stripe's identity/bank-details check (KYC). The code
(`auth.ts → upgrade-writer`):

- Creates a Stripe **Connect Express account** (`accounts.create`, type
  `express`, requesting the `transfers` capability), then
- Generates a **hosted onboarding link** (`accountLinks.create`) where the
  writer enters their details and bank info on Stripe's own pages.

When that's done, Stripe sends an **`account.updated`** webhook; all.haus checks
the account can actually **receive transfers and do payouts**
(`isConnectPayable`) and marks the writer payable. (If Stripe later *disables* a
writer — fraud review, etc. — the same webhook flips them back to "not payable,"
and they quietly drop out of the payout run.)

### Sending the money

Each day, for every writer who is **payable** and has at least **£20** owed
(`writer_payout_threshold_pence: 2000`), the code uses the same careful
**reserve → transfer → confirm** pattern:

1. **Reserve**: write a `writer_payouts` row marked "pending" and tag all the
   reads being paid, so two cycles can't pay the same read twice.
2. **Transfer** (`transfers.create`): move the writer's **net** earnings (price
   minus 8%, already taken at settlement) from all.haus's Stripe balance to the
   writer's connected account — again with a **stable idempotency key**
   (`payout-<id>`) so a retry can't double-pay.
3. **Confirm**: flip the payout to **"completed,"** mark those reads
   **"writer_paid,"** and write a ledger line: *"writer received this money"*
   (`writer_payout`).

**Completion is decided by Stripe's answer to the transfer request itself**, not
by a later webhook. That is worth explaining, because the code used to do the
other thing and was wrong. Stripe does send a **`transfer.paid`** message — but
only for a connected account moving money to *its own bank*, not for us moving
money *to* a connected account. So the payout would sit forever waiting for a
message that was never coming. Since the money moves the moment Stripe accepts
the request, that acceptance **is** the confirmation.

That used to be a strong suspicion with dead code left standing behind it. It is
now **measured**, and the dead code (386 lines) is gone. Proving a thing *never*
happens is awkward — two empty lists look identical to an event log that returns
nothing at all — so the check counted four things at once against a real Stripe
account: **29** `transfer.created` (so transfers of exactly this shape existed),
**24** `transfer.reversed` (so messages about these transfers *are* delivered
here — the positive control), and **0** `transfer.paid`, **0** `transfer.failed`.
With the first two empty it would have reported "don't know" rather than passing
by default.

If Stripe **later claws a transfer back**, it does tell us — `transfer.reversed`
— and that is handled: the writer's ledger goes negative by the amount returned,
including when only part of it comes back.

Transfers, like charges, are split into "definitely failed, safe to retry fresh"
vs "maybe it went through, must not double-send" (`isTerminalTransferError`) —
and here the code is **extra** cautious, because the bad outcome is paying a
writer *twice*.

> **One payout, several transfers.** The above describes what happens today.
> There is a finished-but-switched-off mode (**funds segregation**,
> `STRIPE_ALLOCATED_FUNDS`) in which each reader's charge is locked so it can
> only ever reach a writer's account — never be spent on anything else. Under it
> a payout stops being one transfer and becomes one *per charge drawn on*, each
> naming the charge that funds it. Nothing about who is owed what changes; only
> where the money is drawn from. A single one of those transfers failing is an
> ordinary event — that writer is paid the rest and the remainder is retried next
> cycle — rather than the whole payout getting stuck.
>
> As of August 2026 this has been driven end to end against a real Stripe
> sandbox and passes, but it stays **off**, on two conditions: Stripe confirming
> the feature is enabled for the live account, and a **Mastercard bug on
> Stripe's side** being resolved. The beta only accepts certain card brands, and
> the sandbox run overturned the assumption this design had rested on: a card of
> the wrong brand does **not** simply get charged without the protection — asking
> for it fails the charge outright, which would wedge that reader's tab. So the
> brand is now checked *before* asking, and a card the beta won't take is charged
> perfectly normally with no protection attached. Full detail:
> `docs/adr/FUNDS-SEGREGATION-INTEGRATION.md`.

> **Publications** (shared accounts) pool their articles' earnings and split each
> payout among their members by agreed percentages. Two fixes worth naming, both
> from late July 2026: the publication cycle had a mistake that meant it could
> **never claim a read at all**, so the pool never paid; and a member's split
> that Stripe rejected was marked failed and left there forever, with "do a
> manual transfer" as the standing answer. A rejected split now gets **re-issued
> as a fresh row** (up to three attempts) — it has to be a new row rather than a
> retry of the old one, because the idempotency key that protects against
> double-paying would otherwise dedupe the retry straight back onto the transfer
> Stripe had just refused.
>
> There's also a more elaborate "**tribute**" system that can redirect a slice of
> a writer's earnings to people who inspired them — but that's currently
> **switched off** in production, so in practice it moves no money today.

---

## When money has to go *backwards*: refunds & chargebacks

If a reader disputes a charge with their bank and **all.haus loses**
(`charge.dispute.closed`, status "lost"), or the charge is **fully refunded**
(`charge.refunded`), the code (`reverseSettlement`) carefully unwinds
everything: it **puts the debt back** on the reader's tab, writes opposite
ledger lines, and reverses the writers' earnings for those reads (marking them
"charged_back"). A **partial** refund is *not* auto-handled — the code can't
cleanly split it, so it raises a **"manual review required"** flag for a human
instead of guessing.

Two things happen alongside that unwinding, neither of which is a reversal:

- The debt goes back on your tab, but **automatic collection is put on hold**
  until you re-attach a card. Silently re-charging the same card for the exact
  amount its holder just disputed is the sort of thing card networks penalise.
- A dispute merely being **opened** also raises the manual-review marker, so it
  reaches a human at the point where there's still time to respond to it,
  instead of being discovered when it closes. Opening a dispute reverses
  nothing — it may yet be won.

And under funds segregation (still off), a refund also **draws down the
protected balance** of the charge it came out of, on both the full and partial
arms — because the money genuinely leaves that charge either way, and a
protected pot the code believes is fuller than it is would have the next payout
trying to draw money that isn't there.

**Which reads a reversal claws back — settlement-set, not per-penny.** A
settlement doesn't pair one-to-one with individual reads. Reads that accrue
between a settlement's *reservation* and its *confirmation* advance under that
settlement but are collected by the **next** one, so "exactly which reads did
this one disputed charge pay for" has no answer in principle. Money still
conserves globally — every penny is accounted for — but reversals are computed
against **the settlement's read set as a whole**, not a per-penny pairing of
charge → read. Concretely, this means: a reader is refunded the settlement
amount, and the writers' earnings clawed back are those attributed to that
settlement's reads — which may not be the literal articles the reader would name
as "the ones I'm disputing." all.haus does not, and by construction cannot,
promise per-charge precision on that mapping. Reader-facing refund copy and the
writer-facing earnings/clawback view must both describe reversals as
settlement-level, never per-article. (Mechanics: `confirmSettlement`
read-claiming + `chargeback.ts`; the approximation is documented at the
`confirmSettlement` call site.)

---

## The three ideas that hold it all together

1. **The ledger is sacred.** Every movement — debt chalked up, card charged,
   writer paid, charge reversed — writes one permanent, never-edited line
   (`recordLedger`), *in the same breath* as the money actually moving. To fix a
   mistake you add a reversing line, never a rubber-out. This means all.haus can
   always reconstruct, exactly, where every penny is.

2. **Stripe's webhooks are the truth, and the code assumes they can be late,
   duplicated, or lost.** Every charge and transfer uses a stable idempotency
   key (so a retry can't double-act), every webhook is de-duplicated
   (`stripe_webhook_events`), and reconciliation sweeps go back and ask Stripe
   directly to catch anything that slipped through. The whole system is built so
   that the worst a glitch can do is *delay* money — never lose it, double-charge
   a reader, or double-pay a writer.

3. **A stand-in for Stripe cannot tell you what Stripe does** — the third idea,
   added August 2026 because the last fortnight put it beyond argument. The two worst
   defects on this page — a charge that named no card, and a window in which one
   debt could be charged twice — sat in code that compiled, passed a full test
   suite, and had been reviewed. Neither was reachable from a test that answers
   on Stripe's behalf, because in both cases the thing that knew the answer was
   Stripe. The same standard applies to claiming an absence: "this webhook never
   fires" is only worth anything with a denominator and a positive control
   beside it.

---

## The numbers, in one place

- **£5** free to start (a dial, and stamped on your account so a later retune
  can't rewrite what you were given)
- all.haus takes **8%**
- your card is charged when your tab hits **£8** (or **£2** after ~a month)
- Stripe won't charge under **30p**
- writers are paid out **daily** (02:30 UTC) once they're owed **£20** and have
  passed Stripe's identity check; publications the same, at their own **£20**
- backstop sweeps run **3×/day** (00:15, 08:15, 16:15 UTC); a settlement stuck
  more than **8 hours** raises an alarm
