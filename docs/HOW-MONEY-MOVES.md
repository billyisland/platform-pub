# How money moves on all.haus

*A plain-English explanation of what actually happens, in the code, every time
money is involved on all.haus — written so basically anyone can follow it.*

---

## The big idea: a bar tab

all.haus works like a bar tab. You don't pay for each article as you read it.
Instead, a little gets **chalked up on your tab** every time you read something
paid. Every so often, when the tab gets big enough, all.haus quietly charges
your card for the whole lot at once. Then later, the money is handed out to the
writers you read.

So there are really **three stages**, and the code is literally organised that
way (`accrual.ts` → `settlement.ts` → `payout.ts`):

1. **Chalk it up** — a debt is recorded when you read or vote.
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

To add a card, the code does a careful two-step dance with Stripe (`auth.ts`):

- **Step 1 (`setupIntents.create`, `usage: "off_session"`)** — all.haus makes
  you a Stripe "Customer" and asks Stripe for a *SetupIntent*. Your browser uses
  this to enter your card and pass any bank security check (the "verify it's
  you" 3-D Secure popup) *while you're sitting there*. Crucially, `off_session`
  means you're also giving permission for all.haus to charge that card **later,
  when you're not there** — which is the whole point of a tab.
- **Step 2 (`connect-card`)** — all.haus double-checks with Stripe that the card
  setup truly **succeeded** and that it belongs to you, then marks your account
  as "has a usable card." Only now do your provisional reads get **converted to
  real debt** and moved onto a real tab (`convertProvisionalReads`).

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

### When you vote

Votes cost money too (`votes.ts` + `voting.ts`), and the price **doubles** each
time you vote the same way on the same thing:

- **Upvotes:** 1st is **free**, then 10p, 20p, 40p, 80p…
- **Downvotes:** start at 10p, then 20p, 40p…

The money side works exactly like a read: no card → comes off your free
allowance (provisional); card on file → added to your tab with a ledger debit
(`vote_charge`). The difference is *who it's earmarked for*: an **upvote's**
money is tagged for the **author** you upvoted; a **downvote's** money is tagged
for **all.haus itself** (the platform). You can't vote on your own posts.

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

### How the charge is made — a careful 3-step pattern

The code never just "charges the card and hopes." It uses a
**reserve → charge → confirm** pattern so a crash or a lost internet connection
can never charge you twice or lose track of a charge:

1. **Reserve** (`reserveSettlement`): in the database, it locks your tab, works
   out the **8% platform fee** (`platform_fee_bps: 800`) and the rest "to
   writers," and writes a `tab_settlements` row marked **"pending."** This
   commits *before* talking to Stripe.
2. **Charge** (`paymentIntents.create`): it asks Stripe to charge your card —
   `confirm: true, off_session: true` (charge it now, you're not present) — and
   attaches a **stable idempotency key** (`settlement-<id>`). That key is the
   safety catch: if all.haus has to retry, Stripe recognises the key and **won't
   create a second charge.**
3. **Confirm**: marks the settlement "completed."

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

### If the card is declined

The code splits failures in two (`charge-errors.ts`):

- **Terminal** (card declined, expired, bank security failed) → mark the
  settlement **failed**, unfreeze the tab, flag your account to ask for a new
  card. *Don't retry.*
- **Ambiguous** (Stripe timed out, network blip — *maybe* the charge went
  through) → **leave it pending and retry later** with the same idempotency key.
  The code is deliberately careful **never to assume a failure here**, because
  assuming wrongly would charge you twice.

There's also a safety net (`reconcileSettlements`): if Stripe's "succeeded"
message ever goes missing, a sweep later asks Stripe directly "did this actually
pay?" and finishes the job — so you can never end up charged with your tab still
showing the debt.

### Where the money is now

After settlement, the money sits in **all.haus's own Stripe account**. all.haus
has kept its 8%, and the rest is *owed* to writers but **not yet sent** to them.

---

## Stage 3 — Paying the writers

This is `payout.ts`, and it runs on a **daily** cycle.

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
3. **Confirm**: flip the payout to "initiated," mark those reads
   **"writer_paid,"** and write a ledger line: *"writer received this money"*
   (`writer_payout`).

The payout isn't marked truly **"completed"** until Stripe sends the
**`transfer.paid`** webhook — i.e. the cash has actually landed, not just been
queued. If Stripe sends **`transfer.failed`** instead, the reads are rolled back
to "settled" and tried again next cycle. Transfers, like charges, are split into
"definitely failed, safe to retry fresh" vs "maybe it went through, must not
double-send" (`isTerminalTransferError`) — and here the code is **extra**
cautious, because the bad outcome is paying a writer *twice*.

> **Upvotes** ride along the same payout pipeline: the money you spent upvoting
> an author is paid out to that author just like a read. **Publications** (shared
> accounts) split each payout among their members by agreed percentages. There's
> also a more elaborate "**tribute**" system that can redirect a slice of a
> writer's earnings to people who inspired them — but that's currently
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

---

## The two ideas that hold it all together

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

---

## The numbers, in one place

- **£5** free to start
- all.haus takes **8%**
- your card is charged when your tab hits **£8** (or **£2** after ~a month)
- Stripe won't charge under **30p**
- writers are paid out **daily** once they're owed **£20** and have passed
  Stripe's identity check
