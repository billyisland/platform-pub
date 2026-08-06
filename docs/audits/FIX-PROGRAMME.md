# all.haus — consolidated fix programme

Merges `docs/audits/platform-pub-review.md` (DM path, resolver, feed-ingest, Stripe,
dead-code sweep) and `docs/audits/AUDIT-BACKLOG.md` (scheduler, access, subscriptions,
service structure, refactor debt) after spot-verification against `master`.

Both audits hold up on the things I re-checked against source. Where they
overlap (unused components, workspace setup, `generateDTag`/slug duplication)
they agree; where they don't overlap they are complementary — `AUDIT-BACKLOG`
§29 explicitly flagged DM / resolver / Stripe webhook as out of its scope, and
those are the core of `platform-pub-review`. Claims rejected by either audit
(`/my/account-statement` orphan, 32-md-file count, 42 `as any`) survive my
cross-check as rejected.

Priority is **correctness risk × blast radius × effort**. P0 items can silently
lose user money or corrupt state. P1 are real bugs but not actively destroying
data, or drift hazards. P2 is housekeeping. P3 is bigger architectural work.

Each item points at files/lines so the diagnosis can be re-checked before work
starts.

---

## Progress

- **2026-08-06 (the rev. 4 scoping's two standalone defects — a dial nobody
  read, a share anybody could move — and the blocker that wasn't)** —
  CONSOLIDATED-TODO §1.14, §1.15, §1.16. All three came out of the
  PAYMENT-PERIMETER rev. 4 scoping pass but stand independent of the programme.

  **§1.14 — `publication_payout_threshold_pence` had no reader.** Seeded by
  migration 038, listed in the admin config UI's Money group, and read by
  nothing: `runPublicationPayoutCycle`'s eligibility query bound
  `config.writerPayoutThresholdPence`. An operator moving the publication
  threshold got a successful save, no error and no change — the `CLAUDE.md`
  "dial with no reader" class in its most silent form. Now on `PlatformConfig`
  (both copies), read by `loadConfig` as `publicationPayoutThresholdPence`,
  covered by the parity suite's `FALLBACK_KEYS`, and bound by the publication
  cycle.

  **The stated alternative did not exist.** The queue item offered "wire it or
  drop the seed"; dropping it fails CI by construction, because migration 038
  seeds the key and drift-guard **Check 4c** replays every migration seed onto
  the defaulted DB and fails if a row appears. A dial a migration has ever
  seeded can be re-pointed or re-described, but it cannot be un-seeded.

  **The test had to disagree with itself to be worth anything.** Both dials
  default to 2000, so a test seeding the defaults passes against the bug exactly
  as it passes against the fix — which is precisely why this survived every
  green suite since 038. `payout-threshold-dials.test.ts` drives both cycles
  against a scripted client with the two dials set to **different** values and
  asserts on which value reached Postgres; the writer cycle is asserted
  alongside as the paired control, so a fix that crossed the wires the other way
  is caught too. Mutated (bind reverted): publication test red on the value,
  `expected [800, 1500] to include 7300`.

  **§1.15 — `revenue_share_bps` was writable from a members mandate.** `PATCH
  /publications/:id/members/:memberId` is gated on `can_manage_members` and
  carried `revenueShareBps` in its fieldMap, so a members-manager holding no
  finance mandate could move a member's standing share of every future
  publication payout. M9 could not see it: M9 guards permission GRANTS, and
  `revenue_share_bps` is not a permission. A mandate hole, not a money-math bug
  — the Σ ≤ 10000 clamp and the `pub_shares` lock both held.

  **Taken by deletion, not by a guard.** The field is gone from
  `UpdateMemberSchema` and the fieldMap, and with it the duplicated advisory
  lock + Σ guard the route was carrying (~20 lines). Nothing called it: the web's
  only writer is `updatePayroll` → the finance-gated `PATCH /payroll`, which
  already owns the lock and the clamp. Adding a `can_manage_finances` check
  would have left two writers of a money column and a second place for the
  invariant to drift; there is now one. That also hands W5 the stronger result
  for free — a split version's `set_by` is mandate evidence **by construction**,
  because the only writer holds the mandate, rather than by a check W5 would
  have had to add and maintain.
  `gateway/tests/publication-member-finance-mandate.test.ts` asserts over the
  UPDATE production really issues (no `revenue_share_bps` in the SET list, the
  value never in the bound params, no Σ read, no `pub_shares` lock), with a
  paired control that the fields the route does own still write. Mutated (field
  restored to schema + fieldMap): two of three red.

  **§1.16 — the blocker that wasn't, corrected the same day it was written.**
  The rev. 4 scoping found that the spend→subscription conversion credits spend
  back to the tab with no offsetting debit over an unfiltered spend SUM, minting
  a Reader-funded negative tab, and filed it as an urgent owner decision gating
  the W0 letter and firing the new `negative_reader_tab` alert on ordinary
  business. **The mechanism is real; the urgency was not.** The route has been
  503-gated behind `SUBSCRIPTION_CONVERT_ENABLED` since 2026-07-16, default off,
  with `DEPLOYMENT.md` carrying an explicit "Do NOT flip to `1`". It cannot fire
  the alert, and W0 describes what ships. The fix it demanded — a real
  `logSubscriptionCharge` leg — has also been a stated precondition of revival
  in §0b item 4 since the route was disabled, so the "three options" were one
  option that had already been chosen a year earlier.

  **What the finding was actually worth** is the *reason* (c) is right, now
  recorded where the revival decision lives: netting the first month to zero is
  the only shape that ends the redeemable claim without quietly shrinking the
  offer the reader was made — which is what makes leg 3 a product call. Attack
  order 0e struck; §1.16 rewritten to carry both the diagnosis and the
  correction, because **a defect found by reading a route is not yet a defect in
  production** — the route's own header carried the flag and the do-not-flip,
  and the scoping pass read the body and not the guard. Establish reachability
  in the deployment before writing a finding up as blocking. One residue, a
  check and not a decision: run the negative-tab query against prod once, since
  pre-2026-07-16 history could have left a real credit for the new alert to
  surface with no live cause to explain it.

- **2026-08-06 (payment perimeter W1 critical path + W6 — a reader in credit is
  an incident, and it must not freeze anyone else)** — the item that gates the
  W0 counsel package, plus the cheap parallel-lane one.

  **W1 detection.** `reconcile-ledger.ts` gained a **severity tier**
  (`Check.severity: 'halt' | 'alert'`, `ReconcileResult.haltRequired`), and the
  new `negative_reader_tab` check is the first `'alert'`. The ADR left the tier
  as the only real option and it proved right for a reason worth keeping: every
  check in that file halted **all three payout cycles**, and a reading tab in
  credit is not a books-divergence — the column and the ledger agree to the
  penny while it sits there, which is precisely why `reader_balance_parity`
  passed over the August 2026 double-charge in silence. Halting on it would
  freeze every Writer's payout over one Reader's credit, i.e. commit the
  ¶7.14.6 principal-like-control marker the whole exercise exists to narrow. So
  `'alert'` violations log under their **own** marker (`alert` = the check name,
  a separate `DEPLOYMENT.md` alert from `payouts_halted`) and touch nothing.
  The halt reason names only halting classes, so an incident can never appear as
  a reason payouts stopped.

  Two design points beyond the ADR's sketch. The check watches the **column**,
  not any writer of it, so it covers all three negative-capable paths
  (settlement's confirm/reverse legs, the dispute stake in gateway
  `upstream-edges.ts`, the credit-back in gateway `subscription-convert.ts`)
  without enumerating them — `applyLedgerDelta` is the column's only writer, so
  watching the column is exhaustive by construction. And violations now carry
  **`truncated`**: for a halting check a capped sample is fine (existence trips
  it), but for an alert-tier check the payload IS the response, and twenty rows
  reading as a total when there were five hundred is the same silence the check
  exists to end. The summary says `20+`. (W4's per-account halting attribution
  needs the stronger form — uncapped — and the comment says so at the constant.)

  **Pinned twice, and every assertion mutation-checked.** Severity / marker /
  truncation against a scripted client (`tests/ledger-reconcile.test.ts`, +4
  tests): collapsing the tier back to `'halt'` fails 2, killing `truncated`
  fails 1, and the mock reads the `LIMIT` out of the SQL rather than pinning a
  fixture — dropping it to 1 fails. Then the detector itself against real
  Postgres (`tests/negative-reader-tab-integration.test.ts`, 4 tests, always
  rolled back, `NEGATIVE_READER_TAB_SQL` exported as its one home so the test
  runs production's own statement). **The control is the point there**: the
  shipped `reader_balance_parity` predicate is run over the same synthetic
  double-settlement and asserted **clean**. Without that pair, "the new check
  fires" says nothing about whether the old one already did — and the whole case
  for W1 is that it didn't. Three SQL mutations each caught (LATERAL ordering,
  deepest-credit-first, `LEFT JOIN`→inner).

  **Runbook** `docs/runbooks/reader-tab-credit.md`, and here the build changed
  the plan. The ADR prescribed one resolution — refund outward — and treated the
  wired admin action as the way to reach it. Reading the webhook path showed the
  commonest cause needs neither: a **full** Stripe refund of the duplicate
  charge fires `charge.refunded` → `reverseSettlement`, which restores the debt
  through `applyLedgerDelta` and rolls the reads back to `accrued`. A **partial**
  refund does not — the handler logs `manual_review_required` and skips the
  unwind, so the reader keeps the credit *and* the money, which is why the
  runbook forbids it as a resolution. So the manual path is complete for cause A
  today, and the admin action is needed only for a residual credit. Two side
  effects documented because a reader will notice them: `reverseSettlement` sets
  `card_action_required_at` (a platform-initiated correction asks the reader to
  re-attach their card), and the restored reads settle again later.

  **The finding that matters most is a blocker on the letter, not on the code.**
  `gateway/src/routes/articles/subscription-convert.ts` credits the reader's
  month-to-date spend back to the tab (`min(spend, subPrice)`) with **no
  offsetting debit** — the first month goes to `subscription_events` only,
  unlike the renewal path's `logSubscriptionCharge` — and its spend query sums
  `read_events.amount_pence` **regardless of state**, so it counts reads already
  settled. A reader who settles mid-month and then converts is taken below zero
  **by design**, holding a Reader-funded credit redeemable against future reads:
  the instrument PAYMENT-PERIMETER-ADR §4 rule 4 bans, reached through a route
  nobody classed as one. So W1's premise — that a negative tab cannot arise
  legitimately — **is untrue as built**, W0 cannot assert it, and the alert will
  fire on ordinary business until it is resolved. Three options recorded in the
  ADR (cap the credit at the outstanding balance / restrict the query to
  unsettled reads / debit `subPrice` so the conversion nets to zero). The third
  is the only one that leaves the reader's offer intact but changes what
  conversion means commercially — an **owner decision**, and the runbook
  escalates that cause rather than refunding it.

  **W6.** All three tribute-brake sites now carry the perimeter reason:
  `shared/src/lib/env.ts::tributesEnabled` (a rewrite — its comment gave the
  pre-Phase-3 settlement-apportionment question, a gate that resolved in June,
  and a stale reason on a live brake is how a brake gets released; the
  correction says so in place), `runTributePayoutCycle`, and the worker call.
  Each says the same thing: the cycle is complete and tested, and it is off for
  a legal reason, not an engineering one.

  Payment-service 258 tests green (+8), root lint 0 errors, ledger-adjacency
  green. `CLAUDE.md`'s money-ledger section gained the severity rule (and its
  "five halting checks" count, now stale, was corrected).

- **2026-08-05 (the two `drives.ts` notification defects — fixed ahead of
  resurrection, not with it; migration 174)** — queued the same day as
  must-fix-before-unparking (§10), then done on request. `drive_funded` and
  `commission_request` were the only two `INSERT INTO notifications` in the
  codebase with **no `ON CONFLICT` clause at all**, so a dedup collision raised
  23505 instead of doing nothing — and `drive_funded`'s runs inside the pledge
  `withTransaction`, so the same pledger funding a SECOND drive by the same
  creator **aborted the pledge**: the money never moved and the pledger got a
  500, on a money path, from a notification. Both behind `PLEDGES_ENABLED` (the
  `/drives` plugin 403s wholesale), so no live incident.

  **The clause alone would have been the wrong fix**, and finding out why is the
  substance of this. `idx_notifications_dedup` keyed on nothing the drive
  notifications set, so to it two DIFFERENT drives between the same two people
  were the same notification — adding `DO NOTHING` in isolation converts a crash
  into a silent drop, and on `drive_funded` that means a creator is never told
  their second drive was funded. The reference column already existed:
  **`notifications.drive_id` has been there since migration 020, whose first
  line reads "for frontend routing"**, with a real FK, selected by
  `notifications.ts` and declared by the web's `Notification` interface as
  `driveId?: string` — **and no insert has ever written it.** Six years of
  end-to-end plumbing with no source. It is migration 172's bug one table over.

  So 174 does the 172 shape: binds `drive_id` on all three drive notifications,
  adds it to the dedup index (keeping 173's partial clause and bare `actor_id`),
  adds `idx_notifications_drive`, and only then the `ON CONFLICT` clauses.
  `pledge_fulfilled` gets both too although it names no actor and so cannot
  collide today — all three read the same, and a later decision to name an actor
  there cannot resurrect the 23505. `ON DELETE SET NULL` kept, deliberately not
  the offer's CASCADE: "a pledge drive you backed was published" reads sensibly
  without the drive, and all three types route to the proposals *list* anyway.

  **Validation — both halves mutated.** Four new DB-backed cases. Mutant A (drop
  `COALESCE(drive_id, …)` from the index) fails exactly the two
  drive-distinguishing tests. Mutant B (remove `ON CONFLICT` from the
  `drive_funded` statement — i.e. the pre-fix route) fails exactly the
  transaction test, with the real `23505 … idx_notifications_dedup`. That test
  is the one that matters and is why the suite is DB-backed: Postgres puts an
  aborted transaction into 25P02 for every later statement, so a statement that
  still succeeds after the repeat **is** the proof the pledge survived. Suites
  after: gateway **493/493**, drift guard **8/8** (Check 3b now covers 214
  indexes and validated 174 on its first run), root lint 0 errors, tsc clean,
  both money tripwires green.

  Rule added to CLAUDE.md, since this class has now shipped twice in two months:
  a notification binds its target, that column is in the dedup index, the insert
  carries `ON CONFLICT`, and `actor_id` stays bare.

- **2026-08-05 (§0p.1 — the dedup index that has been wrong on every database
  for three years, and the guard that could not see it)** — migration 019 made
  `idx_notifications_dedup` PARTIAL (`WHERE read = false`) so that reading a
  notification frees its unique slot and the next occurrence of the same event
  can notify again. `schema.sql` carries the non-partial form, and every DB is
  built from `schema.sql` — which also seeds `_migrations` with every filename,
  so `migrate.ts` skips 019 forever. **019's effect has never been in force
  anywhere, including production**, and the bug it was written to fix has been
  live the whole time. Found while auditing migration 172, which deliberately
  rebuilt the index from the LIVE definition so that restoring the clause would
  be its own decision rather than something smuggled in.

  **The fix — migration 173, the partial clause only.** Measured against all
  twenty `INSERT INTO notifications` sites (every one a bare `ON CONFLICT DO
  NOTHING` with no inference target, so this index alone decides what
  collapses): **no change** for the six types carrying a reference column unique
  to the event (`new_reply`'s own `comment_id`, `new_quote` and note-borne
  `new_mention`, `subscription_offer`, `tribute_offer_received`,
  `pledge_fulfilled`); **fixed** for the eight deduping on `(recipient, actor,
  type)` alone, each of which was ONE NOTIFICATION EVER — `new_follower`,
  `new_subscriber` (three sites), `pub_new_subscriber`, `comp_subscription`,
  `pub_invite_received`, `pub_member_joined`, `pub_member_left`, plus
  `new_mention` raised from `replies.ts` (which keys on the target being replied
  to, not the reply, so a second mention of you in one thread was dropped). A
  reader who subscribed, cancelled and resubscribed was announced to the writer
  once, for all time; a writer re-inviting someone who declined could never tell
  them. The ceiling is bounded and is the property worth having: **at most one
  UNREAD notification per tuple**. Safe on existing data by construction — a
  partial unique index constrains a subset of what the full one already did, so
  no de-duplication pass was needed.

  **019 was not wholly right, and is superseded rather than restored.** It also
  wrapped `actor_id` in `COALESCE(actor_id, sentinel)`. The live index leaves it
  bare, so NULL actors never collide — and `pledge_fulfilled` is the one
  actor-less type, meaning 019's COALESCE would tell a reader ONCE EVER that any
  drive they backed was fulfilled, across every drive. The live definition is
  right about that; only the `WHERE` clause came back.

  **Drift-guard Check 3b — index definition equivalence** (`check-schema-drift.sh`,
  now seven checks). Check 3 proves an index's NAME is in `schema.sql`; 3b proves
  it MEANS the same thing. No SQL parsing — Postgres canonicalises both sides:
  execute the migration's own CREATE under a probe name inside an always-rolled-
  back transaction against the Check-1 database, then compare `pg_get_indexdef()`
  of probe and real with the two names stripped. **Indexes only, and that is a
  property of indexes rather than a shortcut**: an index is created whole and
  never ALTERed (only renamed, which the survivor fold already resolves), so its
  migration CREATE is still its whole definition today — a table's is not, and
  the same comparison would false-positive on every table the chain has touched.
  It compares the LAST surviving CREATE per name, which is also why it cannot
  retro-detect 019 at HEAD (172 rebuilt the index, making the live form the
  chain's own answer); it would have been red for the whole 019..172 window.
  213 indexes probed, none unevaluated.

  **Validation — mutated, not merely run.** Guard: hand-editing `schema.sql`
  back to the non-partial form reproduces the 019 signature exactly — Checks
  0/1/3 green, **Check 2 green too (verified by running the round-trip against
  the mutated file, not assumed)**, and only 3b red, naming the clause.
  Behaviour: four new cases in the DB-backed `notification-dedup-integration`
  suite (repeat-after-read notifies; repeat-while-unread still collapses, so the
  fix cannot read as "dedup off"; `read` is per row, not a global switch; an
  actor-less notification never collapses). Mutant 1 — drop `WHERE read = false`
  from the live index — fails exactly the first and third and nothing else.
  Mutant 2 — restore 019's `COALESCE(actor_id, …)` — fails exactly the fourth.
  Full suites after: gateway **489/489**, payment **326/326**, shared
  **117/117**, drift guard **8/8**, both money tripwires green.

  **Two live defects found in passing, NOT fixed here** (queued, CONSOLIDATED-TODO
  §10): `drives.ts`'s `drive_funded` and `commission_request` inserts carry no
  `ON CONFLICT` at all, so a collision raises 23505 — and `drive_funded`'s sits
  inside the pledge `withTransaction`, aborting the pledge. Both behind
  `PLEDGES_ENABLED`. The partial clause narrows the window; it does not close it.

  **The docs asserted the bug as a feature, which is how it survived.**
  `DEPLOYMENT.md`'s migration table read "019 | Fix notification dedup (partial
  unique `WHERE read = false`)" — a flat statement of a behaviour that had never
  once been in force. Anyone checking whether repeat notifications worked would
  have read that row and stopped. Corrected, along with 014's "superseded by
  019" (014's form is what every database actually ran). The table also **stops
  at 101 while the chain is at 173**, so it now carries a header saying so, and
  saying the sharper thing: *a present row is not a behaviour in force*. Same
  correction logged in `SCHEMA-REFERENCE-2026-05.md` §2, which had no row for
  this index at all and now records both the clause and why `actor_id` is
  deliberately not COALESCEd. This is the "a comment is not a state" class again
  (cf. the orphaned traffology containers, 2026-08-04).

- **2026-08-05 (§0p COMMIT AUDIT — Aug 02–04 window — three MEDIUMs found and
  fixed same-day)** — audit of `88ed1e5a..1ce113e3` (13 commits: the §0o.1
  idempotency recovery, §0o.2 sync double-count, §0o.3 pending-sibling flip,
  §0o.7 LOW batch, §0o.9 free-allowance dial + migration 169, the parity test,
  the small-money batch + migrations 170/171). Baseline re-measured at HEAD
  before anything: payment **324/324** with the DB-backed suites genuinely
  running, shared 117, gateway 446, drift guard 7/7, both money tripwires green.
  Findings and dispositions:

  1. **A settled settlement stayed `pending`, and could be stamped `failed`
     with a false card prompt** (§0o.7c). `confirmSettlement`'s metadata-adopt
     path stored the intent and charge ids but never `status`, and
     `resumePendingSettlements` scans `status = 'pending'` with no
     `stripe_charge_id IS NULL` guard — so a settlement whose charge had
     succeeded, whose tab was debited and whose reads were advanced was
     re-driven through `completeSettlement` on the next cycle. **Driven, three
     probes:** with the card still attached it healed (`pending → completed`,
     one charge) — which is what the shipped test's comment asserted and why
     this looked safe; with the card **detached** it took the no-default-card
     arm and wrote `status='failed'`, `failure_reason='no_default_payment_method'`
     and `card_action_required_at` onto a collected settlement; and while
     `pending` the in-flight guard **refused the reader's next settlement**
     (reconcile runs 00/08/16 UTC, so up to 8h). §0o.7b's `no_stripe_customer`
     arm has the identical shape, and the same commit's 8h stuck-pending alert
     could page on an already-settled row. Money was never lost or
     double-charged — the row-stable key and duplicate-claim guard held in every
     probe. **Fixed:** `status = 'completed'` rides the adopting UPDATE, guarded
     `AND status = 'pending'`. +2 tests, and the shipped test's assertion
     inverted from `'pending'` to `'completed'`; **mutation-verified** —
     reverting turns exactly those three red.
  2. **The free-allowance dial's literal survived in a SECOND query in the same
     file** (§0o.9). `my-account.ts` builds the starting-credit row twice — the
     entry list (fixed, reads `free_allowance_granted_pence`) and the summary
     totals (`500 AS amount_pence`, untouched) — so on the first retune of
     `free_allowance_pence` a reader's statement would contradict its own
     summary. The dial being retunable is the entire point of the §0o.9 ship.
     **The test was built to catch this and could not see it:** it scoped with
     `issued.find(sql.includes("'free_allowance' AS category"))`, which matches
     only the entry list, so its `not.toMatch(/\b500 AS amount_pence/)` never
     inspected the query carrying the defect — and the route was 500ing at the
     pagination count before it ever issued the summary, because the mock's
     catch-all answered `rows: []` and the route threw on `rows[0]`. **Fixed:**
     the column in both; the literal ban now runs over **every** issued
     statement; a second case pins the summary specifically; and the mock
     answers the count and summary aggregates so the route actually completes.
     Mutation-verified — restoring the literal turns both cases red.
  3. **The grant notification could not be acted on, and only the first one ever
     fired** (§1.10). `subscription_offer` was absent from `NotificationType`,
     from `getDestUrl`'s switch (→ `default: '#'`) and from `labels` (→ "sent
     you a notification"), and the row carried no reference to WHICH offer —
     `notifications` has a dedicated column per linkable entity and had none for
     an offer. So the recipient saw an unlabelled notification pointing nowhere,
     while the redeem lookup's 401 arm exists precisely so that "the recipient
     arriving from their notification" has a way in. That path did not exist.
     Worse, `idx_notifications_dedup` keys on (recipient, actor, type) plus
     three COALESCEd references that are all NULL for a grant, and every
     notification INSERT is a bare `ON CONFLICT DO NOTHING` — so a writer's
     **second** gift to the same reader was silently dropped, and `DO NOTHING`
     did not reopen the already-read first. **Fixed by migration 172:**
     `notifications.offer_id` (FK, ON DELETE CASCADE) added to the dedup index,
     the route binds it, the list route returns the offer's **code** (withheld
     once revoked, so the row stops linking to a page that 404s), and the web
     gains the type, the label ("sent you a gift subscription") and a
     `/subscribe/:code` destination with the writer's profile as the
     revoked-offer fallback. +1 route assertion and a new **DB-backed**
     `notification-dedup-integration.test.ts` (4 tests, always-rollback) —
     only Postgres can evaluate a unique index over COALESCE expressions.
     **Mutation-verified against the live index:** dropping `offer_id` from it
     turns the two-gifts case red while the three cases pinning that dedup still
     works stay green.

  **Validation:** payment 326/326, gateway 485/485, shared 117/117 (all with
  DB-backed suites live), drift guard **7/7** after the schema.sql regen (172
  files, 347 objects), ledger-adjacency + read-chargeable tripwires green,
  hairlines clean, `tsc --noEmit` clean on both services, root ESLint **0
  errors**, and `next build` clean. Open remainder → CONSOLIDATED-TODO §0p
  (the migration-019 index discrepancy, the 170 deploy-ordering note, the
  convert-route local-time note).

- **2026-08-04 (SMALL-MONEY BATCH SHIPPED — §1.5 calendar arithmetic,
  §1.6 provisional unlocks, §1.10 grant-mode redemption)** — attack-order item 4,
  three of its four parts (§1.9's dev reconcile-ledger run closed 2026-07-16;
  the meaningful prod run stays in §11). Migrations **170** and **171**.

  **§1.5 — a month is a calendar month, and it hangs off an ANCHOR.** Two
  defects, and the second is the one that compounds. (a) Subscribe, re-activate,
  publication-subscribe and comp all added a literal 30 or 365 days, so a
  "monthly" subscription taken out on 1 January renewed on the 31st. (b) The
  renewal worker did use calendar arithmetic (Wave-5 P3) but advanced the
  PREVIOUS period end with `setUTCMonth`, which **overflows rather than clamps**
  (31 Jan + 1mo → 3 Mar) — and then advanced that drifted value the next cycle,
  so a subscriber who signed up on the 31st walked forward a few days every
  month until their renewal date had nothing to do with the day they subscribed.
  **The anchor cannot be inferred from the stored dates** — once a period end
  has been clamped to 28 February there is nothing left in the row saying the
  subscription hangs off the 31st — so it becomes a stored fact:
  `subscriptions.period_anchor_day` (migration 170, `NOT NULL`, `CHECK 1..31`,
  no column default so a new write path fails loudly instead of silently
  inheriting "the 1st"). One home for the arithmetic,
  `shared/src/lib/subscription-period.ts` (`advanceSubscriptionPeriod` /
  `anchorDayOf` / `firstPeriodEnd`), consumed by all six write paths.
  **The backfill is deliberately `current_period_start`, not `started_at`:**
  restoring the original day would push an existing subscriber's next renewal
  LATER than the date they have already been told, so the drift is frozen where
  it is rather than corrected — correcting history is a refund question, not a
  migration. 12 unit tests + 1 worker test, **mutation-verified** (removing the
  clamp fails 6; re-anchoring on the previous end fails the six-cycle walk case;
  making the worker ignore the stored anchor fails the worker test), each with
  the pre-fix expression as a **paired control** so the walk is demonstrated,
  not asserted. `subscription-convert.ts` is deliberately NOT on the shared
  helper — conversion aligns the reader to the calendar month they already spent
  in, so its anchor is the 1st by construction.

  **§1.6 — the unlock flip is a separate claim from the read conversion.** A
  zero-rows early return sat between them in `convertProvisionalReads`, so a
  reader whose provisional reads had already been converted, reversed or charged
  back kept `article_unlocks.is_provisional = TRUE` for ever. Inert today;
  the moment the promised provisional-unlock GC ships, those rows are reaped and
  the reader loses articles they paid for. The return is gone and the flip is
  unconditional (idempotent, `idx_article_unlocks_reader`, and the info log now
  fires only when something actually moved). 3 tests, mutation-verified by
  restoring the early return.

  **§1.10 — grant mode was modelled end to end and dead on arrival.** Offers
  were created with `code = NULL` while the redeem lookup filtered
  `mode = 'code'` and the page is addressed `/subscribe/:code`, so a grant had
  no URL and the recipient check already sitting in the subscribe path could
  never be reached. **Wiring it was cheaper than deleting it** — the redemption
  gate existed; only the addressing was missing. Both modes now get a code (the
  code is an ADDRESS, not the secret), and the mode filter moved out of the
  `WHERE` clause and became a recipient check with two deliberately different
  arms: **401 with no session** (the recipient arriving from their notification
  while logged out is the common case, and 404-ing them would make the feature
  unusable for exactly the person it is for — what it concedes to a code-holder
  is only "this code names a grant", and they already hold 64 bits of code to
  learn it), **404 for a different account** (byte-identical to the no-such-code
  response, so a forwarded link tells its new holder nothing). Migration 171
  mints codes for historical grants so no cohort stays permanently dead;
  `notifications.type` is free text, so the recipient notification needed no
  DDL. Web: the redeem page gains a log-in-and-come-back card and reads as
  "A gift for you"; the dashboard's existing `offer.code &&` guard means the
  Copy-link button appears for grants with no change. 5 tests,
  **mutation-verified against all three arms** (restoring `code = null` fails 1;
  restoring the `mode = 'code'` filter fails 3; dropping the wrong-recipient
  404 fails 1).

  **Validation:** shared 117 / gateway 480 / payment-service 324, all green
  including the DB-backed suites against a migrated dev DB; `tsc --noEmit` clean
  in all four workspaces; `npm run lint` 0 errors; `next build` clean;
  `check-schema-drift.sh` all seven checks green after a pg_dump regen of
  `schema.sql` (170's `ADD COLUMN` is Check 3's known column-level gap, so the
  mechanical dump-and-re-append discipline is what closed it — the structural
  diff was exactly the column, its CHECK and its COMMENT, and nothing else);
  `check-ledger-adjacency.sh` and `check-read-chargeable.sh` unchanged and
  green; `check-hairlines.sh` clean on the touched web files.
  **Deploy:** ordinary shape — migrations 170 and 171 both run under the
  standard manual `migrate.ts` step; no flag, no backfill job, no config dial.

- **2026-08-04 (§0o.9c SHIPPED — the money dials' fallbacks are enforced, not
  asked for)** — `loadConfig`'s nine dials each carry an inline fallback
  (`int(map, 'free_allowance_pence', 500)`, …) whose docblock said "keep the two
  in step" with `config-defaults.sql`, and nothing did. Now
  `shared/tests/config-fallback-parity.test.ts` does — third of the parity trio
  (gateway feed-rank, feed-ingest resonance, this), same `diffAgainstDefaults`
  shape, driving the **real** loader against an empty table so it asserts the
  shipping fallback path rather than a copy of it (the pool is stubbed at the
  one SELECT `loadConfig` makes, so it stays an ordinary no-DB suite test). All
  nine currently agree with the file.

  **Why this file rather than another:** it is the one whose drift the docblock
  is a monument to — from f8c73e6 until 2026-07-20 these dials existed ONLY as
  these fallbacks, because a `--schema-only` regeneration silently dropped the
  seeding INSERT — and they are the money dials: the platform's cut, what a
  reader is gifted, when a card is charged, when a writer is paid. A drifted
  fallback does not error; it moves money by a number no operator can see, and
  it is invisible **exactly when the row is missing**, which is the one case the
  fallback exists for. §0o.9 the same day was the second instance of these dials
  governing nothing, which is what moved this from cosmetic to worth doing.

  Four tests: the parity diff over all nine; a seeded row beating its fallback
  (the other direction — a fallback that shadowed a present row would pass the
  parity test while leaving operators no control at all); the `isNaN` arm
  falling back rather than throwing, pinned because it is the same silent
  substitution the parity check is what makes safe; and a **completeness pin**
  that greps `int(map, '…')` out of `client.ts` and fails if a tenth dial is
  added to the loader without a line in the test — the parity map is
  hand-written, so without this the next dial would ship unchecked and the gap
  would reopen in the shape it was just closed in.

  **Five mutants, each killed** (control green after every revert): a drifted
  in-code fallback (800 → 900); a drifted **SQL** value (800 → 750, proving the
  test reads the real file and not a fixture); `int()` ignoring the seeded row;
  `int()` letting `NaN` through; a tenth dial appearing in `loadConfig`
  untested. 101 → 105 shared tests, all 9 files green; root lint 0 errors; both
  money tripwires green; `tsc --noEmit` clean. The docblock is amended in the
  same commit — "six dials" was stale at nine, and "keep the two in step" now
  names the test that holds them there.

- **2026-08-04 (§0o.9 SHIPPED — and the item's premise was backwards: the dial
  governed nothing)** — the filed finding was that `LedgerPanel.tsx:73` hardcoded
  the gauge denominator at `500` while the allowance is the `free_allowance_pence`
  dial, so "retune the dial and the gauge misreports". Verifying it found the
  opposite and larger fact: **retuning the dial changed nothing at all.** Both
  account-creation paths hardcoded the grant (`gateway/src/lib/account-provision.ts`
  and `shared/src/auth/accounts.ts`, each `VALUES (…, 'active', 500)`), the column
  carried `DEFAULT 500`, the only writer of it anywhere is accrual's decrement —
  and `config.freeAllowancePence` had **zero consumers in the codebase**, only its
  own definition at `shared/src/db/client.ts:101`. The dial was inert: an operator
  moving it changed neither what a reader received nor what any surface displayed.
  That is exactly what the tuning-dials rule exists to prevent, and the **second**
  time it has happened to these same dials — `loadConfig`'s own docblock records
  the first (f8c73e6's `--schema-only` regeneration dropping the seeds, leaving
  them untunable from then until 2026-07-20). Sending the live dial to the gauge,
  as filed, would have been the worse half-fix: a number nobody could move, now
  displayed with authority.
  - **Migration 169 splits the two facts that were being conflated.**
    `accounts.free_allowance_granted_pence` is what a reader was *gifted*, stamped
    from the dial at signup and never restated; the pre-existing
    `free_allowance_remaining_pence` is what is *left* of it. Storing the grant is
    what makes the dial safe to retune — the alternative, showing the current dial
    as everyone's total, restates history: a reader gifted £5 would be told they
    had been gifted £7.50 the moment an operator moved it, on the gauge **and** on
    their statement's "Starting credit" line. The gift is a historical fact about
    that reader ("the free allowance is a gift", a gifted penny charged to nobody
    ever, *including retroactively*), so it belongs on their row. The backfill is
    exact rather than approximate: every account that exists was granted 500,
    because both INSERTs hardcoded it and the column default was 500 for the whole
    life of the table — verified on dev, 100 accounts, all granted 500 with
    remaining varying.
  - **Both halves shipped, because either alone is still broken.** The grant now
    reads the dial (one placeholder feeding both columns, `$6, $6`, so they cannot
    drift apart at signup); the display reads the grant — `/my/tab` sends the
    reader's own `free_allowance_granted_pence`, and the account statement's
    starting-credit line credits the same column instead of the `500 AS
    amount_pence` literal found in the same file while mutating. A fix that did
    only the first would leave the gauge quietly restating history; only the
    second would show a number the operator cannot move.
  - **§0o.9b** — `globals.css`'s "No hairline hrs" comment (a `hr { height: 4px }`
    rule, i.e. prose naming the UA default it abolishes) carries the `hairline-ok`
    marker with its reason. The scoped tripwire is green on it, which matters
    because ignoring a red exit twice was how it got filed.
  - **Tests +6 (434 → 440 gateway), each pinning a claim and each mutation-proved:**
    provisioning stamps the dial not a literal; granted and remaining both start at
    it through one placeholder; the wire sends the granted total not a hardcoded
    £5; the total is what was granted never what remains; **a retuned dial does not
    restate an existing reader's gift** (the case the whole migration exists for);
    and the statement credits the column not `500`. Four mutants, each killed
    (literal grant → 1 red; hardcoded total → 2; total=remaining → 3; statement
    literal → 1). The mock answers from the SQL it is handed — the accounts branch
    asserts the SELECT actually names the granted column before answering it, and
    the grant cases read the dial back out of the INSERT's own parameters.
  - **Full verification:** drift guard 7/7 green (schema.sql regenerated by the
    mechanical dump-and-re-append-in-one-step, never hand-edited — Check 3 does not
    cover column-level drift, which is exactly what this migration is); gateway
    474/474, payment-service 321/321, shared 101/101, all with the DB-backed suites
    genuinely running; `tsc` clean across all six workspaces; ESLint 0 errors; both
    money tripwires green; `next build` clean.
  - **One collateral catch worth recording:** adding `loadConfig` to
    `provisionAccount` turned `closed-beta-gate.test.ts` red — its client mock had
    no `loadConfig`, so the provision path threw a 500 where the test expected 200.
    The failure was correct and the fix is the mock, but it is the standing shape:
    a module mock is a **frozen copy of an interface**, and widening the real one
    silently invalidates every test that copied it. Worth remembering as the cost
    of the mocked-client pattern, not as an argument against it.
  - **Left open, deliberately:** `loadConfig`'s nine money-dial fallbacks in
    `shared/src/db/client.ts` are **not** parity-tested against
    `config-defaults.sql` — `diffAgainstDefaults` covers feed-rank (both twins) and
    the regulatory dials, but not these. The docblock says "keep the two in step"
    and nothing enforces it, on the very file whose drift the docblock is a
    monument to. Filed at §0o.9c.

- **2026-08-04 (§0o.7 SHIPPED — the LOW payments batch, all three)** —
  - **(a) The compensating draw returns the prorated FEE with the principal.**
    `reverseChild` inserted the transfer draw at GROSS (net + fee) but returned only
    the principal on reversal, so every fee-carrying reversed child under-counted its
    charge's budget by the fee share, permanently (a drawn charge is never re-stamped —
    §0o.2) — a standing §3.6 false-divergence contributor. The fee share now rides the
    same `prorateCarveReversal` cumulative-floor proration the §5 probes validated
    against Stripe's real partial-reversal behaviour, so a fully-reversed child makes
    its charge WHOLE. The accounting assumes the runbook-mandated
    `refund_application_fee=true`; a flagless manual reversal now reads as a positive
    §3.6 delta (loud, and Stripe refuses an actual over-transfer) instead of the old
    silent permanent under-count — `DEPLOYMENT.md`'s runbook bullet rewritten to say so.
  - **(b) The resume sweep's no-customer branch now flags the card prompt.** A pending
    settlement whose account had lost its `stripe_customer_id` was failed WITHOUT
    setting `card_action_required_at` (the adjacent no-default-card branch sets it), so
    the tab unfroze but the reader was never told why settlement stopped. Same
    disposition now: `failed` + `failure_reason='no_stripe_customer'` + the flag, in
    one transaction.
  - **(c) `confirmSettlement` gains the `metadata.settlement_id` fallback.** A PI
    created just before a crash stored its id was previously reachable only through
    the resume sweep's same-key dedupe — the channel §0o.1 proved can wedge on payload
    drift. The success webhook now adopts such a row via the metadata the create
    stamps, guarded three ways: only a row with NO stored intent id is a candidate
    (a row owned by a different PI is never clobbered), the adopting UPDATE is
    rowCount-checked under the tab lock AFTER it (preserving the documented
    {reading_tabs, tab_settlements} lock order; a lost race defers), and the
    failed/duplicate dispositions run first unchanged.
  - **Tests +4 (317 → 321), each half at its right layer:** a DB-backed assembly case
    proving the fee proration against the real statements (half back → +500 not +450;
    full reversal → charge whole again), and three battery cases (no-customer resume →
    failed + reason + flag; crash-before-store → webhook adopts, confirms, parity
    holds; the wrong-owner control → a stray PI carrying our id as a hint cannot steal
    the row). The battery's router gained arms for the three new statement shapes, all
    answering from the SQL handed; the dead unguarded `SET status='failed'` arm was
    removed so a reintroduction surfaces instead of being absorbed.
    **Mutation-verified, three mutants, each killed** (fee dropped from the draw → 2
    red across both layers; card flag dropped → 1 red; fallback disabled → 2 red).
    Full suite 321/321 with the DB-backed suites genuinely running; `tsc` clean;
    ESLint 0 errors; both money tripwires green.
  - **A live catch by the mock rule, worth recording:** the first run of the (a) test
    FAILED in the mocked suite while passing against real Postgres — the
    transfer-reversal mock handed out its LIVE child objects, so the
    `reversed_pence` UPDATE retro-mutated the snapshot `reverseChild` had already
    read and the fee proration computed 0. Fixed on both sides: the mock now returns
    copies (the CLAUDE.md copies-not-live-objects corollary, cited at the site), and
    `reverseChild` captures `prevReversed` before issuing the UPDATE rather than
    re-reading its row object afterwards.

- **2026-08-03 (§0o.3 SHIPPED — a pending sibling now holds a reversed parent open, in
  all three cycles)** — the audit's MEDIUM #3: the child-reversal paths tallied
  `outstanding` over children `status IN ('completed','reversed')` only, so child A
  completed + crash before B executes + A fully reversed (manual, 2am) read as
  outstanding 0 and flipped the parent `pending → 'reversed'` — at which point the
  resume sweeps (which scan `status = 'pending'` parents only) never see it again and
  B's claimed units freeze permanently. The fix is the audit's first shape, given one
  home: `REVERSAL_OUTSTANDING_SQL` (exported from `payout.ts`, parameterised on
  `parent_table`, replacing the three inline copies at the writer/tribute/split sites)
  counts `'pending'` as standing — a pending child is money that has not moved YET —
  while `'failed'` stays excluded in both directions (nothing moved, and `failChild`
  released its units, so nothing will: a failed child neither holds the flip open nor
  counts as reversed). The split site keeps the shared rule with a comment noting its
  pending arm is unreachable (one child by construction). **Tests +3 (314 → 317):** a
  DB-backed assembly case running the production statement (pending sibling → 1200
  outstanding; failing it → 0, flip legal) and two mocked handler cases
  (pending-sibling → no flip; failed-sibling → flip) — plus the transfer-reversal
  mock's tally route now PARSES the status list out of the SQL it is handed instead of
  restating `['completed','reversed']`, which would have mis-modelled this exact fix
  (the §0h.1 conformance-mock trap, pre-empted this time). **Mutation-verified:**
  reverting the status list turns both layers red (1 DB + 1 mocked). Full suite
  317/317; `tsc` clean; ESLint 0 errors; both money tripwires green.

- **2026-08-03 (§0o.8 — the five-part docs/tracker tail cleared)** — the ADR §5 results
  block gains the missing 2026-08-01 banner (steps 4–9 seven-of-seven with tallies and
  the step-9 flip-blocker chain, superseding the "written and unrun" framing for those
  steps too); ADR §2's brand bullet no longer poses the Mastercard question its own top
  half records as answered (and carries the don't-baseline-during-workaround warning);
  the two discharged §11 instructions are struck with their answering evidence cited;
  attack-order 0c's deployment note records both halves deployed (the flip-precondition
  kept as a property to preserve); and `payout.ts`'s publication-claim docblock now says
  `publication_payout_id` (migration 168's column — the 0586c389 comment sweep had
  missed it).

- **2026-08-03 (§0o.5 + §0o.6 — the two frozen flip-instruction docs corrected)** — the
  segregation ADR's "Build status" header and §10 intro no longer name §5 step 0 (closed
  07-30) as the flip blocker: both now carry the real gates — the Mastercard escalation
  (TODO attack order 0b) + Stripe live enablement — and the header's self-warning
  parenthesis records that it has now frozen twice. `DEPLOYMENT.md`'s
  `STRIPE_ALLOCATED_FUNDS` row (the operator's flip instruction) drops the falsified
  "ineligible brand yields an unallocated charge, which is handled" premise for what
  step 9 actually proved (asking 500s → ambiguous → wedged tab; the measured
  `ALLOCATION_ELIGIBLE_CARD_BRANDS` pre-flight is what makes it safe) and gains the two
  attack-order-0b warnings: re-measure `--brands` and restore every 5/5 brand when
  Stripe's Mastercard fix lands, and never baseline `allocated_residual_alert_bps`
  while a major brand is excluded.

- **2026-08-03 (§0o.2 SHIPPED — a drawn charge is never re-stamped, so the allocation
  budget stops double-counting draws)** — the same-day audit's HIGH #2, the flip
  blocker: `syncAllocations`' staleness arm re-stamped `allocated_pence` with Stripe's
  *current remaining* — already net of every executed draw — while the budget everywhere
  is `allocated_pence − Σ draws`, so a 24h re-sync of a drawn charge subtracted its
  draws twice (sync 5000 → draw 2000 → re-stamp 3000 → budget 1000). Money-safe
  (under-draw by construction) but coverage-decaying, and `checkAllocationDivergence`
  diverged by exactly Σ draws on every such charge forever — the alert channel
  permanently red, burying the unrecorded-refund/missed-reversal signals it exists for.
  - **The fix is one rule: once a charge has any draw, its budget is
    identity-maintained and sync never touches it again.** `SYNC_ALLOCATION_CANDIDATES_SQL`
    (exported): the first-sync arm (`allocated_pence IS NULL`) stays unconditional; the
    staleness arm gains `NOT EXISTS (allocated_draws)` over every draw kind. A drawn
    charge's drift detector is the §3.6 divergence sweep, whose candidate ORDER now
    puts **drawn charges first** (by most recent draw activity) — sync no longer
    rotates their frozen `allocation_synced_at`, so sync-recency ordering would have
    walked exactly the charges the check exists for out of its window forever.
  - **The stamp adds back recorded refunds** (`SYNC_ALLOCATION_REFUND_SNAPSHOT_SQL` +
    `SYNC_ALLOCATION_STAMP_SQL`): a refund can precede the first sync, and Stripe's
    remaining is already net of it, so the raw stamp double-counted refund draws the
    same way (§0o.2's second arm). Stamping `remaining + Σ refund-kind draws` restores
    `allocated_pence − Σ draws == Stripe remaining` at the moment of sync. Refund-kind
    only, and the snapshot is read BEFORE the Stripe retrieve — both chosen so every
    race errs to under-draw (a transfer draw racing the sweep is committed but
    unexecuted on Stripe and must stay subtracted; a refund landing between snapshot
    and stamp is subtracted once against a possibly-pre-refund remaining).
  - **Tests +9 (305 → 314): 5 DB-backed** in `segregation-assembly-integration.test.ts`
    (28 → 33 there), running the production SQL — drawn charge excluded from re-sync
    while its undrawn twin still rotates; a refund draw freezes the stamp too; first
    sync add-back restores budget == Stripe remaining; the add-back refuses a racing
    transfer draw (the committed slice stays funded); §3.6 checks a drawn charge ahead
    of a seconds-old undrawn one — **and 4 mocked** in the new `allocation-sync.test.ts`
    (transfer-reversal idiom, flag ON) pinning the TS composition the SQL can't:
    stamp = retrieved remaining + snapshot, snapshot-before-retrieve call order, a
    failed retrieve skips without stamping, 0-not-NULL for a no-allocation charge.
    **Mutation-verified, four mutants, each killed:** candidate `NOT EXISTS` removed →
    2 DB tests red; add-back dropped from the stamp → 1 mocked red; snapshot moved
    after the retrieve → 1 mocked red; divergence ORDER reverted to sync-recency →
    1 DB test red. Full suite 314/314 with the DB-backed suites genuinely running;
    `tsc` clean; ESLint 0 errors; both money tripwires green.
  - **Docs:** ADR §3.3a gains the correction block (the sweep paragraph prescribed the
    buggy stamp verbatim); the §10 as-built sync bullet, the lost-dispute backstop
    sentence (undrawn → sync; drawn → §3.6) and the §3.6 no-watermark bullet rewritten;
    same split stated at `recordRefundDraw`, the `charge.dispute.closed` handler, and
    both rewritten module headers. Known bound, said out loud in both: a drawn
    population larger than the divergence batch pins the check to its
    most-recently-active N — acceptable while the check is advisory; revisit with real
    payout volume.

- **2026-08-03 (§0o.1 SHIPPED — the settlement idempotency-conflict wedge is now recovered, not retried forever)** —
  the same-day audit's HIGH #1, re-confirmed live before fixing, and worse than filed:
  **all three** dev `pending` settlements from the 07-31 sandbox run (`e14ab9c7…`,
  `89057f12…`, `96c499c7…` — the audit had found one) were erroring
  `StripeIdempotencyError` on every resume, exactly the payload-drift chain described
  (resume re-resolves the card and rebuilds the brand-dependent create per attempt under
  the row-stable key; Stripe replays only a byte-identical request).
  - **The fix is a specific handler for the one ambiguous error a retry can never
    clear.** `isIdempotencyConflict` (`charge-errors.ts`) names it; `completeSettlement`
    catches it around the factored-out `createSettlementIntent` and calls
    `recoverIdempotencyConflict` (`settlement.ts`), which resolves the ambiguity the
    error itself proves resolvable: enumerate the customer's PIs via
    **`paymentIntents.list`** (consistent — never `.search`, whose index lags: a lagged
    miss would read as "provably absent" and re-charge), window-floored at the row's own
    `created_at` − 1h, matched on `metadata.settlement_id`. Found succeeded/processing →
    **adopt** (store the PI id, flip `completed`, confirm immediately when the charge id
    is known — else the webhook, which now matches, or `reconcileSettlements` finishes).
    Found dead (`requires_payment_method`/`requires_action`/`canceled`) → the
    terminal-decline disposition (failed + card flag, PI id kept for the failure
    webhook). Provably absent (whole window enumerated) → failed
    `idempotency_key_conflict` **without** the card flag — the card was never the
    problem — so the threshold sweep re-reserves under a fresh id/key and charges
    cleanly. Window truncated (>1,000 PIs) → change nothing; unproven absence is not
    absence.
  - **Stuck-pending age alert** (§0o.4's ask, delivered): the resume sweep now logs
    `SETTLEMENT STUCK PENDING` (error level) for any pending row older than one full
    retry cycle (8h), and `SETTLEMENT_IN_FLIGHT_SQL`'s false "that sweep releases
    anything stuck here" claim is rewritten to the true bounding story.
  - **Tests +8** (mocked 241 → 249; 305 total with DB-backed): the conformance Stripe
    double now records per-key params and throws the conflict on drift (as Stripe does),
    mints PIs carrying the request's real `customer`/`metadata`, and grew a `list`; the
    five new battery cases cover adopt-after-card-swap (exactly one charge, parity
    holds), the dead-PI disposition, provably-absent → fresh-key convergence (two rows,
    one real charge), the truncated-window refusal, and the age alert (with a fresh-row
    negative control). **Mutation-verified**: reverting `settlement.ts` fails 6 of them
    with the wedge reproduced (row `pending` forever). Full suite 305/305 with the
    DB-backed suites genuinely running; ESLint 0 errors; both money tripwires green.
  - **Live outcome (same day, fresh key): all three specimens resolved — via the NORMAL
    path, and the reason is a finding in itself.** The first run surfaced that the dev
    sandbox's `sk_test_…` key had expired since 08-01 (`api_key_expired` — ambiguous,
    correctly: leave pending, and the new alert fired on all three, its first live
    trip). With a fresh key, the retried creates were **accepted as new requests** and
    all three completed with fresh PIs (`pi_3U0MKw…`/`pi_3U0MKy…`/`pi_3U0MKz…`,
    confirm via webhook/reconcile as normal): **Stripe GCs idempotency keys ~24h after
    first use**, and the wedged keys had aged out. So the audit's "2½ days refutes the
    24h self-heal" was confounded — the API key expired mid-window, and auth errors
    (not conflicts) blocked most of it. Corrected wedge model: payload drift freezes the
    tab until Stripe drops the key (≥24h, undocumented precisely, at 3 retries/day) —
    shorter than "forever", still a silent day-plus tab freeze per drift event, which
    the recovery now cuts to the next resume pass and the alert makes loud. The
    recovery's live-fire proof therefore remains the mutation-verified battery (a live
    conflict now requires manufacturing drift inside the same 24h window — not worth a
    session; the class is covered). (Housekeeping: recreated the compose network for
    the known inter-container ETIMEDOUT — the payment container had been unhealthy on
    DB connection timeouts.)
  - **Deliberately NOT built here:** the generic bounded retry for *any* deterministic
    ambiguous failure (attack order 0c) — that changes failure semantics on a money path
    and stays an owner call. This fix removes the only *known* member of the class; the
    age alert is what caps the unknown ones at "loud" rather than "silent forever".

- **2026-08-01 (§5 steps 4–9 RUN — seven of seven green, and step 9 found a flip blocker
  that would have wedged every Mastercard reader)** — the family written the previous day
  was driven against the segregation sandbox. **Six steps passed as written; the seventh
  could not run at all, and why not is the most valuable thing this exercise has
  produced.** Final tallies: step 4 **19/19**, steps 5+6 **25/25**, steps 7+7b **36/36**,
  step 8 **15/15**, step 9 **11/11** (after the fix below). No defect was found in the
  code under test by any of 4–8.
  - **P1 (flip blocker) — asking for allocation on an ineligible card brand 500s, and the
    reader's tab wedges permanently.** §3.3a and `settlement.ts` both held that an
    ineligible brand "simply yields a charge whose allocated balance syncs to 0". It does
    not. With `allocated_funds[enabled]=true` the create fails `StripeAPIError` 500 (no
    code, `stripe-should-retry: false`). That 500 is **correctly** classified AMBIGUOUS —
    it may mean the PaymentIntent was created, and rolling back would risk a double
    charge — so `completeSettlement` re-throws, and then:
    - the settlement stays `pending` with **no PI id**;
    - `resumePendingSettlements` retries it every reconcile cycle and 500s again;
    - `sweepDueSettlements` skips that tab **forever** on its `NOT EXISTS pending` guard;
    - `card_action_required_at` is **never set**, because ambiguous is deliberately not
      the terminal path — so the reader is never prompted to change card;
    - their reads stay `accrued`, never settle, and the writer never earns.

    Silent, permanent, per-reader, with an ERROR log nobody reads. **Not live** — the flag
    is off in production — so this is a flip blocker rather than an incident.
  - **The eligible brand set was measured, and both prior lists in the repo were wrong.**
    `scripts/segregation-probes.ts --brands --repeat 5` (new mode): ten tokens × three
    modes (classic version / preview version alone / preview version **plus** the param),
    beta+param repeated five times, **Visa positive control in the same window**. Fifty
    samples, no mixed results. **Eligible:** `visa`, `visa_debit`, `amex`, `discover`,
    **`diners`**. **Ineligible:** **`mastercard`, `mastercard_debit`,
    `mastercard_prepaid`**, `jcb`, `unionpay`. Two overturns: **Mastercard is not
    eligible** (all three variants 0/5, so it is the network, not one test card), and
    **Diners is** (it routes over Discover — eligibility follows the NETWORK, not the
    `brand` string Stripe reports, which is why no documentation list can be trusted here).
    The matrix also isolated the cause: it is the `allocated_funds` **param**, not the
    preview API version, which passed for all ten.
  - **FIXED by pre-flighting the brand.** `ALLOCATION_ELIGIBLE_CARD_BRANDS` +
    `allocatedFundsParam(brand)` in `payment-service/src/lib/stripe-client.ts`, with
    **default-deny** on an unknown, unmeasured or unreadable brand (omitting allocation is
    the safe direction — money right, coverage poorer; wrongly *including* a brand is what
    wedges readers). The card is never refused: `payment_method_types: ['card']` stays
    broad, so no revenue is lost — we simply stop asking for what the brand cannot give,
    which restores exactly what `settlement.ts`'s own comment always intended. The brand
    is read via `expand` on the `customers.retrieve` that `resolveDefaultPaymentMethod`
    **already makes**, so it costs **no extra API call**.
  - **Pinned and mutation-verified.** `payment-service/tests/allocation-brand-eligibility.test.ts`
    — 19 tests (flag off, eligible, ineligible, default-deny, normalisation, and the set
    itself). Mutation: remove the brand guard → **8 fail, 11 pass**, and the 8 are the
    ineligible/default-deny/set-membership ones. Suite 214 → 233. **The mocked tests
    cannot prove the charge now succeeds** — only Stripe knows that — which is why step 9
    is the real gate: it now settles a Mastercard, syncs `allocated_pence = 0` with
    `allocation_synced_at` stamped (the pair), never draws on it, and routes the payout
    around it. 11/11.
  - **RAISED WITH STRIPE THE SAME DAY, and their answer changed the framing.** Support
    confirmed **Mastercard IS in scope** — their docs list Visa/Mastercard/Discover/Amex/
    Swish, the same list this repo's §2 had always carried — **and that the 500s are a bug
    in the preview implementation**, now escalated to engineering. They also agreed an
    unsupported brand should return `400 invalid_request_error` rather than a 500. So the
    measurement records **a Stripe defect with a fix pending, not a scope boundary**, and
    the residual consequence is temporary rather than structural.
    - **What that makes our exclusion: a workaround with an expiry date.** Recorded as
      such in the constant, §2, §5.9 and the queue, with an explicit **re-measure
      trigger** — when the fix lands, re-run `--brands --repeat 5` and restore every 5/5
      brand. Leaving Mastercard out afterwards is not safe-by-default in any useful sense:
      it silently routes roughly a third of UK card volume to the unsegregated residual
      forever, and nothing would connect that back to a constant nobody is looking at.
    - **And a live risk in the other direction.** Diners works despite appearing in no
      documented list; our inference is that eligibility follows the NETWORK (Diners
      routes over Discover) rather than the `brand` string. That is unconfirmed and has
      been put to Stripe, because if their check is brand-based and gets tightened
      alongside the Mastercard fix, Diners would start 500ing and — being in our
      allow-list — would wedge Diners readers exactly as Mastercard ones would have.
    - **Do not baseline `allocated_residual_alert_bps` during the workaround period**
      (§3.3d): with Mastercard excluded the residual reads roughly the Mastercard share of
      payments rather than the credit-funded floor the dial was designed around, so a
      baseline taken now measures the workaround.
    - **Follow-on proposed, not built (queue 0c):** a bounded retry, so that after N
      consecutive ambiguous failures a settlement is failed and the card flagged rather
      than retried forever. The allow-list stops the cases we know about; this would cap
      any deterministic ambiguous failure — including whichever one we meet next — at a
      prompt to the reader instead of a permanent silent wedge. Owner call: it changes
      failure semantics on a money path.
  - **Four harness defects found by running it, all mine, and three shared one shape —
    a check that could not fail.** (a) step 9's fallback list was consulted at card
    *attach* time when the failure is at *charge* time, so it never fired; (b) it then
    accepted "the settlement completed" when the requirement was "completed **and
    unallocated**", and asserted six ineligible-brand claims against an *eligible* charge
    — six red marks that were one mistake; (c) it proceeded on `status = 'completed'`,
    which is stamped at PI-create, when the assertions needed `stripe_charge_id`, stamped
    later by the **webhook**; (d) **`syncUntilStamped` returned `{attempts: 1, unstamped:
    0}` having stamped nothing at all** — its filter requires `stripe_charge_id IS NOT
    NULL`, so an unconfirmed row is invisible and reads as "zero unstamped". Three
    allocation assertions rode on that number. It now reports `considered` alongside
    `unstamped` and step 9 asserts `considered > 0`; the trap was latent for every step
    using that helper, and 2–8 were safe only because `ensureClaimable` already waits for
    the webhook.
  - **The brand probe's own control earned its keep.** The first cut passed `{}` as
    stripe-node's options argument, which that client rejects as `Unknown arguments` —
    and the symptom (*every* non-classic cell failing) was **identical to the finding it
    was looking for**. The Visa control failing is what said "the instrument is broken,
    not the beta". Generalises the 2026-07-30 lesson: it is not only that a matrix run
    inside a failure window cannot show cause — **a matrix with no positive control cannot
    distinguish a finding from a broken instrument.**
  - **One prediction withdrawn.** The 07-31 note doubting §5.6's `manual_review_required`
    claim (reasoned from `webhook.ts` emitting it only on the partial arm) was **wrong —
    the check passed**. The note is withdrawn in the ADR rather than left standing beside
    a claim it wrongly doubted.

- **2026-07-31 (§5 steps 4–9: the refund/reversal/edge-funding family, written and unrun)** —
  the last seven sequence steps are now code. **They have never touched Stripe** — the
  sandbox key was cycled after the same day's run, and a step that has not run is a
  hypothesis, not evidence. 113 checks; `tsc --strict` clean; the four cross-service dynamic
  imports verified to resolve, including the gateway one step 8 needs. What remains is one
  sandbox session.
  - **The family differs in shape from 2/3/10/11, and the machinery follows from that.**
    Those steps call a cycle in the harness's own process and read the result when it
    returns. Every step here asks *Stripe* to refund or reverse something; Stripe emits an
    event; `stripe listen` forwards it to the **container**; and the container's handler is
    what writes the row being asserted. So nothing may read once (a single eager read
    reports "the handler never ran" for a handler that runs a second later — trap (b), from
    the other side), and anything that is not a database row has to be reached for
    deliberately.
    - `pollUntil` — one home for the waiting, returning what it actually reached rather
      than throwing, because a timeout is itself the finding and a step that threw would
      lose every other assertion it was about to make.
    - `drawableRemaining` — **production's own `lockFundingSources`**, run inside a
      transaction that is then rolled back. The claims "a refunded charge stops being
      drawable" and "a reversal restores the remainder" are properties of that specific
      statement — its `GREATEST(0, …)`, its `allocated_pence IS NOT NULL` guard, its `> 0`
      filter — and a hand-written SELECT here would agree with itself forever.
    - `paymentLogsSince` — `manual_review_required` is an alertable **log line with no
      table behind it**, so this greps the container and reports UNKNOWN with the command
      when docker is unreachable. A marker that cannot be read is not a marker that did not
      fire.
    - `runCycleForNewPayout` — the guard against the worst outcome available here. Each of
      steps 5–8 runs a cycle then asserts about "the payout"; if the cycle skipped the
      writer, "the writer's latest payout" is a **completed payout from an earlier step**
      and every downstream assertion passes against it. Not a false alarm — a false
      clearance. The prior id is taken first and the new one must differ.
  - **Two findings without running anything**, both recorded in ADR §5 beside the steps
    they belong to. (a) **§5.6's `manual_review_required` claim does not match the code**:
    `webhook.ts` emits the marker from the PARTIAL arm of `charge.refunded` only, and step
    6 is a full refund, so it takes `reverseSettlement` and emits nothing. Either the ADR
    means a partial refund post-transfer (step 5 already covers that) or a full refund of a
    paid-out charge deserves its own marker. The step states the claim as written and
    expects to fail it; **settle the question before patching either side**. (b) **§5.8's
    "drive a `subscription-convert` credit-back" is unbuildable as written**: that route is
    503-gated *and* its charge leg is a documented phantom — a bare `subscription_events`
    insert with no tab debit, no `subscription_earning`, no writer ledger entry — so it
    mints nothing to pay out, flag on or off. Step 8 drives the live credit-funded branch
    instead (`logSubscriptionCharge` with a pre-paid credit; post-charge balance ≤ 0 ⇒
    `settled_at` stamped at charge time, `tab_settlement_id` NULL forever), which is what
    the residual actually carries in production.
  - **What each step's own header argues, in one line.** 4: pre-transfer is the whole
    condition, and the redelivery arm drives the **out-of-order smaller cumulative figure**
    — the only case a bare assignment fails, where the same-value replay would pass. 5: the
    load-bearing half is not the refund but the cycle **after** it, packing around the
    shortfall rather than building a slice Stripe rejects. 6: the PAID *and* EARNED sides
    both reverse, which is what tells it from 4. 7: the remainder grows back by the **NET,
    not net+fee** — the original draw was gross, the compensating one is net, so our budget
    stays one fee short of what Stripe restored; safe (we under-draw) but real, and
    asserted exactly rather than glossed. 7b: **the sibling is the test** — a handler that
    reversed the parent, or resolved by `writer_payouts.stripe_transfer_id`, passes a
    single-child version and is catastrophic in production; reversed in two stages, because
    a single reversal cannot distinguish cumulative from per-reversal. 8: the only fixture
    that is not a read. 9: the assertion is the **pair** (`allocation_synced_at IS NOT NULL
    AND allocated_pence = 0`), since 0 and not-yet-stamped look alike, plus the card brand
    itself as the control.
  - **Three assertions are loose on purpose and say so in their own headers**, because
    guessing tightly would have been guessing: step 6's platform-balance figure (a fact
    about Stripe, and this harness's methodology is that facts about Stripe are *measured*
    — the direction is asserted and every component recorded, so the first green run can
    tighten it into an equality with evidence behind it), step 6's marker claim above, and
    step 9's card token (two ineligible brands are tried, since a sandbox that declines JCB
    outright says nothing about allocation).
  - Two small refactors carry the family: `mintReaders` takes a payment-method token (step
    9 needs an ineligible brand; every other caller still wants Visa, which is *why* steps
    1–8 carry allocation at all), and `accrueReadsFor` splits out of `accrueReads` so step
    9 can accrue for a reader deliberately outside the rotating set. Plus one real fix to
    existing machinery: **`readPayout` was not selecting `reversed_pence`**, which steps 7
    and 7b poll on — a column a caller reads and the query does not return fails silently in
    exactly one direction, never as an error.

- **2026-07-31 (the sequence runs: steps 2, 3 and 10 GREEN — and step 11 finds that the
  publication payout cycle has never worked)** — the four steps written earlier the same
  day were driven against the segregation sandbox. **Every defect the run surfaced in the
  first three steps was in the harness or in dev's seed data; none was in the code under
  test**, which repeatedly did the right thing at branches it was not being asked about.
  Step 11 is the exception, and what it found is a live P0.
  - **P0 — `runPublicationPayoutCycle` cannot claim a single read, and has never been able
    to.** `reservePublicationPayout` claims the pool's reads with
    `UPDATE read_events SET writer_payout_id = $1` where `$1` is a **`publication_payouts`**
    id — but that column carries `fk_read_events_writer_payout → writer_payouts(id)`. Every
    such UPDATE raises `23503` and rolls back the entire reserve transaction. The FK is in
    `schema.sql` **genesis** and no migration has ever altered it, so this has been true
    since the first day the publication cycle existed.
    - **It fails SILENTLY.** The cycle catches per-publication errors (`catch (err) { logger.error(…) }`)
      so the worker survives and the other publications are attempted — the observable
      behaviour is simply that publications are never paid, with an error log nobody reads.
    - **Scope, measured not assumed:** a pool containing ≥1 settled unclaimed read dies. A
      **subscription-only** pool survives, because the reads UPDATE matches zero rows and
      the subs claim uses `subscription_events.publication_payout_id` — a column that
      exists. That asymmetry is itself the tell: the subscription side got a dedicated
      column and the reads side was left reusing the writer one.
    - **Why nothing caught it.** No test calls `runPublicationPayoutCycle` — the single
      DB-backed publication test states so in its own comment and exercises the ordering
      SQL and the pure `computePublicationSplits` instead. Prod is pre-launch with zero
      publication payouts. So every unit test passes and the feature has never once run.
      This is the §11 verification-debt thesis in its purest form: **component ≠ feature**.
    - **FIXED the same day — migration 168**, taking the dedicated-column fork rather than
      dropping the FK: the latter is one line, but it abandons referential integrity on a
      money path and leaves a column whose name actively misleads. The two cycles are exact
      complements; their claims should be two columns that cannot be confused.
      `read_events.publication_payout_id`, FK → `publication_payouts`, `ON DELETE SET NULL`
      mirroring the writer twin, partial index. **No backfill possible or needed** — the FK
      made it impossible for any row to carry a publication payout id, so every existing row
      correctly starts NULL.
      - **Six sites moved**: the eligibility CTE, the claim, the article-earnings base,
        finalise, the re-pay sweep's settlement recovery (whose *subscription* arm already
        keyed on the right column), and the chargeback reversal's publication arm in
        `settlement.ts` — whose comment had reasoned the column was "overloaded across payout
        kinds". It never was: that FK meant the value it read was **always null**, so the
        F5 split-reversal path has never once fired either.
      - **Two precision fixes that only bite once the claim works.** The KYC-reconcile
        candidate query's "writer read earnings" arm now excludes publication reads (else a
        *paid* publication read matches forever), and the admin dashboard's two held-reads
        figures now require BOTH claim columns null.
      - **The test that would have caught it**:
        `payment-service/tests/publication-claim-integration.test.ts`, which drives the
        **exported** statements (`PUBLICATION_CLAIM_READS_SQL`,
        `PUBLICATION_FINALISE_READS_SQL` — extracted so the test cannot run a copy that
        drifts) against a real database with real FKs. **Its paired control runs the pre-fix
        statement and asserts it still raises 23503** — without that, the file would pass
        just as well against a schema where the FK had been quietly dropped, and would be
        pinning nothing. Mutation-verified: revert the constant and 4 of 5 go red.
      - **Verified end to end: §5 step 11 is 18/18**, including a true §3.3e over-transfer —
        an allocated child inflated 1104 → 6500, rejected `StripeInvalidRequestError`, its
        split failed, the sibling completed, and the parent COMPLETED rather than zombifying.
        Steps 2/3/10 re-run green (128 checks). Payment suite 278/278, drift guard 7/7,
        ledger-adjacency and read-chargeable guards green.
      - **A harness trap found on the way, worth carrying forward.** Step 11's fabrication
        first inflated a child blindly. An ALLOCATED child is bounded by its funding charge,
        so inflating past it is a true over-transfer and is rejected; a RESIDUAL child has no
        charge behind it and is bounded only by the platform balance, so the same inflation
        just makes a larger ordinary transfer — which SUCCEEDS. Both children packed residual
        that run, Stripe paid £50, and the step reported a failure to fail.
      - **And one test-fragility of the same family.** `segregation-assembly`'s two
        residual-window assertions read a **global** 30-day aggregate while their helper's
        comment claimed "the rolled-back transaction means the window queries see only these
        rows". Rollback isolates WRITES, not READS, so both went red the first time a real
        payout existed in a dev database. Now delta-based against a baseline.
  - **Step 2 — 41/41.** Four children, one per drawn charge, nets 1288+1288+1932+2576 =
    7084 = parent `amount_pence` = ledger sum; every `source_transaction` and
    `application_fee_amount` checked against **Stripe's own copy** of the transfer; one
    `allocated_draws` row per allocated child at GROSS; reconcile-ledger gained no violation
    from N entries per parent (§3.6's `ledger_orphans`-tolerates-N claim, confirmed).
  - **Step 3 — 15 pass, 1 honest UNKNOWN.** A child inflated 1932 → 7800 against a 2800p
    charge was rejected by Stripe as a **`StripeInvalidRequestError`**, i.e. classified
    TERMINAL rather than re-thrown as ambiguous (`executeThrew: false` — the distinction the
    whole S1 discipline rests on). Child failed, its draw DELETEd, its 3 reads released with
    both pointers nulled, 7 sibling reads untouched and advanced, parent restated 4508 with
    `failed_reason`. The UNKNOWN is deliberate: the released net was under the payout
    threshold, so no next cycle claims it, and re-packability is asserted by the release
    check rather than faked by lowering a dial.
  - **Step 10 — 15/15.** The crash state is genuine (Txn 1 committed, nothing sent, books
    silent); resume completes without re-packing; a **second** resume adds no entry, child,
    transfer or restatement; and Stripe returns the SAME transfer for a replayed
    `xfer-<childId>` while rejecting that key with different params as an
    `idempotency_error`.
  - **Six harness bugs, every one of which produced a convincing false negative.** Worth
    listing because each looked exactly like a payout defect: (1) `READS_PER_PAIR = 2` posted
    the same (reader, article) pair twice and a reader who already paid is not charged again,
    so 24 gate passes produced 4 read events; (2) the retry loop could not widen the accrual
    space at all, since it is `readers × articles` — fixed by minting fresh readers per step,
    which is also what makes `--step 2,3,10` work in one invocation; (3) one `syncAllocations`
    is not enough, and an unstamped charge is correctly skipped as un-drawable, routing
    earnings to the residual; (4) `amount_pence` is `bigint`, so node-postgres returns a
    string and the ledger sum concatenated; (5) the per-child assertions applied the
    ALLOCATED contract to a residual child, which correctly carries neither
    `source_transaction` nor `application_fee_amount` (with no allocation the fee is
    implicit); (6) the platform-balance expectation summed every child's fee, when a residual
    child moves the balance the *other* way by its whole net — correct expectation is
    `Σ allocated fees − Σ residual nets`, measured −840 against a predicted −840.
  - **Dev had been silently halted for a fortnight.** `scripts/seed.ts` writes
    `reading_tabs.balance_pence` directly and posts **zero** ledger entries, so every seeded
    reader violated `reader_balance_parity` and the scheduled reconcile worker did exactly
    its job on 2026-07-17 09:45: **halted all payouts**. Every payout cycle since has been a
    no-op. All 25 discrepancies fell inside the seeder's own `0..800` range and no account
    that transacted through production code was among them — seed data, not a defect. Fixed
    with the mechanism designed for it (`scripts/backfill-seed-opening-balances.ts`, 25
    `opening_balance` entries, dry-run by default since the ledger is append-only) rather
    than by zeroing the tabs, which would break the same invariant from the other end.
  - Also landed: `scripts/create-sandbox-connect-account.ts`, because the Stripe **dashboard
    cannot create an onboarded connected account** under the controller-properties model —
    the API is the only route, and step 11's failed-split arm needs a second payable
    destination (with one member the payout has one split, and a single failure correctly
    fails its parent outright, so the property has no sibling to be true of).
    → CONSOLIDATED-TODO §11 / `FUNDS-SEGREGATION-INTEGRATION.md` §5.

- **2026-07-31 (four more §5 sequence steps, written and unrun — and one of them
  documents what it refuses to fake)** — `scripts/segregation-sequence.ts` gains steps
  **2** (multi-child writer payout), **3** (forced over-transfer), **10** (crash-resume)
  and **11** (publication cycle). **No assertion in any of them has executed**: the
  sandbox key was cycled after the 07-31 drive, so this is a build, not a result. What
  *was* verified is narrow and worth stating precisely — it typechecks, and a runtime probe
  confirmed every dynamic import and every private method the steps drive resolves
  (`reserveWriterPayout`, `completeWriterPayout`, `resumePendingWriterPayouts`,
  `reservePublicationPayout`, `processPublicationSplits`, `finalisePublicationPayout`,
  `reconcileLedger`, `syncAllocations`, `allocatedTransferParams`). A typo in a private
  method name is `undefined` at runtime and would crash mid-run against a live sandbox
  three steps in, so that probe is the one check worth having before the key exists.
  - **The assertions are three-sided on purpose.** Our DB says N children completed;
    Stripe says N transfers exist with those amounts, sources and fees; the ledger says N
    entries sum to the parent. A step that checked only the first would pass just as well
    against a service that never called Stripe — which is exactly the gap the mock
    batteries leave, since `executePendingChildren`'s Stripe half drives the module-level
    `pool` and is unreachable from a rolled-back transaction.
  - **Steps 3, 10 and 11 need a state no public entry point exposes** — a committed pack
    with nothing yet transferred, which in production only a crash produces. They drive
    production's own `reserve*` methods rather than hand-writing a payout row, so the
    fabrication is one column of one already-committed child (`net_pence` inflated past its
    funding charge). The `allocated_draws` row is left stale **deliberately**: §3.3e's claim
    is about *Stripe's* enforcement, so our own budget must not be the thing that notices
    first. The sibling is what makes it a test rather than a demonstration — a handler that
    failed the whole parent, released every unit or deleted every draw would pass a
    single-child version and be catastrophically wrong.
  - **Step 10 refuses to reconstruct the mid-child-sequence crash, and the reason is the
    durable part.** A faithful reconstruction must DELETE the completed child's ledger entry
    (in a real crash it was never posted — it rides the flip's transaction), and the ledger
    is append-only at the database level, so the DELETE is refused. Reconstructing it
    *without* the delete is unfaithful in the one direction that matters: the resumed flip
    posts a second entry and the step reports a double-credit no crash can produce. **A
    fabricated state that misrepresents the system is worse than an unrun check.** So step
    10 pins the mechanism instead — the `status = 'pending'` selection, and the
    `xfer-<childId>` key put to Stripe directly both ways (same params → same transfer;
    different params → `idempotency_error`, the 2026-07-15 publication-split lesson) — and
    says in the header what it is not covering and why.
  - **Two prerequisites, both failing loudly rather than silently.** The flag must be set in
    the **shell**, not merely the container (these steps run the cycle in their own process;
    with it off, `completeWriterPayout` takes the aggregate path and every child-level check
    reports 0 against 2 — a step that looks broken when only the shell is wrong, so each
    refuses up front). And step 11's failed-split arm needs a **second onboarded sandbox
    account**: with one, the payout has a single split whose failure correctly fails the
    parent outright, so the property has no sibling to hold of — arms 1–2 run, arm 3 reports
    UNKNOWN naming the prerequisite rather than passing vacuously.
  - Also: steps 2/3/10 each accrue their own claimable position (`ensureClaimable`) instead
    of inheriting one, since step 2 pays out what steps 3 and 10 would need; and step 11 runs
    last unconditionally, because it re-homes the sandbox connect ids onto the publication's
    members and `accounts.stripe_connect_id` is UNIQUE. → CONSOLIDATED-TODO §11 /
    `FUNDS-SEGREGATION-INTEGRATION.md` §5.

- **2026-07-31 (the sandbox drive: two P0s in the settlement path, and neither was
  reachable from a mock)** — the §5 sequence was started against a real segregation
  Sandbox with `STRIPE_ALLOCATED_FUNDS=1` and the shipped payment-service. It found two
  live defects in the *pre-existing* charge path — both independent of the flag, both in
  code that has been on prod for months, and both invisible to every test in the repo
  because the only thing that knows these rules is Stripe. **Step 1 is green (6/6) and
  step 13 is green (267/267 flag-off); steps 2–12 remain.**
  - **P0 — the settlement PaymentIntent had no payment method, so no charge could ever
    succeed.** `paymentIntents.create` passed `customer` but never `payment_method`, and a
    PI does **not** inherit `invoice_settings.default_payment_method` — that field governs
    invoices and subscriptions. `gateway/src/routes/auth.ts:588` sets it at card-attach
    time with the comment "for future off-session settlement charges", which is precisely
    the assumption that does not hold. Stripe returns `payment_intent_unexpected_state`, a
    `StripeInvalidRequestError`, which `isTerminalChargeError` **correctly** treats as
    terminal — so the S1 machinery did exactly its job on a false premise: settlement
    `failed`, `card_action_required_at` set, and (since 2026-07-30) the `CardActionRequired`
    prompt shown to a reader whose card was never anything but fine. Fixed by resolving the
    customer's default PM before the create and passing it by id; a customer with no usable
    card is now an explicit terminal skip (`no_default_payment_method`) rather than a
    confusing Stripe rejection. **Paired control, one ingredient varied:** identical create
    without `payment_method` → error, with it → `succeeded`.
  - **P0 — a duplicate-charge window between "completed" and "confirmed".** The tab balance
    is not reduced at reservation, nor when Stripe returns; it moves only in
    `confirmSettlement`, on the `payment_intent.succeeded` **webhook**. But the row leaves
    `pending` the instant the charge returns. The reserve guard tested `status = 'pending'`
    alone, so a second `checkAndSettle` inside that gap saw a full balance and no pending
    row, reserved the same debt again and charged the reader a second time. **Measured, not
    reasoned:** A reserved 11:01:11.324 and correctly turned away three concurrent attempts
    while pending; A completed 11:01:12.787; **B reserved 11:01:12.845 — 58ms later**; A
    confirmed only 11:01:13.163. One £14 debt charged twice, tab left at −1400 — and
    **nothing alerted, because a negative tab is legal** (pre-paid credit, PAYMENTS §1.8). A
    third settlement reserved 1.3s after that, so it cascades. `checkAndSettle` fires on
    every paid gate pass, so two articles read in quick succession reaches it.
    - The guard now also blocks `completed AND stripe_charge_id IS NULL`, in the exported
      `SETTLEMENT_IN_FLIGHT_SQL`. That is the **same pair `reconcileSettlements` already
      selects on** for "charged but not yet applied", which is what bounds the fix: anything
      stuck behind the guard is released by that sweep, so a tab can be delayed but never
      frozen. Delayed collection is the safe direction; a duplicate charge is not.
    - The stale comment at the `applyLedgerDelta` call site enumerated the causes of
      over-settlement and did not contain this one. Corrected in place.
  - **Evidence, and one distinction worth keeping.** 6 DB-backed tests
    (`settlement-in-flight-guard-integration.test.ts`) running the **exported** statement
    rather than a re-typed copy, over all three lifecycle states, with the confirmed row as
    the paired control proving the guard *releases*. **Mutation-verified**: restore the
    `pending`-only predicate and 3 of 6 go red. Suite 267 → 273. The live re-run then showed
    **one settlement per reader** where before there were three — but both guard skips in
    that run hit the `pending` arm, so the live run proves the OUTCOME while the new arm is
    proved by the test. An un-controlled pass can be the harness passing rather than the
    feature working, so the two claims are kept apart.
  - **The conformance battery needed a `customers.retrieve` double**, and its dispatcher
    widened for the new predicate. Deliberately **not** derived from the SQL handed to it:
    for a guard predicate a deriving mock follows production back out again when an arm is
    dropped, which is the "pinning the mock" trap. The behavioural pin is the DB test.
  - **Why none of this was caught before.** Dev's key has always been the placeholder
    `sk_test_...`, prod is pre-launch with zero settlements, and the mocked suite answers
    the call rather than enforcing Stripe's rules. This is the §11 verification-debt thesis
    landing on the money path: *component ≠ feature*, and the only instrument that could
    see either bug was a real key.
  - Also landed: `scripts/segregation-sequence.ts` (re-runnable §5 sequence harness, driving
    OUR code where the probes drive Stripe raw), and the `DEPLOYMENT.md` manual-reversal
    runbook entry owed since the 2026-07-30 500 incident (*pass the flag; a 500 is not an
    answer, retry it*). → CONSOLIDATED-TODO §1.13 / §11.

- **2026-07-31 (the CDN was rewriting the front page, and no gate could have known)** —
  found while verifying the previous day's deploy had landed. Operator-config, no code
  change. Full mechanism + the fix + the check: `DEPLOYMENT.md` › *Known limitations*.
  - **What was wrong.** Cloudflare's Scrape Shield rewrites anything email-shaped in served
    HTML into `[email&#160;protected]` plus an injected decoder script. **NIP-05 is
    deliberately email-shaped**, so the landing page's Nostr demo — the card whose whole job
    is to say *this is a Nostr identity* — was served as `via Nostr · [email protected] →`.
    The decoder is same-origin so `script-src 'self'` runs it and a JS visitor recovers the
    text, but the SSR'd HTML that crawlers, link previews and no-JS visitors receive was
    wrong, and everyone else got a flash of it. Turned off zone-wide; verified byte-exact.
  - **The class, which is the durable part.** This passed `tsc`, `next build`, the hairline
    tripwire and the full suite; it was correct in git and correct in the container. **The
    bytes a visitor receives are not the bytes the container served**, and nothing in the
    repo can see the difference. A public-facing change is verified against the SERVED
    BYTES or it is not verified. `DEPLOYMENT.md` had never mentioned that a CDN sits in
    front of production at all; it does now.
  - **Two wrong checks first, which is why the verification is written down as commands.**
    I first grepped for `bergqvist` to test whether the landing fix had deployed — but that
    fix kept the *name* and changed the *namespace* (`.bsky.social` → `.all.haus`), so the
    string was present either way and the check could not discriminate. Then I read
    `aurelio: 0` as a stale deploy when it was the CDN. **A check that cannot fail and a
    check that cannot pass are the same error**, and the fix for both is to assert the
    thing that actually differs — here `bergqvist.all.haus` present AND
    `bergqvist.bsky.social` absent, which is the paired form the repo already uses for
    mutation testing.
  - **Scope, measured not assumed — and my first draft of this entry overstated it.** I
    wrote that public writer profiles were exposed too, then checked: **no profile surface
    renders a NIP-05 at all**, and the landing demo's `aurelio@all.haus` is the only
    email-shaped identifier in the entire web app (`/.well-known/nostr.json` serves NIP-05
    as JSON, which the HTML rewriter ignores). One card, one page. The risk is **latent**
    rather than closed: the platform mints NIP-05 identities, and the first public profile
    to print one inherits the heuristic. Invisible in dev (no CDN) and invisible behind auth
    (client-rendered), which is why it reached production.

- **2026-07-30 (audit F4 closed: the webhooks that were never coming)** — CONSOLIDATED-TODO
  §1.1 item 1. Since 2026-07-06 `webhook.ts` had carried `transfer.paid` and
  `transfer.failed` as guarded no-ops with a comment saying they do not fire for
  platform→connected transfers, "pending a live-Stripe confirmation before deletion".
  This is that confirmation, and then the deletion.
  - **How you evidence an absence.** Two empty lists prove nothing — an events endpoint
    returning nothing at all looks identical. So the probe counts FOUR types together and
    the verdict is gated on the first two: `transfer.created` as the **denominator** (N
    transfers of exactly this shape existed), `transfer.reversed` as the **positive
    control** (`transfer.*` for these very transfers IS delivered here), then the two under
    test. Result: **29 created, 24 reversed, 0 paid, 0 failed**, with `destination` set on
    every sampled event. With the controls empty it reports UNKNOWN rather than passing by
    default. Same standard as the M10 negative control and yesterday's cumulative-reversal
    check: *a passing check proves nothing until it can fail.*
  - **The same technique that resolved the webhook-scope contradiction the day before** —
    ask the event log what Stripe actually emitted rather than reason about what it ought
    to. Read-only, moves no money, re-runnable: `segregation-probes.ts --f4`.
  - **386 lines deleted**: both switch cases and the six service methods they were the
    ONLY callers of. Checked before cutting rather than after: no test referenced any of
    them, and the two `rollback*PayoutRows` helpers survive because each retains its
    terminal-create-rejection caller — their docblocks now say so, since "shared, so it
    can't diverge" was the reason they were extracted and that reason is spent.
  - **The ledger-adjacency floor did not move (19), and that is the interesting part.**
    Deleting six money-path methods without changing the count means none of them posted a
    ledger entry — which is the F4 design working exactly as stated: completion is keyed
    off the `transfers.create` response, so the entry rides *there* and the webhook
    handlers were pure status flips. Verified against the diff rather than assumed.
  - **Three docs were giving actively wrong instructions and are fixed.** `DEPLOYMENT.md`
    told the operator to verify `transfer.paid` webhooks were reaching `/webhooks/stripe`
    — following it, they would have concluded the webhook wiring was broken. The
    segregation ADR described the `confirmPublicationSplit` guard hole as live. And
    UPSTREAM-EDGES-AUDIT-FIXES **F15** now carries a superseded note: its premise
    ("tribute and publication transfers emit the same webhooks") was false, so the routing
    that fix added was dispatching events that never arrive — a fix built on a
    misunderstanding, doing nothing, for five weeks.

- **2026-07-30 (the card-decline prompt, and the balance that had been lying)** —
  CONSOLIDATED-TODO §1.4, STRIPE audit S1.
  - **The flag with no consumer is the worst shape a flag can have.**
    `accounts.card_action_required_at` had been set by settlement declines and exposed on
    `GET /my/tab` since the S1 audit, and nothing rendered it. The backend behaviour is
    right — settlement backs off rather than retrying a card Stripe has called dead — but
    the reader was told nothing, so from their side the tab just stopped working with no
    explanation and no way to fix it. The copy IS the feature: what happened, what it means
    now, and the one action that clears it. Not dismissible, because the state persists
    until a card is attached and an affordance you can wave away would misrepresent it.
  - **It rides the session, not the tab response.** Beside `hasPaymentMethod` on
    `/auth/me`, so one source serves every surface and none of them needs its own fetch —
    and it self-dismisses everywhere at once, because `connectPaymentMethod` already clears
    the column in the same UPDATE that sets `stripe_customer_id`. One `fetchMe` does both.
  - **The bug it turned up on the way.** Three of `TabOverview`'s four declared fields had
    never existed on the wire: the route sends `tabBalancePence` and the type said
    `balancePence`, with a raw pass-through API client between them and nothing to report
    the mismatch. The ledger's net balance is `earnings − tabBalance`, so with `tabBalance`
    permanently `undefined` and the fallback making it 0, **a reader who owed money saw a
    balance as though they owed none.** `freeAllowanceTotalPence` and `recentReads` were
    undefined too. Worth recording as a class: a hand-written response type is an
    unchecked assertion about another service's JSON, and it fails silently and
    optimistically — the reading that flatters is the one that survives review.
  - Still owed and unchanged: the S2 live browser test of card attach incl. 3DS, which
    needs real keys.

- **2026-07-30 (publication-split re-pay: the row that had to be new)** — CONSOLIDATED-TODO
  §1.2, migration 167. A split Stripe terminally rejected was marked `failed` and left
  there forever: the member simply went short, and the tracker's standing answer was
  "manual transfer".
  - **Why it could not be retried in place, which is the whole shape of the fix.** The
    idempotency key `pub-split-${payoutId}-${splitId}` is row-stable *on purpose* — that
    is what lets the resume sweep retry an AMBIGUOUS failure without double-paying
    (2026-07-15 audit). So a retry against the same row dedupes straight back onto the
    transfer that was rejected. The fix is a **fresh row**, whose new id is a new key.
  - **Why the money does not come back on its own.** The writer and tribute cycles release
    their units child by child, so a failed parent is re-paid under a fresh parent next
    cycle. A split owns no claim rows — the publication cycle claims its reads under the
    PAYOUT, and a split is a bps share of the resulting pool with no per-read decomposition
    to release. The money stays claimed by a payout that has already completed, so a
    replacement against that same parent is the only place it can be paid from.
  - **Two columns, each closing a specific way of getting it wrong.** `attempt` bounds the
    retry at 3: a terminal rejection is a *deterministic* one (the narrow
    `isTerminalTransferError` — `StripeInvalidRequestError` only), which in practice means
    the destination is closed or rejected, and retrying that forever would call Stripe and
    mint a row every cycle for a member who can never be paid.
    `replaced_by_split_id` makes supersession an explicit pointer rather than a match on
    `(payout, account, share_type, article_id)` — ambiguous, because
    `computePublicationSplits` can legally emit two splits for one account in one payout
    (standing + article share). That is the same collision that made the idempotency key
    row-stable in the first place, arriving a second time in a new disguise.
  - **The parent reopens, and that is a loop rather than a special case.** A fresh pending
    split on a completed parent must reopen it or `resumePendingPublicationPayouts` — which
    scans `pending` parents only — never processes the row; `PUBLICATION_PAYOUT_COMPLETE_SQL`
    then re-closes it on its existing "no split PENDING" rule.
  - **Segregation needed no new budget logic, which was worth checking rather than assuming.**
    The predecessor's children were failed by `failChild`, whose single-statement DELETE of
    the child's `allocated_draws` row returns that allocation to the budget. So re-packing
    the replacement draws afresh instead of double-drawing. The fee is re-prorated from a
    denominator that EXCLUDES superseded rows — counted, it would grow with every re-pay and
    quietly shrink each replacement's application fee below the one its predecessor carried.
  - **The safety argument, made falsifiable.** A replacement adds a row to a table three
    money paths read, so the design rests on each of them seeing exactly one. Checked
    against real Postgres rather than reasoned about: `ledger_publication_distribution` sums
    LEDGER entries and a failed split posts none; settlement.ts's read selects
    `IN ('initiated','completed')`; the F5 chargeback selection takes
    `IN ('completed','reversed')`. A chargeback claws back the 600 actually paid, not 1200
    against a member who received it once.
  - **14 DB-backed tests, and the mutation pass that makes them evidence.** Five SQL
    constants exported so the test executes production's own statements — the sweep drives
    the module-level `pool` and is unreachable from a rolled-back transaction, exactly like
    `executePendingChildren`. Three load-bearing predicates were then each removed in turn
    (the candidate query's supersede filter, the fee denominator's, the reopen's
    `status = 'completed'` gate) and each mutation was caught: 2, 2 and 1 failures. What is
    NOT covered is said out loud in the file header — the sweep's control flow (attempt cap,
    un-onboarded skip, re-read-under-lock) is pinned by nothing here.

- **2026-07-30 (segregation §5 step 0: the probes RUN, and the payload nobody had seen)** —
  the sandbox half of step 0 is done. All five probes green against a segregation-enabled
  Stripe Sandbox; the two production baseline queries remain owed. Findings live in ADR §5's
  results block (`FUNDS-SEGREGATION-INTEGRATION.md`) — this is the index, not the record.
  - **§3.5's re-keying is confirmed against the real `transfer.reversed` payload.** It
    carries the CHILD transfer's own id (what `payout_transfers.stripe_transfer_id` resolves
    on — not the charge, not the destination), a sibling child is untouched, and
    `amount_reversed` is CUMULATIVE. The design was built against this without anyone ever
    having seen it.
  - **The cumulative check was vacuous until it was made falsifiable.** After ONE reversal
    of 150, cumulative and per-reversal both read 150 — the check passed whichever was true
    and proved neither. Reversing the same child a second time (150 → 250, with
    `reversals.total_count: 2`) is what turned it into evidence. Same standard as the M10
    negative control: *a passing check proves nothing until it can fail.*
  - **`reversed` stays FALSE on a partially reversed transfer.** Anything keying on that
    boolean misses every partial. Recorded because it is the obvious-looking wrong choice.
  - **The application fee is PRORATED on a partial reversal** — 244 → 406 on 150/400
    (+12 = 32 × 0.375), 244 → 514 on 250/400 (+20). That is the arithmetic
    `prorateCarveReversal` assumes, now measured twice at different ratios.
  - **A false negative that cost the session, and the fix.** Allocation is not visible when
    `paymentIntents.create(confirm:true)` returns — it materialises ~1–3s later. A single
    eager read reports `allocated_funds: null`, which is INDISTINGUISHABLE from a sandbox
    with the beta switched off, and probe 1 read that way. Chased as far as "does
    `syncAllocations` silently stamp every charge 0 and route everything to residual while
    reporting success" before the second read came back populated. It does not: the sweep
    runs 3×/day and a too-early stamp self-heals, so the delay *confirms* the out-of-band
    design (`settlement.ts:1344`) rather than threatening it. `allocatedCharge()` now waits,
    and reports `allocation_visible_after_ms` so the number is evidence rather than folklore.
  - **A Stripe-side 500 that came and went — and an isolation that claimed more than it
    could.** `refund_application_fee=true` on an allocated reversal returned
    `StripeAPIError` 500 four times inside one ~40-minute window, then succeeded **15
    consecutive times**. Final read: a transient incident on Stripe's side, not a latent
    defect in the call shape. Request ids kept and reported anyway, since our payout
    correction path depends on this call.
    - **What the matrix could and could not show.** `scripts/segregation-reversal-isolate.ts`
      (new) varied one ingredient at a time and, during the failing window, failed on both
      flag-carrying cases while passing both without the flag — so the failure was
      **specific to the fee-refund path, not a blanket reversal outage**. But every case ran
      *inside* that window, so it showed correlation and not cause; the later successes
      carry the same flag. The first draft of the ticket said "when and only when
      `refund_application_fee=true`", which the evidence did not support, and it was caught
      by being asked whether this was really a bug rather than our own probes.
    - **A plausible follow-up hypothesis, tested and refuted.** That the fee-refund path
      races allocation state still settling, so reversing too soon 500s. Tested directly
      (`--mode delay`: same shape at 0/2/5/15/30s, twice each, plus no-flag controls at the
      shortest delays) → **12/12 passed, including at a shorter elapsed time than the
      failures had**. Written down because it was plausible, cheap, and wrong.
    - **Reported and closed by Stripe the same day.** They accepted it as a transient backend
      issue rather than anything in our integration or request shape, flagged it internally
      with the four request ids / window / parameter pattern, and independently named the
      same signal we had — that reversals without the flag kept succeeding in the window
      points at the application-fee refund path specifically, not the endpoint, destination
      or currency. **Their one ask was the one thing we could not give them: the RAW response
      body**, where an internal trace or correlation id would surface when the structured
      fields are empty. Nothing retained it, and the run that produced it had been
      overwritten. Now fixed in both harnesses — `describeStripeError()` in
      `segregation-probes.ts` is the one home (every catch in that file routes through it),
      and the isolate script's catch matches; both record `raw` and the response `headers`.
    - **Standing lesson for the harness:** a matrix run entirely inside a failure window
      shows correlation with whatever it varies and cannot show cause. Re-run across windows
      before believing an isolation. Same family as "a passing check proves nothing until it
      can fail" — here, a *failing* check proved less than it appeared to. Corollary from the
      same afternoon: **capture the raw error body at the point of failure**, because by the
      time anyone asks for it, the run that produced it is gone.
    - It remains evidence FOR the narrow `isTerminalTransferError`: a 500 is
      `StripeAPIError`, correctly non-terminal, so a transient like this leaves the child
      `pending` and the resume sweep retries under the same idempotency key rather than
      stranding it. A manual reversal has no such harness, so `payout-children.ts:617`'s
      instruction still wants a *retry it* note in the runbook.
  - **Learned in passing:** `application_fee_amount` is only accepted alongside an allocated
    `source_transaction` (Stripe 400s otherwise, in terms) — so fee and allocation are
    inseparable, and `allocatedTransferParams()` is right to emit both or neither. And a
    segregation sandbox is identifiable read-only: an un-enrolled account rejects the preview
    version header outright, which is how the right one of two sandboxes was found.
  - Probe-side changes: poll-for-allocation, both retrieval paths asserted (they agree),
    full Stripe error capture (`type`/`statusCode`/`requestId` — "An unknown error occurred"
    alone is unactionable), `available + pending` for balance reads (available alone is
    always 0 in a sandbox, so probe 6's check was vacuous), and a documented fallback that
    harvests the payload when the 500 hits.
  - **The production baseline ran too, and returned NOTHING TO MEASURE — which closes
    step 0 rather than leaving it open.** Every figure zero: no payouts in the 30-day
    window, no writers over threshold, no connected accounts. Migration 165 is applied
    (16:35:05 on 07-29) and the window is entirely post-165, so the plumbing is right and
    the platform is simply gated pre-launch. Both dials keep their placeholders, now as a
    *recorded state blocked on payout volume* rather than an outstanding task; the reason
    is written into `config-defaults.sql` beside them. The queries were built for this
    outcome and say so in terms — "NO PAYOUTS IN WINDOW — no measurement. Widen the window;
    do NOT read 0 as perfect coverage" — the same distinction `summariseResidual()` makes by
    returning null on an empty denominator rather than 0%.
  - **And it inverts the ADR's own ordering.** §5 says measure then flip; §6.3 warns that a
    cycle spanning the flip mixes allocated and unallocated charges and spikes the residual
    as pre-flip earnings drain. **With zero payouts and zero settlements there are no
    pre-flip earnings**, so flipping before the first real payout removes the transition
    entirely and segregates every pound from the first one. The measurement cannot precede
    the money, so the sequence that actually applies is: flip when Stripe enables live, then
    baseline from the first 30 days of real volume. §7.5 is moot until a connected account
    exists.
  - Noted for the first cycles: a residual share off a *tiny* denominator is arithmetically
    fine and statistically meaningless, so expect noise from that alert early. That is the
    sample, not the threshold.
  - **Connect onboarding returned every writer to a 404, and still does on prod until this
    deploys.** Found while reading the Stripe surfaces for the session above.
    `accountLinks.create` sent both `refresh_url` and `return_url` to
    `${APP_URL}/settings/payments` (`gateway/src/routes/auth.ts:399-400`) — a route that has
    not existed since settings became a workspace overlay (`web/src/app/settings/` holds one
    `page.tsx`, itself a redirect shim). So a writer who completed Stripe KYC landed on a
    dead page, as did one whose account link expired. Now `${APP_URL}/settings?...`, which
    the shim forwards into `/reader?overlay=settings` where `account/PaymentSection` renders
    Connect status; a return from Stripe is a full page load, so `fetchMe()` runs fresh and
    no explicit refetch is needed. Routed via the shim rather than straight at
    `/reader?overlay=settings` to match the OAuth callback's `?linked=` precedent — the shim
    is the compatibility surface for an external service returning the browser to us.
    Nothing reads `onboarding=complete` / `refresh=true`, so they stay as breadcrumbs,
    forwarded by the shim and added to `OVERLAY_PARAM_KEYS` so they are stripped from the
    workspace URL like every other seed param rather than lingering.
    **Sharpened by the baseline above: production has ZERO connected accounts.** Whether
    anyone hit the 404 or nobody has tried on a gated site is unknown and not worth
    guessing — but it sits on the critical path, since no onboarded writers means no
    payouts, which means the two dials stay placeholders indefinitely.
    Verified: gateway 434 tests, `next build`, 0 lint errors, hairline check clean.
  - **The `DEPLOYMENT.md` webhook-scope contradiction is settled, and the DOC was the wrong
    one.** It claimed `transfer.*` is emitted on *connected* accounts, while production puts
    `transfer.reversed` on the platform-scoped endpoint — and if the doc had been right,
    transfer reversals would have been silently never delivered and §3.5's ledger semantics
    would never fire. Measured rather than argued: `GET /v1/events?type=transfer.reversed`
    returned three events on the platform account and **none** when re-run with a
    `Stripe-Account:` header for the connected account. A Transfer is a platform-account
    object; the connected account sees an incoming payment (`py_…`) and a refund of it
    (`pyr_…`), never a `transfer.reversed` — both ids were sitting in 7b's payload the whole
    time. Probe 7b had also already shown half of it unremarked, retrieving the event through
    a plain platform-key `events.list`. `DEPLOYMENT.md`'s bullet is rewritten with the
    two-endpoint scope table production actually runs, and its
    `STRIPE_CONNECT_WEBHOOK_SECRET` row corrected from "only if a separate endpoint" to the
    shape we run. Closes the last of the rev-3 review's two live defects.

- **2026-07-30 (review batch 2: the flag-flip blockers, and the hygiene tail)** — the rest
  of the three-day review's queue, taken in the order it named. All verified before fixing.
  - **The zero-net payout wedge is closed, and it was WIDER than the review said**
    (`3ef3e5cf`). The review named the fully-gifted read (`chargeable_pence = 0`); code
    reading found the second population — a 1p-chargeable read floors to net 0 under
    `perReadNetPence` at 1000 bps, so a *penny* read is also a zero-net unit (gross 1, not
    0). Either could open its own slice: a `netPence: 0` child violating
    `payout_transfers_net_positive`, aborting the whole reserve, deterministically, for the
    same writer every cycle. Fixed in the packer so all three cycles get the property
    structurally (the tribute cycle had the same exposure via a floored 0p accrual, and
    `apportionCarve` only filters zero-net units when carve > 0): `packUnits` gains a
    `zeroNet` result bucket — callers KEEP those claims (childless-advance, like
    carve-zeroed reads; un-claiming would re-present the row forever) and any fee is dust,
    the under-claim direction — and `usable()` now requires map presence before comparing
    remainders (gross 0 satisfied `(remaining.get(id) ?? 0) >= 0` for a never-locked
    settlement, handing `openSlice` an undefined source). Four packer tests, the soundness
    property gains "every slice is insertable", two DB-backed assembly tests (the CHECK as
    a paired control; the wedge shape through pack→insert). Mutation: reverting the filter
    turns 5 tests red. 253/253 payment-service with the DB suite genuinely running.
  - **Migration 166 corrects the `allocated_draws` refund sign** (`d8df2fbe`). The 165
    table comment — the only signed statement of the convention — said refund draws are
    negative; the implementation stores them positive, and it is right (budget =
    `allocated_pence − SUM(gross_pence)`: transfer +, refund + cumulative via GREATEST,
    reversal −). A reader following the comment would have GROWN the budget on refund.
    165 is checksummed, so the fix is a new docs-only migration; schema.sql regenerated by
    the throwaway-from-committed protocol (only body change in the diff is the comment);
    all seven drift-guard checks green; dev migrated through 166.
  - **The migration-164 sizing recipe is MOOT — dispositioned, not built.** The review
    asked for a prod sizing query + a "resolve these rows" recipe before migrating; 164
    was already applied on prod 2026-07-29 10:12 UTC (the user's own pre-check the day
    before had counted 0 blocking rows), so the DO-block gate has already passed, and
    fresh installs boot from `schema.sql` with 164 pre-seeded — no DB remains where the
    gate can fire. Recording the disposition IS the deliverable.
  - **The hygiene batch** (`b6bdf670`): `files.zip` deleted + `*.zip` gitignored (an
    archive dodges every tripwire); the stylesheet's one raw `rgb()` literal onto
    `--ah-true-black-rgb`; the segregation ADR's Build-status header un-frozen from its
    part-1 state (with a note that headers are what correction sweeps skip); the two
    162/163 timing claims corrected in place against prod's `_migrations.applied_at`
    (each migration went on separately — 162 on 07-24, 163 on 07-27, 164/165 on 07-29 —
    not "162–164 along with 165 at 16:35"); CLOSED-BETA §XI.5's morning-of-07-27 panel
    description corrected against the shipped route (no publish-interest tile/column;
    admitted + admitted-not-invited counts instead), and §XI.2's Export CSV — which fell
    off the build order without being shipped, deferred, or declined — re-queued
    explicitly at CONSOLIDATED-TODO §3.7 as a decision to make, not a slip to repeat.
  - The review's remaining small tail (webhook silent early-returns, the historical
    `'initiated'` parent count, probe fidelity, the crashed-admit wedge, landing
    self-conformance, citation rot) is filed as CONSOLIDATED-TODO §0n.

- **2026-07-30 (review batch 1: a handle that resolved, a window shaped like a clock, and
  four tests that rotted red)** — the act-now findings of the three-day commit review
  (2026-07-27..30), all three verified before fixing.
  - **`bergqvist.bsky.social` was a real person.** The landing demos' invented-content
    rule was enforced by literary judgement, never by resolution: the "invented" Bluesky
    handle under the omnivore demo's corruption-accusation post resolves to a real,
    registered account (`did:plc:7asklo4dkbqs3cdwbxlc33uu`, created 2024-12-31 — checked
    against the live API, both before and after the fix). `aurelio@driftpost.net` was the
    same class one registration away. Both moved into the operator-controlled namespace
    (`bergqvist.all.haus`, `aurelio@all.haus` — also literally true of the product, which
    serves branded atproto handles and NIP-05 from that domain); the rule gained its
    mechanical half in CLAUDE.md + `CanvasDemo.tsx`'s note: an identifier that RESOLVES
    lives only in a namespace we control, checked against its registry before shipping.
  - **The digest's cold-start window was a clock, and it broke the worker's own
    guarantee.** `waitlist-digest.ts` opened a watermark-less window at `now − interval`,
    so any join older than the interval at first-run time was never reported and never
    watermarked — unreported forever. On prod this meant the §XI.4 verification ("the
    three real rows will produce one digest on the next deploy") silently evaluated to no
    email: the deploy landed >24h after the rows. Cold start now opens at **epoch** — the
    whole unreported list is the first report, once. Corrections written where the false
    guarantee stood: worker comment, CLOSED-BETA-ADR §XI.4 (dated correction, incl. what
    the fix does and does not retroactively heal on prod), CONSOLIDATED-TODO §3.7 prod
    note.
  - **The same clock had rotted the digest suite red on master.** Four cold-start tests
    (fixtures dated 2026-07-27) fell out of the `now − 24h` window a day after they were
    written and failed permanently — the 07-29 entry's "(b) pre-existing — untouched"
    note below is corrected in place: true relative to that change, but master carried a
    red suite and a third of the digest's mutation net was dead. The epoch window makes
    the cold-start path clock-independent, so all four are green again with **no fixture
    change**; a new test pins the epoch window with the clock deliberately set months
    past the fixtures, so a regression to a clock-shaped window fails on any day of the
    week, not just the day it was written.
  - Verified: 15/15 `waitlist-digest.test.ts`; mutation-checked by reverting the window
    fix in place — 5 tests go red (the four resurrected + the new pin), restore goes
    green; `check-hairlines.sh` clean on both demo files; `next build` passes. Demo
    change not rendered in a browser (byline text only, the fc8ca95e precedent).

- **2026-07-30 (the segregation step-0 harnesses, and a finding that was my own tooling)**
  — §5 step 0 is the sole remaining blocker between the funds-segregation build and a flag
  flip, and it had never been run, so `allocated_residual_alert_bps` and
  `payout_max_slices` are live placeholders rather than measurements. Neither half can be
  run from a dev laptop — dev's `STRIPE_SECRET_KEY` is the literal placeholder
  `sk_test_...`, there is no sandbox, and the baselines need production — so what shipped
  is the harness for both, leaving a credentials errand rather than a build.
  **`scripts/segregation-probes.ts`** runs probes 1, 4, 6, 7 and 7b against a
  segregation-enabled Sandbox, plus a read-only `--countries` mode for the §7.5
  enumeration. It drives Stripe raw, per step 0's own instruction to run "with no §3.3 code
  at all", importing exactly one thing from the repo (the preview API version, which must
  not drift) and otherwise printing what comes back: a stated expectation is recorded as a
  check with a verdict and never halts the run, because an unexpected shape is the finding.
  7b is the point of the exercise — two children on one charge, then a *partial* reversal
  of one, dumping the whole `transfer.reversed` payload, because `reversed_pence` and
  `prorateCarveReversal` both rest on `amount_reversed` being cumulative and nobody has
  ever seen that event. It reads the event off `events.list` rather than waiting on a
  delivery, so no tunnel is needed, and refuses an `sk_live_` key for anything that moves
  money. **`scripts/segregation-baseline.sql`** is the two production readings, strictly
  read-only — and it leads with a *diagnostic* because the obvious query is wrong here:
  migration 165 added `subscription_events.tab_settlement_id` with no backfill by design,
  so on a DB where 165 has not run every earning classifies as credit-funded and the
  residual comes out ~100%. Query 0 reads `_migrations` and states which classifier the
  window supports; Query A prints the exact and a `settled_at < created_at + 1 minute`
  heuristic side by side, the heuristic erring toward a larger residual, which is the safe
  direction for a threshold. The slice distribution copies writer eligibility exactly from
  `reserveWriterPayout` (`publication_id IS NULL` included — publication reads are the
  pool's, and dropping that filter inflates the count with reads the cycle never sees) and
  is documented as an **upper bound**, since the packer co-locates units and collapses all
  residual units into one slice. Validated as far as credentials allow: the SQL runs clean
  end-to-end against dev (one wrong column found and fixed — `publication_payout_splits`
  has no `completed_at`), the harness typechecks strict/NodeNext, both refusal paths fire.
  **And the correction worth keeping.** Along the way `allocation-packer.ts` was found to
  contain a NUL byte — its residual sentinel was `'\0residual'` — which makes `file` report
  the module as `data`. I reported this as blinding `check-ledger-adjacency.sh` and
  `check-read-chargeable.sh`, having demonstrated that grep matched nothing in the file.
  **That was wrong, and the way it was wrong is the lesson**: `grep` in the agent's shell is
  a wrapper around ugrep with `-I` (skip binary files), while the tripwires and CI run GNU
  grep, whose `-l` still lists a matching binary file and whose `-c` still counts
  correctly. Established by planting a real `INSERT INTO payout_transfers` violation in the
  file with the NUL restored and watching Guard 3 catch it and name it. The guards were
  never blind; I had measured my instrument. The NUL was removed anyway as hygiene for
  human tooling (ripgrep, ugrep and `grep -I` all skip the file in silence, and a search
  that finds nothing looks exactly like a file with nothing in it), the sentinel is only
  ever a `Map` key so nothing behavioural moves, and the in-code comment now records why it
  was *not* a guard problem rather than leaving the scare behind. Verified by mutation
  rather than a green suite: making the sentinel unique per unit turns
  `allocation-packer.test.ts:159` red, the test asserting residual units collapse into a
  single slice. 247/247 payment-service tests with `TEST_DATABASE_URL` set so the 26
  DB-backed segregation assembly tests actually ran; all three tripwires green.
  **Prod state, established afterwards and the same lesson twice.** A request to "deploy
  migration 165" turned out to be a no-op: 165 had been applied on 2026-07-29 at 16:35 UTC,
  and prod's schema was already fully current. *(Corrected 2026-07-30: this entry
  originally said "along with 162–164", which the `_migrations.applied_at` listing it was
  itself based on contradicts — each migration went on separately as its code shipped: 162
  at 2026-07-24 11:39 UTC, 163 at 2026-07-27 19:12 UTC, 164 at 2026-07-29 10:12 UTC, 165
  at 16:35 UTC. All times here UTC, straight from the column. An entry preaching
  state-from-evidence compressed the evidence it had into a falsehood.)* I had asserted the
  opposite earlier in the same session, inferring it from this queue's "not yet deployed"
  note about the closed-beta ship — which is exactly what the deploy note says never to do.
  Three read-only commands settle it and none of them is expensive: `_migrations` for the
  schema, `git log -1` for the source, `docker compose images` for what is actually
  RUNNING — and the third is the one that matters, because prod's source sat at that
  morning's commit while its images dated from 07-29 ~16:10. Reading `git log` alone would
  have said the latest code was live; it was not. What that build window contains is
  segregation parts 1 and 2 but **not part 3** (17:02), so the tribute cycle,
  `allocation-reconcile.ts` and the residual metric are on prod's disk and not in its
  containers — harmless, since the sweep gates on `allocatedFundsEnabled()` and no-ops while
  the flag is off, and parts 1+2 are coherent alone (part 3's carve-ordering fix was to code
  part 3 itself introduced). The one live consequence is good news: `confirmSettlement`'s
  `tab_settlement_id` stamp shipped in part 1, so it has been filling since 07-29 ~16:10 and
  the baseline query's exact classifier becomes authoritative around 2026-08-28. Until then
  its heuristic row is the honest one, and it needs no deploy to run.
  → CONSOLIDATED-TODO §1.13 + attack order 1b; ADR §5 step 0 + §10.3.

- **2026-07-29 (the landing demos' copy, and the paywall figure nobody had looked at in
  dark mode)** — the three `/` demos were rewritten for content, and one real defect fell
  out of rendering them. **The copy.** The invented world had drifted into parody: a
  transit operator posting timetable notices, ridership replies, weekend engineering
  works, an "Open Thread 443", plus the same three or four cards repeated across all three
  figures — a page claiming that everything worth reading fits in one place, illustrated
  with council minutes. The cast and publications stay (they are what makes the three
  demos one world); *Northgate Transit* is replaced by *The Tidewatch*, and the subjects
  are now spread across an essay on power, an investigation, printing, sport, whales, the
  aurora and a repainted gate, with the chatter written as chatter. **No post is repeated
  across the three files** — a card seen twice reads as the page running out of things to
  show — and the shared world is instead carried by stories *crossing* between them, which
  is the thing the product actually does. The one deliberate exception is the pairing that
  now runs through the payment argument: the paid card in the omnivore demo, the article
  behind the gate, and the publication in the subscription line are all Ellis Marchetti's
  *The difficult second read*, so the gate asks forty pence for something a visitor has
  already read the opening of. The gated essay also **has a title and a byline** now; it
  had neither, so the figure could only ever demonstrate the interruption, never what was
  being bought. Notes recording all of this sit in `CanvasDemo` (the no-repeat rule),
  `OmnivoreDemo` and `ReaderDemo` (the two ends of the pairing).

  **The defect: the paywall pane was unreadable in dark mode, and had been since it
  shipped.** `ReaderDemo`'s pane is a Glasshouse — `var(--ah-glasshouse)` — and the
  landing vessel is a light island, so the pane resolves canonical WHITE in both modes.
  Every piece of text on it was taking `palette.cardTitle`/`cardStandfirst`/`cardMeta`
  from `paletteFor('basic', dark)`, which under the dark toggle is the LIGHT end of the
  ramp, built for a dark card. Prose, "Keep reading", the price and the Subscribe button
  all painted near-white on white; only the crimson button survived. Fixed by taking the
  pane's text from the neutral slugs (`--ah-ink`/`--ah-grey-600`/`--ah-crimson`), which is
  the fixed-light-surface rule in CLAUDE.md and is a no-op in light mode. The FLOOR keeps
  the palette — those are feed cards and are meant to follow the toggle. Caught by
  *rendering it*, which is the fourth time this page's own ADR note (§IX *Still open* 7)
  has been right about that: it compiled, linted and read fine.

- **2026-07-29 (funds segregation, part 3 — the tribute cycle, the only visibility it has,
  and a fifteenth mutation that survived)** — the third payout cycle, the §3.6 reconcile
  sweep, the §3.3d residual metric and the §3.3f dust script. **The segregation build is
  now complete**: all three cycles fund through the packer and the shared child lifecycle,
  and everything remains dark behind `STRIPE_ALLOCATED_FUNDS`. Spec:
  `docs/adr/FUNDS-SEGREGATION-INTEGRATION.md` §10.1b (as-built) and §10.3 (a short,
  honest remainder).

  **The tribute cycle (§3.4).** `packTributePayout` inside `reserveTributePayout`'s
  transaction: one unit per claimed `tribute_accruals` row, its read's
  `tab_settlement_id` as the preferred settlement, fee **0** (an accrual is carved out of
  the author's already-post-fee net — there is no second fee to claim). The node's onward
  carve to its direct children goes through the same `apportionCarve` the writer cycle
  uses, with the same two assertions, so the negative-unit class is a rolled-back
  transaction rather than an over-pay. `completeTributePayout` branches on `hasChildren`
  (data, not flag) and all three transfer webhook handlers resolve a child first.

  **What was delicate, and is now pinned.** The author's `tribute_carve` debit is posted
  per child, for that child's accruals, at their **GROSS** — the onward carve flows from
  the inspirer, not the author. It reads `state = 'released'`, which makes it
  ORDER-DEPENDENT on `postLedger` running before `advanceUnits`: read one transition later
  it sums 0 and the author silently keeps earnings that left them. Both statements are
  exported and the test runs them in that order **with the post-advance figure as a paired
  control**, so the ordering contract is a test rather than a comment. The carve-zeroed
  accruals (whose whole share went onward) advance at parent completion through
  `TRIBUTE_CHILDLESS_ADVANCE_SQL`, whose `RETURNING` is the single-shot gate that ledger
  entry needs — `completeParentIfSettled` cannot supply one, since it reports `completed`
  from a tally rather than from its own UPDATE's `rowCount`. And `prorateCarveReversal`
  (extracted to `allocation-packer.ts`, 5 unit tests, 3 mutations) prorates the re-credit
  to the CHILD's own cumulative reversal: both terms use one carve figure, so it cannot go
  negative when a chargeback shrinks the carve between two partials — the parent-grain
  path differences against entries posted under the OLD carve and needs its `> 0` test.

  **Reconcile is a SIBLING of `reconcile-ledger`, not part of it (§3.6).** That file's
  `CRITICAL_CHECKS` holds five halting checks and a default-deny catch-all; an allocation
  check added there is one edit away from halting the platform because a webhook was slow.
  `allocation-reconcile.ts` alerts at ERROR and never halts — a stale budget makes the
  packer under-draw by construction, and a large residual means the money is right and the
  coverage is poor. Two judgements worth the words: **no watermark** (the sync sweep's own
  oldest-first rotation already walks the population, so taking the most-recently-synced
  batch is a moving window with no stored position and no `timestamptz` precision to lose
  — the trap §3.6 flags), and the divergence figure is deliberately **not** floored at 0,
  because a model that has drawn past zero is exactly the state worth alerting on.
  §3.3d returns **null, not 0 bps**, for an empty window: no payouts is no measurement,
  and 0 would read as perfect coverage forever on a platform whose payout cycle had died.

  **Validation.** payment-service 210 passed / 3 DB files skipped without a URL; with one,
  37 DB-backed tests including 26 in the segregation assembly. tsc clean, root lint 0
  errors, all three tripwires green (`check-ledger-adjacency` floor 13 → **19**, re-read by
  hand against the six new `recordLedger` sites; `check-read-chargeable`;
  `check-schema-drift` all seven checks — no migration, no schema change). The dust script
  dry-runs clean against dev. **Fifteen mutations run.** Fourteen turned a suite red. The
  fifteenth — deleting `allocated_pence IS NOT NULL` from the divergence candidate SQL —
  left everything green, because the fixture's sibling `allocation_synced_at` guard
  excluded the row anyway: the test was passing for a reason it did not name. Fixed by
  posing the combination the guard exists for rather than by explaining it away. The
  neighbouring `allocation_synced_at` guard is genuinely redundant (measured the same way,
  survives its own mutation) and now says so in its comment instead of carrying a
  contrived fixture. The flag-off conformance battery needed the `payout_transfers`
  handling its writer and publication siblings already had — added answering from the fake
  table, not hard-coded, so it still pins §5.13's flag-off regression.

  **Found on the way, not fixed, recorded instead:** the carve and the slice cap interact
  and over-carve. The carve is apportioned across all units BEFORE packing; units past
  `payout_max_slices` are un-claimed and re-carved next cycle, while this cycle already
  collected their share — so the recipient is permanently short by the overlap. It is
  **pre-existing in the shipped writer cycle**; the tribute cycle reproduces its shape
  deliberately rather than diverging from it. Inert on two counts (needs tributes live AND
  an overflow) and the fix is not local, since carve → nets → packing → overflow is a
  fixpoint. Queued onto §5 step 0, whose slice-distribution measurement decides how
  reachable it is. → CONSOLIDATED-TODO §1.13(b); ADR §10.3.

- **2026-07-29 (funds segregation, part 2 — the publication cycle, the refund hooks, and a
  zombie that could never die)** — the publication payout cycle under segregation, the
  `charge.refunded` allocation hooks on both arms, and the `finalisePublicationPayout`
  fix. Still dark behind `STRIPE_ALLOCATED_FUNDS`. Spec:
  `docs/adr/FUNDS-SEGREGATION-INTEGRATION.md` §10.1a (as-built) and §10.3 (what remains:
  the TRIBUTE cycle, the §3.6 reconcile sweep, the §3.3d residual metric, and §5 step 0,
  which is now the largest flip blocker). → CONSOLIDATED-TODO §1.13.

  **The refund hook is the flip blocker, and its partial arm was the whole of it.** A
  refund takes money out of a charge's segregated balance. Before this, our drawing budget
  never learned: Stripe's number fell and ours did not, so the packer kept offering a
  remainder the charge could no longer fund and the next payout built a slice Stripe would
  reject. The FULL arm degraded gently by accident — `reverseSettlement` moves the reads to
  `charged_back`, so they leave the pool anyway — but the PARTIAL arm did nothing beyond a
  WARN, leaving reads `platform_settled` and payable against a drained charge. One
  `allocated_draws` row per settlement now holds the CUMULATIVE refunded total, upserted
  with **GREATEST rather than assignment**, because Stripe reports `amount_refunded`
  cumulatively *and* webhook delivery is unordered — a late redelivery of the first partial
  must not shrink the budget back. Recorded before the reverse decision, since the two are
  independent facts and only one of them has a partial arm. A lost dispute deliberately
  records nothing (§3.5: disputed funds stay allocated; `syncAllocations` is the backstop).

  **The publication cycle's real problem was the fee, and rev 2 had it exactly inverted.**
  The pooled fee is withheld when the pool is computed, so claiming an application fee on
  top looks like taking it twice. Right premise, wrong conclusion: under allocation the
  FULL charge is locked, so a fee never claimed as an `application_fee_amount` never leaves
  allocated state at all. Not twice — ZERO times, with roughly a tenth of all publication
  revenue accumulating as locked funds every cycle. `prorateWithheldFee` now routes it out,
  FLOORED so the proration under-claims and the remainder is dust: over-claiming would
  over-draw the charge and Stripe would reject the transfer, so the two error directions
  are not symmetric. No recipient's net changes and `computePublicationSplits` is untouched.

  Attribution needed no invention. A split is a bps share of a pool spanning many charges,
  so it has no natural funding charge — resolved at the funding layer instead: one unit per
  split, with the pool's contributing settlements as a **preference SET**, which the packer
  already accepted. `advanceUnits`/`releaseUnits` are no-ops by design (a split owns no
  claim rows; a failed split keeps its claim for manual re-pay, §1.2).

  **The zombie.** `finalisePublicationPayout` completed its parent only when
  `NOT EXISTS (split WHERE status <> 'completed')`, while the resume sweep retries only
  `pending` splits. So one terminally-failed split froze the parent at `pending` forever:
  every cycle the sweep picked it up, found nothing to retry, finalised, failed the same
  test, and left the row exactly as it was — a state nothing in the system could resolve.
  The rule is now "no split PENDING" ('failed' is *done*, and visible on its own row),
  living in one exported constant used by all three call sites.

  **Seven mutations, all detected — and two of them found real weaknesses in the tests
  first.** New `segregation-assembly-integration.test.ts`: 14 DB-backed tests (real
  Postgres, always-rollback, `skipIf(!DB_URL)` so CI stays green) closing §10.3's stated
  gap, the flag-ON reserve→pack→children→complete assembly, which had no coverage at all.
  DB-backed because that half is almost entirely SQL — `GREATEST(0, allocated_pence − Σ
  draws)`, a UNIQUE-backed upsert, `count(*) FILTER` tallies — none of which a mocked
  `pool.query` can evaluate. Mutations run: the zombie predicate restored;
  `prorateWithheldFee` back to `0`; the refund GREATEST dropped; `completeParentIfSettled`
  blocking on a failed child; `failChild` not releasing its draw; the draw recording net
  instead of gross. **Two lessons the mutations taught, not the reading:** the first
  version of the zombie test ran a COPY of the SQL and so could not have detected a
  regression in `payout.ts` at all (both statements are now exported and executed by the
  test); and the publication conformance mock RESTATED the completion rule in JS, staying
  green against the pre-fix predicate — it now parses the operator and status literal out
  of the SQL it is handed, per the repo's own mock rule, and catches the mutation too.

  Verification: `tsc` clean, root lint 0 errors, both tripwires green
  (`check-ledger-adjacency.sh` — its `payout.ts` registry floor re-read BY HAND to 13
  against the two new call sites — and `check-read-chargeable.sh`), 224/224 tests with a
  DB, 199 passed + 25 skipped without. Not runtime-verified against Stripe: everything here
  is dark, and the sandbox probes (§5 step 0) still have not been run.

- **2026-07-29 (funds segregation, part 1 — the payout stops being one transfer)** —
  migration 165 plus the packer, the shared child lifecycle and the writer cycle, all
  dark behind `STRIPE_ALLOCATED_FUNDS` (default off). Spec:
  `docs/adr/FUNDS-SEGREGATION-INTEGRATION.md`; **its §10 is the as-built record and is
  where the code and the spec diverge.** This is a PART, not the item: the publication and
  tribute cycles, the `charge.refunded` allocation hooks, the reconcile sweep and the
  residual metric are not built. → CONSOLIDATED-TODO §1.13.

  Under the Stripe beta a charge's funds are locked into an allocated state that can only
  reach connected accounts, and they move only via a transfer naming the funding charge.
  One aggregate transfer per writer cannot express that, so the payout unit becomes
  (payout × funding charge). The structural commitment, which is what makes this safe to
  merge: **attribution does not change at all.** The claim SQL, the per-read-then-floor
  net, the subscription leg, the collection gate, the `publication_id IS NULL` exclusion —
  byte-identical, so no money question is reopened and all four conformance batteries pass
  untouched. Only *funding* is new.

  - **Migration 165** — `payout_transfers` (the per-child transfer row, polymorphic parent
    so one lifecycle serves all three cycles), `allocated_draws` (a drawing budget, NOT a
    ledger — it mirrors no entry and posts no movement), `tab_settlements.allocated_pence`
    (read BACK from Stripe, never assumed; NULL = "not known to be drawable"),
    `subscription_events.tab_settlement_id`, and `payout_transfer_id` on the three claim
    tables — the unit→child mapping without which per-child failure is unimplementable.
  - **`allocation-packer.ts`** — pure and mutation-verified. First-fit-decreasing over a
    POOL of charges rather than a per-settlement pairing, because `Σ(read net attributed to
    S) > charge(S)` is routine, not exotic (the reserve clamp; any pre-paid credit). No unit
    is ever split, so the design introduces no rounding anywhere. The tribute carve is
    apportioned with overflow carry and two assertions rather than floored per read — a
    floor would make `Σ units > lockedAmount`, ratifying an overpay in both Stripe and the
    ledger.
  - **`payout-children.ts`** — per-child execute with the row-stable `xfer-<childRowId>`
    key, the terminal/ambiguous split preserved per child, and **the ledger posted per child
    inside its own flip transaction**, gated on the flip's `rowCount`. Posting once at parent
    completion for the parent's full amount was the tempting shape and is wrong: it opens a
    window where money has moved and the ledger is silent. Refs stay on the PARENT row so
    `ledger_publication_distribution`'s filter keeps matching and the entries stay inside
    reconcile-ledger's `ledger_orphans` default-deny catch-all.
  - **§3.5 re-keying** — `confirmPayout` / `reverseWriterPayout` / `handleFailedPayout`
    resolve a child by `payout_transfers.stripe_transfer_id` first, falling back to the
    legacy parent lookup for pre-flip payouts. Without this a `transfer.reversed` for any
    child but one resolves to nothing and is dropped **silently**, which is the whole
    argument. Seven new tests cover it (§5 step 7b's unit-level twin).
  - **Two deliberate departures from the spec**, both recorded in §10.2: a
    `payout_transfers.reversed_pence` column (per-child cumulative reversal state — the
    ledger cannot carry it once N children share one parent ref), and failing a parent
    outright when every child failed rather than leaving it `pending`, which would recreate
    the `finalisePublicationPayout` zombie the spec itself calls out.
  - **Found while wiring the tripwire:** `check-ledger-adjacency.sh`'s `payout.ts` registry
    floor was **4 against 9 actual call sites**, so it would have passed had this change
    deleted four of them. Now 11, re-read by hand. Registering `payout-children.ts` at a
    legitimate floor of 0 also exposed a latent bash bug — `grep -c || echo 0` emits "0\n0"
    into an arithmetic test — fixed here. `INSERT INTO payout_transfers` added to
    `PAYOUT_MARKER`.

  **Not shippable to prod as a flag flip.** Beyond the unbuilt cycles: the
  `charge.refunded` allocation hooks are missing, so a partial refund would wedge the
  packer; `allocated_residual_alert_bps` and `payout_max_slices` are placeholders because
  §5 step 0 was not run first, contrary to the queue item's own instruction; and the
  flag-ON assembly has no automated coverage (the packer and the reversal path do).

- **2026-07-29 (the free allowance is a gift, and we stopped billing it back)** —
  migration 164 + a 30-site sweep of the read money path. **P0: readers were
  being charged for reads we had given them.**

  Found while evaluating `docs/adr/FUNDS-SEGREGATION-INTEGRATION.md`, whose rev 1
  asserted as a core invariant that allowance-covered pence "are never charged to
  anyone, never accrue to any writer" — and instructed that the claim be copied
  into `HOW-MONEY-MOVES.md` and a comment at `classifyRead` so future audits would
  "stop re-deriving a gap that doesn't exist". The gap existed.
  `convertProvisionalReads` flipped every provisional read to `accrued` at the
  full `amount_pence` and debited the tab for all of it, so a reader who read on
  the house and later attached a card was billed retroactively for the gift, and
  the writer accrued on pence nobody had paid. Silent since the function was
  written. F14 (2026-07-06) had already recorded the exact split a write-off
  needed (`allowance_consumed_pence`, its own comment anticipating "a future
  settlement write-off") and nothing ever consumed it.

  Ruling (product): the aspiration was right and the code was wrong — a card does
  not revoke a gift. Both legs move together, and they have to: charging the
  reader less while still paying the writer would have created a fresh
  platform-subsidised path rather than closing one.

  - **Migration 164** — `read_events.chargeable_pence`, `GENERATED ALWAYS AS
    (amount_pence − allowance_consumed_pence) STORED`. `amount_pence` keeps
    meaning the list price, so no column changes meaning by row state. Backfills
    the pre-F14 legacy shape (`on_free_allowance` TRUE with a 0 split — the old
    coarse boolean), scoped to `provisional` rows only. Ends with a DO-block
    assertion that no already-charged row carries a gift, so the sweep cannot
    restate settled money; it is that property which made a 30-site change to the
    payout core safe to ship in one go.
  - **The sweep** — 30 references across `payout.ts`, `settlement.ts`,
    `accrual.ts`, `publications/revenue.ts`, `my-account.ts`, each verified
    against its `FROM read_events`. `chargeback.ts`'s `ReversalRead.amountPence`
    renamed to `chargeablePence` so that path regresses as a compile error rather
    than a silent `NaN`; `per-read-net.ts` now documents which of the two amounts
    it takes.
  - **Enforcement** — `scripts/check-read-chargeable.sh` (CI `backend` job),
    mutation-verified in both directions. CLAUDE.md carries the invariant.
  - **Tests** — `payment-service/tests/free-allowance-gift-integration.test.ts`,
    DB-backed and rolled back, running the REAL exported statement. It is
    DB-backed *because* a mocked `pool.query` cannot evaluate a generated column
    — the §"mock must answer from the SQL" standard's third clause, stated out
    loud in the file header. Each assertion is paired with a list-price control
    showing what the old path billed. Mutation-checked: reverting the fix fails 2
    of 5.
  - Verified: 182/182 payment-service (DB), 0 lint errors, all 7 schema-drift
    checks, ledger adjacency, and `getWriterEarnings` executed against the dev DB.
    Dev held £36.25 of gifted reading that would have been billed on card-connect.

  **Open — not done here.** (a) Readers already billed before 164 are NOT
  refunded; restating them would break reader parity and `ledger_writer_earned`,
  so it is a business decision, not a migration. Population:
  `SELECT count(*), sum(allowance_consumed_pence) FROM read_events WHERE state <>
  'provisional' AND allowance_consumed_pence <> 0` (0 on dev; run on prod).
  (b) Four `gateway/tests/waitlist-digest.test.ts` failures are pre-existing —
  confirmed by stashing this change — and untouched. *(Corrected 2026-07-30:
  "pre-existing" was true relative to this change but was not a diagnosis — the
  four were CLOCK-ROT, cold-start tests whose fixtures fell out of the worker's
  `now − 24h` first window a day after they were written, leaving master's
  suite permanently red and a third of the digest's mutation net dead. Fixed
  with the cold-start window itself — see the 2026-07-30 entry.)*

- **2026-07-29 (the beta is closed, and the register has been looked at)** —
  no code. Two of the three largest items in CONSOLIDATED-TODO §11 discharged
  by deploying and then *looking*, which is the only tier of evidence either
  of them ever wanted.

  **The closed-beta ship is live on prod** — migrations 162 + 163 applied,
  gateway + web rebuilt. `CLOSED_BETA` is a code constant rather than an env
  flag, so the deploy itself is the act: account creation is now reserved to
  the admit route, and the waiting list is the only door. Built 2026-07-24,
  live five days later. *(Timing corrected 2026-07-30 from prod's
  `_migrations.applied_at`: the migrations did NOT ride this deploy — 162 was
  applied 2026-07-24 11:39 UTC and 163 on 2026-07-27 19:12 UTC, days before
  the 07-29 image rebuild that actually closed the beta. "Live five days
  later" is right about the code, not the schema.)*

  **The logged-out register was swept on `all.haus` in both modes at both
  form factors**, and read correctly as built — no changes required. That
  settles the two §VIII judgement calls **in favour of the shipped
  arithmetic**, which is worth stating plainly because the fallbacks were
  written down and are now not needed: islanded bone at 4px does not read hot
  on an ink-900 card (so `cardStandfirst`, which would have lightened light
  mode to fix dark, stays unused), and the row's band distinguishes itself
  from the fitted floor at six points rather than wanting to track it. Also
  confirmed: the dark mouth on a fitted vessel, no ⊔ surviving at ≤767px (no
  inline border beating the media query), vessels exactly as tall as their
  content on desktop (no `flex: 1 1 0` left in the chain), the waitlist
  panel's unbounded email column, and all three landing demos — including
  `CanvasDemo`'s four seasonal walls still reading as four distinct feeds at
  an 8.5px base, by some way the smallest surface that claim has been made at.

  **What this pass does NOT cover, recorded so it is not read as covering
  it:** the `trustProxy: 1` real-client-IP check (§0m.6) is a log-tier check,
  not an eyeball one — the waitlist rows still need confirming to carry real
  client IPs and not nginx's; and of §11(d), only `/admin/waitlist` was
  rendered, so the row's band clearance over `/write` (whose sticky bar lost
  its `top-[53px]` offset) and `/traffology/*` remains untested visually.
  Two eyeball calls and one query, not a session.

- **2026-07-27 (waitlist: the operator can admit)** — CLOSED-BETA-ADR §XI.3
  item 3, the last of the three the incident produced. Spec + as-built: §XI.6.
  §3.7's minimum for running a beta at all: before this, converting a
  waitlister to a member meant hand-written SQL on the box.

  **Migration 163** — `admitted_at` (the double-admit guard),
  `admitted_account_id` (`ON DELETE SET NULL`), `invited_at`. Three columns
  because they are three facts, and the last two can fail apart.

  **`POST /admin/dashboard/waitlist/admit`** claims the row in one statement,
  find-or-creates the account, then claims and sends the invitation. Account
  creation moved to `gateway/src/lib/account-provision.ts::provisionAccount` —
  an EXTRACTION of `google-auth.ts`'s private `createGoogleAccount`, which now
  imports it, so the two paths cannot drift. It deliberately bypasses
  `CLOSED_BETA` (that constant reserves account creation to a human decision;
  this is that decision) and deliberately is not `signup()`, which sets a
  session cookie on the reply — from the admit route that would log the
  operator into the prospect's account, once per admission.

  **The second claim was found by mutation, not by design.** The admission
  claim leaves a window in which a second click reads the row as "admitted,
  never told" and sends a duplicate email; the invitation is now claimed the
  same way and released if the send throws. Every failure path leaves a
  retryable row: provisioning throws → the admission claim is released
  (guarded on `admitted_account_id IS NULL`); the mail throws → the admission
  STANDS (D7) and the row rests at "admitted, not yet told", which the panel
  shows and offers the retry on.

  The invitation carries **no login token** (a 15-minute magic link read hours
  later is dead on arrival, and its likeliest observable is a prospect
  concluding the invitation was a mistake) and goes on the **transactional**
  stream, not broadcast — one message per operator click to a named person who
  asked. Panel: Status column, a per-row Admit / Send invite behind a
  `window.confirm`, two new tiles.

  A row stamped with no account behind it is refused (409
  `admit_in_progress`), not invited — that state is either a click mid-flight
  or a failed release, never a resend, and inviting would point someone at a
  login page for an account we cannot confirm.

  22 tests; 10 mutations each kill at least one, and **two of them found real
  defects in this work**: the double-click test passed against a route with no
  claim guard at all (the event loop ran the requests in sequence, so the claim
  was never exercised — both reads are now held open until both arrive), and
  the mock was handing out live row objects, letting one request see another's
  writes through shared identity. The one survivor — a `COUNT(*) FILTER`
  replaced by a literal — is underivable from SQL by any mock, so it gets a
  structural pin that says so.

  Driven on dev through the real middleware on a rebuilt gateway: fresh admit
  (real keypair, reading tab, 500p allowance, invitation sent), repeat → 409,
  existing member → linked not duplicated, unknown → 404, malformed → 400,
  mixed-case padded input → matched. Drift guard green (7/7), `next build`
  clean, hairline tripwire clean. **Still not seen in a browser** — no browser
  tooling this session, same residual the read half carries.

- **2026-07-27 (waitlist: the operator can see the list)** — CLOSED-BETA-ADR
  §XI.3 item 2, straight after the digest below. Spec + as-built: §XI.5.

  `GET /admin/dashboard/waitlist` behind `requireAdmin`, plus
  `web/src/app/admin/waitlist/page.tsx`; `AdminShell`'s tabs go six → seven.
  Four counts — total, joined in 7 days, publish-interest, and **when the
  operator was last told** (the digest's own key, "Never" in crimson while the
  list is non-empty) — then every entry newest-first with an absolute joined
  stamp. The last-digest tile isn't in §XI.2's spec; it earns its place because
  this whole section exists from an incident about not being told.

  **Three deliberate restraints**, each with a test that fails if it is
  relaxed: no actions (Admit needs `admitted_at` to be safe against a
  double-admit, so it waits for its own item, and the page says so rather than
  showing a control that half-works); no filtering of disposable-mail domains
  (the address is on screen for a person to read — a route that quietly dropped
  rows would hide someone who IS waiting); and the 500 cap carries a
  `truncated` flag, because a bare LIMIT reads as "that's everyone" exactly
  when it isn't.

  **The mutation pass caught the mock, again.** Flipping the route's `ORDER BY`
  to ASC passed all six tests, because the mock sorted in JS regardless of the
  SQL it was handed — the same blind spot that let the digest's microsecond bug
  through yesterday. Fixed in the mock (it now reads the `ORDER BY` out of the
  query) rather than by adding a structural assertion, so the ordering test is
  real. Four other mutations — dropping `requireAdmin`, hard-coding
  `truncated: false`, filtering a domain, nulling the last-digest read — were
  caught first time.

  Pre-flight: 417 gateway tests (was 411), `tsc` clean on gateway + web,
  `next build` green (`/admin/waitlist` prerenders at 1.5 kB), root eslint 0
  errors, hairline check clean. **Driven against the dev database through the
  real middleware**: no session → 401, a genuinely signed admin cookie → 200,
  rows newest-first, and the 7-day count correctly excluding a 9-day-old row;
  dev left clean. **Not seen in a browser** — rendered appearance in either
  mode is unverified, tracked in §11.

- **2026-07-27 (waitlist: the operator hears about it)** — CLOSED-BETA-ADR §XI
  D8.2, the first of the four items §XI.3 orders. Spec + as-built: §XI.4.

  **The failure it closes.** `POST /waitlist` stores a prospect and sends
  nothing (D2, by design) and nothing reads the table, so a real prospect sat
  unseen on prod for eight hours and was found only because the operator went
  looking for a confirmation email that was never going to arrive. The mailer
  was fine (`EMAIL_PROVIDER=postmark`), the capture was fine; the gap was that
  no one was told.

  **What shipped.** `gateway/src/workers/waitlist-digest.ts` on the hourly
  worker tick under a new advisory lock (100008), recipients from
  `getAdminIds()` → those accounts' email, cadence dial
  `waitlist_digest_interval_hours` in `config-defaults.sql` (a dial, not a
  constant: a launch week may want hourly, and that should be an UPDATE).
  Neither state key moves unless a send succeeded, so Postmark having a bad
  minute retries the same rows instead of dropping a day of joins (D7).

  **Two bugs, both found by driving it against a real database, neither visible
  to the unit tests that were passing at the time.**

    · **One key doing two jobs.** The window ("what have I reported") and the
      cadence ("am I due") were the same value. The watermark holds a ROW's
      timestamp, so a digest sent at 10:00 whose newest row was from 02:00
      reads as due again at 02:00 the next day — fourteen hours early. Split
      into `waitlist_digest_watermark` and `waitlist_digest_last_sent_at`. The
      tests missed it because they set both in lockstep.
    · **Microseconds.** Postgres keeps µs; a JS `Date` keeps ms. A watermark
      round-tripped through `toISOString()` lands up to 999µs BEFORE the row it
      came from, so that row qualifies again next run and every digest
      re-reports its own newest joiner, for ever. Now carried as Postgres's own
      text (`created_at::text` out, `$1::timestamptz` back). The tests could not
      have caught this: a mocked Date has no microseconds to lose.

  The second is the sharper lesson and it is the same one as 2026-07-17: **a
  green suite written against a mock proves the mock.** The suite is now 14
  cases and mutation-checked (8 mutations, each caught); the `::timestamptz`
  cast is pinned structurally only, and the test says so out loud, because that
  is exactly the class the mock cannot see.

  Pre-flight: 411 gateway tests pass (was 397), `tsc` clean on gateway +
  shared, root eslint 0 errors, `check-schema-drift.sh` green (Check 4b now
  counts 67 dials — the new one self-heals onto an existing DB, verified by
  running migrate on dev: "seeded 1 missing dial(s)"). Dev driven through five
  scenarios and left clean. **Not driven on prod** — the three real rows there
  will produce one digest on the next deploy, and that email is the check.

- **2026-07-27 (waiting list: one promise reworded, one question withdrawn)** —
  Two copy/scope changes on the join surface, the second larger than it looks.
  Spec: `CLOSED-BETA-ADR.md` D3 (reversed) + §V copy block.

  **"When there's room" → "when we're ready for you."** Room is a capacity
  statement and it is the wrong one: it says the constraint is our shelf space,
  when what a person on a list wants to know is when we will be in a state to
  look after them. Changed on `/waitlist` (both subheads and the joined
  confirmation), in the route's acknowledgement, in the admin admit dialog —
  and in the **invitation email**, which is the sentence that keeps the promise
  ("You asked to be told when we were ready for you. We are."). A promise and
  its fulfilment reading differently is how a real message starts to sound like
  a template, so those two move together or not at all.

  **The "I'd also like to publish" tickbox is gone, and so is everything that
  reported it.** D3 kept it in 2026-07-24 on the grounds that "the
  cohort-recruitment signal is worth the one boolean" — which values the signal
  without asking what it would ever change. Nothing: the answer implies nothing
  about what anyone should be given, admission is one operator reading one
  screen, and there is no larger interest here looking for hints about revenue.
  What it does do is turn joining a waiting list into answering a question, put
  to people who have been given nothing yet. Removed from the page, from
  `waitlist.join`'s payload, and from the `POST /waitlist` schema — **and from
  the two places that reported it**, the digest email's breakdown and the admin
  panel's tile and column, because removing the question while still counting
  the answers would be the same instinct wearing a different hat.

  **The column is NOT dropped.** `waitlist.publish_interest` keeps its data and
  its `false` default: the `true`s in it are answers people actually gave, and
  ceasing to ask is not the same as deleting what was said. Nothing reads it —
  no migration, no `schema.sql` regen, and the route simply stops writing it.
  The schema is deliberately not `.strict()`, so a cached client still POSTing
  the old field is accepted and the field ignored.

  Tests: the three suites that pinned the field now pin its ABSENCE — the insert
  binds one param, the digest body must not match `/publish/i` and must issue no
  query mentioning the column, and the admin route must not aggregate it.
  **Mutation-checked**, per the standing rule: reinstating the flag in the
  insert, in the digest copy, and in the route's count each fails exactly one
  test, which is what makes the absence a pin rather than a green suite that
  would never have noticed.

  Pre-flight: 433 gateway tests pass (unchanged count), `tsc` clean on gateway,
  shared and web, root eslint 0 errors, `next build` green.

- **2026-07-27 (public register: no vessel on a phone, and none taller than what
  it holds)** — Two chassis changes from one instinct: a container should be
  doing a container's job or not be there. Spec: `LOGGED-OUT-REGISTER-ADR.md`
  §IX departure 7quinquies (amending §V and 7bis).

  **Mobile drops the ⊔ on every logged-out page.** 7bis took `/` from 56px a
  side to 16 and kept one wall, on the reasoning that "the ⊔ still reads, at
  mobile weight". It does read; what that dodged is what the ⊔ is FOR — it says
  *this is one object among several*, which is true of a feed on a workspace
  floor and false of the only column on a phone, where it is ink spent framing
  the one thing already filling the screen. The mobile workspace reached that
  conclusion first and dropped its vessel chassis outright, so the register now
  matches it instead of sitting a notch softer. At ≤767px `/`'s inner frame
  keeps its 8px pad and draws no wall (374px of a 390px phone, up from 358), and
  `PublicVessel` loses all three — `/auth`, `/waitlist`, `/about`, `/invite`,
  `/subscribe`, `/tribute/claim`, `/auth/verify`, the Google callback, 404 and
  the error page. `PublicPage` (the share/SEO surfaces) never had a vessel.

  The wall widths had to leave the component for this, exactly as 7bis moved
  `/`'s: `.ah-public-vessel` in `globals.css` §1a-bis, colour crossing in as
  `--ah-public-wall`. These pages are SSR'd, so a `useIsMobile` branch would
  paint the walled chassis on a phone and snap after hydration — and an inline
  border shorthand would beat the media query outright, which is the trap that
  makes this a CSS change rather than a component one.

  **Desktop: the vessel hugs its content, centred on both axes.** §V's fitted
  amendment had it take the shell's whole height, so `/auth`'s four fields sat
  in a ⊔ as tall as the screen — a frame around a great deal of nothing, worse
  the taller the monitor. Every link of the chain (shell measure column → frame
  → scroll body) is now `flex: 0 1 auto`, and `.ah-public-fit` gained
  `justify-content: center` beside the `align-items: center` it always had. The
  paddings make that centring true to the viewport rather than just to the box:
  top `min(64px, 8vh)`, bottom band `NAV_ROW_H + GRID` = 64.

  **It is not a revert of §V, and the distinction is the design.** §V bounds the
  vessel at the viewport (bottom wall on screen or it isn't a vessel); this
  bounds it at its content. Both are live at once — `flex-shrink: 1` and
  `minHeight: 0` survive on every link, so a page with more content than room
  still shrinks to the remainder and scrolls inside its walls exactly as before.
  Only the stretching of a short page went. `/` is unaffected on desktop: its
  content is always longer than the viewport, so the hug is a no-op there.

  Pre-flight: `tsc --noEmit` clean, root eslint 0 errors, `next build` green (41
  pages), emitted CSS checked for both rules and their cascade order (base then
  mobile override, equal specificity so source order decides). **Not in a
  browser** — the phone reading is the point of the change and is exactly what
  is unverified.

- **2026-07-27 (landing: the demos become a canvas and a reading pane)** — A
  second bundle the same day, revising the one below. Reviewed, corrected in
  four places, applied. Spec: `LOGGED-OUT-REGISTER-ADR.md` §IX departure 7quater.

  **Three equal columns were the weakest reading of the claim.** `WorkspaceDemo`
  showed three feeds of equal width, height and spacing, which says "this app has
  columns" — a thing every app has had since 2004. What the workspace does is let
  a feed be any SIZE, in any POSITION, at either ORIENTATION, and no figure in the
  set had ever shown it. `CanvasDemo` replaces it with four irregular feeds: one
  wide and tall down the left, two narrow stacked in the right-hand column, one
  horizontal along the bottom whose cards run off its own right edge under a
  gradient to the vessel interior (a horizontal feed shown statically has to be
  clipped to read as scrollable — a row that ends tidily reads as a row that has
  ended). Four colourways rather than three, so the per-feed wall reads as a
  system. Caption rewritten to match: "Feeds are objects on a canvas — size them,
  stack them, turn them sideways."

  **It scales instead of reflowing, and that is the mobile fix.** The old version
  dropped to two columns under a viewport media query and got knocked about: it
  was sized against a guess at the viewport rather than the width it was handed,
  so an upstream padding change threw it out. And reflowing was wrong in
  principle — the arrangement IS the argument, so a mobile version that tidies
  the feeds into a regular stack demonstrates the opposite. The wrapper is now a
  container (`container-type: inline-size`), the base size
  `clamp(8.5px, 1.95cqw, 12px)`, everything inside `em`. Below 430px of
  *container* width the card bodies and provenance tags hide, leaving bylines and
  titles — shed detail, don't shrink. **This is a deliberate departure from §1c's
  media-query rule and is safe for §1c's own reason**: a container query is still
  CSS, resolving at paint on server-rendered markup, so it keeps the SSR safety
  while measuring the right box rather than a guess at it.

  **The bare gate became the whole Glasshouse figure.** Shown on plain card
  ground, `GateDemo` read as text that had gone wrong — a paragraph trailing into
  a fade, a price, two buttons, floating on nothing. A paywall is legible as a
  paywall because of the SITUATION it appears in, and the situation was missing.
  `ReaderDemo` supplies it: a blurred, desaturated four-feed floor, a scrim at
  `.gh-scrim`'s wash, and the lifted pane with grip and ✕. The blur is a `filter`
  on the floor, NOT `backdrop-filter` on the scrim — the real scrim needs it
  because it sits over a live workspace it cannot know the contents of; this
  floor is inert markup that exists only to be blurred, so blurring it directly
  renders identically, costs less, and dodges the backdrop-filter containment
  bugs that bite inside clipped ancestors. The 52px inset is gone: a lifted pane
  over a blurred field cannot be mistaken for the page's own prose, so the inset
  was no longer doing separate work. Registers are now omnivore 14.5px fixed /
  reader 12px / canvas fluid.

  **`DemoVessel` gains two geometry modes**, because inline styles beat
  `@layer components`: pass `wall` and it draws its ⊔ inline (the fixed-size
  omnivore figure), omit it and it only publishes `--ah-demo-wall` and leaves
  border/padding/gap to §1d (the two demos that scale in `em`). An inline zeroed
  border would silently win and flatten the ⊔, hence "declare no borders at all"
  rather than "declare 0".

  **Four corrections to the bundle.** (1) **It reverted both corrections to the
  bundle below** — the demo content again named Naomi Kanakia, Scott Alexander,
  the Guardian, Reuters, the Baffler, Astral Codex Ten, and the same real-account
  Ukrainian drone post, and it deleted the comment blocks recording why the names
  were invented. Rewritten onto the existing invented world (Tobias Wren, Ines
  Bergqvist, Marguerite Oyelaran, Ellis Marchetti, Halloran, Aurelio Frame,
  Rosalind Vane; The Meridian, Fenwick Wire, The Ravelin, The Slow Hour,
  Northgate Transit, plus one new publication, *The Whip Room*), with the note
  rehomed to `CanvasDemo` and its references repointed. (2) **The 1px divider was
  back**, `height: 1` again, this time in `ReaderDemo` — caught by the pattern the
  previous entry added to `check-hairlines.sh`, which is the first time that
  pattern has earned its place. Whitespace again, not a thicker rule. (3) and (4)
  are both consequences of the new `wall`-optional mode, which silently drops the
  ⊔ from any vessel that neither passes `wall` nor has a CSS rule: `OmnivoreDemo`
  still called `<DemoVessel palette={palette}>` and would have rendered wall-less
  (now explicit `wall={8}`, the mode the bundle's own notes say it wants), and
  `.ah-demo-reader-floor > *` set padding and gap but no border — so the reader's
  floor would have been four borderless interiors, losing the four wall colours
  that are the entire reason the floor is there.

  Incidental: the duplicate `../../workspace/tokens` import is back in both new
  files (a hard `no-duplicate-imports` error under the root config), merged
  again; a stale `WorkspaceDemo` reference in `LandingVessel`'s dark-flag note
  repointed.

  Pre-flight: `check-hairlines.sh` clean on all touched files, `tsc --noEmit`
  clean, root eslint 0 errors, `next build` green (41 pages prerendered). **Not
  in a browser** — and this bundle adds container queries, the one genuinely new
  platform feature in the set, plus eight seasonal palettes resolving inside
  `LIGHT_ISLAND_STYLE` (ADR §IX still-open 7).

- **2026-07-27 (landing: the screengrabs become live markup)** — Arrived as a
  patch bundle; reviewed, corrected in two places, applied. Undoes the showcase
  half of yesterday's entry below. Spec: `LOGGED-OUT-REGISTER-ADR.md` §IX
  departure 7ter.

  **Why the captures had to go, and it was not file size.** Each was a full
  1848×1056 viewport shown ~640px wide inside a card at the prose measure — a
  2.9× reduction, which put the app's 15px body type at about 5px. The four
  `via …` provenance lines ARE the omnivore argument and they were the first
  thing to dissolve, leaving the captions to carry the whole claim: a decorative
  image where evidence was intended. Yesterday's "the frame was cut to the
  shots" reads well and was the trap — it locked all three figures to 16:9
  landscape, the worst shape for interface detail in a narrow column. And
  screenshots rot silently, with nothing in CI to notice.

  **Rebuilt as inert components.** `components/landing/demos/` (`primitives` +
  `WorkspaceDemo`/`OmnivoreDemo`/`GateDemo`) and `LandingFigure`; deleted
  `web/public/landing/*.webp` (331 kB), `Shot`, `SHOT_RATIO`, `LandingShot`, its
  `failed`/disc-placeholder fallback, and `next/image` on `/`. The demos read
  the same palette tokens as the live site, so they invert with the global
  toggle and cannot drift from a retune. Deliberately a COPY of the card grammar
  rather than a reuse of `PostCard` — that takes a `Post`, resolves a level spec
  and threads eight callbacks, none of it meaningful to a logged-out visitor.
  Sized as a set and unequally (omnivore 14.5 / gate 13 + a 52px inset /
  workspace 12), one `fontSize` knob each with everything inside in `em`; the
  knobs live in `globals.css` §1d, not the components, for §1c's SSR reason —
  mobile steps to 13.5/12/11, drops the gate's inset and the workspace's third
  column.

  **Two corrections to the bundle.** (1) `GateDemo` drew a divider as
  `height: 1` — a real 1px rule, which the house never renders. Removed rather
  than thickened; the surrounding margin already separated. `check-hairlines.sh`
  passed it clean, because every pattern greps the literal string `1px` and a
  bare `1` in a style object only picks up its unit at render — so the script
  gained a pattern for that form (`height|width|border*Width|outlineWidth: 1`),
  self-tested on a planted line, and finding **zero** other hits across
  `web/src`. (2) The demo content named real people and outlets — Guardian,
  Reuters, Scott Alexander, and a post about Ukrainian drone procurement
  attributed to a real account with a real-sounding quote tile. Real posts in a
  screenshot are defensible; retyped as markup on a page that sells something
  they are indistinguishable from words we put in someone's mouth. All bylines,
  publications, handles and bodies are now invented and share one world across
  the three demos; the protocol labels stay literally true, being the argument.
  A note saying so sits in `WorkspaceDemo`, `OmnivoreDemo` and `page.tsx`.

  Incidental: the bundle's duplicate `../../workspace/tokens` import (value +
  type on two lines) is a hard `no-duplicate-imports` error under the root
  config, merged to one inline-type import; its bare `ah-demo-ws-col` class,
  which no stylesheet defines, dropped.

  Pre-flight: `check-hairlines.sh` clean on all touched files (full-repo sweep
  otherwise unchanged — same 7/14/3 pre-existing), `tsc --noEmit` clean,
  `next build` green with `/` still prerendered static at 6.92 kB, root eslint
  0 errors, `knip` shows nothing landing-related. **Not in a browser** — dark
  mode and the 390px step-down are unverified by eye (ADR §IX still-open 7).

- **2026-07-26 (feed feel: the horizontal axis gets one owner, and the card gets
  a handle)** — Two reported feel bugs in the workspace, both with the same
  shape: an affordance that existed but had no way to be found, or had three
  meanings at once. Spec: `WORKSPACE-COLUMN-LAYOUT-ADR.md` §X (amended).

  **A horizontal feed now OWNS the sideways axis inside its walls.** Reported as
  "scrolling a horizontal feed is flukey, and scrolling right usually acts like
  the browser back button". It did: three consumers shared one gesture, and which
  one got it depended on scroll state the user cannot see — the feed scrolled to
  its mouth, then the gesture **scroll-chained** out to pan the floor, then, once
  the floor had also run out, the browser claimed it as a back/forward swipe. The
  fix is containment at the innermost consumer: the horizontal vessel's scroll
  body sets `overscroll-behavior-x: contain` (`Vessel.tsx`), so a swipe means
  exactly one thing — scroll the cards, and at the mouth, pull to refresh (which
  on a ⊐ vessel is a swipe RIGHT, the mouth being the left where newest arrives:
  precisely the gesture the browser was stealing). Pan the floor from the floor,
  the muster, or Ctrl+←/→.

  **The floor's own `contain` was not enough, and the reason is worth recording.**
  `Floor` has declared `overscroll-behavior-x: contain` since Slice 3, but
  browsers only honour it on an element that is **actually scrollable** — and a
  taut floor narrower than the viewport (two or three feeds on a wide screen: the
  common case) is not one, so the declaration was silently inert and the document
  got the gesture. `WorkspaceView`'s `Floor` now also pins
  `overscroll-behavior-x: none` on `<html>` for as long as the workspace is
  mounted, restoring the previous value on unmount so the rest of the site keeps
  its back-swipe. Nothing in the workspace scrolls the document sideways, so a
  horizontal document overscroll there can only ever be the nav gesture.

  **This SUPERSEDES the 2026-07-24 `floorCanConsume` guard** (below, MEDIUM (2)),
  which is deleted from `PullToRefresh.tsx`. That guard arbitrated the
  pull-vs-pan ambiguity by disarming the refresh while the floor still had room
  to pan — the right call while the chain existed, but containment removes the
  ambiguity at its source, and kept, the guard would now simply refuse to refresh
  whenever the floor happened to be panned (a state with no visible relationship
  to the feed you are pulling). The arm-after-idle rule is the whole guard now:
  come to rest at the mouth, scroll toward it again.

  **The card gets a declared grab handle — a regression from `82274a8`.** Reported
  as "very difficult to drag a card from one feed to another; the dropzone may be
  too small". The dropzone was in fact the whole vessel; the **grab** was the
  problem. Before `82274a8` (selectable card text, 13 Jul) the card pinned
  `draggable`; after it, drag arms only where `isDragSurface` says "bare chrome",
  which on a card is the 16px padding ring and the gaps between rows — correct,
  invisible, and unfindable. `isDragSurface` now takes an optional handle
  selector (a nominated region grabs even though it holds its own text; controls
  inside it still win, since the walk hits `NO_DRAG_SELECTOR` first), and the
  **byline row** is that handle, carrying `cursor: grab` — the only thing on the
  card that says so. It is the honest choice of handle: the gesture moves the
  SOURCE, and the byline is what names it. Scoped to `level="feed"`, so thread
  ancestors/replies (which share the host item's `dragData`) don't advertise a
  handle that would move the wrong source. The standard-density-only gate is
  dropped: it existed because a tightened card has no bare chrome left to grab,
  and a condensed/headline feed is exactly where source curation happens.

  **And the drop side stops lying.** `dataTransfer` is deliberately unreadable
  during `dragover`, so a vessel could not tell a card dragged out of itself from
  one dragged in — every vessel armed, including the origin, which is the
  feedback that makes real targets hard to pick out. New
  `web/src/lib/workspace/cardDrag.ts` publishes the origin feed for the gesture's
  lifetime (module-level: a drag is singular by construction, and its two ends
  live in different component trees) and owns the `CARD_DRAG_MIME` constant both
  ends were spelling by hand. The origin feed now stays unarmed (no
  `preventDefault`, so the cursor reads "no drop"); real targets ring in
  **crimson**, distinct from the merge-armed wall colour — which, drawn at
  `outline-offset: -4` over an 8px wall, was painting the wall its own colour on
  two of four sides and answering nothing.

  **Residual, deliberate:** panning the floor by scrolling *over* a horizontal
  feed is gone. If that proves a real loss, the fix is an explicit modifier
  (Shift+scroll chaining through), not reopening the implicit chain.

  Pre-flight: `check-hairlines.sh` clean on all touched files, `tsc --noEmit`
  clean, `next build` green, root eslint 0 errors, 77 workspace tests
  (`layout.test.ts` + `workspace.test.ts`) pass.

- **2026-07-26 (landing: real screengrabs, and the mobile vessel goes full-bleed)** —
  A small follow-on to the register sweep below, on `/` only. Spec:
  `LOGGED-OUT-REGISTER-ADR.md` §IX departure 7bis.

  **The screengrabs are real, and the frame now fits THEM.** The three showcase
  shots were replaced with current captures (light workspace / dark workspace
  carrying via-RSS + via-Bluesky + via-Nostr side by side / the £0.75 "Keep
  reading" gate). The previous set had been padded to fit a chosen 16:10 frame;
  all three new captures are a full 1848×1056 viewport, so the **frame was cut to
  the shots** instead — one `SHOT_RATIO` constant in `LandingVessel.tsx`, which
  makes the existing `objectFit: cover` a genuine no-op. Nothing is padded to fit
  the frame and nothing is cropped away by it. Alt text rewritten against what
  the shots actually show.

  **The mobile vessel is full-bleed, and the doubled wall is now desktop-only.**
  The desktop chassis spends 16 (floor) + 8 (wall) + 8 (buffer) + 8 (wall) + 16
  (pad) = 56px **a side** — 112px of a 390px phone, 29% of the screen, to argue
  about an 8px square, leaving the prose 278px. At ≤767px the floor margin, outer
  wall and buffer now all drop and the interior pad halves 16 → 8: 16px a side,
  and a 358px column. This is MOBILE-LAYOUT-ADR's own grammar (the mobile
  workspace drops the vessel chassis outright for a full-bleed feed) applied one
  notch softer, not a responsive reflow of the desktop reading — the ⊔ still
  reads at mobile weight; what goes is the doubled-wall *statement*, which needs
  room to be one.

  **The geometry had to leave the component.** It lives in `globals.css` §1c
  (`.ah-landing-area`, `.ah-landing-frame`/`-outer`/`-inner`) rather than behind
  a `useIsMobile` branch **because `/` is SSR'd**: `useIsMobile` returns false on
  the server, so a JS breakpoint paints the 56px desktop chassis on a phone and
  snaps to the mobile one after hydration. Only the palette-derived wall colour
  crosses into the component, as `--ah-landing-wall`; the outer frame stays in
  the tree on mobile as a plain flex pass-through (`padding: 0; border: 0`) so
  the component keeps one shape in both modes.

  **Verified in a browser, by measurement rather than eye** (the first time any
  register surface has been — ADR §IX still-open 1 said nothing had): 390×844 and
  1440×900 against the rebuilt container. Phone card x=16 w=358; desktop card
  x=400 w=640, i.e. **desktop is unchanged to the pixel**. `tsc` clean, root lint
  0 errors, `next build` compiles, hairline tripwire clean on both touched files.

  **Found and NOT fixed: `PublicNavRow` breaks below ~420px.** The CTA is 65px
  tall inside a 56px row, both labels wrap to two lines, and the CTA and lockup
  touch at x=243 with zero gap. It is global chrome on every public route, so the
  fix is register-wide and its shape is a design call — queued at
  CONSOLIDATED-TODO §0m.11 / ADR §IX still-open 6 rather than decided here.

- **2026-07-26 (the logged-out register — the black topbar is deleted)** — Eight
  commits (`34eb21b`…`335c363`) closing the whole logged-out sweep, tranches 1–3
  plus its dark-mode audit. Spec + as-built: `docs/adr/LOGGED-OUT-REGISTER-ADR.md`
  (§IX is the as-built record — read it before touching the register).

  **The finding.** `/`, `/about` and `/admin/*` had already left the 60px black
  topbar via a `chromelessRoute` allow-list; everything else logged-out still ran
  the retired marketing/auth register. So the site shipped two houses at once — a
  visitor landing on `/` met the bone floor and the ⊔ walls; a visitor following a
  shared article link, which is how most people arrive at a platform like this,
  met a black beam. An allow-list that grows every time a page is redesigned is a
  migration in progress, not a design.

  **What shipped.** `Nav.tsx` and `LandingNavRow.tsx` are deleted and nothing
  mounts a topbar: every route is chromeless, and the sole chrome off the
  workspace is one fixed bottom `PublicNavRow`, mounted once by `LayoutShell` for
  any non-workspace route with no pane overlay open. It serves **members too** —
  the retired `Nav` rendered a bare wordmark beam for them precisely because
  standalone routes sit outside the workspace, so the row's *left end* varies by
  auth (the two CTAs for a visitor, each page showing the one it is not; nothing
  but the lockup for a member, pointing at `/reader`) rather than its mounting.
  New chassis in `web/src/components/public/`: `palette.ts` (`usePublicPalette` +
  the register's constants + the derived `controlLine`/`scrollThumb`),
  `PublicVessel` (single-wall ⊔, fitted, scroll body), `PublicShell` (fitted),
  `PublicPage` (scrolling, for the share/SEO surfaces), `PublicNavRow`, and
  `Field.tsx`. Rewritten: `/auth`, `/waitlist`, `/auth/verify`,
  `/auth/google/callback`, `/about` (+ metadata, readers-first), `error.tsx`,
  `/invite/[token]`, `/subscribe/[code]`, `/tribute/claim`. New: `not-found.tsx`
  — there was none, so every 404 fell through to the Next.js default.
  Wrapper-only on the six share/SEO routes, deliberately: each delegates to a
  component *also* mounted in a workspace overlay, so restyling from there would
  silently redesign the member surface.

  **Three real bugs found on the way, all verified in source before fixing.**
  (1) **`.btn-accent` rendered crimson-on-near-black in dark, sitewide** — `color:
  var(--ah-white)`, and `white` is a `DARK_SLUG` that inverts to 30 29 26 while
  crimson (an accent) holds. 11 call sites across 8 files; `::selection` had it
  too. Fixed at source with a slug for the ROLE — `on-crimson`, outside
  `DARK_SLUGS`, because the ground it sits on never inverts either. (2)
  **`bg-grey-50` on `/read/[postId]` does not exist** — the theme defines `grey`
  at 100/200/300/400/600 only, so the page has never had a background and the
  white reading column has been floating on the browser default; the `shadow-sm`
  was compensating for it. (3) **`Footer.tsx` was orphaned** and pointed at
  `/community-guidelines`, `/privacy` and `/terms`, none of which exist as
  routes. Deleting it removes the dead links, not the requirement.

  **Corrections to the sweep as drafted**, each because applying it as-written
  would have been wrong: `/` keeps its own chassis (the drafted rewrite was cut
  against an 11:39 snapshot and would have reverted the screengrab showcase, the
  `'FOR ALL'` coda and the tightened copy); the row's band is padding INSIDE a
  full-viewport box rather than subtracted from the height (subtracted, the GRID
  of clearance fell through to `body` and drew a stripe of the wrong colour); the
  band is reserved from first paint with only the row waiting on auth (gating
  both meant a 64px reflow when `fetchMe` returned); `ground={false}` drops
  `PublicPage`'s `minHeight` too (`/article` otherwise carried the band's worth
  of dead scroll); and the drafted `palette.ts` did not compile (`VesselPalette`
  imported twice — `TS2300`, plus `no-duplicate-imports` once merged).

  **And the machinery the topbar was hiding behind.** `usePaneRedirect`, and the
  entire `ah:session` no-FOUC apparatus — the localStorage breadcrumb, the
  `html.ah-session` class, the blocking `<head>` script, and the CSS that hid
  `.site-topbar`/`.site-footer` and zeroed `pt-[60px]`. All of it existed to stop
  a member painting logged-out chrome before auth resolved; there is none left.
  Three logged-in tool surfaces now clear the row's band instead (`/write`,
  `/admin/*`, `/traffology/*` — every other platform route is a redirect shim
  into the workspace), and `/write` loses the `top-[53px]` sticky offset that
  existed to clear the topbar's mobile height. CLAUDE.md's escape invariant
  described all of it as standing rule and is rewritten; a new "public register"
  section documents the chassis.

  **Gates:** `next build` green, root lint 0 errors, `tsc` clean, hairline count
  back to the pre-sweep 25 (the four new matches are comment prose quoting the
  hairlines these files removed, marked `hairline-ok` with reasons). **NOT
  browser-verified — see §11.**

- **2026-07-25 (NAV-ROW-MUSTER-ADR Phase 3 — polish)** — Closed out the muster's
  deferred §VIII.3 polish. (1) **Floating hover-name label** (§V): the `title`
  stand-in is replaced by the vessel roundel's own `ROUNDEL_TOKENS` treatment
  (`.label-ui`, ink-925 ground, bone text), floated *above* the disc — the muster
  sits at the screen's bottom edge, so its label rises where the vessel's drops —
  centred over the disc and pointer-inert, driven by per-roundel local hover
  state. (2) **Reduced-motion gate**: `prefersReducedMotion()` nulls both the disc
  state transition and the label fade (matching `ExplainOverlay`/`Vessel`).
  (3) **Explain `navRow.muster`**: new kind + copy (`registry.ts` union,
  `copy.ts` — "One roundel per feed… click any of them to go straight there").
  The muster is a separate fixed layer *above* the floor-mode scrim (z-58 > 50),
  so — like the ∀ disc — it **reports its own hover** to the engine rather than
  relying on the scrim's hit-test (which never reaches it); gated to floor mode
  and About-closed, so pane-mode Explain still annotates only the pane. This is
  an owned HOW-divergence from §VII's imagined passive `data-explain` tag, which
  would be unreachable above the scrim. (4) **§VII a11y close-out**: the labelled
  group of aria-labelled state-naming buttons was already in place from Phase 2;
  the addition is a click-while-Explain-active guard that sheds the annotations
  instead of navigating (the disc's behaviour, since the muster's click never
  reaches the scrim's own dismiss). (5) The overflow track gained a `max()` floor
  so a pathologically narrow viewport can't collapse it. `next build` green,
  hairline tripwire clean. Phase 4 (arrival flags, §VI) stays deferred to its own
  ADR. Spec: `docs/adr/NAV-ROW-MUSTER-ADR.md` §VIII.3.

- **2026-07-25 (NAV-ROW-MUSTER-ADR Phase 2 — the muster)** — The nav row was a
  56px silent reserved band with nothing but the ∀ lockup docked at its right
  end, so the workspace had no persistent answer to "how many feeds do I have,
  and where am I among them" — panned-off and minimised feeds were invisible
  until you opened the ∀ menu. §IV adds the **muster**: a centred run of numbered
  roundels in the row, one per **live** feed (hidden included, on Phase 1's
  stable numerals), each reporting one of three states. New `web/src/components/
  workspace/Muster.tsx` — **fixed 32px cells, discs that grow within them** (no
  roundel moves during a pan; only which discs are large changes): 24px solid
  `--ah-ink` with a bone numeral (in view), an 18px 2px-`--ah-ink`-ring hollow
  disc (on floor, panned off), an 18px 2px-`--ah-stone-350`-ring hollow disc
  (minimised); 140ms ease-out on size/fill/ring/numeral; Jost numerals (identity,
  not metadata); the track centres and clears the lockup by a symmetric 200px
  side-reserve, scrolling in place (`.scroll-silent`) past that. `WorkspaceView`
  gained the tighter in-view selector `musterInView` — the **real** viewport band
  `[panOffset, panOffset + viewport.w]`, deliberately NOT the three-viewport
  `visibleIds` mount band (reusing it would paint three screens of roundels as
  "in view"), inheriting VIRT_QUANT hysteresis for free off the same quantised
  `panOffset` — the `musterFeeds` list over `liveSorted`, and `goToFeed`: one
  verb (**go to this feed**) that first dismisses any open Glasshouse pane (the
  muster is clickable over a pane at z-58; leaving a modal over the scrolled floor
  is incoherent — §V), then scrolls the feed's rect to one GRID from the leading
  edge; a minimised feed is **restored first**, and a `geom`-keyed effect scrolls
  once its rect exists (restore re-enters as a new right-most column, so the rect
  is absent until the next derivation — a stashed target beats a guessed timer).
  **HOW divergence from §VII, owned:** built as a **separate fixed z-58 layer**
  beside NavRow rather than a child of it (state locality), so NavRow stays the
  pure `aria-hidden` band and the muster owns its own `role="group"` +
  per-roundel `aria-label`; container marked `data-explain-chrome` pending the
  Phase-3 Explain label. Included §IV's centring/overflow (structural — the track
  runs under the lockup without it), deferring the §V floating hover-name label
  (a `title` stands in), the `navRow.muster` Explain copy, the full §VII a11y
  pass, and a reduced-motion gate to Phase 3. **Also fixed an unrelated build
  blocker in the working tree**: `app/page.tsx`'s landing copy had a straight
  apostrophe in `"You don't need"` inside a single-quoted string (curly `’`
  everywhere around it), terminating the literal — corrected to `don’t`. `tsc`,
  the hairline tripwire, root eslint (0 errors), and `next build` all clean; the
  workspace `/reader` route compiled. Phases 3–4 remain. →
  `docs/adr/NAV-ROW-MUSTER-ADR.md` §VIII.

- **2026-07-25 (NAV-ROW-MUSTER-ADR Phase 1 — stable numerals)** — Feed numerals
  were assigned over the *visible* set (`WorkspaceView` `visibleSorted` →
  `feedNumerals`), so minimising a feed renumbered everything after it and the
  hidden feed lost its number (`FeedComposer` rendered `–`). NAV-ROW-MUSTER-ADR
  §III makes the numeral **identity**: it now derives over the **live** set
  (every undeleted feed, hidden included) via a shared `feedRankComparator` →
  `liveSorted`, with `feedNumerals` mapped over that; `visibleSorted` is derived
  as its hidden-filtered subsequence and is unchanged as the layout/parade
  ordering (still a subsequence of the live order, so floor + parade still fall
  in numeral order — just with gaps where a feed is away). `FeedComposer`'s rank
  list numbers every row (`const num = ++numeral`, the `–` placeholder gone;
  hidden rows keep their muted weight + "hidden" tag), and it is the sole
  renumber surface — its `order` already includes hidden feeds. `MobileWorkspace`
  gained a `numeralFor` prop (fed from `feedNumerals`) and its pip aria-labels
  now announce **both** the stable number and the gapless position ("Feed 4, 3
  of 4") — position still drives the swipe. Four stale comments rewritten
  (`WorkspaceView` ~341 + the regimented "starts at Feed 1" scroll comment,
  `FeedComposer` header, `MobileWorkspace` ~88); the §V regimented code left
  untouched per the ADR. **Also fixed two ADR citation slips found in the
  pre-build code review**: `handleReorderFeeds` (no such function — it is the
  `FeedRankList` component's `onReorder`) and the claim that `NavRow` holds the
  lockup (the row element is empty; the lockup docks in via `ForallMenu
  anchor="row"`). No schema change, no new UI; `tsc`, the hairline tripwire on
  the three files, and `next build` all clean. Observable on its own: minimise a
  feed and the others hold their numbers; the visible run reads 1, 2, 4, 5.
  Phases 2–4 (the muster row, polish/a11y, arrival flags) remain. →
  `docs/adr/NAV-ROW-MUSTER-ADR.md` §VIII.

- **2026-07-25 (landing page `/` rebuilt from the member grammar)** — The
  logged-out `/` carried the old marketing register (black topbar + centred
  crimson ∀ + serif/mono column). Rebuilt it from the member grammar: a
  `--ah-bone` floor, one *abstracted* ⊔ vessel (`web/src/components/landing/
  LandingVessel.tsx` — the ⊔ stance + 8px wall/lattice + cards on a continuous
  ground, deliberately WITHOUT the feed vessel's numeral/roundel/VesselBar,
  which assert a "feed n of m" the page can't make), and a fixed bottom nav row
  (`LandingNavRow.tsx`) with the static lockup (`components/brand/
  ForallLockup.tsx` — wordmark + disc-form ∀, painted not punched) docked
  right; the row's left carries the two CTAs the retired topbar held (Log in ·
  Join the waiting list). `/` joined `chromelessRoute` in `LayoutShell` so the
  black topbar no longer mounts over it (two logos on one screen otherwise);
  `HomeRedirect` still bounces a logged-in member to `/reader`.
  **Three fixes over the handed-off draft.** (1) The bundle's `.patch` was
  stale — its base predated `8f40ba5` (the copy sharpen), so it wouldn't apply;
  hand-applied against HEAD and **kept HEAD's newer copy** ("three *radical*
  propositions", the "dopamine hacks"/"set the terms" prose) rather than
  regressing to the patch's older strings. (2) **Restored `<ol>`/`<li>`
  semantics** for the three propositions (the draft had flattened them to
  `<div>`s with a decorative numeral — a screen-reader regression); the crimson
  numeral is now `aria-hidden` since the list position carries order, and the
  `<ol>` is one flex child with the same `GAP` so card spacing is unchanged.
  (3) **Killed a dark-mode first-paint flash**: the islanded, SSR'd landing
  surfaces gated their palette variant on the store's `dark` field, which lags
  until `hydrate()` runs post-mount, so a dark-mode visitor painted a light
  vessel on the (already-dark) floor with a near-invisible lockup, then snapped
  dark. Added `useResolvedDark()` to `stores/colorScheme.ts` — a
  `useSyncExternalStore` reading the `html.dark` class the pre-paint script set,
  reconciled by React before paint — and switched both landing components to it.
  Verified: `tsc` clean, `next build` (`/` prerenders static), hairline
  tripwire + root promise-safety lint both pass. CLAUDE.md workspace-escape
  invariant + light/dark section updated.
  **Follow-up same day (two live bugs).** (1) The page rubber-banded on mobile —
  stretch, snap back, the end of the text re-hidden. Cause: `100vh` is the LARGE
  (URL-bar-hidden) viewport on mobile, so both the landing container and the
  shared `<main className="min-h-screen">` forced a phantom overflow taller than
  the visible area. Switched the chromeless `<main>` branch and the landing
  container to `100dvh` (dynamic viewport). Safe for the workspace —
  `WorkspaceView` sets its own explicit `height:100vh` (line ~1994), independent
  of `main`. (2) The ∀ lockup did nothing when clicked — it linked to `/`, a
  no-op on the home page. Pointed it at `/waitlist` (the closed-beta sign-up
  funnel; `/auth?mode=signup` only redirects there) via `ForallLockup`'s `href`
  prop, so the mark doubles as the get-started CTA. `tsc`/`next build`/hairline
  all still clean.
  **Follow-up 2 (the dvh patch wasn't enough — restructured to an app shell).**
  The document-scroll layout still fought the mobile viewport. Rebuilt `/` as a
  pinned `100dvh` flex column (`overflow: hidden`, no document scroll): the
  vessel area fills the space above the nav row, `LandingVessel` fills that area
  (`flex:1 / minHeight:0`) so it is always wholly on screen, and the CARD COLUMN
  scrolls INSIDE the vessel — the same `flex:1 / minHeight:0 / overflowY:auto`
  body the workspace `Vessel` scrolls, `.scroll-silent` to suppress the scrollbar
  rule. `LandingNavRow` became a `flexShrink:0` flex child at the foot (was
  `position: fixed`), so it can't be overlapped and needs no reserved padding.
  Both ⊔ frames now `overflow: hidden` so the column reads as cards passing a
  fixed mouth. Net: the vessel is fully visible and only its contents move —
  no rubber-band possible. `tsc`/`next build` (`/` static)/hairline/lint clean.
  **Follow-up 3 (content for the scroll).** Added a live-site SHOWCASE (three
  screengrab cards below the sell text — `LandingShot`, a 16:10 `next/image fill`
  figure + caption, pointed at `/landing/*.webp` in web/public; missing assets
  fall back to a faint-disc placeholder via `onError`, so an absent file reads as
  an intentional slot, never a broken image) and a closing CODA (the ∀ disc +
  the motto “FOR ALL”, centred) that ends the column. Extracted the disc-form ∀
  into `components/brand/ForallDisc` (ADR-locked geometry, per-instance `useId`
  clip so several discs on one page don't collide); `ForallLockup` now composes
  it. Real screengrabs still to be supplied. `tsc`/`next build`/hairline/lint clean.

- **2026-07-25 (feed-items page load 7.2s → 78ms — the slow/failing-reload
  incident)** — Feeds with follow-import-scale source sets (251–717
  `feed_sources` rows) had become multi-second or failing to load. Measured on
  dev (`EXPLAIN ANALYZE`, 34.7k `feed_items`): **7,246ms for one 20-row page**
  of the 717-source feed. Three compounding causes, three fixes, all
  page-output-identical (verified old-vs-new across all 6 dev feeds + the
  page-2 cursor path):
  **(1) The `matched` CTE was a cross product.** The five source-match arms
  were OR'd inside one join condition, which has no hashable key — the planner
  nested-looped `feed_items × feed_sources` and filtered **24.9M row-pairs per
  page** (~4.5s). Rewritten as one UNION ALL branch per `source_type`, each an
  index-friendly equijoin riding indexes that already existed
  (`idx_feed_items_author`/`_source`/`_article`), then `GROUP BY fi_id`
  (`MAX(weight)`/`bool_or` — same multi-source collapse). Work is now
  O(matching items), not O(items × sources).
  **(2) JIT compiled 334 functions per query (~2.5s)** — the inflated cost
  estimate tripped Postgres's JIT threshold on every request. `jit=off` at the
  shared pool's connection options (`shared/src/db/client.ts`) — all service
  queries are OLTP-shaped, so JIT is pure per-query overhead; connection-level
  means no per-environment postgresql.conf step and it ships with the deploy.
  **(3) The heavy projection ran per candidate, not per winner.** The `scored`
  CTE computed the full `FEED_SELECT`/`POST_SELECT` — correlated subqueries
  (tag_names, reply/quote post-id derivation) + six LEFT JOINs — for all ~12k
  matched rows to return 20. Restructured rank-then-project: a slim `ranked`
  pass (id + effective_score + only the columns the visibility predicates
  read) sorts and LIMITs first; the fat projection joins onto the ≤limit
  winners (the same post-LIMIT move the dedup provenance lateral already made).
  **Why it read as "fails to reload":** the shared pool's 10s
  `statement_timeout` — a 7.2s query needs only mild concurrency (the
  `/workspace/bootstrap` all-feeds fan-out, or one other reader) to blow past
  10s, get killed, and 500. **Why it deteriorated abruptly:** both factors of
  the quadratic grew together — follow-import feeds landed hundreds of sources
  per feed while feed-ingest filled `feed_items` daily from 1,595 sources.
  Live-verified after gateway rebuild: worst feed ~75–120ms, full bootstrap
  (6 feeds concurrent) 279ms. Dev-DB note: `feed_items` had never been
  analyzed (empty planner stats) — worth an `ANALYZE` + autovacuum check on
  prod at next deploy. Files: `gateway/src/routes/feeds/items.ts`,
  `shared/src/db/client.ts`.

- **2026-07-24 (Jul 22–24 commit-audit fix batch — CONSOLIDATED-TODO §0m)** —
  Four-agent adversarial review of the window's 25 commits (`48913a2`…`d599d76`:
  columnar floor Slices 0–5 + follow-ups, owner dashboard, closed-beta Phases
  1–3 + waitlist, brand disc, §0k batch), all findings re-verified in source
  before fixing. Clean on the load-bearing checks: no signup bypass, admin
  routes guarded, ledger-view money numbers, enumeration-safe waitlist, exact
  disc geometry, drift/ledger/hairline/build/test gates all green. Fixed
  same-day (1 HIGH, 7 MEDIUM, the cheap LOWs):
  **HIGH — resize commit was unguarded** (`Vessel.tsx`): a zero-movement press
  on the grip committed a "resize" (freezing an `h: null` fill slot, baking a
  squeezed height into the stored layout) and `onPointerCancel` routed to the
  same commit handler — and since `onSizeCommit` runs `materializeIfRegimented()`
  first, a bare click in `\` mode silently replaced the stored custom layout
  with the parade (the drop path's `dropIsNoop` class, unguarded on resize).
  Now: a `moved` flag + seed-equality check make the no-op release commit
  nothing, and pointercancel ABORTS to the derived rect. `WorkspaceView` also
  gains a `resizeActiveRef` guard so `\` is refused mid-resize (mirroring
  mid-drag).
  **MEDIUM** — (1) parked-vessel phantom fetch: the load-more + caught-up
  listeners weren't gated on `parked`; the unmount's scroll-clamp event always
  read "near end" against the 100% wash, fetching a page per park cycle for an
  off-screen feed (§VII violation). Both effects now bail when parked,
  mirroring the scroll-save listener. (2) Horizontal pull-to-refresh vs floor
  pan (`PullToRefresh.tsx`): at a horizontal vessel's mouth a leftward wheel
  scroll-chains to the floor AND fed the refresh accumulator, so panning
  flicks could fire a refresh mid-pan (collapsing the open conversation). New
  `floorCanConsume` guard: while the next horizontally-scrollable ancestor
  (the floor) can still pan left, toward-mouth deltas disarm instead of
  accumulate (wheel + touch). (3) `waitlist.ts` returned a raw Zod
  `flatten()` as `error` — now the shared `zodValidationError` envelope, plus
  `.max(254)` on the email (the route writes; no length bound before).
  (4) Gateway `trustProxy: 1` (`index.ts`): behind nginx every visitor shared
  one `req.ip`, so the waitlist's 5/min limit was one **global** bucket (six
  genuine joins/minute worldwide; one curl loop = lockout). One trusted hop
  takes the nginx-appended XFF entry — never `true`, which trusts the
  client-controlled leftmost. (5) One-home admin identity: `/auth/me` computed
  `isAdmin` from env only while `requireAdmin` reads `platform_config` first,
  so a dashboard-granted admin passed the API but AdminShell bounced them —
  `/auth/me` now calls `getAdminIds()`, and both its paths trim entries.
  (6) `saves.ts` cursor: the bespoke `parseSaveCursor` missed §0k.4b's clamp —
  a crafted finite epoch (`1e300`) survived the ms-rescale and 500'd at
  `to_timestamp()` (repro'd on dev PG16); now clamped to the shared
  `[0, 1e11]` after the rescale. (7) `PaywallGate.tsx` `prefer-const` — the
  root lint pass was at 1 error (rule: 0); back to 0.
  **Smaller** — `/waitlist` added to `PLATFORM_PREFIXES` (the beta's main
  capture page rendered the bare canvas topbar instead of the logged-out
  register); overview "Oldest holding" warn now reads the served
  `custody.holdingWarningDays` (the `regulatory_holding_warning_days` dial,
  same fallback discipline as the regulatory endpoint) instead of a hardcoded
  14; `Stat.tsx` `text-[20px]`→`text-[1.25rem]` (scales with the type-size
  control); config PATCH now one transaction with `rowCount` checked (a key
  DELETEd between pre-check and write no longer no-ops silently; audit lines
  logged post-commit; `updated` counts real changes); starter-merge guard's
  SELECT takes `ORDER BY id FOR UPDATE` (closes the operator-flag TOCTOU,
  deterministic lock order); unhide-failure revert no longer removes a slot
  the idempotent insert never added (`hadSlotAlready`); Google OAuth deleted
  accounts get "Account deleted" (mirroring magic-link, §0k.4a's class); NEW
  TEST `closed-beta-signup-gate.test.ts` pins the `/auth/signup` flat refusal
  in both flag positions (deleting the gate previously failed zero tests);
  stale comments corrected (NavRow slab, WorkspaceView `floorScrollRef`,
  ForallMenu §V→§IV.4); and `WorkspaceView.tsx` carried two **literal NUL
  bytes** (the Slice-5 `join("\0")` memo key written as raw 0x00 in source) —
  semantically identical but every grep/tool classified the file as binary;
  rewritten as the two-character escape.
  **Deferred to §0m**: invite login-redirect stash, the 1.5px logged-out-register
  field borders, a durable config audit table, trigger-proxy fire-and-poll,
  PullToRefresh palette/grip-focus debt, and the `trustProxy` prod
  verification note. Validation: gateway `tsc` + 397 tests green (2 new),
  web workspace suites 76/76, root lint 0 errors, `next build` green,
  hairline tripwire clean over every touched file.

- **2026-07-24 (workspace — horizontal vessel opened the wrong way)** — The
  horizontal orientation opened on the RIGHT (`Vessel.tsx` walls top+left, glyph
  `⊏`) while newest items arrive on the LEFT (newest-first row, load-more fires
  approaching the far right), so the mouth sat at the OLDEST end — a 180° break
  from WORKSPACE-DESIGN-SPEC §"Opening" (*"the open end of the ⊔ is where new
  content arrives"*) and from the vertical `⊔`, whose open top IS the arrival
  end. Fixed cosmetically (no scroll/geometry logic touched): horizontal is now
  `⊐` — walls top+**right**, open on the **left** (`Vessel.tsx` `wallStyle`); the
  resize grip overhangs the now-present right wall in both orientations
  (`right: -WALL`); the `OrientationGlyph` path flips to open-left
  (`FeedComposer.tsx`). **Pull-to-refresh made axis-aware** (`PullToRefresh.tsx`,
  new `axis` prop, default `vertical` so other callers are untouched): horizontal
  gates on `scrollLeft`, gestures on `clientX` (drag right) / `deltaX || deltaY`
  (trackpad or mouse-wheel-over-overflow-x), and the indicator grows rightward
  from the left mouth with a vertical `← PULL TO REFRESH` label; `Vessel` passes
  `axis={isHorizontal ? "horizontal" : "vertical"}`. ADR notes updated
  (WORKSPACE-COLUMN-LAYOUT §XI `⊏`→`⊐`, MOBILE-LAYOUT §intro glyph). `next build`
  green, hairline tripwire clean over touched files.

- **2026-07-24 (closed beta — Phase 3, the presentation)** — CLOSED-BETA-ADR
  Phase 3 built; all three phases now complete. Frontend-only (no gateway/schema
  change). **Every public signup CTA sitewide routes to `/waitlist`**; the only
  `mode=signup` left in the code is a comment. Landing (`app/page.tsx`)
  readers-first per §IV (hero "Read everything / in one place.", body + metadata
  reconciled off the author-centric line §VII flagged); CTAs "Join the waiting
  list" → `/waitlist`, "Log in" → `/auth?mode=login`, closed-beta line. `/auth`
  (`app/auth/page.tsx`) rewritten **login-only** — signup form/fields/toggle
  deleted; the two D4 edge cases (`?mode=signup` direct, `?error=closed_beta`)
  `router.replace` to `/waitlist?from=beta` and render `null` while redirecting
  so the form never flashes; the Phase-1 inline notice + `mailto` fallback
  retired. Google callback's `closed_beta` branch now routes straight to
  `/waitlist?from=beta` (D4). Waitlist surface gains the §V "you're not in the
  beta yet" line on `?from=beta` (read from `window.location.search`, not
  `useSearchParams`, to stay out of a Suspense boundary). §VIII carried surfaces
  swept: `Nav.tsx` (desktop + mobile sheet), `about/AboutContent.tsx` (CTA +
  softened "Sign up…" prose; £5-credit fact kept), `article/PaywallGate.tsx`
  (logged-out branch → `/waitlist` link, not the account-assuming unlock button)
  + `ArticleReader.handleUnlock` fallback. **Two §VIII open items ruled
  conservatively (recruit only existing members), not built as exemptions:**
  publication invites (`invite/[token]`) → "Log in to accept" (token-scoped
  signup exemption for outside writers stays a deferred design decision), and
  tribute claim (dark feature) anonymous CTA → `/waitlist`. `next build` clean;
  hairline tripwire clean on all touched files. As-built: ADR §X.
  **Landing restyled into the logged-out register's own idiom (same day):** the
  Swiss-sans `hero-headline` and the 6px `slab-rule` beam — neither used
  elsewhere in that register — dropped for the centred crimson `∀` + serif head
  + mono copy grammar shared by `/auth`, `/waitlist`, `/about`; body "Log in" /
  "About" links removed (both already in the topbar), leaving one CTA + the
  closed-beta line.

- **2026-07-24 (closed beta — Phase 2, the waiting list)** — CLOSED-BETA-ADR
  Phase 2 built. Migration 162 adds the minimal `waitlist(email UNIQUE,
  publish_interest, created_at)` table; `POST /waitlist`
  (`gateway/src/routes/waitlist.ts`) is enumeration-safe by construction —
  lower-cased/trimmed email, `ON CONFLICT (email) DO NOTHING`, a fixed
  acknowledgement new-or-repeat, and `publish_interest` not bumped on a repeat
  (a bump would leak row-existence via export). Surface at `/waitlist`
  (`web/src/app/waitlist/page.tsx`) with the single unticked "I'd also like to
  publish" opt-in (D3, resolved: keep the flag). D5 lawful-basis/purpose note
  drafted at `docs/adr/WAITLIST-PRIVACY-NOTE.md`. Tests
  `gateway/tests/waitlist.test.ts` (6, mutation-checked); drift guard green;
  `next build` clean. **Phase 3 (presentation) shipped same day — see the entry
  above.** As-built: ADR §IX.

- **2026-07-22 (brand — the nav row loses its slab; the disc adopts the cut mark's
  dimensions)** — two review notes on the shipped columnar workspace, both design
  calls by the operator.
  **(1) The nav row's divider is gone.** `NavRow` shipped (Slice 4) with the
  canonical 4px slab on its top edge, there because the row's ground is
  `var(--ah-bone)` — the same colour as the floor — so without it the row does not
  read as a distinct band. On review that is fine: the lockup docked at the row's
  right end is indicator enough, and a full-width rule across the viewport is a
  heavier statement than the row is making. The slab div is deleted; the row is
  now a silent reserved band that still holds the ∀ clear of the feeds and still
  stops the floor running under it (`deriveGeometry`'s `navRowH` is untouched, so
  no geometry moved). Nothing thinner replaces it — the no-single-pixel-lines
  invariant forbids that outright. Recorded in WORKSPACE-COLUMN-LAYOUT-ADR §VI +
  its as-built notes and in CLAUDE.md's nav-row rule, in both cases as
  *don't reinstate*, not as history.
  **(2) The ∀ disc now carries the cut mark's geometry — and that closes the
  two-stance drift.** FORALL-CUT-AND-LOCKUP-ADR §III.1's honesty note recorded
  that the brand exports came out at a ≈16.7° leg splay rather than the canonical
  ~20.5°: pinning BOTH ends to the rim (feet at ±28° from top, apex vertex set so
  the mitred outer tip resolves to a point on the bottom rim) over-constrains the
  stance, and the narrower letter fell out of the construction. The in-app disc
  kept the old clear-of-the-rim glyph, so trigger and exports visibly disagreed;
  §IV.4 had explicitly recommended that split, and CONSOLIDATED-TODO §10 carried
  the decision as open with "don't propagate the export geometry" pending it.
  **Resolved in favour of neither queued branch: the narrow stance is the DISC
  FORM's stance, in-app included.** The trigger's idle-∀ group and `favicon.svg`
  were ported onto §III.1 by scaling its 200-unit frame (disc r=94) into the
  56-unit one (disc r=28) by 28/94 — legs `M10.6 -1.7 L28 45 L45.4 -1.7` w5
  become `M14.36 1.61 L28 47.15 L41.64 1.61` w5.06 (miterlimit 6 → 12; the join
  needs ≈3.5, and the apex vertex at y=47.15 puts the mitred tip at y≈56, a point
  on the bottom rim), and the crossbar (18,22)→(38,22) w4.2 becomes
  (19.96,20.26)→(36.04,20.26) w4.17. `#forall-clip` goes 27 → **28**, the literal
  rim: under this construction the feet overshoot the circumference deliberately
  so the clip trims them flush, and a 1-unit inset would leave exactly the ink
  slice the overshoot exists to remove. The anti-aliasing the inset used to guard
  is already covered by the wrapper `<span>`, which clips in the *rendered*
  coordinate space — the second of the two clips §III.3 requires, so the disc
  stays background-independent over floor and frost alike. **Realisation is
  unchanged: still painted, not punched** — the lens died with the floating disc
  (WORKSPACE-COLUMN-LAYOUT-ADR §VI) and the cut realisation remains exports-only;
  only the dimensions came across. Favicon rasters `icon-32.png` /
  `apple-touch-icon.png` regenerated from the SVG (sharp, density 1200) and
  eyeballed against `allhaus-disc-on-bone.svg` rendered at the same size —
  pixel-equivalent, so the three disc instances are one geometry again.
  **The one-construction rule is amended, not broken**, and CLAUDE.md now says so:
  the ≈16.7° splay is a *consequence* of having a rim to meet, so it belongs to
  every disc instance (trigger, favicon, exports) and to no bare one — the bare
  `ForAllMark` (crimson ∀, Nav/Footer/About) has nothing to kiss and keeps ~20.5°.
  Two stances, one construction, the difference derived rather than drawn.
  ADR §III.1 gains the resolution note, §IV.4 is marked superseded (its
  pinched-crescent warning kept as the standing visual check at 36–40 px, which is
  the one thing to watch on the live disc), CONSOLIDATED-TODO §10 closed. The
  cross-referenced docs that still asserted the old split were corrected in the
  same pass, since each would otherwise have sent the next reader back to the
  superseded numbers: LOGO-REFINEMENT-SPEC's header note (it claimed the in-app
  discs "remain exactly as specified here" and that §IV.4 deliberately kept the
  live button clear of the rim) rewritten to scope this spec's stance to the bare
  glyph alone, with Files 2/3 marked superseded on geometry but retained for their
  still-live structural instructions; `ForAllMark`'s doc comment (it claimed the
  disc marks derive their splay from it) rewritten to state the two-stance rule;
  `web/public/brand/README.md` extended to say the exports are no longer a
  special case.
  Green: web tsc clean, `next build` clean, root eslint 0 errors, hairline
  tripwire clean over both touched components, dev web image rebuilt.

- **2026-07-22 (prod incident — a starter template merged away; the merge guard)** —
  the operator dragged the feed flagged `is_starter_template` onto another feed
  on live. `POST /workspace/feeds/:id/merge` is asymmetric and destructive: it
  moves the SOURCE feed's non-duplicate sources into the target, deletes the
  duplicates, copies saves, then `DELETE FROM feeds` on the source
  (`crud.ts` step 5). Nothing guarded the flag, so the only row carrying it was
  destroyed.
  **Two live symptoms, one cause.** (1) New signups landed on an empty
  "Founder's feed". That name is `DEFAULT_FEED_NAME` (`WorkspaceView.tsx:94`) —
  a *client-side* fallback minted with zero sources when `boot.feeds.length === 0`,
  which for a fresh account happens only when `seedStarterFeeds` finds nothing
  flagged. So they weren't getting a broken clone, they were getting no clone
  and a 0-source feed named after the operator, whose contents fall to the
  explore placeholder (48h of platform natives, minus their own) — empty on a
  quiet day. The name is the diagnostic: it is unreachable while any template
  is flagged. (2) The merge target on the operator's own account painted
  `COULDN'T LOAD FEED` (`WorkspaceView.tsx:1286`, `status: "error"`, set only in
  `loadVesselItems`'s catch): holding the union of both source sets, its
  `sourceFilteredItems` query — `feed_items × feed_sources` under a polymorphic
  `OR`, with a correlated `EXISTS` per pair for `tag` sources — exceeded the
  pool's 10s `statement_timeout` (`shared/src/db/client.ts:24`).
  **Unrecoverable tail:** migration 114's `cloned_from_feed_id … ON DELETE SET
  NULL` nulled every clone's provenance pointer, so `fromStarter` is now false
  for all existing users. Cosmetic — it forks only the Explain/first-run copy.
  **The guard** (`crud.ts`, merge step 1b): a merge whose SOURCE feed carries
  `is_starter_template` is refused with 409 `starter_template_source`, thrown
  before any write. Merging INTO a template stays allowed — it survives and only
  grows. Refusal was chosen over carrying the flag to the target: which feed
  seeds every new account is an operator decision, not a side effect of a drag,
  and the damage from getting it wrong is global, delayed, and invisible from
  the gesture (it lands on the NEXT signup). `MergeFeedConfirm` rendered
  `err.message` — the raw `API error 409: {…}` dump — so the refusal now goes
  through `apiErrorMessage`; the error moved onto its own line (a full sentence
  squeezed the actions out of the 420px panel) and the panel's hairline border
  went with it (shadow-only lift, the Glasshouse grammar).
  **Prod repair is operator work, queued at CONSOLIDATED-TODO §0l** — the
  recovery levers are that `feed_sources.created_at` survives a merge (the merge
  only UPDATEs `feed_id`, so the two original feeds are two distinct timestamp
  clusters, which is how the target gets un-merged), and that any user who
  signed up before the accident still owns a verbatim clone of the lost template
  (findable by name now that provenance is gone). Order matters: trim the target
  BEFORE flagging it, or every new signup clones a feed that times out.
  **Validation:** `gateway/tests/feed-merge-starter-guard.test.ts`, 3 tests
  (refusal writes nothing — no feed DELETE, no source move, no saves copy;
  merge-into-a-template still runs; ordinary merge untouched), mutation-verified
  (guard forced to `if (false)` → 1 red). Full gateway suite 384 passed; root
  lint 0 errors; `next build` clean; hairline tripwire clean on the touched file.
  **Residual, not fixed:** `DELETE /feeds/:id` has the same hole — it guards
  "cannot delete your only feed" but not the template flag (§0l).

- **2026-07-22 (columnar floor, post-ship audit fixes — WORKSPACE-COLUMN-LAYOUT-ADR
  §X addendum)** — a same-day code audit of Slices 0–5 found two behavioural
  bugs and a tail of smaller gaps; all fixed. The full record is the ADR's
  "Post-ship audit fixes" §X note; headline items:
  - **Capacity-gated vertical drop bands** (`layout.ts::resolveDrop`): rule 1's
    top/bottom bands inserted into a column unconditionally while rule 2's gap
    path proved its run, so repeated band drops could stack a column past the
    viewport — and the overflow fell below the nav row, where the floor
    (`overflowY: hidden`) has no vertical scroll: a feed could end up fully
    off-screen with its bar and drag surface unreachable. Cross-column band
    insertions now require `(n+1)·SLOT_MIN_H + n·GRID ≤ H`; within-column moves
    always pass (the count doesn't change). The gesture-sequence property now
    asserts no gesture produces an over-capacity column; viewport-shrink
    degradation (which may still overflow) is unchanged by design.
  - **`dropIsNoop` guards the drop commit** (`layout.ts` + `WorkspaceView.tsx::
    handleVesselDragEnd`): a release back into the held-open slot (or a band
    position landing identically) is structurally unchanged, but the host
    treated it as a committed drop — which under regimented mode **materialised
    the parade over the stored custom layout**, silently destroying the user's
    arrangement on a "never mind" release. A no-op now commits nothing: no
    materialise, no write, mode retained.
  - **Slot-rect hit testing** in rule 1 (was column-span): the empty band
    beside a slot narrower than its column no longer arms a merge from
    visually empty ground; it falls through to rule 2 / nearest-boundary.
  - **Faithful hide revert** (`locateSlot`/`restoreSlot` + store action): a
    failed hide PATCH used to revert via `insertFeed` — right-most, factory
    size — so a transient network failure rearranged the floor. The slot's
    column id + index are captured before the optimistic removal and restored
    on failure (re-creating a pruned column at its old position).
  - Housekeeping: `SLOT_MIN_W` 220 → **224** (on the 8px lattice; one minimum
    width, matching `snapAtLeast`'s resize floor, instead of two); neighbours
    track a live resize by direct set rather than a spring restarted every
    frame (`Vessel snapSettle`); the `\` guard covers the open ∀ menu
    (`[role="menu"]`); the store's uncalled `reset()` deleted;
    `handleMergeConfirm` no longer starts a refetch inside a `setVessels`
    updater (the impure-updater class `adoptFeed`'s comment documents); stale
    `clampPos` / "20px lattice" comments corrected.
  - **Validation:** 13 new tests (capacity fixtures + within-column allowance,
    narrow-slot band, `dropIsNoop` corpus, `locateSlot`/`restoreSlot`
    round-trips, store revert) plus a capacity assertion folded into the
    300 × 20-step gesture-sequence property; each fix mutation-tested (gate
    removed → 2 red; span hit-test restored → 1 red; restore degraded to
    append → 3 red; `dropIsNoop` forced false → 3 red). 76/76 in the two
    suites; root lint 0 errors; `next build` clean; hairline tripwire clean on
    touched files; image rebuilt and verified on `localhost:3010`.
  - Docs: ADR §III.3 + §X amended; CLAUDE.md drops + regimented bullets carry
    the two new invariants (capacity gate / no-op-is-not-a-mutation).

- **2026-07-22 (columnar floor, the regimented hotkey — WORKSPACE-COLUMN-LAYOUT-ADR
  Slice 5, the last)** — plain `\` toggles the parade ground: every visible feed
  on screen at once, one column each, numeral order, factory width scaled down
  uniformly to fit. Pure `WorkspaceView` wiring — `regimentedLayout` and the
  store's `setRegimented`/`materializeRegimented` shipped in Slices 1–2 and were
  used unchanged, so the ADR is now fully implemented.
  **The mode is a VIEW, not an edit:** the stored layout and the v2 key are
  untouched while it is on, so leaving it is free and there is no snapshot to
  lose. A layout **mutation** (a committed drop, a resize commit) materialises
  the parade as the custom layout, applies its one edit, and leaves.
  **Five as-built deviations**, all recorded in the ADR's §X: (1) the parade is
  ordered by the **numeral** (`sortRank: i + 1` over `visibleSorted`), not the
  raw server rank — `regimentedLayout` breaks a rank tie by id and
  `visibleSorted` by `createdAt`, so the raw rank would let the parade disagree
  with the numerals painted on the vessels, which is the one thing the mode is
  for; (2) `visibleSorted` hoisted above the geometry block and its feed list
  memoised on a joined-id key, or a fresh array each render would re-derive the
  geometry and re-render every vessel for as long as the mode was on; (3) the
  resize **clamp** re-pointed from `useWorkspace.getState().layout` to the
  derivation the floor is actually arranged by — under the mode the store's
  layout is the *hidden* custom one, so the handle would have stopped where an
  invisible stack ends while the commit landed on a different layout; (4)
  merge/hide/delete/adopt deliberately do **not** materialise (they are
  feed-list changes, not layout edits — materialising there would silently
  overwrite the user's custom layout every time they hid a feed) and the parade
  simply re-derives; (5) entering scrolls the floor to 0, instantly, because the
  parade reads 1..N from the left and the floor has just changed shape.
  Guards are §V's plus the lightbox, the editor overlay and a mid-drag check;
  the seven local non-Glasshouse surfaces ride a ref rather than the effect's
  dep list so opening one doesn't re-attach the listener.
  Green: `tsc --noEmit`, root `npm run lint` 0 errors, 197 web tests,
  `next build`, hairline tripwire, `docker compose build web` + live at
  `localhost:3010`. Docs: ADR header + §X Slice 5, CLAUDE.md's floor section
  (new standing `\` bullet) and Key-docs line.

- **2026-07-22 (columnar floor, the nav row — WORKSPACE-COLUMN-LAYOUT-ADR
  Slice 4)** — the ∀ leaves its floating position and the difference lens is
  deleted. New `components/workspace/NavRow.tsx` (`NAV_ROW_H = 56`) is chrome
  only: full-width `position: fixed` at the bottom, neutral bone ground that
  inverts with `html.dark` (global chrome, never a feed island), a 4px slab on
  its top edge as the one divider. The **lockup stays intact** — wordmark and
  ∀ disc adjacent in one fixed container docked at the row's right end via a
  new `ForallMenu anchor="row"` (menu/search open upward), decided against
  §VI's literal split-to-opposite-ends reading because FORALL-CUT §V tunes
  disc-to-cap-height precisely so the two read as kin, and the wordmark is
  part of the trigger, not a label. What §VI was actually after is still
  taken: the wordmark's **separate fixed layer** dies (it existed only so the
  lens could blend without an intervening stacking context) and it becomes a
  plain child of the lockup, collapsing the outside-click handler's two
  `contains` checks to one.
  **Deleted with the lens:** `lensMode` and its painted/punched swap, the
  punched-lens SVG branch, the hoisted un-blended badge twin,
  `stores/lensSuppress.ts` + the `useLensSuppressor` calls in `NewFeedPrompt`
  and `LightboxOverlay`, the `body { isolation }` scope in `globals.css`, the
  canvas `isolation` in `WorkspaceView` (verified safe, not assumed: the
  Vessel's drag/armed raise tops out at z-6, far under the row at 58 and the ∀
  at 60), the `"floating"` anchor, and the dead `wordmarkRef`.
  **Wired:** `deriveGeometry`'s `navRowH` goes live, so the floor ends one GRID
  above the row and no vessel can extend behind it; `usePanePlacement` gains a
  `usableH(vh)` that subtracts `NAV_ROW_H` from the desktop `maxYFor`, resize
  cap and `maxHeight` (the mirror of its mobile `MOBILE_BAR_H` branch),
  unconditional because a member always lands in the workspace so a pane over a
  rowless standalone page is only ever a pre-redirect frame; Explain's
  **pane-mode** cursor bubble 58 → 59 (the row tied it), while floor-mode
  bubbles (50/51/52/53) stay deliberately below the Glasshouse band — raising
  them would also raise them above the About pane, which is meant to frost the
  tour over (the arrow-stepping guard depends on it).
  Two by-eye tunings: the row-anchored disc is **40**, not the floating 46, so
  40 + 2·GRID lands exactly on `NAV_ROW_H` and the lockup is GRID-centred by
  construction (§V's ratio preserved by scaling the wordmark 28 → 24); and the
  wordmark picks its mode explicitly (`chromeFg = discBg` — ink on the light
  row, bone on the inverted one) because moving inside the lockup put it inside
  `LIGHT_ISLAND_STYLE`, where `var(--ah-ink)` resolves canonical-dark in *both*
  modes — the same trap the 2026-06-21 dark-disc-glyph fix documented, arriving
  by a new route.
  Green: root lint 0 errors, `tsc --noEmit` clean, `next build` clean, hairline
  tripwire clean over every touched file, the 63 workspace unit/property tests
  unchanged and passing, `docker compose build web && up -d web` serving 200 at
  `localhost:3010`. Standing docs folded the same day. **Slice 5 (the
  regimented `\` hotkey, §V) was the only one left open at the time of
  writing — it shipped later the same day; see the entry above.**

- **2026-07-22 (columnar floor, the store + the floor — WORKSPACE-COLUMN-LAYOUT-ADR
  Slices 2 + 3)** — the rewrite lands. `stores/workspace.ts` rebuilt around
  `{layout, appearance, regimented}` (two disjoint records; new key
  `workspace:layout:v2:{userId}`; the v1 key read once at hydrate for its
  appearance fields — `textSize`/`orientation` are local-only, so a wholesale
  wipe would lose real settings — coordinates discarded, key deleted), and
  `WorkspaceView`/`Vessel` rewired to render from `deriveGeometry`. **Net −341
  lines**, which is the point: `lib/workspace/collision.ts` (+ its test) and
  `canvas.ts` are gone, along with the origin-compensation choreography in both
  components, `defaultGridSlot`/`DEFAULT_GRID`, `VESSEL_DEFAULT_W`,
  `clearLegacyHidden` and the pre-migration-113 hide push-up, `removeVessel`,
  `healRestingOverlaps`, and `settleAfterAbandonedMerge` — every one of them
  machinery for escaping states the new model cannot enter.
  - **The vessel commits no coordinates at all.** A drag reports only the
    pointer; `resolveDrop` answers merge-vs-insert per frame against a layout
    held stable for the whole gesture (the lifted slot stays in place — see the
    ADR's index contract), and the release commits it. So the vessel *cannot*
    place itself anywhere the model forbids, and a declined merge needs no
    repair: the source never left the layout, so it springs back to its
    held-open slot and the target never moves.
  - **Auto-pan had to live in the Vessel.** Panning moves the canvas under an
    absolutely-positioned vessel, and framer owns `mx` during a drag (rewriting
    it as `dragOrigin + offset` on every pointermove), so the accumulated pan
    can't live in the motion value alone — it rides on top of framer's own last
    write, re-applied both in the rAF loop and in `onDrag`, and by the
    **applied** scroll delta so clamping at the floor's end doesn't walk the
    vessel off the cursor.
  - Three pure additions to `layout.ts` (`slotFor`, `clampSlotSize`,
    `withSlotSize`) so the live gesture and the commit share one definition of
    the envelope, and so a resize preview can feed through derivation and make
    the columns to the right slide *with* the handle.
  - 16 store unit tests (v1 fixtures at 5a/5b/5c shapes, round-trip,
    `reconcileFeeds`). Four mutations — migration lifts nothing · reconcile
    prunes by live not visible · appearance pruned by visible not live · v1 key
    not deleted — were each confirmed to fail them before the tests were
    trusted.
  - Per the ordering note the lens survives: the canvas keeps `isolation:
    isolate` and vessels keep `LIGHT_ISLAND_STYLE` until Slice 4. Ctrl+←/→
    unchanged; Slice 0's virtualization now reads the derived rects (one
    coordinate space, so the pan offset is plain `scrollLeft`).
  - Docs folded the same day: CLAUDE.md's floor section rewritten as the
    columnar rule (the old "infinite sideways" rules are retired, not
    footnoted), the WORKSPACE-DESIGN-SPEC mover-yields addendum marked
    SUPERSEDED, ADR §X carrying the five as-built deviations.

- **2026-07-22 (columnar floor, the pure layout module — WORKSPACE-COLUMN-LAYOUT-ADR
  Slice 1)** — `web/src/lib/workspace/layout.ts` + `layout.test.ts`: the whole
  columnar geometry, wired to nothing. Deliberately renders nowhere yet — this is
  the half property tests can hold to account, and it lands before the store
  (Slice 2) and the floor rewrite (Slice 3), which ship as one commit.
  - **Geometry is derived, never stored.** What persists is an ORDER — columns
    left→right, slots top→bottom, plus per-slot sizes — and `deriveGeometry`
    computes positions, gutters and the scroll extent from it. That is what makes
    the module have no detect/resolve/heal counterpart: `collision.ts` and
    `canvas.ts` exist to escape states this model cannot enter.
  - **Degradation is derivation's job, not the store's.** A shrunken viewport
    (window resize, or Slice 4 subtracting the nav row) compresses `null` slots
    toward `SLOT_MIN_H` first, then squeezes fixed heights proportionally — and
    the STORED layout is never rewritten, so growing the window restores exactly
    what shrinking it hid. A column that cannot fit even at minimums overflows
    rather than silently dropping feeds.
  - **`applyDrop` leaves the emptied column standing while it resolves.** The
    drop's indices address the pre-removal layout (§IV.1 holds the lifted slot
    open for the whole gesture), so the slot is spliced out, its column kept in
    place, the insertion applied, and empty columns pruned at the end — no index
    arithmetic, and the column object (hence its id) survives, which is what
    makes a drop back into a one-slot column a genuine no-op rather than a
    same-looking rebuild. An earlier extract-then-adjust form silently re-homed a
    lone feed into its right-hand neighbour; the property corpus caught it.
  - Three smaller deviations from the ADR sketch, all recorded in its §X: the
    `Geometry` carries `columnH` (so `resolveDrop` needs no second viewport
    argument) and pre-applies `offsetX` (rects are final canvas coordinates —
    one conversion seam, not two); derived fill heights are plain integers, since
    snapping them left orphan pixels at the bottom buffer for no gain while the
    taut claim is about gutters, which stay exact (STORED heights are still
    snapped); and the third-of-a-rect band clamp is defensive rather than
    reachable at the real envelope (`SLOT_MIN_W = 220 > 2·EDGE_BAND = 96`).
  - **`grid.ts` flips to `GRID = 8`**, equal to the vessel `WALL`, restoring the
    phase with the 4px design rhythm that 10 broke — the exact repair its own
    comment anticipated. This retunes the LIVE free-coordinate floor and the
    Glasshouse pane lattice immediately (positions persisted on the 10px lattice
    re-snap on the next gesture, invisible in practice), which is the point:
    it saves a two-lattice interregnum. `collision.test.ts` fixtures re-based off
    the old lattice in the same change; it is deleted in Slice 3 regardless.
  - **Tests:** 47 cases — fixtures pinning each rule, plus four property corpora
    (taut/non-overlapping derivation over random layouts × viewports; every rect
    within the available height where the stack can fit; every pointer position
    resolving to a drop whose application is legal *and* taut; 300 × 20-step
    random gesture sequences staying legal). Widths run to resize scale, per
    `collision.test.ts`'s own lesson that a corpus stopping where legal gestures
    keep going proves nothing about them.
  - **Validation:** 203 web tests pass; `tsc --noEmit` clean; root `npm run lint`
    0 errors; hairline tripwire clean; `next build` compiled; image rebuilt and
    `/reader` 200 on `localhost:3010`. The GRID flip is the only user-visible
    effect of this slice and wants an eye on the live floor.
  - Commit `567bd0d`. Queue: CONSOLIDATED-TODO §9.14 (Slices 2–5).

- **2026-07-22 (workspace virtualization — WORKSPACE-COLUMN-LAYOUT-ADR Slice 0)**
  — `docs/adr/WORKSPACE-COLUMN-LAYOUT-ADR.md` accepted the same day (the columnar
  floor: geometry derived from a stored order, a finite taut floor, slot-resolved
  drops, a fixed bottom nav row, and the death of the ∀ difference-blend lens).
  **Slice 0 is virtualization and ships FIRST, against the current
  free-coordinate floor** — it is the fix for the Firefox memory pressure
  (nothing virtualized: n feeds cost n live hydrated feeds at all times,
  regardless of visibility), it is deliberately independent, and nothing in it
  is thrown away by the layout rewrite that follows.
  - **Visibility set** (`WorkspaceView.tsx`): a vessel mounts its contents iff
    its rect intersects the viewport ± one viewport width. The band is measured
    in **store** space via `panOffset = scrollLeft + originX` — a sum that is
    **invariant** under the gesture-slack origin shift (`originX −d` is cancelled
    by the compensation layout effect's `scrollLeft +d`). This is a deliberate
    deviation from the ADR's canvas-space sketch: the compensation is a *layout
    effect*, so there is one commit carrying the new `originX` against the old
    `scrollLeft`, and reading the band there would unmount most of the floor on
    every drag start. Hysteresis is a 200px dead band on pan (`VIRT_QUANT`, well
    under the one-viewport margin, so nothing on screen is ever parked), driven
    by a rAF-throttled scroll listener plus a layout effect — the latter declared
    *after* the origin compensation, and covering the cold start, since the
    first-paint scroll init assigns `scrollLeft` without dispatching a scroll
    event (a workspace whose feeds all sit far from store-x 0 would otherwise
    boot with an empty band).
  - **Parking** (`Vessel.tsx`, new `contentsMounted` prop): chassis, numeral and
    bar stay mounted — the vessel remains a drag obstacle, a merge target and an
    explainable root — while the card tree unmounts and the interior renders a
    flat wash (no `PullToRefresh` listeners either). The instance surviving is
    the point: it owns the scroll body's scroll position (recorded continuously
    while mounted, restored pre-paint) and the intrinsic-height **pin**. The pin
    matters because `readFloorRects` reads `offsetHeight` for collision and merge
    hit-testing — a collapsed wash would lie to both. It rides a
    `ResizeObserver`, *not* a render-path `offsetHeight` read: the vessel
    re-renders on every drag frame and measuring there would force layout each
    time. Parked before ever measured (intrinsic vessel that started outside the
    band) it wears `MIN_H` — bounded, and self-correcting the moment it enters.
  - `VesselState` (items, `nextCursor`, caught-up watermark) is untouched by
    design — it lives in the host, not the unmounted tree — and the client holds
    **no relay connections** (`web/src/lib/ndk.ts` is types-only; content arrives
    over the gateway REST API), so a park tears down nothing and a remount
    refetches nothing. CLAUDE.md's stale "Web reads via NDK" line corrected in
    the same change (an ADR §IX doc obligation).
  - **Validation:** `tsc --noEmit` clean; root `npm run lint` 0 errors;
    `scripts/check-hairlines.sh` clean on both files; `next build` compiled;
    image rebuilt and `/reader` 200 on `localhost:3010`. **Not verified here** —
    the ADR's own verification bar: Firefox `about:memory` before/after on a
    many-feed workspace, and a hands-on pass that drag/merge/resize behave
    identically against washed vessels. Both need a logged-in session with
    enough feeds to push some off-screen; they are the operator's to run.
  - Commit `6301a46`. Queue: CONSOLIDATED-TODO §9.14 (Slices 1–5).

- **2026-07-22 (owner dashboard — §3.1 shipped)** — the launch-blocking
  operator surface (`planning-archive/OWNER-DASHBOARD-SPEC.md`, adapted to the
  invariants that postdate the April draft), picked per the queue's attack
  order (the Stripe session ahead of it is key-blocked) and §0j discipline #4
  (product-surface work over another audit pass).
  - **Backend** (`gateway/src/routes/admin-dashboard.ts`, registered at
    `/api/v1`): `GET /admin/dashboard/{overview,users,content,config,regulatory}`
    + `PATCH …/config` + the two trigger proxies
    (`POST …/trigger-{settlements,payouts}` → payment-service
    `settlement-check/monthly` / `payout-cycle` via the gate-pass
    `x-internal-token` idiom — NOT `proxyToService`, which sends the wrong
    header). All `{preHandler: requireAdmin}`; `requireAdmin`/`getAdminIds`
    extracted to `gateway/src/middleware/admin.ts` (spec §10.1;
    moderation.ts + external-feeds.ts re-pointed). Spec deviations, deliberate:
    writer-ness derived from published articles (`is_writer` dropped in
    migration 145); outstanding writer money = `ledger_writer_earned` −
    `ledger_writer_earnings` per account (the shipped ledger views, not the
    spec's hand-rolled fee arithmetic); revenue = `tab_settlements` completed
    `platform_fee_pence`; overview also surfaces `payouts_halted` (reason +
    since) and charged-back reads; content health = feed-scorer staleness,
    `jetstream_healthy`, and relay_outbox backlog (no TCP probe).
  - **Config editor rules**: PATCH updates existing keys only — unknown keys
    are refused by name (new dials go via config-defaults.sql, the
    platform_config invariant), `payouts_halted`/`jetstream_healthy` are
    runtime state and refused, numeric keys must stay numeric, `*_bps` clamps
    0..10000, `*_pct` 0..100; every change logged with adminId + old/new.
  - **Regulatory dials** appended to `shared/src/db/config-defaults.sql`
    (6 keys: `tax_trading_allowance_pence`, `tax_vat_threshold_pence`,
    `tax_vat_warning_pct`, `tax_corp_small_profits_pence`,
    `tax_corp_main_rate_pence`, `regulatory_holding_warning_days`) — **no
    migration** (no DDL; a migration INSERT is the banned pattern). In-code
    fallbacks exported as `REGULATORY_DIAL_DEFAULTS` and tripwired against the
    SQL file by `gateway/tests/admin-dashboard.test.ts` (the §0h.7 parity
    pattern; + 4 `ukFinancialYear` cases for the 6-April boundary).
  - **Web**: shared `AdminShell` (auth guard + tab nav Overview · Reports ·
    Users · Content · Config · Regulatory + `← Workspace`) and `Stat`
    primitives (`bg-glasshouse-well` cards, `.label-ui text-grey-600` labels,
    `tabular-nums`, crimson only on warning states); five new pages under
    `web/src/app/admin/`; reports page folded into the shell; `/admin` now
    redirects to `/admin/overview`; `formatPence` added to `lib/format.ts`
    (locale grouping); typed client `web/src/lib/api/admin-dashboard.ts`.
    Sans headings throughout (the spec's Literata call predates the
    no-serif-for-admin rule); no hairlines (2px table rules, 8px ladder bars).
  - **Validation**: gateway tsc clean; gateway suite 381 passed + 5 new;
    schema drift guard all green (Check 4b now carries 66 dials incl. the 6
    new); web `next build` clean (6 admin routes emitted); hairline tripwire
    clean; root lint 0 errors. **Driven end-to-end on the rebuilt dev stack**:
    migrate seeded exactly the 6 new dials; all five GETs return real seeded
    data; 401 anon / 403 non-admin on read AND trigger; PATCH negative
    controls (unknown key, state key, non-numeric, bps range) all 400 with the
    right envelope; valid PATCH round-trips and was reverted; both trigger
    proxies round-trip to payment-service ({processed:0} — dev's awaiting
    writers are KYC-incomplete; {settlementTriggered:0} — no tabs past the
    fallback window); moderation `GET /admin/reports` still 200 post-refactor;
    all six web pages serve 200. Dev residue: `admin_account_ids` on dev now
    holds the `kellenmoen` seed account (was empty) so the dashboard is
    browsable there. Browser-tier look rides the §11 smoke list. Follow-ons
    queued in §3.1: account search/suspend on the Users tab, Reports tab
    badge, prod deploy (standard shape — migrate seeds the dials, no flag).

- **2026-07-22 (§0k fix batch — the queued same-class follow-ons)** — all four
  §0k items, in phases: gateway (1, 2, 4a, 4b) then the web Escape sweep (3).
  All confirmed-live bugs; nothing dark-feature (per §0j discipline #1 these
  had been queued, and the owner called the batch).
  - **§0k.1 — account deletion now clears the writer's feed cards in the same
    transaction** (`gateway/src/routes/auth.ts`): a `feed_items.deleted_at`
    soft-stamp over the account's articles, alongside the article soft-delete —
    the idiom chosen to match the sibling pairing in `manage.ts` (soft-deleted
    article → soft-stamped card; the notes' cards go with the notes hard-DELETE
    via FK cascade, and cms.ts's hard-DELETE pairing with its own hard-delete
    stands). **Driven end-to-end against the rebuilt dev stack**: fixture
    account + published article + feed_items row → dev-login → `POST
    /auth/delete-account` → 200, account `deleted`, article stamped, **feed
    card stamped in the same txn** (pre-fix it lingered until reconcile pass 4,
    up to 24h). No negative control run (would need the pre-fix image); the
    pre-fix behaviour is the §0k sweep's source-verified diagnosis.
  - **§0k.2 — author-timeline hydration no longer silent-fails transient
    errors** (`gateway/src/lib/author-timeline-hydration.ts`): the three
    `safeFetch` sites (atproto feed, AP lookup, AP statuses) now throw on
    429/5xx (definitive 4xx stays a clean settle), and the entrypoint's catch
    clears the TTL guard — porting exactly the `485493c`/D1 treatment, so one
    transient error no longer freezes an author's profile-timeline hydration
    for the full 10-minute TTL. 3 new tests in `author-timeline-guard.test.ts`
    (thrown-failure clears guard; 5xx clears; 4xx keeps the stamp),
    **mutation-verified** (guard-clear reverted → 2 fail).
  - **§0k.3 — Escape double-close swept via one shared hook**:
    `web/src/hooks/useEscapeShield.ts` (stopPropagation-claim + optional
    `yieldTo` for a modal above) applied to all five §0k sites —
    `ProfileFollowControl`, `IdentityLinkControl`, `FollowingTab`'s
    UnsubscribeModal, `VouchModal`, and `AuthorModal` (which keeps its
    lightbox-above yield, §0f-15, while gaining the Glasshouse-below shield) —
    and the SchemeMenu original ported onto the hook so the pattern has ONE
    home. Focus traps / outside-click / focus-on-open behaviour untouched.
  - **§0k.4a** — the deleted-account magic-link refusal now reads "Account
    deleted", not "Account suspended" (`auth.ts` verify branch). **§0k.4b** —
    `parseCursorEpoch` range-clamps to `[0, 1e11]` (~year 5138): a crafted
    finite epoch (`1e300`) previously reached `to_timestamp()` and 500'd;
    out-of-range now degrades to the documented page-1 restart. 2 new tests in
    `feed-cursor.test.ts`, **mutation-verified** (clamp reverted → 1 fails).
  - Validation: gateway `tsc` clean; gateway suite 376 passed (36 in the two
    touched test files, 3 mutations verified across the batch); web `next
    build` clean; hairline tripwire clean on all touched web files; root lint
    0 errors. Browser-tier residue: the five popovers' Escape behaviour is
    jsdom-untestable here and rides the standing §11 consolidated smoke list.

- **2026-07-22 (diagnosis-verification sweep — §0k)** — seven-agent verification
  of the §0j bug catalog: each §0h/§0i fix diagnosis re-derived from pre-fix
  source and checked at HEAD. 8 of 9 CONFIRMED; the `8423cd8` ctor-throw
  consequence PARTIALLY CORRECT (real defect + right fix, but k-of-n could not
  hang and the likelier pre-fix observable was a gateway crash via unhandled
  rejection — correction recorded in §0k). Output is four same-class follow-ons
  queued per §0j discipline, not fixed: account deletion leaving feed cards up
  to 24h (fourth M6 sibling, → §0i.4 cluster); author-timeline hydration's
  silent `!res.ok` return + never-cleared guard (the pre-`485493c` pattern);
  five popovers still double-closing on Escape; two minors (deleted-account
  "Account suspended" mislabel, unclamped cursor epoch → `to_timestamp` 500).
  No code changed. Details: **CONSOLIDATED-TODO §0k**.

- **2026-07-22 (process retrospective — the Jul 21 self-audit loop)** — a
  process review, not a fix batch, prompted by the owner's "going off the rails"
  read. Findings: the code is healthy (backends typecheck clean; the §0h/§0i
  batch fixes 7 live user-reachable bugs, not make-work; the collision arc
  converged with a real property-test corpus) but the *cadence* shows a
  self-reinforcing audit loop — §0i auditing its own prior window, ~520 log
  lines/day, a same-day design discard (the collision push-wave built + hardened
  over two commits, deleted in the third). No code changed. The forward
  discipline (dark-feature findings to the queue not same-day fixes; one audit
  pass per window; validate a mechanism before hardening it; rebalance toward the
  §3 launch-blocking product gaps) is recorded as **CONSOLIDATED-TODO §0j**.

- **2026-07-21 (drift-guard batch — §0h.6/.7/.8)** — three duplications that
  each had a bug class attached, closed with a guard rather than a promise.
  - **Cursor codec (§0h.8).** The M13 rule (`Number`, never `parseInt`; reject
    empty explicitly) was written out three times and the `<epoch>:<uuid>`
    encoder hand-rolled five times. `gateway/src/lib/cursor.ts` is now the one
    home. The two wire formats stay distinct deliberately — collapsing the
    untagged and tagged families would invalidate every in-flight client cursor
    for no correctness gain. **Also closed the undefended half of M13**: a
    `::bigint` cast truncates the epoch inside Postgres, before any decoder
    runs, so no JS care can recover it; the original fix corrected the queries
    but nothing stopped the next one from casting again. Reverting the parser
    to `parseInt` now fails **12** tests where the pre-consolidation fix failed
    7 — one primitive backs every decoder, which is the consolidation paying
    for itself.
  - **Config fallback parity (§0h.7).** Parity chosen over deletion. Both tests
    drive the REAL loaders with an empty config, so they exercise the shipping
    fallback path rather than a copy of the table, and each pins the *other*
    direction too — a seeded value must beat its fallback, since a fallback
    shadowing a present row passes a naive parity check while removing all
    operator control. All 13 agreed: a guard, not a repair. One of the three
    sites was deleted outright — `engagement-baseline-refresh` re-declared the
    five E weights with independent fallbacks.
  - **Resonance E (§0h.6).** Formula extracted to shared builders in the
    existing `bandExpr`/`PCTL_EXPR` idiom. The failure mode is why it earns a
    test: E is the numerator in one module and the denominator in the other, so
    a term reweighted on one side throws nothing — it scores every post against
    a distribution built from a different formula and *presents as mis-tuned
    bands*, sending the next person to retune gates that were never wrong.
  - **Population divergence: found, deliberately NOT fixed.** The scorer bands
    `is_context_only` rows the baseline excluded (reachable — the selection
    filters `deleted_at` only). It reads like a bug and isn't clearly one:
    context-only rows are hidden from feeds but visible in threads and hydrated
    profile timelines, so excluding them leaves visible posts bandless.
    Product question, glyph is dark, and changing scoring population unmeasured
    while dark is what the dial discipline warns against — so the CURRENT
    divergence is pinned by a test that fails if anyone aligns it silently.
  - **Verification.** Every claim mutation-tested (8 mutations across the three
    items, all killed). The resonance refactor was additionally driven
    end-to-end against the dev DB — 613 author baselines, 4 ambient rows —
    because a SQL refactor that only typechecks is the evidence tier this
    programme keeps catching. Suites: feed-ingest 224, gateway 371, shared 101.
  - **Two incidental findings.** `shared`'s `tsc` build never copied
    `src/db/*.sql` into `dist`, so a `migrate.ts` run from `dist` would ENOENT
    on `config-defaults.sql` — not live (the deploy path is `tsx src`) and it
    fails loud rather than skipping the seed, but `dist` should be
    self-contained; build now copies. And a scripted edit of this queue
    truncated `CONSOLIDATED-TODO.md` to zero: `open(p,'w').write(open(p).read()
    …)` opens for write — truncating — *before* evaluating the read. Restored
    from HEAD, redone as read-all-then-write-once. Worth knowing before the
    next scripted doc edit.

- **2026-07-21 (prod deploy — the §0i/§0h code-tier batch)** — prod brought to
  `ecd4499`. **The deploy's main finding was about evidence, not code.**
  - **The pending-deploy memory was substantially wrong.** It listed a large
    backlog (M13 re-fix, migrations 158–161, the workspace arc, brand/lens,
    both 07-21 batches); almost all of it was already live from an
    undocumented ~21:00 BST deploy. `migrate.ts` reported `All migrations
    already applied` / `all dials already present`, which read as alarming and
    was correct. Verified rather than assumed: the app's DB (queried *through
    the container*, not the published port) held 161 rows against 161 files,
    with 158's table, 159's enum value and 160/161's config keys all genuinely
    materialised, and `ss` showed a single listener — so the host runner and
    the app share one database. **N = 0 dials seeded**, the documented prod
    case (prod migrated incrementally from before the genesis dump, so the
    per-migration INSERTs actually ran there; dev, booted from `schema.sql`,
    had been missing 46).
  - **Real gap: exactly the 8-commit code-tier batch** `8e4b5f4`…`ecd4499`.
    Image build times (UTC) against commit times (BST) placed gateway/payment/
    web at 21:00–21:02 BST, i.e. built from `eaad953` minutes before the batch
    began at 21:05; feed-ingest was a day older but already carried resonance
    step 3 (`ee7ea51`). Rebuilt web/gateway/feed-ingest/payment and verified by
    marker: `asOf` 0→3, engagement cursor 0→1, and payment's
    `writer_payout_id = NULL` **2→3** — a partial count, which localised the
    gap far better than a boolean hit/miss would have.
  - **Three marker methods were invalid and are worth not repeating.**
    `docker compose ps`'s CREATED column is container recreation, not image
    build (all six read "44 minutes ago" while the images spanned two days).
    An identifier grep against `web` proves nothing — Next minifies
    client-bundle names, so only string literals survive; `lensSuppress`
    returned empty on a *current* image. And `grep … | head; echo $?` captures
    `head`'s status, not `grep`'s. Recorded in the pending-deploy memory and
    queued as a revision stamp (§8.12) so this stops being forensic work.
  - **Prod reached "schema ahead of code"** — 158–161 applied while feed-ingest
    ran day-old code. Harmless here because all four migrations are additive;
    under a destructive one it would have been live 500s for the rebuild
    window, which is exactly the case DEPLOYMENT.md's order-inversion note
    covers but nothing enforces.
  - **Two deploy traps fixed in the docs** (`5985b30`), both fired in one
    command: the migrate step's `localhost` cannot work (compose publishes
    `127.0.0.1:5432:5432`, IPv4 only, while localhost resolves `::1` first →
    `ECONNREFUSED ::1:5432`), and nothing sets `DATABASE_URL` in a host shell,
    so `$POSTGRES_PASSWORD` interpolated empty. Also replaced the upgrade
    block's `git pull origin master`, which always errors on the prod checkout.
  - **nginx `/media/` lockdown finally applied** (shipped 2026-07-09, never
    deployed): `up -d --force-recreate nginx` for the single-file bind-mount
    inode trap, then verified end-to-end — `PUT /media/upload` → 404,
    `GET /media/<sha>.webp` → 200, `DELETE` → 403.
  - **`reconcile-ledger.sql` clean on prod** — every Part-A check zero rows,
    B1/B2 zero diffs. Low information (all totals 0; prod is pre-launch with no
    money movement), but the A6 unknown-`ref_table` catch-all shipped hours
    earlier is now live and finding nothing.
  - **§0d.1 discharged, condition did not fire** — 3 `open` drives, 0 `funded`,
    all with zero active pledges/pence/pledgers and no draft or deadline. The
    guard is self-limiting: it 403s pledge *creation* too, so a parked drive
    cannot acquire pledges. Re-open if PLEDGES_ENABLED is revived.

- **2026-07-21 (code-tier batch, seven commits `8e4b5f4`…`009801f`)** —
  **§0i.1/2/3/5/6/7/8/9 + §0h.1/2/3/5 discharged.** The queued code-tier
  remainder of the second-pass audit, worked highest-stakes first:
  - **Payments (`8e4b5f4`):** magic-link verify admits only
    active/deactivated (a pre-deletion link no longer mints a
    middleware-dead session for a `deleted` account — mirrors Google OAuth;
    also the §0i.4 last bullet); `rollbackWriterPayoutRows` nulls
    `writer_payout_id` on charged_back reads (state untouched — symmetric
    with the tribute void leg; nothing consumes the pointer post-flip,
    verified); reconcile A6 gains an unknown-ref_table catch-all in BOTH the
    TS worker checks and the SQL twin (the scoped branches were
    default-allow — the next F5-style trigger reuse now halts payouts
    instead of going silently unchecked); writer conformance harness models
    the state filter, handles the new pointer-null UPDATE (was the silent
    fallthrough), and gains a mid-flight charged_back fixture via a one-shot
    `mutateOn` — mutation-verified. §0h.2's M3 cross-ref bullet was already
    discharged by `df4265f`'s comment block.
  - **Feed denormalisation (`a1d4248`):** publication DELETE route removes
    `feed_items` inside its transaction (§0i.3 — the §0f-1/M6 class, third
    sibling; same rowCount guard as unpublish); author-refresh pass 6 keys
    on ORIGIN deletion (`ei_p.deleted_at`), not row absence (§0i.6):
    soft-deleted parents now clear (previously pinned forever, pass 4
    re-writing them), hard-pruned parents RETAIN the last-known name
    (retention prune/GC is storage management — clearing there would strip
    valid attributions once prune churn starts; the decided semantics).
    Pass 4 skips origin-deleted parents; pass 5 stays absence-based (notes
    hard-delete IS the origin signal).
  - **Engagement starvation (`49f9aa5`, §0i.1):** the daily <7d sweep pages
    via a persisted keyset cursor (`engagement_daily_sweep_cursor` —
    payouts_halted-class runtime state: fresh reads, upsert, DELETE-to-reset,
    absent from config-defaults.sql), so successive daily runs rotate the
    whole window instead of deterministically re-reaching the freshest 2000
    (~90% of dev's 19,944 eligible were unreachable forever, freezing counts
    at ~age 6h and poisoning D3's near-final-E premise). Short page resets
    the rotation; stale cursor re-selects from the top same-run; the
    non-daily tiers stay freshest-first; warns corrected. Five-test battery,
    mutation-verified. This also discharges the flip-gate coverage caveat —
    long-tail items now refresh every ceil(window/budget) days.
  - **D6 cursor decay (`90e26ef`, §0i.2):** the scored-mode blend pins its
    age term to a cursor-carried fractional-epoch `asOf`
    (`to_timestamp($asOf)`, minted page 1) — with `now()`, every score
    strictly decayed between fetches and boundary items re-qualified under
    the strict keyset (duplicates / silently short pages). Optional 4th
    cursor part; 3-part pre-deploy and flag-off cursors unchanged.
    Time-shifted pagination test (exact reproduction at pinned asOf, decay
    demonstrated at +1h) + codec round-trip/rejection tests.
  - **Web (`41c6ad1`, §0i.5/7/9 + §0h.5):** lens-suppressor store
    (`stores/lensSuppress.ts`, self-declaring) — `NewFeedPrompt` and
    `LightboxOverlay` now flip the ∀ disc to the painted glyph (they can't
    ride the presence registry: it wires the mobile disc-X to `onClose`);
    FORALL ADR's painted-state list made exhaustive. SchemeMenu Escape stops
    propagation (document-vs-window ordering, M22 precedent) so it no longer
    dismisses the whole FeedComposer; SchemeDot active ring keys off global
    mode (bone-on-dark); trigger+swatches carry `.focus-ring`; the swatch
    aria-label colourway-id exposure recorded as deliberate
    (GLASSHOUSE-AND-PALETTE-ADR §III.4). `PostResonance.networkLabel` picks
    the corpus label by protocol alone (native with NULL custodial pubkey no
    longer reads as open-Nostr).
  - **Hydration/relay (`8423cd8`, §0h.3 + §0i.8):** k-of-n counts only
    DELIVERING relays toward k (two fast empty relays settled the broad net
    near-instantly, caching reply-light for 60s) and counts each relay once
    (duplicate EOSEs); first-event resolves/stores only a filter-requested id
    (a broken relay's instant junk copy otherwise became the exclusive
    result); a synchronous WebSocket-ctor throw decrements `pending` instead
    of hanging the outer promise forever; `fetchFocal` starts the D2
    background poll on `hydrating: true` (the §0f-5 residual), seq-guarded.
    Four scripted-relay tests; empty-EOSE guard mutation-verified; ADR
    amended.
  - **Resonance/rename residue (`009801f`, §0i.9/10):**
    `protocol_engagement_ambient` pairs absent from the rebuild's tmp_e are
    DELETEd in the same transaction (a toggled-off protocol's months-old
    percentiles no longer re-arm scoring when count writes recur; battery
    test, mutation-verified); the Jetstream enrichment self-heal widens from
    NULL-handle-only to missing-OR-failed-resolve via the shared
    `ATPROTO_ENRICH_FAILED_ERROR` marker, so a rename whose one-shot
    getProfile re-resolve failed transiently heals on the existing
    error_count backoff instead of being lost forever.

  Validation: payment-service 177 tests, gateway 361+15 DB-backed blend,
  feed-ingest 214+8 DB-backed baseline; `tsc --noEmit` clean in all four
  workspaces; hairline tripwire clean; `next build` green. Still open from
  §0h/§0i: §0i.4 (account-deletion external residue — product-flavoured),
  §0i.10's poll-TICK skip-log remainder + migrate.ts `;`-split latent + the
  brand geometry decision, §0i.11 workspace test debt, §0h.4 DOM-sweep
  dedupe, §0h.6 E-formula parity guard, §0h.7 num() fallback parity, §0h.8
  pattern-tier (cursor codec, reconcile TS/SQL twins), and §0h.1's
  delete-account DB-test residual.

- **2026-07-21 (docs pass)** — **§0i documentation-tier findings fixed.**
  The resonance ADR's "Absence" battery line no longer contradicts its own
  step-5 correction (NULL rows take the `feed_proof_floor`, not
  proof_term = 0); `feed-rank.ts`'s defaults comment now points at
  `config-defaults.sql` instead of teaching the pre-1d6b756
  "mirror the migrations" model; CLAUDE.md's config-rule rationale corrected
  (the band gates were re-tuned before landing and went into config in the
  same commit as the scoring code — they never shipped hardcoded);
  `jetstream_healthy`'s presence in the defaults file justified in situ
  (state whose absence must read healthy, vs `payouts_halted` whose absence
  IS the state); the missing §7 item-18 bullet (BalanceHeader
  sign-convention copy) restored to the 2026-07-20 entry + closed list;
  THREAD-HYDRATION-LATENCY-ADR gains the 50s poll budget correction, a
  dated amendment recording the 2026-07-21 failure-must-throw semantics, and
  the process-local-registry consequence (multi-replica gateway
  precondition); FORALL-CUT-AND-LOCKUP-ADR §III.1 + LOGO-REFINEMENT-SPEC now
  own the brand-export splay discrepancy honestly (rim-pinning forces
  ≈16.7° vs the canonical ~20.5°; the geometry decision stays queued,
  §0i.10 — don't propagate the export geometry meanwhile). Drift guard
  re-run green after the defaults-file comment.

- **2026-07-21 (second audit + fix batch)** — **§0i: floor-lurch scroll
  compensation, system placements yield, visibility-aware heal, hydration
  silent-success, tribute-void earned-side pairing.** Five-agent adversarial
  review of the full Jul 19–21 window (all 22 commits; remaining findings
  queued as CONSOLIDATED-TODO §0i, with §0h amended for the parts this batch
  discharges). Fixed same-day:
  (1) **Floor lurch on drop (HIGH, `WorkspaceView.tsx`):** contract-to-fit
  committed the narrower canvas width before the origin layout effect ran, so
  the browser had already clamped `scrollLeft` — and the relative `+=`
  compensation then corrected twice: the floor jumped ~a viewport on most
  drops away from the left end, and even on a plain click on vessel chrome (a
  no-move gesture still opens/closes the slack). Ctrl+ArrowRight → any drag
  reproduced it 100%. Fix: a passive scroll listener tracks the live position
  in `floorScrollRef` (scroll events — including the clamp's own — dispatch
  after the layout effect, so the ref is still pre-clamp when read) and the
  compensation is now an ABSOLUTE assignment from it.
  (2) **System placements now yield (HIGH):** `adoptFeed`, the bootstrap
  default slots, and un-hide wrote index-derived/stored positions with no
  clearance check — three non-gesture paths minting resting overlaps in
  violation of the mover-yields guarantee. All three settle through
  `findRestingPosition` (bootstrap against store-estimate obstacles — the DOM
  isn't up; slotted same-boot siblings join the obstacle set; un-hide yields
  to whatever legally took its ground).
  (3) **Heal moved hydrate → bootstrap, made visibility-aware (MED,
  `stores/workspace.ts`):** the hydrate-time heal was blind — it shelved a
  vessel legally resting over a HIDDEN feed's stored rect (hidden feeds are
  not obstacles) and never pruned ghost layouts for feeds deleted on another
  device. New `reconcileLayouts(liveIds, visibleIds)` (bootstrap, before
  anything paints) prunes ghosts and heals over visible feeds only; `hydrate`
  no longer heals; `healRestingOverlaps` takes the include filter.
  (4) **Gesture-slack correctness (MED, `Vessel.tsx`):** the slack-close
  listener now matches the initiating `pointerId` (any second finger's
  pointerup collapsed the origin under a live drag — mx is deliberately
  uncompensated mid-drag, so the commit landed ~a viewport off); Ctrl+arrow
  is ignored while a vessel is held; the resize seed height is floored to the
  lattice (a press-with-no-move committed a fractional intrinsic height that
  the store's round-nearest snap could grow ≤5px into a flush neighbour — and
  handed `clampSizeClear` an off-lattice start it could only freeze on).
  (5) **Merge-failure feedback (MED):** `handleMergeConfirm`'s catch cleared
  `pendingMerge`, unmounting `MergeFeedConfirm` before its error/retry state
  could paint — a failed merge read as a silent close. The rejection now
  propagates to the dialog (which owns retry); Cancel/Escape still settles
  the source via `onClose`.
  (6) **Hydration silent-success — the other half of §0f-5 (MED,
  `external-hydration.ts`):** non-throwing failure exits reported success:
  AppView/Mastodon HTTP failures returned on `!res.ok`, and a zero-event
  nostr harvest returned cleanly (reachable with ZERO relays answered — the
  k-of-n soft deadline fires unconditionally). The job resolved true →
  `hydrating: false` → the client cached the bare focal for the 60s TTL with
  the throttle guard still set: the D1 deadlock in miniature, surviving §0f-5.
  Now transient statuses (429/5xx) and empty harvests THROW (definitive 4xx
  "gone" stays a clean settle). Client twin: the poll budget was unreachable
  past 22.5s (the 46.5s cumulative tick tripped the 45s guard pre-fetch) —
  raised to 50s so the final backoff tick actually fires.
  `thread-hydration-guard.test.ts`: success cases now seed a real harvested
  event; new zero-event-is-failure case.
  (7) **Tribute-void earned-side pairing (MED, `payout.ts`
  `rollbackTributePayoutRows`):** voiding a chargeback-reversed claimed
  accrual on terminal tribute-payout failure left the chargeback planner's
  as-if-paid `tribute_carve_reversal` (+root gross on the author) permanently
  unpaired — completion never runs, the forward `tribute_carve` never posts,
  and `ledger_writer_earned` stayed inflated by +root_gross for a read that
  was fully clawed back (correct earned delta: 0). The rollback now posts the
  balancing `tribute_carve` (−voided sum, account = author, cp = inspirer,
  ROOT only) at the single point the ledger learns the carve will never
  execute; the void UPDATE gained its missing `state = 'released'` filter
  (the `<> 'completed'` guard admits `'reversed'`, whose accruals are 'paid'
  and must stay so). The paid-side unpaired `tribute_payout_reversal` is
  deliberately retained (the documented M3 residual — noted in situ). The
  tribute conformance mock now models the void UPDATE + state-filtered
  release faithfully, with a charged_back × terminal-failure fixture
  asserting void + balancing carve (§0h.1's tribute half).
  **Validation:** payment-service 170/170 (+1), gateway 354/354 (+1), web
  collision 22/22, `tsc --noEmit` clean (web/gateway/payment-service), ledger
  adjacency green, `next build` clean, root lint 0 errors. CLAUDE.md +
  WORKSPACE-DESIGN-SPEC updated (system-placements-yield rule; heal
  relocation).

- **2026-07-21 (night)** — **Collision physics replaced with mover-yields
  placement: nothing else on the floor ever moves.** User report: putting a
  feed down bounced neighbours aside — the push-wave resolver's third-party
  displacement WAS the glitch, and its livelock budget + verify-and-repair
  machinery existed only to make that displacement safe. The no-overlap
  invariant, resting-state reading, pointer/rect merge split, and horizontal
  escape valve all stand; who yields is reversed. `collision.ts` rewritten:
  `resolveCollisions` (wave, MAX_OPS, in-resolver repair) deleted;
  `findRestingPosition` places the mover at the nearest clear lattice-aligned
  in-bounds spot against immovable obstacles (candidate set = requested coords
  × obstacle-edge escapes, directional snap; guaranteed non-empty since x is
  unbounded); `clampSizeClear` stops a resize stretch at the first neighbour
  (per-obstacle cut on the axis losing less of the proposal, floored at vessel
  minimums). `WorkspaceView`: `resolveFloorAround` → `settleMoverAt` (drop +
  declined/failed merge — the SOURCE now slides off; under push the cancel
  path shoved the target away); drag frames do no placement work (the held
  vessel rides over the floor); resize wires the new Vessel `clampResize` prop
  per frame so the commit is clear by construction; the store's dead
  `batchUpdatePositions` removed. `repairRestingLayout` survives with one
  caller (hydrate heal for pre-2026-07-21 persisted piles).
  `collision.test.ts` rewritten to the new contract (22 tests: nearest-spot
  preference, signed-x escape, vertical boxing → sideways, idempotence,
  3000-trial random corpus at resize scale, clamp fixtures incl. mid-cell
  snap + diagonal axis choice + start-size fallback; repair suite kept).
  WORKSPACE-DESIGN-SPEC gains the *Mover-yields placement* addendum;
  CLAUDE.md floor bullets rewritten. Verified: web suite 156/156, root lint
  0 errors, hairline tripwire clean, `next build` clean.

- **2026-07-21 (late evening)** — **Floor slack made gesture-scoped; Ctrl+←/→
  end-jump; lens disc solid-white fix (the fixed-container stacking context).**
  Three user-reported issues from the first eyeball pass of the day's work.
  (1) The floor read as "instantly infinite": `WorkspaceView` passed
  `computeExtent` a full-viewport slack unconditionally, so a viewport of empty
  scrollable floor always sat beyond the outermost feed on each side —
  `canvas.ts`'s own doc said rest slack should be `EDGE_PAD`, but the caller
  never implemented the rest case. Now `canvasSlack` is gesture-scoped: `EDGE_PAD`
  at rest (the floor is exactly the feeds' span + breathing room), a viewport
  only while a drag is live. The origin shift this puts at the gesture
  boundaries is cancelled pre-paint in a single frame: `Vessel` gains an
  `originX` prop with a layout effect that shifts `mx` by the origin delta
  (instant `set`, never the spring — so the spring sync then sees dx ≈ 0),
  paired with `WorkspaceView`'s existing `scrollLeft` compensation layout
  effect; the slack opens via the new `onFloorGesture` prop on pointerdown
  — BEFORE framer samples its drag origin, so drag-frame/commit store
  conversions stay coherent — and closes on window pointerup/pointercancel,
  which batches into the same task (and render) as framer's position commit.
  (2) Ctrl+←/→ jumps the floor to its far ends (`scrollTo` smooth, honouring
  `prefersReducedMotion`); guarded off editable fields (native word-jump),
  other modifiers, mobile, and any open Glasshouse.
  (3) The idle lens disc rendered solid white: the difference blend sat on the
  disc BUTTON, but the fixed lockup container above it is itself a stacking
  context (`position: fixed` forms one even at z-index:auto — the same rule as
  the §IV.5 z-index bug, second instance), so the blend composited against
  nothing. The blend now sits on the outermost fixed container itself (the
  wordmark, which already carried its own blend as a fixed element, was always
  correct — the diagnostic tell); the unread badge hoists out of the
  now-blended container to a later fixed sibling mirroring the lockup geometry
  (§VI: never iridesces; pointer-events pass through). CLAUDE.md's floor and
  ∀ sections updated to carry both corrected invariants. Verified: web tsc
  clean, suite 156/156, hairline tripwire clean, `next build` clean. The ADR
  §VII browser eyeball pass (CONSOLIDATED-TODO §11) remains the visual gate.

- **2026-07-21 (evening)** — **FORALL-CUT-AND-LOCKUP-ADR implemented: the
  negative-space cut mark, the idle disc as a difference lens, the lockup
  rebalance.** §III: brand assets shipped (`web/public/brand/` — true-cut
  SVG+PNG, self-contained on-bone/on-ink pairs, proof sheet; the README states
  the punch-vs-paint rule). §IV: the resting desktop disc is now a real window
  — a white disc with the ∀ punched through (SVG mask), `mix-blend-mode:
  difference` against the workspace, so the body renders as the live negative
  of whatever passes beneath and the letterform shows the TRUE feed; the
  wordmark takes the same blend so a feed edge runs its seam through the type.
  The blend is scoped by `body { isolation: isolate }` (globals.css) plus the
  canvas wrapper's own `isolation` (WorkspaceView) — the latter confines the
  vessels' drag-raise z-indices so the z-auto lens lockup still paints above
  them (any z-index between disc and feed renders the disc solid white — the
  prototype bug, now documented at each seam). Lens holds only while idle
  (`lensMode = !inBar && view closed && !glasshouseOpen && !explainActive`);
  every other state keeps the painted glyph on the z-60 island, and the swap
  lands where hole and paint coincide (§IV.2.2). The hole spins with the
  hover-turn (spin style + 360°→0° reset shared across both svg branches); the
  unread badge hoists to an unblended later sibling in lens mode (§VI: the
  badge never iridesces; `pointer-events: none` so clicks fall through to the
  button). §V: floating disc 56→46, wordmark 24→28, dropdown gap now tracks
  `discSize`. Docs: ADR → Accepted; LOGO-REFINEMENT-SPEC geometry note (the
  cut form's rim-kiss supersedes for that form only — the live button stays
  clear-of-rim per §IV.4); ForAllMark doc comment; CLAUDE.md ∀ rule extended
  with the punch-vs-paint + stacking invariants. Verified: web tsc clean,
  suite 156/156, `next build` clean, hairline tripwire adds nothing (one
  pre-existing comment false-positive in globals.css), root eslint 0 errors on
  touched files. Outstanding: the ADR §VII eyeball pass (feed schemes under
  the lens in light + dark, the lens→paint open-swap, the seam through the
  wordmark, keyboard-focus ring colour over the blend) needs the rebuilt web
  image (`docker compose build web && up -d web`).

- **2026-07-21 (later)** — **Follow-up: the no-overlap guarantee made literal —
  livelock repair, corpus widened to resize scale, hydrate heal.** A review
  probe (~600k randomized legal layouts) falsified two claims in the entry
  below. **(1) The resolver could still rest vessels overlapping**: the wave
  **livelocks** on legal wide-mover geometry (a resize commit is a mover, and
  `VESSEL_MAX_W` is 2000), the `MAX_OPS` exit returned the overlapping
  intermediate state, and that state's signature is vessels at **identical
  coordinates** — the exact symptom the fix below was named for, silently
  persisted. Repro: mover 800×350 at (20,210) on a 760 floor → v0/v1 coincident
  at (820,300); identical at budget 400, 10k, and 1M, so a true livelock, not an
  undersized budget. **(2) The `visited` guard is load-bearing to omit in the
  wave formulation too** — the entry below called its removal "defensive": a
  vessel's second displacement can land it on a *third* vessel, and with a guard
  the pair is never re-tested (~146 per 200k legal layouts rest overlapping).
  Both findings live exclusively above the property corpus's 420px mover cap —
  the corpus stopped where legal gestures keep going. **Fixes**:
  `resolveCollisions` now ends with a **verify-and-repair pass** — it checks its
  own output and, on any residual intersection, deterministically **shelves**
  overlappers past the right edge of everything settled (the horizontal escape
  valve applied wholesale; also backstops `pushClear`'s squeezed-from-every-side
  fallback, which ignores the mover by construction), with a once-per-session
  `console.warn` so budget exhaustion is no longer invisible. The repair
  primitive (`repairRestingLayout`) is shared with a **one-shot hydrate heal**
  in the workspace store, closing the "known residue" below on the spot rather
  than "if it proves common" — a persisted pile renders as *one* vessel on a
  floor with no retrieval affordance, so the user can never see it to report
  it, and that trigger could never fire. Heal detection is conservative so a
  deliberate arrangement is never disturbed: stored widths are exact, intrinsic
  width is the shared default, absent (content-driven) heights are taken at the
  vessel minimum — any overlap found at minimum size is real. **Tests**: corpus
  widened (mover to 1600×600, others to 900×500), both counterexamples landed
  as directed fixtures — the guard fixture discriminates by *position bound*
  (wave-resolved settles left of the mover's right edge; guard-plus-shelf parks
  a vessel past it at x ≥ 1520), because the no-overlap assertion alone is
  satisfied by guard-plus-repair — the deliberate-illegal 50-pile test upgraded
  from "terminates" to "clears", and four unit tests pin the repair primitive.
  Mutation runs: reinstating the guard fails exactly its fixture; disabling the
  repair fails the livelock fixture *and* the widened property test. Suite
  22/22, full web 156/156, `next build` + hairline tripwire clean. Folded in:
  the four vessel size bounds + intrinsic default width consolidated into
  `lib/workspace/grid.ts` (WorkspaceView carried an admitted mirror of
  Vessel.tsx's `WIDTH`; the store's heal would have been a third copy), and
  Vessel.tsx's stale "overflow:hidden handles oversize" comment corrected.
  **Residue, deliberate**: the wave itself still livelocks — the repair makes
  the *outcome* correct, not the wave convergent, so a shelved vessel jumps
  rather than shuffles; acceptable for geometry reachable only by resizing into
  a crowd. The same review's remaining workspace findings (mid-gesture origin
  shift, armed-merge target out of the obstacle set, un-hide/adopt/bootstrap
  bypassing the resolution pass) are queued in CONSOLIDATED-TODO.

- **2026-07-21** — **The no-overlap invariant now actually holds, and
  merge-by-drag stopped fighting it.** A bug hunt over the drag/stretch/collision
  seam found `resolveCollisions` could terminate with vessels still
  intersecting, so *"no overlap in any scenario"* (WIREFRAME-DECISIONS Step 3)
  was aspirational rather than enforced. Two reproductions: a 20px nudge into a
  row of six threw one vessel 1780px right and left two stacked at **identical
  coordinates** (a displaced vessel was re-pushed but never re-enqueued as a
  pusher — the `visited` guard — so the second displacement never propagated);
  and a vertical push clamped to the viewport floor was **accepted as resolved**,
  leaving the vessel under the mover. The clamp bug had a nasty second-order
  effect: since collision otherwise pushed every overlapping vessel away, the
  merge hit-test could only ever fire when collision *failed* — **merge-by-drag
  was reachable only through a defect.** The design question came first (does
  the workspace even want collision, if merge needs overlap?) and the committed
  specs settled it against dropping it: WORKSPACE-DESIGN-SPEC's *"occlusion
  without affording retrieval"* is decisive here, because this workspace has
  deliberately stripped every retrieval affordance a window manager would give
  you — no z-cycling, no alt-tab, no taskbar — and the one locator a vessel has,
  its numeral, is occluded along with everything else. Collision also carries the
  spec's *carrying-capacity pressure*; free overlap would quietly defeat it.
  **Resolution: the rule governs the RESTING state, not the gesture** (spec
  amendment `8fd8815`), so overlap-while-held is legitimate and merge needs a
  *drop target*, not overlap. Collision is a **rect** question, merge a
  **pointer** question; conflating them into one rect test is what made them
  fight. Implementation (`4c933eb`): the mover is now immovable **and in the
  obstacle set** (it was the queue seed but not an obstacle, so nothing was
  tested against it after the first pass); **horizontal is the escape valve** —
  a vertical push that would clamp is no longer available, the resolver spends
  the expensive sideways move, since only the unbounded axis can guarantee
  resolution; displacement propagates in **waves** with no `visited` guard, which
  also keeps a 40px nudge a 40px shuffle (resolving every pair at once let a
  vessel be shoved by a neighbour that was itself about to move). Snapping is
  **directional** (ceil outward / floor inward) so a resting position is both
  lattice-aligned and provably clear — round-to-nearest could settle a vessel
  back inside its obstacle by half a cell. Merge now arms the vessel the
  *pointer* is inside (the dragged vessel's centre sits over things the user
  never aimed at), suspends collision for that vessel alone so the dragged one
  visibly rides over it (raised z-order + 4px armed frame), and **resolves the
  floor when the confirmation is declined or the merge call fails** — that cancel
  path is what makes the invariant true rather than usually-true. Also: **resize
  commits now run a resolution pass** (a stretch left an overlap that no later
  gesture repairs — the same violation by a different gesture); ceremony-hidden
  vessels are marked inert (they render at `opacity: 0` but were live collision
  *and* merge targets, contradicting a comment asserting the opposite); vessels
  with no stored layout are skipped explicitly rather than by accident. **Tests:**
  `web/tests/collision.test.ts` predated the infinite floor (`fef39d1`) and still
  asserted a horizontal bound and `x >= 0` — both backwards under signed store
  coordinates, and it was failing against the *corrected* resolver. Superseded by
  a co-located suite (`web/src/lib/workspace/collision.test.ts`); live coverage
  ported, stale assertion inverted into a test that negative x is allowed. The
  suite catches the previous implementation on **6 of 11** cases, and mutation
  runs confirm the fixtures bite (dropping the mover-obstacle rule, accepting a
  clamped vertical, shrinking the propagation budget, and round-to-nearest
  snapping each fail it). **One mutation survives**: reinstating the `visited`
  guard still passes, including across 3000 tightened random layouts — in the
  wave formulation a vessel never needs a second push that must re-propagate, so
  removing it is *defensive, not load-bearing*; it was a genuine bug in the old
  pairwise algorithm, not this one. **[CORRECTED same day — see the follow-up
  entry above: the guard IS load-bearing to omit; the mutation survived only
  because the corpus capped the mover at 420px, below where second pushes must
  re-propagate. The counterexample is now a directed fixture.]** **Not verified running** (same blocked dev
  container swap): the armed-target *feel* — whether riding-over reads clearly,
  whether arming is too eager when crossing a crowded floor — needs eyes in a
  browser; a ~250ms dwell before arming is the tuning knob and drops into
  `handleVesselDragFrame` without touching the resolver. **Known residue:**
  layouts already persisted to `localStorage` by the buggy resolver may hold
  stacked vessels, and the resolver only fixes what the *mover* disturbs, so an
  existing pile stays piled until someone drags one of its members; a one-shot
  heal on hydrate is the fix if it proves common. **[Closed same day — the heal
  shipped, see the follow-up entry above; "if it proves common" was unfireable,
  since a pile renders as one vessel and cannot be reported.]** Docs: WORKSPACE-DESIGN-SPEC
  addendum, WIREFRAME-DECISIONS Step 3 note, CLAUDE.md › *Desktop workspace
  floor*.

- **2026-07-20** — **The workspace floor extends infinitely sideways; the snap
  lattice halved to 10px.** The floor was a fixed `100vh` box with
  `overflow: hidden`, and seven places encoded "the floor is the viewport" (the
  drag clamp, the resize ceiling, framer's `dragConstraints`, the collision
  bounds, the default grid pack, the merge hit-test). It is now the scroll
  viewport onto a canvas whose horizontal extent is **derived** from the vessels
  on it (`web/src/lib/workspace/canvas.ts`) — drag a feed past the edge and the
  space stretches, drag it back and the space contracts; nothing new is
  persisted. Vertical extent stays the viewport, so a feed can never hide below
  the fold. Store coordinates became signed with no origin, so the canvas
  carries an `originX` (native scroll has no negative offset) and the store↔canvas
  conversion happens at exactly one seam — the `Vessel` call site — with
  collision, merge hit-testing and persistence all staying in store space.
  Clamps are axis-split (`resolveCollisions` now takes `{ h }` only); framer's
  `dragConstraints` is gone. **Two decisions worth re-reading before tuning
  this:** (1) slack beyond the outermost vessel is a *full viewport*, not the
  40px `EDGE_PAD` a literal reading of contract-to-fit implies — that confines
  origin shifts to gesture boundaries, where a single `scrollLeft` compensation
  is invisible, rather than every frame, where it jitters and loses a fight with
  framer for ownership of the motion value; the visible cost is ~one screen of
  scrollable emptiness each side, as in Figma/Miro. (2) The floor pans by
  **native scroll, never a transform** — a transform establishes a containing
  block and captures the `position: fixed` ∀ chrome and mobile bar, which is
  precisely what must stay pinned bottom-right and superimposed over the feeds.
  Scrollbar suppressed via a new `.scroll-silent` (a native one draws a banned
  single-pixel rule). Separately, `GRID` was halved 20 → 10 for finer placement:
  it is a **shared** lattice, so Glasshouse pane drag/resize moved with it. That
  gives up the old 20 = LCM(10, 4) property that kept the floor in phase with
  the 4px design rhythm; 10 is still even, so vessels and panes keep landing on
  whole pixels and the sub-pixel-blur rationale survives — 8px is the nearest
  value that would halve the grid *and* keep the 4px phase, if the drift ever
  shows. **Not verified running** (the dev container swap is blocked on the
  stale-AppArmor issue), and **no edge-pan**: a single drag moves a feed only as
  far as the pointer reaches within the viewport, so a long move is
  drag-release-scroll-drag. Both are the obvious follow-ups. Docs: CLAUDE.md
  › *Desktop workspace floor*, `WORKSPACE-DESIGN-SPEC.md` › *The workspace* +
  *Position*.

- **2026-07-20** — **Resonance test battery built (ADR steps 2–3), and two
  clauses proved redundant by mutation.** The ADR specified a nine-item test
  battery; steps 4 and 5 were covered when they shipped, but the **scoring
  engine itself — shrinkage, the ambient veto, the band gates, absence
  semantics, D2a composition — shipped with zero tests**, which is the exact
  "component ≠ feature" shape §11 catalogues. Now 27 tests across
  `feed-ingest/src/lib/resonance.test.ts` (20) and
  `.../tasks/engagement-baseline-refresh.test.ts` (7); feed-ingest 221 → 248.
  - **Both run the crons' OWN SQL.** `EXTERNAL_RESONANCE_SQL` /
    `NATIVE_RESONANCE_SQL` extracted as exported constants and `refresh()`
    exported (typed `ClientBase`, not `PoolClient` — it needs only `query()`),
    so a test drives the real strings on its own rolled-back client instead of
    a copy that can drift. Pure extraction: no SQL body changed.
  - **Isolation.** The external pass keys its ambient join on
    `feed_items.source_protocol`, which is free TEXT — so fixtures file under a
    synthetic `test_proto` and no test can touch the shared atproto/activitypub
    ambients or be perturbed by the 26,727 real scored rows.
  - **Mutation-verified, and that is where the value came from.** 18 mutations
    applied one at a time; **16 detected, 2 survived — correctly.** Working out
    *why* the survivors survived produced the two findings below, which a green
    suite would have hidden. (Three earlier "survivors" were harness artifacts —
    a first-occurrence-only replace hitting the wrong one of two identical
    substrings. Worth noting as a trap: a mutation that doesn't apply where you
    think it does reads exactly like a test gap.)
  - **FINDING 1 — the band-2 ambient veto is unreachable.** `n` is capped at 20
    by `BASELINE_LAST_N`, so `baseline ≥ 3·p50/23`; `resonance ≥ 4` then forces
    `1+E ≥ 16 + 2.087·p50`, while the veto binds only when `1+E < 1+p50`.
    Together: `p50 < −13.8`, impossible. Anything scoring band-2 resonance has
    already cleared p50 arithmetically. The band-1 arm is reachable, but only
    above ambient p50 ≥ 22 — so D4's veto does real work on band 1 alone.
    **This bounds a claim the ADR makes**, and it means my first veto fixture
    (n=100, p50=10) tested a state production cannot reach; rewritten to
    n=20/p50=25/E=24, which it can.
  - **FINDING 2 — `PCTL_EXPR`'s `p50_e <= 0` branch is redundant**, computing
    exactly what the general path computes at p50 = 0 (the divide-by-zero it
    guards is already unreachable via that segment's own `e < p50` guard).
  - Both clauses **retained** (zero cost, they document intent) and recorded in
    the ADR under *Clause redundancy* plus in-file mutation logs, so the next
    reader doesn't mistake a surviving mutation for an untested branch.
  - **Battery correction:** the ADR's "n=20 author is ≥87% own-median" holds
    only when ambient p50 > 0 — it is exactly 86.96% at p50 = 0. Tested as the
    algebra, ADR amended.
  - **`sample_n` pinned despite having no code reader** — it is the diagnostic
    an operator reads when re-measuring band incidence on prod, which is the
    standing gate on `RESONANCE_GLYPH_ENABLED`; a wrong denominator there
    misinforms tuning rather than breaking a feature.
  - **Still open:** *monotonic writes* is the one battery item deliberately
    uncovered — it belongs to the engagement cron's count writer, not to either
    module tested here. feed-ingest suite 248/248, tsc clean, root lint 0
    errors.

- **2026-07-20** — **`platform_config` defaults never landed on a fresh DB —
  fixed, and the hole closed in CI.** (Found during resonance step 5;
  CONSOLIDATED-TODO §9.13, now struck.)
  - **The bug.** `schema.sql` is the genesis base and is structure-only
    (`pg_dump`, no data), but it *also* seeds `_migrations` with every migration
    filename — so `migrate.ts` skips those migrations as already-applied and
    their `INSERT INTO platform_config` never executes. Every dial seeded by a
    migration older than the current genesis dump was therefore **absent** on
    any DB booted from `schema.sql`. Measured on dev: **31 of 45 missing** —
    `feed_gravity`, all four `feed_weight_*`, all nineteen `feed_ingest_*`,
    the `outbound_*` set, `admin_account_ids`, `jetstream_healthy`,
    `publication_payout_threshold_pence`, `max_subscriptions_per_user`.
  - **Mostly masked, but not entirely.** Every consumer carries a code fallback
    equal to the seeded value, so *reads* behaved correctly — but that silently
    demotes an operator dial to a constant (an `UPDATE` on a missing row changes
    nothing and reports no error). It was **not** masked for `jetstream_healthy`:
    the listener's `setHealthy` was a bare `UPDATE … WHERE key =
    'jetstream_healthy'`, which matched zero rows and threw nothing, so the
    listener could never record itself unhealthy — and since the consumer reads
    `!== "false"` (absent ⇒ healthy), **the atproto polling fallback in
    `feed-ingest-poll.ts` could never engage**. A Jetstream outage meant silent
    ingestion loss with no fallback, on every fresh DB.
  - **The fix.** Defaults move out of migrations into
    **`shared/src/db/config-defaults.sql`**, applied by `migrate.ts` on **every**
    run (after the chain, including when nothing is pending — that is how an
    existing DB self-repairs with no remediation step), always with `ON CONFLICT
    (key) DO NOTHING`, so a tuned value is never overwritten. The file is
    resolved against the module, not `process.cwd()`, and a missing file is
    **fatal** rather than a skip. The 11 historical seed statements were folded
    in verbatim, extracted with a real SQL statement splitter rather than a grep
    — several descriptions contain a `;` ("reserved; inert until zap
    ingestion"), which silently truncated 6 of migration 158's 10 keys on the
    first naive pass. Two of them (038, 052) had no `ON CONFLICT` clause; added,
    since the file is re-applied every run.
  - **`setHealthy` is now an upsert**, independently of the seed — a write path
    must not depend on a seed having happened.
  - **Not in the defaults file, deliberately:** `payouts_halted`, which is
    runtime *state* whose absence means "not halted" and which `resumePayouts`
    DELETEs. A seeded default would fight the resume path. Only tuning dials
    belong there. (It is also the only key in dev not covered by a migration
    seed — verified, not assumed.)
  - **Scope check:** the other data-writing migrations (`ledger_entries`,
    `feed_items`, `external_authors`, `trust_layer1`) are all `INSERT … SELECT`
    **backfills** over pre-existing rows. On a fresh DB there is nothing to
    backfill, so skipping them is correct — the bug class really is
    `platform_config`-only.
  - **CI, three new drift-guard checks** (`scripts/check-schema-drift.sh`):
    **4a** no migration outside the closed historical allowlist may
    `INSERT INTO platform_config` (comment-stripped, so prose doesn't trip it);
    **4b** the Check-1 fresh DB carries every key `config-defaults.sql` defines,
    i.e. `migrate.ts` really applies it — ground truth derived by applying the
    file to an empty table in a second throwaway DB, so no SQL parsing in bash;
    **4c** replaying every migration seed on top of the defaults inserts
    nothing, i.e. the defaults file lost no key in the fold and loses none to a
    later edit (uses `scripts/extract-config-seeds.ts`, the same splitter).
    All three **mutation-verified**: a seed added to an existing migration trips
    4a, removing the `applyConfigDefaults` call trips 4b, and deleting one key
    from the defaults file trips 4c.
  - **Verified:** dev repaired (31 seeded, second run a clean no-op); an
    operator-tuned `feed_gravity=9.9` survives a migrate run untouched; full
    suite green, lint 0 errors, `tsc` clean across shared/feed-ingest/gateway.
  - **Rule added to CLAUDE.md** (tuning-dial section): dials go in
    `config-defaults.sql`, never a migration; never `UPDATE platform_config`,
    upsert.
  - **Second pass — 15 more dials that had no default row ANYWHERE.** Sweeping
    every `platform_config` key read across the services (not just the ones
    migrations seed) found fifteen that were pure code constants:
    - **Six money dials** — `platform_fee_bps`, `free_allowance_pence`,
      `tab_settlement_threshold_pence`, `monthly_fallback_minimum_pence`,
      `monthly_fallback_days`, `writer_payout_threshold_pence`. These were
      seeded by an `INSERT INTO platform_config` inside **`schema.sql` itself**,
      until **`f8c73e6` "chore(schema): regenerate schema.sql from current DB
      state"** replaced it with a `--schema-only` dump and silently dropped the
      data. Since then nobody could change the platform fee by any means but a
      deploy. Recovered values verified identical to both the pre-`f8c73e6` seed
      and today's `loadConfig` fallbacks — restores the dials, changes no
      behaviour. That commit is also the standing argument for why config data
      must never live in `schema.sql`: a regeneration will drop it again.
    - **Nine feed-ingest/GC dials** — the adaptive-RSS ceiling and both interval
      factors, the nostr backfill window, the engagement per-run cap, the email
      error cap, and the three external-GC retention dials. Four of them
      (`rss_max_interval_seconds`, both RSS factors, `engagement_max_items`)
      are *specified* in UNIVERSAL-FEED-ADR §IV.9 but never made it into
      migration 052 — spec'd, documented, never real.
    - **Not resurrected:** `note_char_limit`, `comment_char_limit`,
      `media_max_size_bytes` were in the same genesis seed but have no reader
      anywhere (all services + web). Dead config stays dead.
    - **Logged, not silently reconciled:** `feed_ingest_max_errors` (50, read
      only by the email adapter) vs `feed_ingest_max_error_count` (10, every
      other adapter) — two keys, one meaning, 5× apart. Both seeded at current
      values; unifying them changes live ingest behaviour. → CONSOLIDATED-TODO.
    - Dev now carries **60** dials; the stale `loadConfig` header comment
      ("these match the INSERT statements in schema.sql exactly") was corrected
      to point at `config-defaults.sql` and record why schema.sql must not hold
      config data.
  - **This was a re-discovery, not a discovery.** `AUDIT-BACKLOG` **D1**
    (2026-06-07) diagnosed the identical root cause — "`schema.sql` carries no
    `platform_config` seed data while its `_migrations` seed marks 106
    already-applied" — and explicitly noted the same omission stranded the RSS
    interval, backoff/decay factors and engagement cap. The fix taken then was
    to change one consumer's code fallback, with the structural work deferred to
    a "B1 genesis-seed" item that never happened; six weeks later it was
    rediscovered from scratch during resonance step 5. The entry is now marked
    closed with that lesson attached: patching a consumer's fallback leaves the
    mechanism broken for every other key.
  - **Docs corrected** where they'd have taught the old pattern:
    UNIVERSAL-FEED-ADR §IV.9 and PUBLICATIONS-SPEC (both show a migration
    seeding config) now carry a superseded-mechanism note;
    UPSTREAM-EDGES-BUILD-PLAN's "all four checks green" instruction updated.
    Historical log entries saying "all 4 checks" are left alone — they were
    true when written.
  - **Outstanding, needs the operator:** whether **prod** was affected. It may
    have been migrated incrementally from before genesis, in which case its rows
    exist and the two environments differed. The next prod `migrate.ts` run
    repairs it either way and prints the count — compare against dev's 46.

- **2026-07-20** — **Resonance step 5: the D6 read-time proof blend, shipped
  dark.** (SOCIAL-PROOF-RESONANCE-ADR Sequencing step 5 / D6;
  CONSOLIDATED-TODO §9.12.)
  - **The blend.** `gateway/src/lib/feed-rank.ts` (new) owns the two SQL
    builders — `feedAlphaCte` + `proofBlendScoreSql` — spliced into the `scored`
    CTE of `sourceFilteredItems` (`routes/feeds/items.ts`), replacing the
    `COALESCE(fi.score, 0) * m.weight` numerator for the `scored` sampling mode
    only. `fi.score` and `feed-scores-refresh`'s gravity write are untouched:
    they are the flag-off fallback, so the brake needs no backfill and is
    instantly reversible. The four blend params are appended AFTER the optional
    cursor pair so their `$n` indices don't shift with cursor presence.
  - **α is derived, not stored.** A feed carrying a non-muted `reach:explore`
    source *is* the explore surface (`feed_alpha_explore`); anything else is
    following-shaped (`feed_alpha_following`). Keeps the surface decision
    derived from what the user composed, with no third place to drift.
  - **Correction to D6 as drafted — `proof_term` needs a floor.** The ADR said
    NULL-band items (rss/email, dark nostr) "take `proof_term = 0` and rank on
    recency alone within the gravity expression". They cannot: `0/(age+2)^g` is
    0 at *every* age, so a zero proof term collapses every silent item onto one
    constant score and the `ORDER BY` falls through to its uuid tiebreak —
    arbitrary order, strictly worse than the chronology D6 replaces. Added
    `GREATEST(…, feed_proof_floor)`, seeded at 0.05 by **migration 161** as a
    `platform_config` dial per the tuning-dial rule (its right value is only
    knowable from a live mixed feed: it sets how far a silent-but-fresh item may
    outrank a resonant-but-older one). ADR D6 amended in place.
  - **Read-time clamping**, also new: `resonance` is unbounded above and
    negative below, `ambient_pctl` is a plain `NUMERIC`. Both are clamped so one
    bad row can't dominate a feed's ordering — and negative resonance clamps to
    0 rather than *subtracting*, since a below-baseline post that is still top-
    decile for its network keeps its ambient proof.
  - **`gateway/src/lib/platform-config.ts`** (new, deliberate sibling of
    feed-ingest's): 30s in-process cache, so the hottest read path in the
    service doesn't add a `platform_config` SELECT per feed page × every feed in
    a `/bootstrap` fan-out.
  - **Not converted:** `placeholderExploreItems` (the empty-vessel fallback).
    It selects native items only, so D6's commensurability argument doesn't
    bite, and its cursor filters the `fi.score` *column* directly. The real
    explore surface is a `reach:explore` source inside a composed feed, which
    goes through `sourceFilteredItems` and does take `feed_alpha_explore`.
    Documented at the function.
  - **Brake:** `RESONANCE_RANKING_ENABLED`, default OFF, gating the one splice
    point (`DEPLOYMENT.md` row + `docker-compose.yml` default). Deliberately
    **independent** of the step-4 `RESONANCE_GLYPH_ENABLED`: ranking on
    resonance and displaying the band are separate claims with separate
    evidence bars, so the explore A/B can run with the glyph still dark.
  - **Tests:** `gateway/tests/feed-rank-blend.test.ts` — 14 cases against a live
    Postgres, all fixtures rolled back, exercising the *real* builders (the
    dedup-integration pattern). Covers ordering by proof, ordering by age,
    NULL-item recency ordering, the silent-below-resonant rule, all three
    clamps, α selection incl. the muted-source case, and weight composition.
    Then **mutation-verified**: seven implementation mutations (drop the floor,
    swap the alphas, drop each clamp, drop the weight multiplier, ignore
    `muted_at`) were each confirmed to fail the suite. One survived first pass —
    the negative-clamp test only asserted `score > 0`, which the floor satisfies
    on its own — so it was sharpened to compare against an ambient-matched item.
    Full suite green (31 gateway test files), root lint 0 errors, `tsc` clean.
  - **Smoke, real route + real dev feed** (`loadFeedItemsPage`, 11-source feed
    forced to `scored`): flag off → every item scored 0, cursor `scored:0:<uuid>`
    — i.e. that surface is ordered *by uuid* today, because `fi.score` is only
    ever written for native items. Flag on → positive scores, page shifted to
    items ~4 days fresher, page 2 paginated cleanly against the computed score.
    Recorded in the ADR as the *Step-5 note*, with its consequence: the flag-off
    state is **not** a meaningful control for the A/B on external-heavy feeds;
    the honest comparison there is against chronological.
  - **Side-finding, logged not fixed** (CONSOLIDATED-TODO §9.13): pre-genesis
    `platform_config` seeds never land on a fresh DB — `schema.sql` is
    structure-only but seeds `_migrations` with every filename, so `migrate.ts`
    skips those migrations and their config INSERTs never run. Dev is missing
    `feed_gravity` + the four `feed_weight_*` keys from migration 035. Masked by
    code fallbacks today, but it silently demotes an operator dial to a
    constant.
  - **Still outstanding:** the A/B measurement itself (needs prod volume), and
    the two step-3 measurements gating the step-4 glyph brake.

- **2026-07-20** — **Resonance step 4: the D7 glyph, wired end to end and
  shipped dark.** (SOCIAL-PROOF-RESONANCE-ADR Sequencing step 4 / D7;
  CONSOLIDATED-TODO §9.12.)
  - Plumbing, the ADR's own path: `fi.resonance_band` added to `FEED_SELECT`
    (`gateway/src/lib/feed-sql.ts`) → `Post.resonanceBand` in
    `gateway/src/lib/post-mapper.ts` and its web mirror
    `web/src/lib/post/types.ts` → `showResonance` on `ResolvedSpec`.
    Verified safe across all seven `FEED_SELECT` consumers first: the only
    `GROUP BY` in that neighbourhood (`items.ts` `matched` CTE) projects
    `fi.id` alone, so it can't be broken by an added column.
  - `web/src/components/post/PostResonance.tsx` renders `·` / `··` / `···` for
    bands 1–3 in `palette.cardMeta`, in the byline metadata cluster via the
    `trailing` slot (ahead of any caller trailing, so price/protocol badges stay
    rightmost). The D4 two-clause gloss is both `title` and `aria-label` —
    author-relative clause + ambient clause naming the network it was measured
    against ("all.haus" for native, since a native post is scored against the
    house corpus, not the open Nostr network).
  - Level-gated per D7 to `feed` + `focal` only, and **not** tier-masked:
    resonance measures response, not identity, so the silence on rss/email
    comes from D4's absence semantics (no band computed) rather than a mask —
    keeping "no band" and "band 0" distinct all the way up even though both
    render nothing. Explain kind `card.resonance` registered in the union,
    `CARD_KIND_ORDER`, and `EXPLAIN_LABELS` (the `Record<ExplainKind>` type
    makes a missing caption a build failure).
  - **Shipped behind `RESONANCE_GLYPH_ENABLED`, default OFF.** The brake gates
    the MAPPER, not the renderer: while off the band is nulled for every read
    path and never leaves the gateway, so there's no client flag to drift and
    no half-lit state. Chosen over the ADR's unflagged step-4 because the
    migration-160 gates are dev-tuned and the per-protocol band-3
    re-measurement is still outstanding — the queue item now records that
    measurement as the gate on flipping it, not merely as follow-up.
  - Verified: gateway tsc + 353 tests; web tsc + `next build`; root eslint 0
    errors; hairline tripwire clean on all touched files. Four new
    `level-spec.test.ts` cases (level gate, bands 1–3 vs 0, absent band, no
    tier mask) — **mutation-checked**: inverting the band gate to `>= 0`,
    deleting the level gate, and flipping `thread-parent` on each turned the
    suite red, and it went green again on restore. Brake proven against live
    dev rows (band 3 present in 619 rows): same query, `mapped=null` with the
    brake off and `mapped=3` with it on.

- **2026-07-20** — **Resonance step 3: per-item scoring in the refresh crons,
  and the tuning verdict it was built to produce.** (SOCIAL-PROOF-RESONANCE-ADR
  Sequencing step 3; CONSOLIDATED-TODO §9.12.)
  - New `feed-ingest/src/lib/resonance.ts` writes the three migration-158
    columns (`resonance` / `resonance_band` / `ambient_pctl`) from stored counts
    + the daily baselines. `external-engagement-refresh` recomputes exactly the
    rows whose counts moved — folded into `batchUpdateCounts`, plus a separate
    call for the Mastodon media rows that bypass it; `feed-scores-refresh` runs
    the D2a native union (votes / read_events / feed_engagement) over a 7-day
    window as a pass distinct from the gravity query it shares a cron with.
    Both recomputes are non-fatal: a resonance failure must never cost an
    engagement-count refresh or a hotness refresh.
  - **Dark by construction, not by flag** — nothing reads the three columns
    until steps 4 (glyph) and 5 (ranking), so there is no behaviour to gate.
  - **The measurement was the point, and it failed the ADR's own targets.**
    Over 26,719 real Bluesky + Mastodon items the draft gates (resonance
    ≥ 1/2/3) gave band ≥ 1 on 30–35 % against a 10–15 % target, and band 3 on
    6–9 % against ~1 %. Diagnosis: the ambient veto rarely binds (66 % of
    atproto items clear a corpus median E of 4) — the resonance gate does all
    the work, and observed resonance p85 was already ~2.1–2.6, so "≥ 1" sat
    near the 65th percentile.
  - **Migration 160 moves the gates out of the code into `platform_config`**
    (2.5 / 4 / 6 → 11.7 %/1.3 % activitypub, 15.5 %/3.2 % atproto). They are
    config for the same reason the weights are: tuning a band must not need a
    deploy. Deliberately not over-fitted further — see the two carried-forward
    open questions (per-protocol band-3 gates; the native up-vote weight, which
    dev's 8 scored native items could not test).
  - Absence semantics verified empirically, not assumed: all 7,392 dark-nostr
    and 230 rss rows scored NULL, and `ambient_pctl` was inside [0,1] on every
    scored row.
  - Verified: drift guard 4/4; feed-ingest tsc + 209 tests; root eslint 0
    errors; both passes executed against the dev corpus before and after the
    retune.

- **2026-07-20** — **§7 cleanup cluster: one batched pass.** Fourteen of the
  eighteen items closed; two dispositioned without code; two narrowed. Every
  fix re-verified in source first, and the three with a testable premise were
  proved empirically rather than asserted.
  - **1** Composer dead chip/DM machinery deleted — `chips` had no setter, so
    `isPrivate` and the whole `messagesApi` send branch were unreachable;
    removed the state, the `ToChip` type, `isMixed`/`isPrivate`/`hasPersonChip`/
    `hasBroadcastChip`, the mixed/private hint copy, and the "Sending…"/"Send"
    button branches. `broadcastProtocols` collapses to `enabledProtocols`.
  - **2** `ParentContextTile.tsx` deleted (zero imports); `PostCard`'s unused
    `header` prop, its render slot and stale comment removed; dead
    `ReplyGroupItem`/`reply_group` type dropped from `ndk.ts` (not in the
    `FeedItem` union, zero references) — the one-post-per-card residue.
  - **3** `expandedByFeed` key leak closed — the drop-the-key idiom is now the
    shared `clearExpandedFor(feedId)` callback, called on refresh (as before)
    **and** on feed delete + merge, where the key used to survive its vessel.
  - **4** Stale `reply_to_author` now re-NULLed: passes 3/4 are inner joins and
    could only ever WRITE a name, so a deleted/unresolvable parent pinned its
    byline forever. Added passes 5/6 mirroring each sibling's join chain
    exactly (and the trigger's — there is no third resolution path). **Verified
    against dev data:** 0 of 13,271 resolved replies touched (no false
    positives), then a positive control in a rolled-back transaction — deleting
    a parent flipped exactly 1 row to NULL.
  - **5** njump.me permalink for external-Nostr: `originWebUrl` returns
    `https://njump.me/<uri>` for bech32 `nevent1`/`naddr1`/`note1`. Scoped to
    bech32 deliberately — native posts hold a raw hex event id and must keep
    linking to all.haus, and the relay-free identity invariant guarantees
    external-Nostr URIs are bech32.
  - **6** **Closed as compliant, no change.** The FeedComposer source row is
    the documented `ref` fallback (`openProfileHref`/`isModifiedClick`), and it
    routes account vs publication/source/tag separately — swapping to
    `<ProfileLink>` would be a REGRESSION, mis-classifying `/pub/:slug`,
    `/source/:id` and `/tag/:name` as native profiles.
  - **7** Per-host enqueue throttle now logs what it dropped
    (`skippedByHostCap`/`skippedByTickCap`/`skippedNoTask` + the capped host
    names and both limits) — a starved host was previously indistinguishable
    from an idle one. Counting only; the cap itself is unchanged.
  - **8** Lint suppressions restored. Of the five stray `{ }` from `f9cbf3f`,
    three files were since retired (legacy `components/feed/` cards) and
    Composer's was already gone, leaving `ArticleEditor`'s — restored, plus the
    `AuthorProfileView` suppression that commit deleted outright rather than
    braced. Both are `@next/next/no-img-element` (will error when `next lint`
    is wired).
  - **9** Infinite-scroll duplicate-fetch race fixed with a synchronous
    `loadingMoreRef` latch. The old guard read `loadingMore` off `vesselsRef`,
    which only catches up on re-render, so two scroll events in one tick both
    saw `false` and fetched the same cursor twice. Vessel `loadingMore` is now
    presentation-only (the spinner); the ref is the concurrency guard, cleared
    in `finally`.
  - **10** **Rejected — the finding is not implementable.** `referrerPolicy` is
    not a valid attribute on `<video>` (HTML allows it only on
    `a`/`area`/`iframe`/`img`/`link`/`script`); adding it fails typecheck. The
    poster `<img>` correctly carries it. Residual leak is bounded by nginx's
    document-level `Referrer-Policy: strict-origin-when-cross-origin`, so a
    cross-origin media host sees the origin, never the path.
  - **12** Migrate-runner guard fixed, **both halves proved empirically.**
    Detection now runs against a comment-stripped copy (never executed): the
    raw match routed any migration whose PROSE mentions CONCURRENTLY onto the
    no-transaction path, silently giving up rollback — **live on two real
    migrations**, 022 and 083, whose comments both say "CONCURRENTLY removed".
    Added a pre-flight refusal for a multi-statement CONCURRENTLY file with an
    actionable message (Postgres wraps multi-statement files in an implicit
    transaction, which CONCURRENTLY refuses — confirmed against PG16, as was
    the fact that ALTER TYPE ADD VALUE is permitted in a transaction since
    PG12, so that guard is now documented as conservative rather than
    required). Both behaviours driven end-to-end against a throwaway DB, and
    the comment-stripping **mutation-verified** (reverting detection to raw SQL
    changes the outcome). Note the earlier "partial application" worry was
    checked and is FALSE — the implicit block rolls back cleanly.
  - **13** Bluesky handle renames now heal. Two gaps: nothing triggered
    (enrichment self-heal fires only on a NULL handle) and `repairAtprotoAuthors`
    is fill-only. Added an `identity`-event branch to the Jetstream listener
    that re-enqueues enrichment under the existing job key, plus a DID-keyed
    `external_authors.handle` refresh-on-change (the byline reads `xa_handle`
    ahead of the per-item snapshot). **Premise verified against live
    jetstream1.us-east:** identity events ARE delivered alongside
    `wantedCollections` (9 in 2,160 messages) and frequently carry NO handle —
    hence re-resolve rather than trust the event. Per-item `author_handle` stays
    a historical snapshot; `display_name` keeps fill-only semantics (an account
    with no displayName resolves to "@handle", which must not overwrite a name).
  - **15** Card chassis migrated off px so the global type-size control reaches
    it: mono action/counter/origin/quote labels → `text-mono-xs` /
    `text-[0.625rem]`, playscript dialogue → `text-[0.90625rem]`. All exact rem
    equivalents, so **pixel-identical at the default root** and scaling above
    it. Verified in the built CSS that tracking utilities emit after fontSize,
    so `tracking-[0.02em]` still overrides the token's 0.06em. The byline
    already rode `.label-ui`. CLAUDE.md chassis spec amended. **Narrowed
    residual:** the card BODY is sized by the per-feed text-size control as an
    inline px number — making it rem would compound two user-facing size
    controls, which is a design call, not cleanup.
  - **16** Live hairline debt burned down: `NewFeedPrompt`'s two 1px borders
    removed (panel lifted by shadow alone; the text field is now the
    `bg-glasshouse-well` inset), which also removed an inline `outline: none`
    that was killing the keyboard focus ring — replaced with `focus-ring`. The
    remaining 8 literal-1px hits are all in the **dormant** `PipPanel`, left
    alone deliberately (parked component, renders nothing). Net: two removed,
    zero added; no touched file appears in the tripwire.
  - **17 (first part)** Publications PATCH no longer interpolates
    request-derived keys as SQL column names — the loop runs over a fixed
    `UPDATABLE_COLUMNS` list declared in the route, with a type-level
    exhaustiveness guard so a new schema field is a **compile error** rather
    than a silently-undroppable column. **Mutation-verified** (removing a
    column from the list fails `tsc`). Injection-bounded before, structurally
    closed now. The rest of §7.17 (error shapes, `as any`, naming) remains.
  - **18** BalanceHeader copy corrected to the ledger sign convention
    (`account/BalanceHeader.tsx`): positive net = the platform owes the
    reader ("In credit — this is yours"), negative = an outstanding tab that
    settles from the card at the threshold, and exact zero now reads
    "Settled" instead of claiming credit. The old copy hung the settlement
    clause on the CREDIT branch — backwards; credit is never charged, the
    tab is. A sign-convention comment mirrors the ledger.balance Explain
    caption. *(Bullet added 2026-07-21 — the fix shipped in the batch commit
    and its message, but this itemised record was omitted; §0i.10.)*
  **Untouched:** §7.11 (flag-only/unreachable notes), §7.14 (carried nits),
  and the remainder of §7.17. **Validation:** `tsc` clean across web /
  gateway / shared / feed-ingest; `next build` compiled; root eslint 0 errors;
  hairline tripwire clean on every touched file; ledger-adjacency tripwire
  clean; drift guard 4/4; test suites green — gateway 353, feed-ingest 209,
  shared 101.

- **2026-07-19** — **§0g.1 HIGH fixed: account deletion was broken for
  everyone — three independent latent defects, none ever reachable past the
  first.** `POST /auth/delete-account` aborted 100% of the time; the whole
  `withTransaction` rolled back, so the handler can never have completed once
  in production. Peeled in order by driving the endpoint against the dev
  stack: (1) `UPDATE notes SET deleted_at = now()` — `notes` has no
  `deleted_at` column (42703; the §0g finding). Fixed by switching to the
  hard-DELETE + kind-5 tombstone pattern `DELETE /notes/:nostrEventId`
  already uses (`DELETE … RETURNING id, nostr_event_id`, then the existing
  non-fatal sign+`enqueueRelayPublish` loop; both FKs into `notes` —
  `feed_items.note_id`, `notifications.note_id` — are CASCADE). (2)
  `DELETE FROM feed_saves WHERE user_id = $1` — `feed_saves` has no user
  column (it's feed-scoped: `feed_id`/`feed_item_id`); rescoped via the
  owner's feeds (`WHERE feed_id IN (SELECT id FROM feeds WHERE owner_id =
  $1)`). (3) `SET status = 'deleted'` — `account_status` had no `'deleted'`
  value (22P02): migration 049 ("account deletion") only ever added
  `'deactivated'`. **Migration 159** adds `'deleted'` as a NEW terminal value
  rather than reusing `'deactivated'`, because deactivated is reversible
  (magic-link login matches `('active','deactivated')`; Google login
  reactivates it) and a Google-linked "deleted" account must not resurrect.
  Stale comments corrected (route header claimed the account row was
  hard-deleted; the RESTRICT-FK comment listed `notes`). **Validation
  (empirical, before/after):** pre-fix drive of the live endpoint with a
  minted session → HTTP 500 42703 `column "deleted_at" does not exist`,
  transaction proven rolled back (account still active, 3 notes intact);
  post-fix drive → HTTP 200, account `status='deleted'` + scrambled email +
  `sessions_invalidated_at` stamped, all notes hard-deleted, kind-5 enqueue
  failed *non-fatally* as designed (throwaway account has no custodial key),
  and a re-drive with the same token → 403 (terminal state holds). Gateway
  `tsc` clean; drift guard 4/4 green (seed lists 159 files; schema.sql
  regenerated via throwaway-from-committed). CONSOLIDATED-TODO §0g.1 closed.

- **2026-07-19** — **Resonance foundation shipped (SOCIAL-PROOF-RESONANCE-ADR
  Sequencing steps 1–2), with pre-ship review fixes.** Migration 158
  (`author_engagement_baseline` + `protocol_engagement_ambient` tables; three
  nullable `feed_items` columns `resonance`/`resonance_band`/`ambient_pctl`;
  `idx_feed_items_resonant` partial index; `resonance_*` + `feed_alpha_*`
  platform_config seeds) and the daily `engagement_baseline_refresh` task
  (`feed-ingest/src/tasks/engagement-baseline-refresh.ts`, cron `45 4 * * *`
  after the 04:00 external-engagement full sweep, registered in
  `feed-ingest/src/index.ts`). Pre-ship close-read against source found and
  fixed two defects in the drop: (1) the native branch selected the
  nonexistent `articles.author_id` → `writer_id` (would have 42703'd every
  run, rolling back the whole single-transaction refresh); (2) the ADR +
  config descriptions carried the dead pre-F9 "paid up-vote" premise — voting
  is free since F9 — corrected in the ADR Context/D2 (rev 2.1) and the
  migration's description text, with the keep-at-5 decision made explicit
  (identity-bound + capped 1/(voter,target,direction); first dial to turn if
  step-3 dark distributions run hot). ADR filed at
  `docs/adr/SOCIAL-PROOF-RESONANCE-ADR.md`. **Validation:** drift guard 4/4
  green (seed lists 158 files; migrate no-op on schema.sql-built DB; canonical
  round-trip); regenerated schema.sql via throwaway-from-committed;
  feed-ingest `tsc` clean; root eslint 0 errors; task executed twice against
  the dev DB — first run bootstrapped 4 ambient rows + 598 author baselines
  with sane distributions (atproto/AP p50=4, p90 51–64; native articles
  p50=20; dev notes 0), second run byte-identical on `(median_e, n)` (the
  ADR's fold-idempotency regression, proven by checksum diff). Steps 3–5
  queued at CONSOLIDATED-TODO §9.12; the account-deletion HIGH discovered
  during review is CONSOLIDATED-TODO §0g.

- **2026-07-19** — **§0f fix batch: all 19 items of the 2026-07-19 commit audit
  closed in one sweep** (CONSOLIDATED-TODO §0f; every item below cites its §0f
  number). **HIGH — 1**: the publication unpublish route
  (`publications/cms.ts`) now gates the unscoped `feed_items` DELETE on the
  UPDATE's rowCount (0 rows → 404 before any delete), closing the
  cross-publication sitewide feed-strip. **MEDIUM — 2**:
  `rollbackWriterPayoutRows` takes `AND state = 'platform_settled'`, so a
  chargeback's `charged_back` marker survives a payout failure (no re-pay of
  clawed-back reads; symmetric with the completion flip's existing filter).
  **3**: both A6 orphan checks (`reconcile-ledger.ts` + `scripts/reconcile-ledger.sql`)
  are now fully `ref_table`-scoped — `tribute_payout_reversal` splits
  tribute_payouts/tab_settlements, and the chargeback-derived
  `writer_payout_reversal` (ref_table tab_settlements) branch is restored — so
  the first live-tribute chargeback can no longer halt payouts forever.
  **3-sibling**: `rollbackTributePayoutRows` VOIDS (terminal) any claimed
  accrual whose read is `charged_back` — joined on `read_events.state`, the
  ground truth the accrual row lacks — and state-filters its release leg;
  chargeback-time terminalisation was rejected because it would skew the
  completion path's `tribute_carve` sum (computed from the released→paid flip).
  **4**: the editor seeds `autoSaver.markSaved(snapshotDraft())` once the
  editor exists (untouched open→close of a published article no longer mints a
  draft via the dTag upsert), and `disposedRef` is set BEFORE the
  publish/schedule awaits (reset on catch) so the unmount flush can't recreate
  a just-deleted draft. **5**: the hydration job resolves a success bit;
  `awaitHydrationWithinBudget` reports settled only on SUCCESS, so a fast
  failure returns `hydrating: true` (not cached; client polls; D1's
  guard-cleared retry actually fires). Guard tests updated + a
  settled-by-failure case added. **6**: saves cursor moved off the bespoke
  rounding ms codec onto the shared fractional-seconds + `Number` pattern
  (legacy ms cursors auto-rescaled by magnitude), ending the last M13 page-edge
  duplicate. **7**: `commentsEnabled` threaded through the whole publication
  pipeline (both INSERTs + ON CONFLICT in `publication-publisher.ts`, the CMS
  schema, the scheduler call, web `submitArticle`/`publishToPublication`) —
  publication articles no longer drop "allow replies". **Docs/tests — 8**: the
  redrive runbook now instructs `--force-recreate` (bind-mount inode trap
  documented). **9**: Explain composer caption names the real "Make this an
  article" affordance (+ colon). **10**: CLAUDE.md density rule amended to
  state the deliberate gateway superset. **11**: dedup integration tests grew
  context-only-twin + reply-suppressed-twin fixtures with in-test positive
  controls (mutating either M11 predicate now fails; 15/15 green on dev
  Postgres). **12**: the prune DELETE is batched (LIMIT-subquery ×5k, 200
  batches/run cap, capped-run warning) and the integration test no longer
  asserts a DB-global rowCount (loops to completion; the BUGGY-control
  pre-clears ALL in-window citations so seasoned DBs can't 23503 it; 4/4 green
  on dev). **LOW — 13**: Jetstream `connect()` closes any socket already in
  `this.ws` before claiming the slot (overlap can't orphan a live socket).
  **14**: moderation removal is two-phase — tombstones signed via key-custody
  BEFORE the transaction (`prepare*` on pool + `applyPreparedRemoval` in-txn;
  resolve route re-checks report status `FOR UPDATE`), so a prolific account's
  sign loop no longer holds a transaction open. **15**: AuthorModal's
  document-level Escape/pointerdown handlers yield while the lightbox is open
  (same-node listeners — stopPropagation never shielded them). **16**: the
  PATCH role LABEL is guarded like a grant (assigning a role whose
  ROLE_DEFAULTS exceed the editor's own powers → 403; the label gates
  masthead + transfer-eligibility), and invite-accept re-validates the grant
  against the INVITER's current permissions (pre-guard/demoted-inviter invites
  refuse). **17**: safeFetch 301/302 rewrite POST→GET only (303 rewrites all
  but HEAD; PUT/DELETE re-send unchanged) and a rewrite strips the dropped
  body's Content-* headers — 4 new transport-mock tests. **18**: SchemeMenu
  trigger `aria-label="Colour scheme"` + arrow-key roving focus on the
  `role="menu"` palette (focus lands on the checked swatch on open); the
  `pending`-goes-negative comment added in `nostr-relay.ts`;
  `.claude/scheduled_tasks.lock` gitignored + untracked. **19**: account-export
  key fetch now hits `/api/v1/writers/export-keys` (empirically: unprefixed
  404s, prefixed reaches the route) — the export-mandatory invariant works
  again. Validation: payment-service 169/169, gateway 353 passed, shared
  101/101, feed-ingest 209 passed, dedup 15/15 + prune 4/4 against dev
  Postgres, `next build` clean, root eslint 0 errors, hairline tripwire clean,
  ledger-adjacency guard green. (Known pre-existing, unrelated:
  `web/tests/collision.test.ts` "pushes upward" fails at clean HEAD too.)

- **2026-07-19** — **Feed appearance: colour picker → menu; density → two-state;
  dead density plumbing cleared.** Two FeedComposer cleanups (GLASSHOUSE-AND-PALETTE-ADR
  §III.4 amendment + new §III.4a). (1) The **Colour** control is now a menu
  (`SchemeMenu`) instead of a click-through cycle: the trigger shows the selected
  scheme's dot, opening drops a little palette of one `SchemeDot` per scheme (a
  solid dot in the scheme's `walls` colour, current global light/dark variant),
  click to pick. Retired the three-bar `SchemeSwatch` and `tokens.ts::nextScheme`.
  (2) **Density** collapsed from `compact | standard | full` to `compact | standard`:
  `full` rendered byte-identically to `standard` in every path (the only density
  branches — card padding, action-row visibility, media visibility, drag — test
  `=== "compact"` only). New `tokens.ts::normalizeDensity` migrates any persisted
  `full`/junk → `standard` on read (localStorage rehydrate + server reconcile), so
  no DB backfill; gateway `FEED_DENSITIES` keeps `full` accepted for stale-client
  round-trips (mirrors the `primary`/`dark` scheme tolerance). Dead code cleared:
  the `Vessel` `density` prop (density reaches cards via `WorkspaceView`'s
  `CardContext`, not the vessel) and its never-read `effDensity`, plus a stale
  "300px default at standard density" comment. CLAUDE.md scheme-control passages
  updated. Web + gateway typecheck + `next build` green.
- **2026-07-19** — **Explain-label copy re-voiced (plain-spoken register).**
  All on-screen Explain labels in `web/src/lib/explain/copy.ts`
  (`EXPLAIN_LABELS`, `CARD_FLAVOUR_COPY`, `VESSEL_COPY`) moved from the original
  editorial "signage" voice to a plainer, conversational one: contractions and
  direct address, `all.haus` as an actor, and labels that name what a thing is
  and what happens when you touch it. The reading-tab/paying explanations were
  trimmed (paying is a standard concept). Small fixes folded in: a stale
  `editor.gate`↔`reader.gate` harmonisation comment removed (the parallel no
  longer holds), an `editor.dek` "card title card" typo, two sentence-initial
  "All.haus" brand-casing slips, and a `FIRST_RUN_COPY.floor` phrase synced to
  its `EXPLAIN_LABELS.floor` twin. `FIRST_RUN_COPY` is otherwise unchanged — the
  six-beat onboarding keeps its poetic register by design (deliberate two-voice
  split). Typechecks + `next build` green. Editorial record: `EXPLAIN-ADR`
  Appendix A now carries a 2026-07-19 amendment marking `copy.ts` authoritative.
  **Flag:** `ledger.allowance` still describes a `free_allowance` that the
  money-ledger F1 change retired — reworded for voice, but if that UI element is
  gone the whole label should be deleted, not kept (unverified).
- **2026-07-19** — **THREAD-HYDRATION-LATENCY-ADR Slice 3a (D5): short
  synchronous await on first expand.** With the deadlock gone (Slice 1) and the
  per-phase timeouts trimmed (Slice 2), a cold external expand still made the
  client round-trip twice — once for `hydrating: true`, once more after the poll
  merged the hydrated rows. D5 collapses the fast case to one round trip.
  - **Server (`gateway/src/routes/post-thread.ts` + `lib/external-hydration.ts`):**
    the external branch now captures the hydration job — the freshly-kicked-off
    `hydrateExternalThreadContext(...)` promise when not throttled, else the
    already-running `getInFlightHydration(itemId)` — and races it against the new
    `THREAD_HYDRATE_SYNC_BUDGET_MS` (2 s) via the pure helper
    `awaitHydrationWithinBudget(job, budgetMs)`. On a fast relay the hydrate
    commits inside the budget, so `assembleExternalThread` (which still runs
    *after* the await) reads the complete DB and the response carries
    `hydrating: false` — the client renders the whole thread with no poll. If the
    budget elapses first, it assembles whatever is ingested so far and flags
    `hydrating: true`, and the D2 poll merges the rest. `hydrating = !settled`
    keeps deriving from the in-flight registry (D1), never `willHydrateThread`
    (which flips false the instant the throttle guard is set — the mid-flight
    `hydrating: false` deadlock). A missing job (non-hydratable protocol, or
    throttled-and-settled) resolves TRUE immediately, so the common warm path is
    unchanged. The helper never rejects (a failed hydrate still "settles"; its
    guard is cleared so the client's poll re-triggers a retry).
  - **Test:** `awaitHydrationWithinBudget` cases in
    `gateway/tests/thread-hydration-guard.test.ts` (settled-in-time → true,
    budget-exceeded → false via fake timers, no-job → true). Mutation-verified:
    flipping each of the three `resolve(...)` outcomes fails exactly the case
    that asserts it; revert restores green. `tsc` + root promise-safety lint
    clean (0 errors).
  - **Remaining:** D6 (viewport prefetch) — the one decision that touches the
    card component; D7 (relay health scoring) post-launch.

- **2026-07-19** — **THREAD-HYDRATION-LATENCY-ADR Slice 2 (D3+D4): the latency
  levers — stop waiting for the slowest relay, and overlap the two slow phases.**
  Slice 1 killed the deadlock; the cold-expand still paid a hung relay's full
  per-phase timeout on every phase (the ADR's realistic ~18 s).
  - **D3 (`gateway/src/lib/nostr-relay.ts`):** `fetchNostrEvents` gained an opt-in
    `resolve` param (`NostrFetchResolve`). Restructured from `Promise.all` over
    per-relay promises to a single outer promise with a per-relay closer list, so
    an early condition can hang up the stragglers. Three modes: `exhaustive`
    (default, unchanged — waits every relay to EOSE-or-timeout), `first-event`
    (resolve on the first EVENT from any relay — only safe for content-addressed
    `{ ids: [x] }` lookups, where the first hit is authoritative), `k-of-n`
    (resolve at `k` EOSEs or a soft deadline). The default being unchanged is the
    whole safety story: the replaceable-by-author callers
    (`fetchNostrContacts`/`fetchNostrWriteRelays`/`fetchNostrAuthorProfile` and the
    kind-0 thread-profile REQ) keep newest-wins by staying exhaustive; no
    higher-level helper needed an edit.
  - **D3 wiring (`gateway/src/lib/external-hydration.ts::hydrateNostrThread`):**
    focal fetch → `first-event`; broad `#e` reply nets → `k-of-n` (2-of-n, 2.5 s
    soft deadline, 6 s hard); ancestor-walk hops → `first-event`; kind-0 profiles
    stay exhaustive.
  - **D4 (same function):** the kind-0 profile REQ for the authors known after the
    broad net now runs CONCURRENTLY with the ancestor walk (kicked off as a
    promise before the walk loop, awaited after); a small follow-up REQ covers
    authors the walk newly discovers. The two slow phases cost `max`, not `sum`.
    Moved the `all.size === 0` bail up ahead of both (the walk can't start without
    the focal anyway).
  - **Tests (mutation-verified):** `gateway/tests/nostr-relay-resolve.test.ts`
    scripts a fake `ws` under fake timers to assert each mode resolves early vs
    waits: first-event, k-of-n-at-k-EOSEs, k-of-n-soft-deadline-fallback, and
    exhaustive-waits-for-the-hung-relay. All four early-resolve guards go red under
    targeted mutation (disable first-event / disable k-of-n EOSE / disable soft
    timer / flip the default to first-event). Full gateway suite green (349),
    `tsc` clean. Server-only; no client change (D2's poll settles sooner for free).
  - **Remaining:** Slice 3 (D5 short sync await on first expand — `getInFlightHydration`
    is already staged for it — + D6 viewport prefetch), then D7 relay health scoring.

- **2026-07-19** — **THREAD-HYDRATION-LATENCY-ADR Slice 1 (D1+D2): the 60 s
  external-thread expand deadlock is fixed by construction.** Expanding an
  external (Bluesky/Mastodon/Nostr) card stalled ~60 s and recovered only after
  repeated clicks. Root cause was three timing constants interacting, two of
  which this slice removes:
  - **D1 (server, `gateway/src/lib/external-hydration.ts` + `routes/post-thread.ts`):**
    `hydrating` was reported from `willHydrateThread`, which flips false the
    instant the 60 s throttle guard is set — so a client's mid-flight refetch was
    answered `hydrating: false` and cached an empty thread. Now a module-level
    `hydrationInFlight` registry is the truth source (`isThreadHydrating`), kept
    distinct from the re-trigger guard. `hydrateExternalThreadContext` dedupes
    concurrent callers, deletes its entry in a `finally` on settle (so
    `hydrating` can't stick true and the map can't leak), **clears the guard in
    its `catch`** (the secondary defect — a failed hydrate was frozen for the
    full TTL; now retriable on the next poll), and returns the promise (for D5).
    Also added `getInFlightHydration` (unused until D5).
  - **D2 (client, `web/src/hooks/usePostThread.ts`):** replaced the fixed
    `[3 s, 8 s]` merge offsets (which stopped at 8 s and let a slow relay's result
    land on an empty DB) with a backoff poll (1.5→3→6→12→24 s, ~45 s budget) that
    stops only on `hydrating: false`; `writeCache` now refuses to persist a
    `hydrating: true` partial (the poisoned-cache leg). **D2 depends on D1** — it
    stops-and-caches on `hydrating: false`, so under the old server it would have
    re-created the exact stall; shipped together.
  - **Tests (mutation-verified):** `gateway/tests/thread-hydration-guard.test.ts`
    (in-flight truth, concurrent-caller dedupe, guard-on-failure) —
    finally-delete and guard-clear mutations both go red; and
    `web/src/hooks/usePostThread.cache.test.ts` (cache hygiene) — hygiene-guard
    mutation goes red. `tsc` clean both sides; `next build` clean.
  - **Remaining:** Slice 2 (D3 `fetchNostrEvents` early-resolve modes + D4 phase
    parallelisation — the latency levers) and Slice 3 (D5 short sync await + D6
    viewport prefetch), per the ADR Sequencing.

- **2026-07-17** — **Attack-order 0d: finished the 0b sweep (M13 + M15). Both
  driven before/after; M13 was found to be STILL LIVE — its own fix defeated by
  its decoder — and re-fixed.** The pattern held from 0b/0c: audit the evidence,
  drive the feature where the recorded "typecheck clean" couldn't reach.
  - **M13 — the fix shipped inert; pagination was still losing rows.** The
    2026-07-16 fix made the four cursor SQLs emit a *fractional* epoch and the
    encoders put it on the wire — but the DECODERS (`parseCursor` in `feed-sql.ts`,
    the explore codec in `feeds/items.ts`) still used `parseInt`, which stops at
    the `.` and truncates straight back to the whole second. So the round trip
    stayed whole-second and the bug the fractional cursor exists to prevent was
    never actually closed. **Driven end-to-end on the running stack** against
    `GET /tags/:name/posts` (optionalAuth, so reachable): 5 articles inside ONE
    second, `limit=2` → **page 1 returned 2 rows, page 2 was EMPTY, cursor
    `1784282400` (bare whole second) — 3 of 5 rows permanently unreachable.** Also
    found **two cursors the 2026-07-16 fix never touched** — `tags.ts` and
    `sources.ts` still *encoded* `published_at_epoch` (`::bigint`, whole seconds),
    so they were defective on the encode side too. Fixed: a shared `parseCursorEpoch`
    (`Number`, not `parseInt`; empty→NaN so `Number('')===0` can't mean 1970;
    non-finite rejected), the explore decoder switched to `Number`, and both
    untouched cursors now emit fractional `published_at_secs`. **Re-driven on a
    rebuilt gateway image (throwaway container, fix confirmed present in
    `/app/gateway/dist` first — the [[reference_docker_restart_perms]] rig, since
    AppArmor blocked recreating the real container): same fixtures, pages of 2/2/1,
    all 5 rows, no dupes, cursor `1784282400.4`.** The pre-fix build is the
    negative control. Guarded by `gateway/tests/feed-cursor.test.ts` (15 tests,
    codec functions exported for it); **mutation: restore `parseInt` → 7 fail**
    (the 8 that survive are the whole-second/malformed-input controls).
  - **M15 — fix real and complete; all three claims reproduced.** Unlike M13 this
    one was correctly wired; the job was to *prove* it, which the original entry
    hadn't. Drove the DELETE (fixed vs the pinned pre-M15 query, 643fab3) against
    a live DB over seeded fixtures (old plain / cited / native-reply-parent /
    author-tombstoned), all rolled back. **All three confirmed: (1) the permanent
    wedge** — the buggy query raises `23503` on the cited item (`citation_edges`
    has no on-delete action), which in the daily run fails the whole batch every
    time → nothing ever pruned again; **(2) the guards** — cited + native-parent
    spared; **(3) the privacy inversion** — the buggy `deleted_at IS NULL` retained
    exactly the author-deleted item the fix now prunes. Guarded by
    `feed-ingest/src/tasks/external-items-prune-integration.test.ts` (4 tests). To
    stop the test proving a *copy* of the SQL (the M4(b) lesson), the DELETE is
    extracted to an exported `EXTERNAL_ITEMS_PRUNE_SQL` the task and test share;
    **mutation: revert the constant to the pre-M15 SQL → 2 fail** (the 2 controls
    inline `BUGGY_DELETE` and correctly still pass). Rollback proven by before/after
    row counts (24843 external_items untouched).
  - **Net:** M13 was a live content-loss bug still open a day after being marked
    fixed — the strongest vindication yet of the 0b thesis (compile-clean evidence
    hid a defective *and* incompletely-applied fix). Two new DB-backed tests + one
    codec test, all mutation-verified; two SQL constants extracted so neither test
    can drift from production. Test totals: gateway 342→357, feed-ingest 217→221.
    → `CONSOLIDATED-TODO.md` §11.

- **2026-07-17** — **Attack-order 0c: the M3/M4/M25 tests written. The three
  fixes 0b mutation-proved had ZERO coverage are now covered, and every test is
  mutation-verified.** 248 → 272 tests (payment-service 164 → 175, shared 84 →
  97). Each fix was reverted and the suite re-run: **before, all three could be
  deleted with the suite fully green; now each deletion fails tests.** That
  revert-and-re-run is the acceptance criterion — a test written for an
  already-passing fix proves nothing until you have watched it fail.
  - **M3 `claimedByPendingPayout`** (money) — 3 tests in the existing
    `chargeback-reversal.test.ts`, built as the direct contrast to the
    already-present unclaimed `platform_settled` case: same state, opposite
    treatment, decided solely by the claim. Covers the full reversal (−920), the
    carve-reduced variant (−620, proving the claim routes down the paid-side
    branch's *arithmetic*, not just a flat full-net reversal), and the third leg
    of the triple state — a **publication** read with the flag set must still
    reverse only its split recipients, never the author (guards the F5
    mis-attribution if anyone moves the check above the publication branch).
    **Mutation:** dropping `|| r.claimedByPendingPayout` → 2 fail (was 164/164
    green).
  - **M4(a) pool clamp** (money) — 2 tests in `payout-math.test.ts`. The existing
    combined flat+bps test never overdraws (pool 820 vs payout 80), so `Math.min`
    never bound; the new one starves the pool with a 900 flat fee so a 460 override
    must clamp to the 20 left. **The assertion is Σ splits ≤ the distributable
    pool, deliberately not `remainingPool`** — the F10 `if (remainingPool < 0)`
    floor sits directly below the clamp and scrubs the negative pool back to 0, so
    a pool-level assertion cannot see an unclamped overdraw; the over-paid split is
    the only evidence. Paired with an over-clamp guard (an override that fits is
    still paid in full). **Mutation:** removing the clamp → 1 fail.
  - **M4(b) short-pool `ORDER BY`** — the one 0b called structurally unreachable.
    New DB-backed `publication-share-order-integration.test.ts` on the
    `dedup-integration.test.ts` idiom: real Postgres, fixtures seeded in an
    always-rolled-back transaction, `describe.skipIf(!DB_URL)` so the no-Postgres
    CI `test` job stays green (verified both ways; CI sets no `DATABASE_URL`).
    Rollback **proven**, not assumed — row counts snapshotted before/after are
    identical. To make the test run the *same* SQL the cycle does rather than a
    copy that could drift, the two order-dependent reads are extracted to exported
    constants (`PUBLICATION_ARTICLE_SHARES_SQL` / `PUBLICATION_STANDING_MEMBERS_SQL`)
    — the only production change in this batch, SQL text identical, tsc + 169 tests
    unchanged. The test composes real SQL → real `computePublicationSplits`, as
    production does, and **each ordering test is paired with a deterministic
    control**: the same rows in the order an unordered query could return them
    allocate the money to a *different person* (flat fee skipped entirely, the
    freelancer paid nothing; standing clamp clips the senior member instead of the
    junior). That control is what proves the `ORDER BY` is money logic, not tidiness.
  - **M25 credential stripping** (credentials) — new `shared/tests/safe-fetch-redirect.test.ts`,
    13 tests. `safeFetch` was not imported by any test; the only test touching the
    exfiltration risk (`gateway/tests/activitypub-follow-reader.test.ts:206`)
    **mocks `safeFetch` itself**, i.e. mocks the defence away. Here only the
    *transport* (undici `fetch`) and DNS are mocked — the strip logic under test
    runs for real between hops, and every assertion reads the headers the transport
    was actually handed on hop 2. Covers Authorization/Cookie/Proxy-Authorization
    dropped on host/scheme/port change, any header casing, non-credential headers
    surviving, no reappearance on a later same-origin hop, and the 301/302/303
    POST→GET body drop vs 307/308 preservation. **Controls** (same-origin keeps the
    token, absolute and relative) are what stop a safeFetch that dropped *every*
    header from passing. **Mutation:** neutering both blocks → 8 of 13 fail; the 5
    that survive are exactly the controls, which assert the *absence* of stripping
    and so should pass — the mutation result is itself readable as a check on the
    tests' construction.
  - **The methodology bit worth keeping — an ORDER BY test can pass against a
    build with no ORDER BY.** The first M4(b) draft used the obvious 2-row fixture
    and **passed under mutation**: with the clause stripped, the plan is a Hash
    Join (build on `publication_article_shares`, probe with `articles`) whose
    incidental output order *happened* to match the expected one. An unordered
    query's order isn't random, it's a plan artefact — so a 2-row fixture is a coin
    flip, and mine landed heads. The test asserted a true property while being
    structurally incapable of detecting the fix's removal: **the C1 error, in
    miniature, inside the session written to prevent it.** Fixed by widening the
    fixture (8 scrambled rows over 4 articles; 5 pinned-id rows for the tiebreak)
    so an incidental match is vanishingly unlikely — re-mutated to confirm all
    three ordering tests now fail. The money-property test still cannot detect the
    mutation on its own (2 rows), and **says so in its own comment** rather than
    implying coverage it lacks; its job is the composition, and its control is its
    proof. Generalises: **when a test passes the moment you write it, you have
    learned nothing yet — mutate, and if it still passes, the fixture is the
    problem.** → `CONSOLIDATED-TODO.md` §11.

- **2026-07-17** — **Attack-order 0b: the 2026-07-16 batch's evidence tier,
  re-checked. 6 fixes driven (all pass), 3 proven to have ZERO test coverage,
  1 new residual found.** The queued task was to audit *evidence*, not code —
  for each entry, ask what the recorded proof actually exercised, then drive only
  what it doesn't reach. Verdict: **the 0b hypothesis is confirmed, and for three
  items it is worse than "unproven" — the recorded evidence was structurally
  incapable of supporting the claim.** Every gateway fix was confirmed present in
  the **running image** before driving (`/app/gateway/dist`, not `/app/dist` — an
  early "NOT FOUND" was a bad path of mine, not a stale image; the part-1 rebuild
  holds).
  - **Driven and PASSED (5 auth/integrity fixes, evidence was "typecheck clean"):**
    - **M5 members-roster leak** — anon → 401; authed non-member → 403; member →
      200 with the full roster. Closed, and *not* over-corrected into locking
      members out.
    - **M9 escalation guard, both arms** — manager (can_manage_members, NO
      finances/settings) invites `editor_in_chief` → 403 "it confers
      can_manage_finances, which you do not hold"; invites contributor/editor
      (within powers) → 201; PATCH `canManageFinances` → 403; PATCH `canPublish`
      (held) → 200; owner PATCH → 200 (exempt). Blocks escalation without
      over-blocking.
    - **M7 withdrawn-article leak** — driven **with a baseline** (the same
      non-author got 200 while published): after `published_at=NULL`, non-author →
      404, author → 200 (still edits their own withdrawn draft). The baseline is
      what makes the 404 attributable to the withdrawal rather than to an
      unrelated denial.
    - **M6 publication unpublish** — `feed_items` row built from the publisher's
      own INSERT shape (`publication-publisher.ts:265`), then unpublish → row
      count 1 → 0, status `unpublished`, `published_at` NULL.
    - **M10 magic-link single-use — proven to the highest standard, with a
      negative control.** 8 concurrent `POST /auth/verify` of one minted token
      through the real route → exactly 1 × 200 + 7 × 401, `used_at` set once.
      Then the control, against real Postgres concurrency: the **pre-M10
      SELECT-then-UPDATE pattern minted 8 sessions from ONE token**; the shipped
      atomic UPDATE minted 1. So the harness is demonstrably *sensitive* to the
      defect — the pass means the fix is the **cause** of the single-use guarantee.
  - **M24 (migrate.ts advisory lock) — driven, with a negative control.** Built a
    throwaway `m24test` DB from `schema.sql` (real dev DB never touched), unseeded
    migration 157 and reversed its columns to make it genuinely pending, then fired
    two concurrent `migrate.ts` runners. **With the lock:** A applies 1, B waits
    then reports "All migrations already applied", both exit 0, exactly one
    `_migrations` row. **Without the lock** (lock stripped + a deterministic window
    after the applied-set read): both read the set, both apply, and runner A
    **crashes, exit 1** — `duplicate key value violates unique constraint
    "_migrations_filename_key"`, rolled back. The lock is what turns a crashed
    migration run into clean serialization. **Honest limit:** 157 is a
    *transactional* migration, so its double-apply fails *safely* (unique
    constraint + ROLLBACK). The corruption case M24 actually cites — the
    **no-transaction path** (`ALTER TYPE ADD VALUE` / `CONCURRENTLY`), where the
    DDL runs outside BEGIN and a failed INSERT cannot roll it back — was **not**
    reproduced. The lock is acquired before the applied-set read regardless of
    migration type, so the serialization guarantee is generic; but the
    un-rollbackable case remains undriven.
  - **ZERO test coverage, proven by MUTATION (revert the fix, re-run the suite —
    green every time). The recorded evidence could not have failed:**
    - **M3** (`claimedByPendingPayout`, chargeback during a pending payout —
      *money*): the identifier appears only in src + docs, **never in a test
      file**. No test builds the triple state (platform_settled +
      `writer_payout_id` + non-publication). Deleting `|| r.claimedByPendingPayout`
      → 164/164 still pass. Note the asymmetry: the *tribute* analogue of the same
      concept **is** tested (`chargeback-reversal.test.ts:92`). Recorded evidence
      was "full payment-service suite green (164 passed)".
    - **M4(a)** (pool clamp): the one combined flat+bps test never overdraws (pool
      820 vs payout 80 — `Math.min` never binds). Reverting the clamp → 164/164
      pass. **M4(b)** (short-pool `ORDER BY`): *structurally unreachable* — its
      enclosing `runPublicationPayoutCycle` is called by **zero** tests, and
      `computePublicationSplits` receives an already-ordered array, so no unit test
      can cover the ORDER BY at all. Covering it needs a DB-backed test of the
      reserve path, which does not exist.
    - **M25** (safeFetch credential stripping across cross-origin redirects):
      **`safeFetch` is not even imported** by `shared/tests/http-client.test.ts`.
      All 44 tests are IP/IPv6/WebSocket classification and predate the fix.
      Deleting the entire strip-and-downgrade block → 84/84 pass. "All 44
      http-client tests still pass" is true and carries **zero** evidential weight.
      Worse: `gateway/tests/activitypub-follow-reader.test.ts:206` asserts a user's
      Mastodon Bearer token is passed *into* a mocked `safeFetch` — the one test
      touching the exfiltration risk mocks away the defence.
  - **NEW RESIDUAL — M9's PATCH arm does not guard `role`** (see CONSOLIDATED-TODO
    §0e). The invite arm guards the role against `ROLE_DEFAULTS[role]`; the PATCH
    arm guards only the explicit `can_*` fields — but `role` **is** in its fieldMap
    and **is** written. So the invite guard is walked around: invite(contributor) →
    PATCH(role=editor_in_chief). Driven end-to-end: PATCH → 200 with every `can_*`
    still FALSE, so it is **not** a privilege escalation (the middleware gates on
    `can_*` only) and **M9's core claim holds**. But `role` is not cosmetic: the
    **public** masthead (`optionalAuth`) renders it, so a manager can forge the
    publication's public leadership; and transfer-ownership eligibility is gated
    *solely* on `role='editor_in_chief'` (`members.ts:407`) — the owner then
    transferred ownership to the manager-promoted member (**200, ownership moved**).
    Owner action is still required, so this is a confused-deputy/social-engineering
    shape, not a unilateral takeover. Fix shape: guard `ROLE_DEFAULTS[data.role]`
    in the PATCH arm, as invite already does — the **asymmetry between the two arms
    is the bug**.
  - **Lesson (the session's own evidence nearly failed the same test).** The first
    M10 negative control used a 5ms window and reported INCONCLUSIVE — the old
    buggy pattern also yielded 1 winner. A **false negative**: trusting the
    uncontrolled race alone would have recorded "M10 verified" on a harness that
    provably *could not detect the bug* — the exact C1 error, committed inside the
    audit about that error. Widening to 300ms made it 8/8 vs 1/8. **A verification
    needs verifying: an un-controlled pass can be the harness passing, not the
    feature working.** Mutation/negative controls are cheap and are what separate
    "the suite is green" from "the fix is load-bearing".
- **2026-07-17** — **§11 smoke session (part 1): 11 verifies driven against a
  HEAD dev stack; 1 CRITICAL found (above), 10 passed.** Stack rebuilt to HEAD
  first (all six images predated the 2026-07-16 M-batch; the M20 SQL and the
  M19 `commentsEnabled` token were confirmed *in* the built gateway dist / web
  bundle before trusting any result — the BuildKit stale-context gotcha). DB
  seeded `--small` (41 accounts, 54 articles). **Verified:**
  - **Relay end-to-end (C1's real close-out).** A `/sign-and-publish` kind-1 and
    a scheduler-published kind-30023 both reach strfry and are stored — outbox
    `sent`, correct NIP-23 `d`/`title`/`published_at` tags. First native events
    to land since ~March. (Required the strfry fix above; see that entry.)
  - **H1 key-service gate** — no secret → 401, *wrong* secret of equal length →
    401 (so the constant-time compare is genuinely exercised), correct secret →
    passes into route logic (404 `ARTICLE_NOT_FOUND`).
  - **H2 convert route** — 503 `conversion_unavailable`.
  - **Paywall Step-1b** — gate-pass on a vaultless paywalled article → 409
    `article_misconfigured` with honest "You have not been charged" copy, and
    **no money moved** (reads/ledger/unlocks all 0 after).
  - **Three-validator lockstep** (the 2026-07-07 poisoned-article bug) — gateway
    paywalled+price0 → 400, paywalled+gate0 → 400, public+price0 → 201 (still
    allowed), all in the shared `zodValidationError` envelope; editor
    `validatePaywalledPublish` confirmed called **pre-sign on BOTH the publish
    and schedule paths** (early `return` into `publishError`, so it is a message
    not a 400); key-service `PublishVaultSchema` agrees (`positive()`, gate 1..99).
  - **Duplicate-draft race** — 6 concurrent first-saves (no `draftId`/`dTag`) →
    one 201 + five 200s, **all six returning the same `draftId`**, exactly 1 row.
    The `pg_advisory_xact_lock` holds under real concurrency.
  - **Scheduled draft excluded from the guess target** — with the only untagged
    draft scheduled, a new first-save → **201 (fresh row)**, scheduled draft
    untouched.
  - **Scheduler publish disposes of its draft** — due draft → article published
    (`published_at`, event id) **and** the draft row deleted.
  - **Wave-3 collection gate** — card-less subscribe → 402 `card_required`.
  - **F1 subscription money legs** (card gate passed with a synthetic
    `stripe_customer_id`, reverted after; the charge is pure tab debt so no
    Stripe call) — subscribe 367p → tab 367 debt + `subscription_charge` −367
    (reader, writer counterparty) + `subscription_earning` +338 (writer,
    post-fee); **`reading_tabs.balance_pence == −SUM(reader ledger)` holds**; both
    `subscription_events` rows `settled_at` NULL (collection-gated — the payout
    cycle cannot claim them yet).
  - **Mobile pip order** (MOBILE-LAYOUT-ADR §X) — 6 pips, **Feed 1 leftmost,
    ascending 1→6**, aria-labels carrying the feed names; matches the desktop
    numerals in the same session. The removed `.reverse()` has not regressed.
  **Still unproven, and why:** everything Stripe-calling — settlement, card
  attach/3DS, the publication-subscription payout loop (§1.3) — dev's
  `STRIPE_SECRET_KEY` is the literal placeholder `sk_test_...`, so those need
  real test keys, not more dev driving. Also outstanding from §11: external-author
  history hydration, Explain, PaywallGate copy, mobile swipe/drag gestures.
- **2026-07-17** — **CRITICAL: strfry rejected 100% of native publishes —
  `rejectEventsOlderThanSeconds = 0` (C1 was only half-fixed).** Found by the
  §11 smoke session, driving the real publish path end-to-end in dev rather
  than trusting the 2026-07-16 sign-off (see the CORRECTION on the `a157834`
  entry below).
  - **The bug.** `relay/strfry.conf:57` carried `rejectEventsOlderThanSeconds = 0`
    under a comment reading "Event retention — keep everything (no expiry at
    launch)" — i.e. authored believing `0` meant "no limit". It is not a
    retention switch: strfry **rejects any event whose `created_at` is older
    than N seconds**, so `0` rejects everything not dated in the future. Present
    since the `5fbbc0c` baseline (2026-03-20) but *invisible*, because the SSRF
    pin (`8375365`, 2026-05-16) was failing delivery upstream — every event died
    before strfry could rule on it. Fixing C1 uncovered it, and C1's own
    verification then misread it as staleness.
  - **Blast radius.** Every native Nostr publish — kind-30023 articles, kind-1
    notes, kind-5 tombstones, discovery kind 0/3/10002 — silently failed, on dev
    and prod, while every API returned success (the relay-outbox invariant is
    "signed and durably queued", so rejection surfaces only as worker retries →
    `abandoned`). Dev's strfry held 175 kind-7003 events from April and nothing
    else: no notes, no articles, ever.
  - **Proof (dev, one variable).** Two events identical but for `created_at`:
    `now` → `failed`, `Relay rejected event: invalid: created_at too early`,
    absent from strfry; `now+30s` → `sent`, stored. That boundary *is* the
    0-second window, and it disproves the "image applies its own older-than
    default" theory (a 3-year default would have accepted both, and would have
    accepted the 22 stale rows too).
  - **Fix + verification.** `rejectEventsOlderThanSeconds = 315360000` (10y) with
    a comment recording the reject-window semantics so `0` is not reintroduced as
    "unlimited". Generous by intent ("keep everything") and it makes an outage
    backlog **redrivable** — a signature covers `created_at`, so stale rows can
    never be freshened, which is the whole reason `strfry import` was needed on
    2026-07-16. After the fix, config-only change, same code: a normal
    `created_at=now` publish → `sent`, attempts=1, no error, **present in
    strfry**; and the previously-`failed` row, redriven, → `sent` + stored (so
    the `strfry import` workaround is no longer required for a stale backlog).
  - **Prod: DEPLOYED + VERIFIED same day (2026-07-17).** `git reset --hard
    origin/master` + `docker compose up -d --force-recreate strfry`. The
    **`--force-recreate` is load-bearing**: `strfry.conf` is a single-file bind
    mount (`./relay/strfry.conf:/etc/strfry.conf:ro`), so git replacing the file
    mints a new inode the running container isn't bound to — the same trap that
    bit the nginx.conf/Blossom cutover; a plain `up -d`/`restart` can silently
    keep serving the old config. (A plain `restart` sufficed in dev only because
    an in-place editor write preserved the inode — do not generalise from that.)
    Confirmed in-container (`grep rejectEventsOlder` → `315360000`), then proved
    **end-to-end with a real UI publish**: new `relay_outbox` row `sent`,
    `attempts=1`, no error; strfry event count 89 → 90.
  - **Blast radius: ZERO — the earlier "every publish on prod is failing" framing
    overstated the practical impact.** The pre-fix diagnosis found 22 rows, all
    already `sent` (the imported batch), and **nothing enqueued since the
    2026-07-16 deploy at all**: prod was idle (pre-launch, discovery publishing
    dark by default), so there were no publishes to fail and nothing was lost.
    The mechanism was real and total; the victim count was nil. **No redrive was
    needed.** Cosmetic residue for future readers: those 22 imported rows are
    `sent` yet retain `attempts=5` + a stale `last_error` ("All relays rejected
    or timed out") from before the import recovery marked them `sent` directly —
    a `sent` row carrying an error string is import scar tissue, not a live
    failure.
  - **Lesson worth keeping:** C1 was signed off "confirmed fixed empirically" on
    evidence that only proved *transport* reached the relay. The publish path was
    never driven end-to-end to a stored event. "The pin is fixed" and "publishing
    works" are different claims.
- **2026-07-16** — **Deep-audit M2 (pledge NULL tab_id) + M21 (editor close
  discards work).**
  - **M2 — pledge fulfilment left `read_events.tab_id` NULL.** `drives.ts` INSERTed
    the fulfilment read with no `tab_id` (it can't know it — `applyLedgerDelta`
    upserts the tab), but `confirmSettlement` advances reads `WHERE tab_id = $2`,
    so the read stuck at `accrued`: the pledger's tab was debited + collected but
    the writer was never paid. Now stamps `tab_id` from `applyLedgerDelta`'s
    returned `tabId`. Latent (pledges parked) but no longer a money bug on revival.
  - **M21 — editor close silently discarded work.** Autosave keyed its
    idempotency fingerprint on `title|content` only (so dek/price/cover/comments
    changes never saved) and fired only from TipTap body edits (a title-only new
    article persisted nothing); close/supersede just `cancel()`led the debounce
    with no flush. Now: the fingerprint (`createAutoSaver`) covers every persisted
    field; a metadata-change `useEffect` autosaves title/dek/price/cover/comments
    edits (skipping the settled initial mount — both editor surfaces gate mount on
    `editorReady`, so there's no async-load race); and unmount flushes a
    fire-and-forget `saveDraft` when `isDirty` + real content exists. Crucially a
    `disposedRef` (set after publish/schedule) suppresses the flush so it can't
    recreate a disposed draft (the "draft + published article, both listed" bug),
    and explicit Save calls the new `markSaved` so the flush skips identical
    content — every save still targets `currentDraftId`/`dTag` (one-draft-per-
    article invariant). Verified: gateway + web typecheck clean; `next build`
    clean; hairline tripwire clean.
- **2026-07-16** — **Deep-audit M20 (dek dropped by the draft pipeline) +
  M19 scheduled residual (migration 157).** `article_drafts` had no column for
  the dek (standfirst) or the "allow replies" toggle, so the whole draft pipeline
  silently dropped the dek (gateway schema had no field → Zod stripped it → GET
  returned none): reopening a draft lost the standfirst, and a *scheduled* article
  published with no summary + no NIP-23 `summary` tag; the scheduled article also
  always published comments-on. Migration 157 adds `article_drafts.dek` +
  `comments_enabled` (both nullable so existing drafts are unaffected and the
  upserts' `COALESCE(EXCLUDED.x, existing)` keep-on-conflict pattern works
  uniformly; NULL comments_enabled reads as true). Plumbed through: the drafts
  route schema, all four upsert paths (explicit-id UPDATE, dTag upsert,
  new-article existing-row UPDATE, fresh INSERT) and the GET; the scheduler's
  claim query + `ScheduledDraft` + a `summary` NIP-23 tag from the dek + the
  `articles` INSERT (`summary`, `comments_enabled`); the editor's autosave (via a
  new `commentsEnabledRef`), explicit Save, `handleSchedule`, draft-load
  (`commentsEnabled` was hardcoded true), and the `DraftData` type. schema.sql
  regenerated canonically via a throwaway-from-committed + pg_dump (drift guard
  green: Checks 0/1/2/3 all pass; dev migrated to 157). Verified: gateway + web
  typecheck clean; `next build` clean.
- **2026-07-16** — **Deep-audit MEDIUM web batch (M19, M22).**
  - **M19 — "Allow replies" dead at publish (publish-now path).**
    `PublishData.commentsEnabled` was collected in the editor but sent by neither
    `publishArticle` nor the index route, and the editor's edit-load hardcoded
    `true`. Now `publishArticle`/`articlesApi.index` send `commentsEnabled`, the
    gateway `IndexArticleSchema` + INSERT/UPDATE write `articles.comments_enabled`
    (the column already existed, default true), and edit-load reads the real value
    from `/articles/by-event` (which now returns it). Scheduled-path residual
    (`article_drafts` has no such column) folded into the M20 drafts migration.
  - **M22 — Escape closed the Lightbox AND the Glasshouse under it.** The Lightbox
    (`document` keydown) and Glasshouse (`window` keydown) had uncoordinated
    Escape handlers, so enlarging an image inside a pane and pressing Escape closed
    both (and fired the pane's `history.back()` for URL-synced panes). The
    Lightbox is the topmost modal (z-70); its `document` listener runs before the
    `window` listener in the bubble phase, so it now `stopPropagation()`s on
    Escape — the pane below stays open.
  Verified: gateway + web typecheck clean; `next build` clean; hairline tripwire
  clean on touched files.
- **2026-07-16** — **Deep-audit MEDIUM feeds batch #2 (M13, M15).**
  - **M15 — external-items-prune broken two ways + a permanent wedge.** In
    `external-items-prune.ts`: (1) the "reply thread" guard was
    `NOT EXISTS (… WHERE FALSE)` — dead code, so a native reply's external parent
    (`notes.external_parent_id`, ON DELETE SET NULL) was deleted at retention and
    the thread broke; replaced with a real `notes.external_parent_id` guard. (2)
    `citation_edges.source_external_item_id` has no ON DELETE action, so deleting
    a cited item raised a RESTRICT violation that failed the whole batch — after
    which nothing was pruned ever again (unbounded growth); added a
    `citation_edges` guard. (3) `deleted_at IS NULL` EXCLUDED author-tombstoned
    items, retaining exactly the content a user deleted forever (inverted
    retention / privacy); dropped it. The citation_edges wedge fix was extended to
    the two tasks the audit flagged with the same defect: `external-context-gc`
    (added the guard, dropped its `deleted_at IS NULL`) and `external-sources-gc`
    Phase B (spare a source whose items are cited — the source-delete cascade to
    external_items would otherwise hit the same RESTRICT wedge).
  - **M13 — cursor truncation to whole seconds.** Four time-based keyset cursors
    emitted `EXTRACT(EPOCH …)::bigint` (whole seconds) but compared it via
    `to_timestamp()` against the full-precision `published_at`/`created_at` in the
    ORDER BY, so several rows sharing a second were skipped/duplicated at page
    boundaries. `feed_saves` now emits `(EXTRACT(EPOCH …) * 1000)::bigint` (ms,
    divided back to fractional seconds for the filter); the explore-placeholder
    (`items.ts`) and both author-log cursors (`author.ts`) carry a fractional
    `EXTRACT(EPOCH …)` value (to_timestamp accepts fractional). The display
    `published_at_epoch` stays whole-seconds. Verified: gateway + feed-ingest
    typecheck clean.
- **2026-07-16** — **Deep-audit MEDIUM infra/shared batch (M24, M25) + M10
  test.**
  - **M25 — safeFetch leaked credentials across cross-origin redirects.**
    `safeFetch` (`shared/src/lib/http-client.ts`) re-sent `options.headers` (incl.
    `Authorization`) and the body verbatim on every redirect hop, so a 302 to a
    third-party host re-sent the caller's credentials (`activitypub-resolve.ts`
    threads a user's Mastodon token through it). Now method/headers/body evolve
    across hops: a hop that changes scheme/host/port strips
    `authorization`/`cookie`/`proxy-authorization`, and a 301/302/303 downgrades
    the method to GET and drops the body (307/308 preserve). All 44 http-client
    tests still pass.
  - **M24 — migrate.ts had no lock against concurrent runners.** Two simultaneous
    `migrate.ts` runs read the same applied set and double-apply a pending
    migration; for the no-transaction path (ALTER TYPE ADD VALUE / CONCURRENTLY) a
    partial double-apply can't roll back. Added a session `pg_advisory_lock`
    (acquired before the applied-set read, released in `finally`) so the second
    runner waits.
  - **M10 test** updated for the atomic `verifyMagicLink` (single `UPDATE … WHERE
    used_at IS NULL … RETURNING`) — the two-query mock became one, and a new
    assertion pins the single-statement atomic claim keyed by the token hash.
  **Not done — M23 (strfry open-write):** closing it needs a strfry write-policy
  plugin allow-listing the platform's per-user custodial pubkeys (a DB-synced
  allowlist + plugin script + config), an operational change out of scope for
  this code pass; carried in CONSOLIDATED-TODO §0e.
  Verified: shared typecheck clean; full shared suite green (84 passed).
- **2026-07-16** — **Deep-audit MEDIUM money batch (M3, M4).**
  - **M4 — publication-split overdraw + nondeterministic short-pool order.** In
    `computePublicationSplits` (`payout.ts`) the flat-fee branch checked
    `remainingPool` but the `revenue_bps` override computed `articleNet·bps/10000`
    unchecked, so a combined flat+bps distribution could pay out more than the
    pool (platform funding the difference). Clamped the override to
    `Math.min(…, remainingPool)`. Also added `ORDER BY pas.share_type,
    pas.article_id, pas.id` to the shares load (flat fees before proportional bps,
    stable by id) so which fee is honoured when the pool is short is deterministic.
  - **M3 — chargeback during a pending payout created money.** The chargeback
    planner (`chargeback.ts`) reversed the author's paid slice only for
    `state='writer_paid'` reads, but a read claimed by a still-PENDING writer
    payout (state='platform_settled', writer_payout_id set) has its transfer
    amount locked at claim time and the resume sweep transfers it in full — so
    that slice was clawed-back money paid with no reversing entry. Added
    `ReversalRead.claimedByPendingPayout` (set in `settlement.ts` for a non-pub,
    platform_settled, claimed read) and reverse it as-if-paid, mirroring the
    already-closed released-but-claimed tribute-accrual case. A writer payout is
    atomic (all-or-nothing), so the residual (payout later fails terminally →
    slight over-report) is reconciliation-only, never phantom money. **The
    publication-split analogue is deliberately left open** — its split load stays
    paid-only because a pending pub payout's splits can individually fail KYC, so
    reversing not-yet-paid splits would risk over-debiting; carried as a residual
    in CONSOLIDATED-TODO §0e.
  Verified: payment-service typecheck clean; full payment-service suite green
  (164 passed).
- **2026-07-16** — **Deep-audit MEDIUM feeds/ingest batch (M11, M12, M14, M18).**
  - **M11 — dedup could hide both copies.** The `candidates` CTE
    (`gateway/src/lib/dedup-sql.ts`) picked the cross-source winner from `matched`
    without the context-only/reply visibility predicates the host applies
    afterward (`items.ts` `scored` WHERE), so a context-only or reply-suppressed
    twin could win, suppress its visible sibling, then be filtered itself — both
    copies gone (the exact SLICE-8 failure the candidate universe must prevent).
    Mirrored `ei.is_context_only IS NOT TRUE` and `(fi.is_reply IS NOT TRUE OR
    m.allow_replies)` into `candidates`. The integration test's `matched` stub
    gained `allow_replies` to match production's CTE contract; all 13 dedup
    integration tests pass against the dev DB.
  - **M12 — feed merge 500 on a shared reach source.** The merge duplicate guard
    (`crud.ts`) enumerated account/publication/external/tag but omitted `reach`,
    so merging two feeds that both carry Following/Explore violated
    `feed_sources_reach_uniq` and the unhandled 23505 rolled back the whole merge
    (common with starter-template feeds). Added the `reach`/`reach_kind` arm.
  - **M14 — one bad RSS pubDate deactivated the feed.** `new Date(bad)` yields an
    Invalid Date (NaN), not a throw, so the try/catch was dead and `NaN > x` is
    false — an Invalid Date reached the batched INSERT, failed the whole fetch,
    and after ~10 polls deactivated the source. Both the RSS and `parseJsonFeed`
    date parses now guard `isNaN(getTime())` (matching AP/atproto).
  - **M18 — nostr poll interval never reset on success.** The error path backs
    off `fetch_interval_seconds` up to ~19,200s, but the success path reset only
    `error_count`/`last_error`, so a recovered source polled every ~5.3h forever
    (AP already resets). Both the main poll and the backfill completer now set
    `fetch_interval_seconds = 300` (the backoff base) on success.
  Verified: gateway + feed-ingest typecheck clean; dedup integration suite green
  against the dev DB; feed-ingest unit suite green.
- **2026-07-16** — **Deep-audit MEDIUM gateway/auth batch (M5, M6, M7, M9,
  M10).** Five contained gateway/auth defects from `DEEP-AUDIT-2026-07-16.md`.
  - **M5 — members roster leaked to anonymous.** `GET /publications/:id/members`
    had no preHandler, exposing every member's account id, permission matrix, and
    `revenue_share_bps` to any anonymous caller. Added `requireAuth` + an active-
    member check (403 otherwise); the roster is shown to every member by the UI
    (only management actions are permission-gated client-side), so membership —
    not `can_manage_members` — is the right gate. Public projection stays the
    masthead route.
  - **M6 — publication unpublish left the article in feeds.** `POST …/unpublish`
    (`cms.ts`) only nulled `published_at`; feed queries filter on
    `feed_items.deleted_at`, so the pulled card lingered. Now deletes `feed_items`
    in the same transaction (matching personal unpublish).
  - **M7 — by-event served withdrawn articles.** `GET /articles/by-event/:id`
    (the editor-load route) had no `published_at` guard, so any authed user with
    the event id read metadata + full `content_free` after withdrawal. Now gates
    `published_at IS NOT NULL OR writer_id = caller` — the author still loads their
    own withdrawn draft to edit, non-authors get 404.
  - **M9 — members-manager could escalate above itself.** Both the invite and the
    PATCH member routes (gated only on `can_manage_members`) let a manager grant
    `editor_in_chief` / set `can_manage_finances`/`can_manage_settings` on a
    colluding account — powers the grantor lacks. Added a shared `escalationBeyond`
    helper (owner exempt) that rejects granting any permission the grantor doesn't
    hold; wired into invite (against `ROLE_DEFAULTS[role]`) and PATCH (against the
    explicit `can_*` fields).
  - **M10 — magic-link single-use non-atomic.** `verifyMagicLink` did SELECT-then-
    UPDATE, so two concurrent verifications of one intercepted token both minted
    sessions. Collapsed to one atomic `UPDATE … WHERE used_at IS NULL … RETURNING`
    — exactly one racer's UPDATE matches.
  Verified: shared + gateway typecheck clean. No schema change.
- **2026-07-16** — **Deep-audit H14 (mobile back-guard self-closes reader/
  profile) — final HIGH.** `web/src/lib/backGuard.ts`'s unregister cleanup
  assumed its history sentinel was always the top entry and fired a balancing
  `history.back()`. But when a guarded sheet (Library/Dashboard/Messages/Network)
  opens a URL-synced overlay (reader/profile/surface), that overlay pushes its own
  canonical URL on top of the sentinel *before* the supersede unmounts the sheet,
  so the cleanup's `history.back()` popped the successor's entry and its own
  popstate handler closed the just-opened pane — every reader/profile open from a
  guarded mobile sheet flashed and self-closed. Now the cleanup consumes the
  sentinel (`history.back()`) only when `history.state.ahBackGuard === id`, i.e.
  it is genuinely still the top; if something was pushed above, the inert sentinel
  is left buried rather than popping the wrong entry. Nested guards (DM cover over
  Messages) and normal self-close are unaffected. Verified: web typecheck +
  `next build` clean. **This closes the last HIGH — all 14 HIGHs + the CRITICAL
  from DEEP-AUDIT-2026-07-16 are shipped; MEDIUM (bar M1, done) and LOW remain.**
- **2026-07-16** — **Deep-audit H11–H13 (Jetstream dead zone + socket leak;
  doppelgänger external authors).**
  - **H11 — Jetstream filtered-mode dead zone.** `listener.ts` built the
    filtered upgrade URL with one `wantedDids` per DID (~48 chars each) and passed
    it to `pinnedWebSocketOptions`, whose default cap is 2048 chars — exceeded at
    ~40 DIDs, while wildcard mode only engages at `WILDCARD_DID_THRESHOLD=150`. In
    between, connect threw, was caught, and retried the identical over-length URL
    forever, so every atproto deployment with 40–149 active sources could never
    connect and all Bluesky ingest degraded to the delete-blind poll fallback.
    Added `JETSTREAM_MAX_URL_LENGTH=16384` (covers 149 DIDs at the documented
    server upgrade-URL ceiling; never binds in wildcard mode, which carries no
    DIDs) and pass it as `maxLength`.
  - **H13 — Jetstream reconnect leaks live sockets.** The `close` handler
    unconditionally nulled `this.ws` and scheduled a reconnect. `refreshDids`
    closes socket A, nulls `this.ws`, connects socket B; A's async close then
    nulled `this.ws` (now B — orphaning a live socket even `stop()` can't reach)
    and spawned socket C, multiplying connections across DID churn / blips. Added
    an `if (this.ws !== ws) return;` identity guard at the top of the handler.
  - **H12 — doppelgänger `external_authors` from origin-shaped `author_uri`.**
    The identity trigger (`schema.sql`) derives `external_authors.stable_handle`
    straight from `author_uri`, so a non-canonical value forks a second author
    that real ingest's promotion (which re-homes `source_id` but never rewrites
    `author_uri`) can never merge — the post stays permanently mis-filed (missing
    from the real profile, invisible to author-level deletions). The prefetch /
    hydration paths wrote the origin-shaped `https://bsky.app/profile/<did>` (vs
    the canonical DID in `atproto-ingest.ts`) and the human web `account.url` (vs
    the actor URI `account.uri`/`actor.id` in `activitypub-ingest.ts`). Fixed all
    four feed-ingest sites (`external-parent-prefetch.ts`) and the four gateway
    twins (`external-hydration.ts`, `external-items/{quote,parent,thread}.ts`):
    atproto → `post.author.did`; AP → `account.uri ?? account.url` (added the
    optional `uri` actor-id field to the shared `MastodonStatus.account` type and
    the three inline REST-status types). Verified: feed-ingest + gateway typecheck
    clean; feed-ingest test suite green (209 passed).
- **2026-07-16** — **Deep-audit M1 (reconcile `ledger_orphans` false-halt).**
  The A6 orphan check — in both `payment-service/src/services/reconcile-ledger.ts`
  and `scripts/reconcile-ledger.sql` — resolved `writer_payout_reversal` and
  `tribute_payout_reversal` refs against `tab_settlements`, but those handlers
  post `ref_id` into `writer_payouts` / `tribute_payouts` (confirmed at
  `payout.ts:899/1970`), and F5's publication-split-recipient reversal reuses
  `writer_payout_reversal` with `ref_table='publication_payout_splits'`
  (`payout.ts:2201`). So the first real `transfer.reversed` would post a reversal
  entry whose `ref_id` is absent from `tab_settlements`, the NOT-EXISTS fires,
  `ledger_orphans` flags it, and `runLedgerReconcileAndEnforce` calls
  `haltPayouts()` — recurring on every subsequent run (the entry is append-only)
  until a human resumes, blocking *all* payout cycles. Made the check
  `ref_table`-aware: `tab_settlement_reversal`→`tab_settlements`,
  `writer_payout_reversal`→`writer_payouts` OR `publication_payout_splits` (split
  by `ref_table`), `tribute_payout_reversal`→`tribute_payouts`. Also corrected the
  A12 comment that shared the wrong "reversals ref the settlement" assumption.
  Verified: payment-service typecheck clean; the corrected orphan SQL runs against
  the dev DB and returns 0 rows.
- **2026-07-16** — **Deep-audit H4–H8 (schedule-path pair, moderation
  completeness, deactivation reactivation, feed-delete teardown).** Five HIGHs
  from `DEEP-AUDIT-2026-07-16.md`, continuing the attack order after H1/H2/H3/
  H9/H10.
  - **H7 — top-of-article paywall scheduled free.** `handleSchedule`
    (`web/src/hooks/useArticleEditorInit.ts`) reassembled the gate marker only
    when `data.freeContent` was truthy; a gate at the very top makes freeContent
    an empty string (legal — validation checks only paywallContent), so it fell
    back to `data.content` (marker already stripped) and the scheduler published
    the whole paid body as a free public article. Now reassembles whenever
    `data.isPaywalled` (validation guarantees paywallContent is present).
  - **H8 — scheduled publication article published as personal.**
    `handleSchedule`'s `saveDraft` omitted `publicationId`; the field is plumbed
    end-to-end (drafts client → gateway schema → `article_drafts.publication_id`
    → scheduler branches on it), so a scheduled "Publishing as <pub>" article
    silently went to the personal profile, bypassing review/splits/byline. Now
    passed through.
  - **H4 — admin removal cosmetic.** `remove_content`/`suspend_account` only
    nulled `articles.published_at` (feed queries filter on `feed_items.deleted_at`,
    never `published_at`) and never enqueued a kind-5, so a removed article's card
    + free body stayed in every feed and the full NIP-23 event stayed served by
    the platform relay — moderation was cosmetic for `illegal_content`. Added
    `removeArticle`/`removeNote`/`removeContentByEventId`/`removeAllContentForAccount`
    to `moderation.ts`: soft-delete the article's `feed_items`, enqueue the kind-5
    tombstone (article *and* note — the normal note-delete path tombstones too,
    moderation's `DELETE FROM notes` didn't), signed with the content author's own
    custodial key, mirroring the self-delete paths in `articles/manage.ts` +
    `notes.ts`. Wired into all three sites (report resolve remove/suspend + direct
    `POST /admin/suspend/:accountId`).
  - **H5 — deactivation a permanent lockout.** `POST /auth/deactivate` set
    `status='deactivated'` and the UI promised reactivation-on-login, but nothing
    ever set `active` back (`requestMagicLink` filtered `status='active'`, Google
    403'd non-active, `requireAuth` 403'd surviving sessions). Now `requestMagicLink`
    admits `deactivated` (`status IN ('active','deactivated')`), and `/auth/verify`
    + the Google exchange flip `deactivated`→`active` + `invalidateAuthCache` on
    successful login; suspended (admin action) stays blocked in every path.
  - **H6 — feed delete orphans subscriptions.** `DELETE /feeds/:id` deleted the
    feed and cascaded `feed_sources` without passing through `removeSource`, so
    the derived `external_subscriptions` row survived (the GC keys "orphaned" on
    it → the source polls forever), the author card stayed "Following" with no
    surface to undo it, and a `nostr_external` follow stayed on the published
    kind-3. The handler now `loadFeed`-gates ownership, enumerates the feed's
    `external_source` rows and tears each down via `removeSource(..., {recordExclusion:false})`
    (its own last-feed count + `feed_sub:<owner>` lock + kind-3 dirty-mark) before
    deleting the feed.
  Verified: shared + gateway + web typecheck clean; `next build` clean;
  hairline tripwire clean on the touched web file. No DB/schema change. §0e HIGHs
  remaining: H11–H14 (feed-ingest Jetstream + doppelgänger authors, mobile
  back-guard).
- **2026-07-16** — **Deep-audit H2 (subscription-convert money pump — exploit
  closed).** `POST /subscriptions/:writerId/convert` was an unmetered money
  pump: no card gate (creates an active/auto_renew sub with no
  `stripe_customer_id`); the current-month spend SUM had no `state` filter
  (provisional reads counted) or `publication_id IS NULL` filter, so it credited
  back spend that never debited the tab; the "charge leg" was a phantom bare
  `subscription_events` insert (no `applyLedgerDelta`, no `subscription_earning`,
  no writer entry — so the reader was never charged, the writer never earned, and
  the credited-back reads still paid the writer at settlement, the platform
  funding the credit); and it was repeatable (409 only on `status==='active'`, so
  cancel→re-convert re-credited the same reads unboundedly). Any authed account
  with one month's spend ≥ 0.7× the sub price could drive its tab arbitrarily
  negative. **Confirmed no web UI calls it** — `PaywallGate` shows the conversion
  nudge and posts `/nudge/shown`, but the convert action was never wired — so the
  route is dead-but-live. Per the audit's option A, gated the handler behind
  `SUBSCRIPTION_CONVERT_ENABLED` (default off → 503 `conversion_unavailable`)
  with zero product impact, and documented all four defects in a route block
  comment so a reviver can't miss them. The **full economic rework** (fix all
  four legs via `logSubscriptionCharge` + wire the PaywallGate button, then flip
  the flag) is an owner decision, carried in CONSOLIDATED-TODO §0e item 4.
  Verified: gateway typecheck clean, image rebuilt + restarted, route reachable
  (401 pre-auth as expected; the flag-gate is the first statement post-auth). No
  DB/schema change. §0e HIGHs remaining: H4–H8/H11–H14.
- **2026-07-16** — **Deep-audit H9 (comp-subscription grant ON CONFLICT
  arbiter).** `POST /subscriptions/:writerId/grant`'s first-time-grant INSERT
  used `ON CONFLICT (reader_id, writer_id)` with no predicate, but migration
  038 replaced the full unique with a **partial** index
  (`idx_subscriptions_reader_writer … WHERE (writer_id IS NOT NULL)`), and
  Postgres refuses to infer a partial index without a matching predicate — so
  **every** first-time comp grant raised 42P10 (`there is no unique or
  exclusion constraint matching the ON CONFLICT specification`) and 500'd; only
  reactivations survived, via the SELECT-then-UPDATE branch. This is the §1.10
  "functional gift mechanism," so gifting a new recipient was dead. Fix: append
  `WHERE writer_id IS NOT NULL` to the ON CONFLICT clause. Verified in dev:
  `EXPLAIN` of the exact statement now plans (Conflict Arbiter Index →
  `idx_subscriptions_reader_writer`) where it previously errored; gateway
  typecheck clean, image rebuilt + restarted. No schema change (the index
  already existed). §0e HIGHs remaining: H2/H4–H8/H11–H14.
- **2026-07-16** — **Deep-audit H1 + H10 (key-service internal-secret gate +
  loopback port bindings).** Next two HIGHs off the 2026-07-16 deep audit
  (§0e), both single-surface network-hardening fixes. **H1**: `key-service`'s
  vault/key routes trusted gateway-injected identity headers
  (`x-writer-id`/`x-reader-id`/`x-reader-pubkey`) with **no** proof the caller
  was the gateway — only the two `x-internal-secret`-gated routes checked. Any
  container on the compose bridge (web SSR the realistic pivot) could POST
  `/api/v1/articles/<id>/key` with `x-reader-id: <writer's uuid>` and, via the
  `readerId===writerId` self-issue branch in `vault.ts`, decrypt **any**
  paywalled article with no payment. Fix: a plugin-scope `preHandler` on
  `keyRoutes` requires `x-internal-secret === INTERNAL_SECRET` (constant-time
  compare via `timingSafeEqual`, fail-closed if the env is unset) for **every**
  route; the two per-route secret checks it subsumes were removed. The two
  previously-ungated gateway call sites now send the header —
  `proxyToService` (the vault/key/patch proxies) and `fetchContentKey` (the
  gate-pass key fetch). **H10**: `web:3010` and `strfry:4848` were published on
  `0.0.0.0`; Docker's DNAT in the `DOCKER` iptables chain runs before UFW's
  INPUT rules, so `harden-server.sh`'s 22/80/443 allowlist never saw them — on
  prod the whole app (incl. the Next `/api/*`→gateway rewrite, bypassing
  nginx/TLS/security-headers/the `/media` read-only lock) was reachable over
  plaintext on `:3010`, and the raw relay on `:4848`. Fix: both re-bound to
  `127.0.0.1:` (matching postgres/gateway); nginx reaches them by service name
  over the compose network, and dev browser access
  (`ws://localhost:4848`, `http://localhost:3010`) is unchanged. Verified:
  shared+gateway+key-service typecheck clean; gateway 325 tests + key-service
  11 tests green; images rebuilt and the stack recreated; the H1 exploit
  (no secret) returns **401**, the authorised path (with the secret) passes the
  gate to a normal **404** not-found, and both ports now publish on
  `127.0.0.1` only with web still 200ing locally. **Prod runbook**: deploy,
  then `docker compose up -d web strfry` to re-create the two containers with
  the loopback bindings (a plain restart keeps the old `0.0.0.0` publish). No
  DB, schema, or migration change. Remaining §0e HIGHs (H2/H4–H9/H11–H14) open.
- **2026-07-16** — **Deep-audit C1 + H3 (relay-publish unblock + kind-5 email
  leak).** First two items off the 2026-07-16 deep audit (§0e), landed as a
  pair per the ordering constraint. **C1**: the SSRF pin rejected the in-house
  relay's private compose address (`ws://strfry:7777`), so every native publish
  enqueued into `relay_outbox` failed the pin on claim and abandoned after
  `max_attempts` while the API reported success — native Nostr publishing had
  been silently dead since the DNS-hardening commit `8375365` (2026-05-16).
  Fix: `pinnedWebSocketOptions` now takes an `allowHosts` list (options-bag 2nd
  arg, replacing the positional `maxLength`); a host is exempted from the
  private-IP rejection only on **exact hostname match**, and the DNS-rebinding
  pin is still fully enforced against that host's resolved address. The outbound
  publisher (`feed-ingest/src/adapters/nostr-outbound.ts`) passes only the
  operator-configured `PLATFORM_RELAY_WS_URL` host; external cross-post relays
  get no exemption. **H3**: account deletion built the kind-5 `a` coordinate
  from `accounts.email` (`30023:<email>:<d_tag>`) instead of the pubkey —
  publishing the user's email in permanently-public signed events and
  mis-addressing the replaceable-event deletion. Fixed to `nostr_pubkey`,
  matching the publications path. Landing H3 with C1 is load-bearing: the
  redrive flushes queued deletion events, and the leak is baked into each
  already-signed payload. Ships with **`scripts/redrive-relay-outbox.sql`** —
  dry-run by default (`-v apply=true` to mutate), it **purges** the
  email-poisoned `article_deletion` rows (detected by an `@` in an `a`-tag
  coordinate) **before** redriving the rest (`abandoned`/`failed` → `pending`,
  fresh attempt budget). Verified: shared/gateway/feed-ingest typecheck clean,
  3 new `pinnedWebSocketOptions` exemption tests (44 http-client / 81 shared
  green), lint 0 errors, and the redrive script exercised end-to-end against
  dev with seeded poisoned + clean rows (purged exactly the leak, redrove the
  rest). **Prod runbook**: deploy + restart `feed-ingest`/`gateway`, then run
  the redrive dry-run, inspect, re-run with `-v apply=true`. Commit `a157834`.
  Remaining §0e HIGHs (H1/H2/H4–H14) still open.
  **Prod-verified 2026-07-16 (post-deploy):** dry-run showed 22 `abandoned`
  rows, **0 email-poisoned** (the H3 leak never actually queued on prod — the
  one `article_deletion` row carried no email), so PHASE 2 purged nothing and
  PHASE 3 redrove all 22 to `pending`. C1 confirmed fixed empirically — the
  events now reach `ws://strfry:7777`, pass the SSRF pin, and are evaluated by
  the relay (transport works; the "resolves to private IP" failure is gone).
  **But** the 22 rows (12 kind-30023 articles, 4 kind-1 notes, 4 kind-14,
  1 drive, 1 kind-5) were 1–5 weeks stale, and `dockurr/strfry:latest` rejected
  every one with `invalid: created_at too early` (an older-than default the
  image applies despite the repo config's `rejectEventsOlderThanSeconds = 0`).
  Since a signature covers `created_at`, redrive can't freshen them — recovered
  instead via **`strfry import`** (writes the signed events straight to LMDB,
  bypassing the write-policy timestamp check): `/app/strfry
  --config=/etc/strfry.conf import` → **22 added, 0 rejected**, then the rows
  marked `sent`. strfry applied replaceable-event + kind-5 deletion semantics on
  import (4 stale article versions dropped in favour of newer live copies; the
  tombstone applied) — all correct. The stale-event caveat + the exact `strfry
  import` recovery are now documented in the redrive-script header for the next
  operator. **New publishing (fresh `created_at`) works normally** — this only
  affected replaying the long-outage backlog.
  > **⚠️ CORRECTION 2026-07-17 — the two claims above in bold are FALSE; do not
  > rely on them.** (a) "New publishing works normally" was never tested, and is
  > wrong: a fresh-`created_at` publish was rejected too. (b) The rejections were
  > NOT "an older-than default the image applies despite the config" — that theory
  > cannot explain its own evidence (a 3-year default would have ACCEPTED 1–5-week
  > rows). The config was applied exactly as written: `rejectEventsOlderThanSeconds`
  > is a **reject window**, not a retention switch, and `0` means "reject every
  > event not dated in the future". So C1's pin fix was real but only got the
  > worker *to* the relay; strfry then rejected 100% of what it was handed, and
  > `strfry import` appeared to succeed precisely because it bypasses that check.
  > Every native publish on prod was silently failing from this deploy until the
  > 2026-07-17 config fix. Full finding + proof: the 2026-07-17 entry below.
- **2026-07-16** — **Menu slimming + composer label (EXPLAIN-ADR amendment
  11).** About removed from the desktop ∀ menu — the Explain group is
  Explain alone there (About via Explain's "About all.haus" button or
  `/about`; mobile keeps About alone; `AboutOverlay` stays mounted both
  branches). Accepted consequence: with a pane open on desktop, About is
  unreachable from workspace chrome until the pane closes (pane-mode
  Explain suppresses the wordmark swap). And the note composer's article
  escalation now reads **"Make this an article →"** (was "Write an
  article →") in both compose surfaces (`Composer`, `ComposeOverlay`);
  the long-note nudge's Switch button is unchanged. CLAUDE.md's two
  canonical mentions updated.
- **2026-07-16** — **Explain post-programme trio: scroll-through, card
  flavours, one copy file (EXPLAIN-ADR third-session amendments 8–10).**
  (1) All caption prose extracted to `web/src/lib/explain/copy.ts` — strings
  only (`EXPLAIN_LABELS`/`CARD_FLAVOUR_COPY`/`VESSEL_COPY`/`FIRST_RUN_COPY`),
  the one file to edit until the copy feels right; `registry.ts` keeps the
  machinery and the `Record<Kind, string>` typing fails the build on a lost
  caption. (2) The `card` hover caption now says what kind of card it is —
  native article / native note / open-Nostr / Bluesky / Fediverse / RSS /
  email newsletter: `PostCard` derives the flavour (`explainCardFlavour`,
  native = nostr + pubkey mirroring `isNativePost`), the chassis carries it
  as `data-explain-param`, the hit-test folds it into hover identity (so
  adjacent cards of different flavours swap copy), `explainCardCopy` resolves
  with the generic label as fallback; the param channel is generic for any
  future per-instance copy. (3) The Explain scrim forwards wheel scroll (D1
  softened: frozen for clicks, live for scroll — the sanctioned v2 seam):
  nearest axis-scrollable ancestor under the cursor via `elementsFromPoint`,
  then a hover re-resolve at the unmoved pointer so the caption tracks what
  scrolled in; pane bodies, Messages columns and vessel interiors all scroll
  mid-Explain. First-run stays fully frozen (pinned bubbles anchor to rects;
  D11 has no scroll re-measure). Verified: tsc, root eslint, `next build`,
  hairline tripwire all clean (the one vitest failure, collision.test.ts,
  pre-exists on HEAD).
- **2026-07-16** — **Dev stack rebuilt to HEAD (all six app images) + first
  `reconcile-ledger.sql` run (§1.9), clean.** The dev containers run baked
  images (no source mounts) and had drifted badly: web predated the same-day
  C4 commit, gateway was at 07-12, and payment/keyservice were on **May 25**
  images — the whole July payments rework (`applyLedgerDelta`, migrations
  152–156, Dial-A) and the paywall validator lockstep were not what dev was
  running. Rebuilt web/gateway/payment/keyservice/key-custody/feed-ingest at
  `2e85b22`, recreated; all healthy, DB already migrated through 156.
  Verified the new code is serving: C4 Explain kinds present in the web
  bundle, `applyLedgerDelta` in the payment container's shared/dist,
  web `/` + gateway `/health` 200. (An over-eager `up -d` also started the
  prod-only nginx/certbot — stopped again; dev runs without nginx.) Then ran
  `scripts/reconcile-ledger.sql` against dev (read-only): **every divergence
  check zero rows** — no orphan entries, no unpaired reversals, B1 reader
  view == tabs, B2 writer view == payouts. Caveat: dev holds no live money
  rows (all aggregates 0), so this proves the script executes end-to-end and
  finds no structural divergence, not penny-parity under load — the
  meaningful run is prod post-deploy. The §11 "consolidated smoke session"
  browser verifies are now actually possible (stack at HEAD) but remain to
  be done interactively.
- **2026-07-16** — **Explain C4 shipped — profile + surface-overlay captions
  (EXPLAIN-ADR Appendix A.3e). The caption programme is complete.** 11 new
  hover-only kinds, copy Ed-approved (minimal set: avatar lightbox, RSS links
  and the Message button cut as self-describing; the one new money site
  `profile.subscribe` approved with the card-on-file requirement left to the
  402 error message): `profile` (+ .follow/.followFeeds/.handle/.subscribe/
  .identityLinks) and `source`/`tag`/`pub` (+ pub.nav/pub.follow). Bases ride
  the overlay scroll bodies — `profile` on ProfileOverlay's (native +
  external branches both inherit), the surface trio on SurfaceOverlay's
  switched by target kind — and the content logs inherit the `card.*` kinds
  from the tagged chassis for free. `profile.followFeeds` teaches the
  feed-derived external-follow invariant from the doer's side (reciprocating
  `network.following`); `profile.subscribe` is one kind covering both
  subscription states; dropdown controls tag their wrapper so trigger and
  open menu answer alike. No engine work. Deliberately uncaptioned:
  AuthorModal + everything inside it (`useAuthorHover` suppresses the modal
  while Explain is active, so it is unreachable by construction), flag-gated
  Vouch/TrustProfile, logged-out branches, and the self-describing residue
  (A.3e lists them).
- **2026-07-16** — **Explain C3 shipped — destination-surface captions
  (EXPLAIN-ADR Appendix A.3d).** 29 new hover-only kinds across the six
  ∀-menu destinations, copy Ed-approved as drafted with all four new money
  sites (dashboard.pricing, dashboard.gifts, network.dmFee, settings.payment)
  confirmed: `messages` (+ .notifications/.new/.thread), `dashboard`
  (+ .context/.articles/.gifts/.pricing), `library` (+ .bookmarks/.history),
  `network` (+ .dmFee/.following/.blocked/.muted), `ledger` (+ .balance/
  .allowance/.transactions/.subscriptions — the base carries the approved
  "this is your reading tab" sentence), `settings` (+ .payment/.discovery/
  .reach/.theme/.typeSize/.export). Base kinds ride the overlay scroll
  bodies (Messages, flush, tags the `MessagesInbox` roots); `SettingsSection`/
  `SettingsRow` gained the optional `dataExplain` prop; nested tags
  (ledger.allowance ⊂ ledger.balance, settings.discovery ⊂ settings.reach)
  resolve innermost via `closest()`. No engine work. Deliberately
  uncaptioned: flag-gated affordances, publication-context dashboard tabs,
  transient panels, self-describing forms, the Followers tab (A.3d lists
  them). Also removed SubscriptionsSection's pre-existing `divide-y`
  hairline (touched file; rows' own py-4 rhythm separates). Remaining: C4
  (profile + surface overlays), copy to be drafted for review first.
- **2026-07-16** — **Explain C2 shipped — writing-surface captions
  (EXPLAIN-ADR Appendix A.3c; logged late, shipped in `63d1ee6`).** 24
  hover-only kinds across the note Composer, the article editor, and the
  FeedComposer; copy Ed-approved as drafted. Wiring patterns established:
  `editor.gate` set in `PaywallGateNode`'s node-view DOM;
  `ToolbarButton`/`AppearanceControl` carry the optional `dataExplain` prop;
  `feedComposer.volume` nests inside `feedComposer.source` so the row's two
  ×s resolve to different copy.
- **2026-07-16** — **Explain C1 shipped — pane chrome + Reader interior captions
  (EXPLAIN-ADR Appendix A.3b).** Six new hover-only kinds, copy Ed-approved
  as drafted: `pane.resize` (stretch handle; opens with the `vessel.resize`
  sentence — one grammar for one gesture, A.4), `pane.frame` (feed-identity
  frame), `pane.ear.prev`/`pane.ear.next` (skip ears; the ear copy teaches
  ←/→, the next-ear alone carries the ↑/↓ scroll hint), `reader` (the
  ReaderOverlay scroll body — answers interior hovers ahead of the generic
  `pane` tag), `reader.gate` (PaywallGate; first reading-tab money copy on a
  surface, points at Ledger in the ∀ menu). The ✕ stays uncaptioned by
  decision. Two engine accommodations: the pane-mode hit-test scopes to the
  pane's z-56 WRAPPER (`ExplainOverlay.hitTest`) because the ears are
  siblings of the pane root (outside its overflow-hidden clip; only explicit
  tags match, so the wider scope can't leak a frozen-floor annotation), and
  the pointer-events:none chrome (frame strips, a dimmed ear) flips
  hit-testable only while a program is active (`explainActive` in
  `Glasshouse.tsx` — `elementsFromPoint` skips pointer-events:none; zero
  live-behaviour change since Explain's scrim intercepts all real pointer
  events for exactly that window). Next: C2 (writing surfaces), C3
  (destinations incl. Ledger), C4 (profile + surface overlays), captions
  drafted for editorial review before wiring each.
- **2026-07-15** — **Explain over Glasshouse panes (engine) + menu/disc chrome
  corrections (EXPLAIN-ADR second-session amendments 5–7).** Three linked
  changes. (1) **Desktop disc-X removed**: the six-destination close-on-click
  was mobile's minimise-X bled into a surface already carrying ✕/Esc/scrim
  (`ForallMenu.tsx` — `menuOverlayOpen` + `closeMenuOverlays` deleted); the
  desktop disc now always toggles the menu, which opens at z-60 over any pane
  (destination-hopping rides the supersede rule). Mobile untouched; the one
  desktop X left is Explain's About-pane state. (2) **D10 reversed — pane-mode
  Explain**: `Program.surface: "floor" | "pane"` decided at `open()`
  (`ExplainProvider.resolveExplainProgram` checks `useGlasshousePresence`);
  pane mode raises the scrim/bubble to z-57/58 (above pane z-56, under menu
  z-60), hit-tests ONLY `[data-explain]` tags inside the new pane root tag
  (`Glasshouse.tsx` `data-explain="pane"` — every pane inherits the base
  caption, new `pane` registry kind), freezes focus/ARIA on the pane instead
  of the vessels, closes Explain when the pane closes (presence
  subscription; Esc precedence unchanged — pane consumes first), and
  suppresses the wordmark→About swap (About would supersede the explained
  pane). Explain-row D10 disable deleted. (3) **About in the menu**: the
  Explain group is an Explain / About pair on desktop, About alone on mobile
  (Explain has no hover branch there); `AboutOverlay` now mounts on both
  branches (`WorkspaceView`). Per-surface pane captions (the C-slices) are
  the follow-on work. Docs: EXPLAIN-ADR amendments 5–7 + D10 strike + §4
  `pane` kind + Appendix A.2 `pane` label; CLAUDE.md ForallMenu-invariant
  paragraph rewritten.

- **2026-07-15** — **∀ disc sat ~8px off its anchor — inline-block baseline
  descent (Explain About-button alignment).** In Explain mode the "About
  all.haus" pill read as hanging below the disc's horizontal rules. The pill
  was never wrong (56px tall, `bottom: 24`, 28px end radius — exactly the
  disc's box): the **disc button itself** was floating ~8px above its anchor.
  Its style never set `display`, so the button rendered as the UA-default
  inline-block, sitting on the bottom-anchored container's text BASELINE —
  and the line box reserved strut-descent space (half-leading + font descent
  ≈ 8px at 16px/1.5) *below* the disc, pushing it up off `bottom: 24`. Fix:
  `display: "block"` on the disc trigger (`ForallMenu.tsx`), killing the line
  box. Knock-ons are restorations, not changes: the dropdown (`bottom: 64`)
  and SearchPanel (`bottom: 72`) offsets were authored assuming disc-bottom =
  container-bottom (56 + 8px / 16px gaps) — the descent had been eating those
  gaps (the menu literally touched the disc) — and the wordmark, centred in
  the same 56px box, had always sat slightly low relative to the disc. Mobile
  bar anchor is top-anchored, unaffected. Disc + About pill now read as the
  intended disc/elongated-disc pair on one shared bottom rule (the mobile
  pip-strip grammar, EXPLAIN-ADR D3).
- **2026-07-15** — **One "Write something" menu entry + note→article seed
  carry-over fix.** The ∀ menu's create group carried two write rows ("New
  note" + "Write an article"); collapsed to a single **"Write something"** row
  opening the note composer — article writing is reached through the
  composer's existing "Write an article →" escalation (`ForallAction`
  `new-article` removed; the editor overlay stays reachable via the dashboard
  rows and the `?overlay=editor` deep link). The escalation's promised body
  carry-over was silently broken: `EditorOverlay` is mounted globally, so
  `useArticleEditorInit`'s `editorReady` flag was already stale-`true` from
  the boot-time effect run — `ArticleEditor` (which reads its `initial*`
  props at mount only) mounted before the load effect populated
  `initialData`, then ignored the seed when it arrived. Same dead gate also
  silently emptied **draft/edit loads** through the overlay. Fixed in the
  hook with a render-phase reset keyed on the load target
  (`JSON.stringify([editEventId, draftId, seedContent, seedTitle])` — key
  change → `editorReady=false` + `initialData`/`loadError` cleared before
  paint), and `EditorOverlay`'s mount gate widened from
  `(editEventId||draftId) && !editorReady` to `!editorReady` so every target
  (edits, drafts, seeds) waits for its data. Verified end-to-end (throwaway
  web container + Playwright): single menu row; typed note body lands in the
  article editor; `# Heading` first line promotes to the title without
  duplication; draft deep-link loads title+body in the overlay.

- **2026-07-15** — **Explain residue pass (§0d items 2–4 closed).** (1)
  **Keyboard/SR freeze (§0d.3)** — D1 froze the pointer only (the scrim is a
  stacking freeze): Tab could walk focus into controls under the scrim, Enter
  activated them, and ⌘K opened the composer over it; bubbles carried no
  role/aria-live, so the tour was imperceptible to screen readers. Real
  `inert` on the floor is unusable (the spec makes an inert subtree hit-test
  as `pointer-events:none`, blinding the hover hit-test's
  `elementsFromPoint`; the floor also CONTAINS the overlay chrome + disc
  layer), so the freeze is focus-policing: a capture-phase `focusin` bounces
  any focus outside the Explain chrome set (bubbles / `.forall-trigger`
  disc+About / an open Glasshouse pane) to the program's primary control
  (first-run stepper button, else the ∀ disc), and the vessel roots are
  `aria-hidden` for the window so AT can't activate what the pointer can't
  reach. ⌘K gated on `useExplain.isActive` in `WorkspaceView`. The first-run
  bubble is now `role="dialog"` (labelled "Welcome tour, step N of M") with
  the copy in an `aria-live="polite"` region and focus following each beat
  onto the primary button (keyed on the annotation — beats 5/6 share a
  kind:key and don't remount); the cursor bubble is `role="status"`. (2)
  **§0d.2 (card-kind hover/pin anchors to the representative instance) closed
  as MOOT** — the same-day post-live rework (`30c790f`, after the audit
  write-up) made hover a cursor bubble with no anchor/leader and deleted
  click-pin; `elementFor` now serves only the first-run pinned channel, whose
  representative card anchor is by design (D5). The dormant `pin` seam in
  `stores/explain.ts` now carries the instance-key requirement in its comment
  so a revival doesn't reintroduce the bug. (3) **§0d.4 smaller residue, all
  seven**: the D11 ResizeObserver also observes the pinned target's scroll
  CONTENT wrapper (a height-set vessel's scroll box never resizes when its
  interior reflows, so the pinned bubble drifted); the clipped-target leader
  clauses are implemented (`visibleTargetRect` clips the target rect to its
  `[data-vessel-scroll]` box + viewport — partial clip anchors the leader to
  the visible remainder, full clip renders free-float/no-leader like an
  absent target); `FirstRunController`'s `localStorage` get/set are
  try/caught (private-mode throw escaped the effect); arrow keys no longer
  step the hidden tour under an open About pane (glasshouse-presence guard in
  the keydown handler); both bubbles use `text-ui-sm` instead of inline
  `fontSize:"14px"` (scales with the type-size control); the unused
  `EXPLAIN_KINDS` export is deleted; the About-button stale-hover was already
  fixed same-day in `3151a85`. Files: `ExplainOverlay.tsx`,
  `ExplainProvider.tsx`, `WorkspaceView.tsx`, `stores/explain.ts`,
  `lib/explain/registry.ts`. eslint (0 err) + hairlines + `next build` clean.
  NOT browser-verified (needs `docker compose build web && up -d web`) — the
  §0d keyboard walk: open Explain, Tab (focus stays on disc/About), ⌘K
  (nothing), hover a card in a second vessel (bubble at cursor), Esc.

- **2026-07-15** — **Explain post-live rework (EXPLAIN-ADR "Post-live
  amendments"): four calls reversed after the first session on production.**
  (1) **First-run auto-entry dormant** — refreshing the live site dropped the
  user straight into Explain mode (the once-per-device six-beat tour), which
  read as a malfunction; `FirstRunController` is unmounted in `WorkspaceView`
  (kept intact in `ExplainProvider.tsx` for revival) and Explain is strictly
  ∀-menu-invoked. (2) **Hover bubble at the cursor** — element-anchored
  placement (right→left→below→above of the whole target rect) landed bubbles
  far from the pointer on large targets, reading as haphazard; the Explain
  bubble is now a cursor-following tooltip (`CursorBubble`, offset below-right,
  flips at viewport edges; cursor tracked document-wide so the z-60 disc/About
  hovers place correctly). (3) **Pinned channel not rendered in Explain** — the
  index-0 floor bubble sat permanently dimmed at 0.35 alpha (the full-viewport
  floor target means hover is never empty), the "faintly half-triggered"
  ghost; Explain is hover-only (one persistent bubble, copy swaps in place, no
  per-target re-fade), click-pin is deleted (any click dismisses), hover is
  suppressed during first-run, and the dim rule is gone. Anchored placement +
  leader + stepper survive untouched for the (dormant) first-run pinned beats.
  (4) **Chrome swap is wordmark-only** — the ∀ disc now stays on screen during
  a program (no more explaining an invisible menu): it registers as the `disc`
  root, surfaces the rewritten `disc` label on hover, and clicking it exits
  Explain (About pane open → closes that first, glyph flips to X); the "About
  all.haus" button takes the wordmark's spot and carries a new hover-only
  `about` kind. Copy re-verified byte-identical between `registry.ts` and the
  amended Appendix A (disc, about, beat 4). Files: `ExplainOverlay.tsx`,
  `ForallMenu.tsx`, `ExplainProvider.tsx`, `WorkspaceView.tsx`,
  `stores/explain.ts`, `lib/explain/registry.ts`; ADR + build plan amended.
  tsc + eslint (0 err) + hairlines + `next build` clean.

- **2026-07-15** — **Three-day commit audit (Jul 12–15) follow-ups: the four
  small-and-worst findings fixed.** A five-stream review of the window's 41
  commits (follow-import, payments core, payments idempotency/reconcile,
  Explain, misc) found no high-severity issues; the four cheap medium ones are
  fixed here, the rest queued. (1) **Publication-split idempotency key is now
  row-stable** — `payout.ts` keyed transfers on
  `pub-split-<payoutId>-<accountId>`, but `computePublicationSplits` can emit
  two splits for the same account in one payout (standing member + article
  share), so the second create was a param-mismatch `idempotency_error` →
  classified ambiguous → re-thrown every cycle → the payout's remaining legs
  wedged `pending` forever. Now keyed on `split.id`; the conformance battery
  gained a same-account-twice test (the old seed shape couldn't express the
  collision — 164/164 green). **Deploy note:** the key format changed, so
  before deploying confirm no `publication_payout_splits` row sits `pending`
  mid-create (a split whose transfer went through under the OLD key but whose
  flip didn't commit would retry under the NEW key and double-pay; the resume
  sweep normally clears these within a cycle). (2) **Card shell keyboard
  guard** — `chassis.tsx` `onKeyDown` now mirrors the click path's
  `closest("a")` guard, so Enter on a focused in-card link follows the link
  instead of toggling the card (gap opened by the 82274a8 linkify work).
  (3) **Explain click-dismiss is now reachable** — the full-viewport floor
  registration meant `hitTest` never returned null, so the ADR's promised
  empty-click dismiss was dead and Esc was the only mouse-free exit; a click
  resolving to the floor now counts as the empty click and dismisses (floor
  copy stays hoverable and is the pinned opening annotation). (4) **First-run
  ignores clicks** — click-pin used to warp the six-beat tour (clicking empty
  floor jumped to beat 5; clicking an off-tour target minted a 7th annotation
  with a no-op Next and no Done); the overlay's click handler now early-returns
  during `firstrun` (stepper/arrows/Done/Esc drive it). EXPLAIN-ADR §1-D1/§6
  amended to record both resolutions. Remaining audit findings (Explain
  wrong-instance anchoring + keyboard freeze, drives in-flight prod check,
  reconcile/test hygiene) queued in CONSOLIDATED-TODO §0d.

- **2026-07-15** — **Explain: disc label now reachable in the Explain program
  (the slice-7 follow-up, fixed).** The "About all.haus" button (the D3 chrome
  swap, z-60, the one live control above the Explain scrim) now reveals the `disc`
  label on hover, honouring Explain's "hover anything, read its label" contract —
  previously the label was byte-verbatim in the data but unreachable (the scrim's
  pointermove hit-test never reaches a control above it, and Explain has no
  stepper). Fix is 2 lines in `ForallMenu.tsx`: the button's own
  `onMouseEnter`/`onMouseLeave` set/clear the Explain hover to `{kind:"disc"}`;
  the overlay's existing hover renderer anchors the bubble to the button's
  registered `disc` ref and draws the leader. No new concepts, no document-level
  listener, and D1's frozen-floor contract is untouched (the About button was
  already the sanctioned live exception; click still opens About, hover teaches).
  It also makes the disc hoverable in first-run. Verified end-to-end in a browser:
  hovering the button surfaces the `disc` label verbatim incl. the literal `∀`
  glyph ("...this same corner is the ∀ menu..."), the pinned floor bubble dims,
  and the label clears on mouse-leave. `tsc` + eslint (0 err) + hairlines +
  `next build` clean. **Dev-env gotchas hit during verify (not code issues):**
  (1) `docker compose build web` served `COPY web/ .` from a **stale BuildKit
  context cache** — the edited file never reached the build even with
  `--no-cache` (which only disables layer cache, not context transfer); confirmed
  by grepping the built bundle. (2) Fell back to running the local production
  build directly, where the `/api` rewrite destination is **baked into
  `routes-manifest.json` at build time** from `web/.env` (`GATEWAY_URL=
  http://gateway:3000`, unresolvable off the docker network) — fixed by building
  with a `web/.env.local` override to `http://localhost:3000` (removed after).
- **2026-07-15** — **Explain slice 7 (on-screen copy pass) shipped — the Explain
  build plan is COMPLETE (all 7 slices).** Verified the engine's copy is verbatim
  against EXPLAIN-ADR Appendix A; no code change was needed (copy was entered as
  data in slice 2). A programmatic diff (extract every Appendix-A blockquote vs
  every copy string literal in `registry.ts`) confirmed all **20** strings — 7
  first-run beats + 9 Tier-1 labels + 4 Tier-2 labels — match **byte-for-byte in
  both directions**, and that **no em/en dashes** appear in any copy string (the
  editorial rule; dashes exist only in code comments). On-screen render confirmed
  in a browser (throwaway container off the fresh web image, `runthrough`): the
  first-run beats (1 + 6, incl. beat 6's `\n\n` paragraph break) and the Explain
  labels `floor` / `vessel.gear` / `card.byline` / `vessel.addSource` all render
  verbatim, cleanly anchored. **Follow-up flagged (slice-5 gap, NOT a copy
  defect):** the Explain `disc` label — byte-verbatim incl. the literal `∀`
  glyph, last in the Explain sequence — is **unreachable in the Explain program**.
  The "About all.haus" button sits at z-60 above the Explain scrim (z-50), so a
  `pointermove` over it never reaches the scrim's hit-test (no hover resolution)
  and a click opens About rather than pinning; and the Explain program has no
  stepper (that's first-run only), so the pinned cursor never advances to the
  disc annotation. It renders fine in first-run (beat 4, via the stepper). To
  make it reachable in Explain would need a slice-5 decision — either a
  document-level hover path for the disc (breaking D1's scrim-only pointer model
  deliberately for the one control above the scrim) or an Explain-program stepper.
  Deferred, not fixed here (copy proof-read scope).
- **2026-07-15** — **Explain slice 6 (first-run program) shipped.** The six-beat
  first-run onboarding now auto-runs once per user per device (EXPLAIN-ADR
  D6-D8). `ExplainProvider.tsx` gains `resolveFirstRunProgram` (the `firstRunBeats`
  sequence resolved from the live registry: beats 1-2 — the vessel + its
  add-source — anchor to the **lowest-sort_rank** vessel, whose `fromStarter`
  drives the beat-1 provenance fork, D7; beats 3-4 carry no key; beats 5-6
  free-float over the floor, D8, and beat 6 carries the "done" affordance), a
  `useOpenFirstRun()` hook, and a headless **`FirstRunController`** that runs the
  D6 gate: seen-flag unset (`workspace:firstrun_seen:<userId>`, following the
  ceremony namespace), ≥1 vessel registered, then a ≤4s wait for a `card.byline`
  (beat-3 readiness) before running anyway with beat 3 free-floating; it never
  fires over a deep-linked Glasshouse, and writes the seen-flag **on open** (§6, so
  a one-gesture dismiss still counts). Mounted desktop-only in `WorkspaceView`,
  `armed` on `bootstrap === "ready" && !ceremony && !bringWorld` (defensively
  subscribed to the dark ceremony signal per §0.2). `ExplainOverlay.tsx` adds the
  first-run **stepping footer** on the pinned bubble (a `label-ui` "N / M" counter
  + `.btn-text` Back/Next, swapping to **Done** on the beat-6 `done` beat; the
  footer sets `pointerEvents:auto` so the controls are live through the otherwise
  inert bubble, separated from the copy by whitespace, no rule) plus **ArrowLeft/
  ArrowRight** stepping (first-run only, ignored in fields) folded into the
  existing capture-phase key handler. Explain (slice 5) is untouched — the footer
  is gated on `program.kind === "firstrun"`. Verified end-to-end in a browser
  (Playwright against a throwaway container off the fresh web image, dev-login as
  `runthrough`): first-run auto-fired on a flag-clear load with the beat-1 bubble
  leader-anchored to vessel 1 and the "About all.haus" chrome swap present; the
  neutral beat-1 variant rendered (the test feeds aren't starter clones);
  Back/Next, Back-reverses, and 2×ArrowRight → beat 3 all stepped the counter;
  beat 6 free-floated with Back + Done and the worldview copy; Done closed the
  overlay and restored the ∀ chrome; and a clean reload with the flag set did
  **not** refire. `tsc` + eslint (0 err) + hairlines + `next build` clean.
  Remaining: slice 7 (on-screen copy pass — the copy is already verbatim from
  Appendix A and em-dash-free in the string literals).
- **2026-07-15** — **Explain slice 5 (Explain program + ∀-menu row + chrome swap)
  shipped — the engine is now live in production.** The Explain program is now
  resolvable and openable end to end: `ExplainProvider.tsx` gains
  `resolveExplainProgram` + the `useOpenExplain()` hook — built once at open()
  from the live registry, ordered floor → per-vessel (by sort_rank) → one
  representative card kind each (D5, gated on any vessel actually having cards) →
  disc, with the `vessel`/card copy resolved (vessel provenance fork off the
  anchored feed's `fromStarter` param, D7). `ExplainOverlay.elementFor` now
  anchors each card-kind representative to the topmost tagged leaf in the
  **lowest-sort_rank** vessel that has it (D5, was a bare document-order
  `querySelector`), and carries a capture-phase Esc handler with the D12
  precedence (open Glasshouse → Explain → ForallMenu dropdown: early-returns
  while the About pane is open so the pane consumes Esc, else closes Explain and
  stops propagation). `ForallMenu.tsx` adds the **Explain row** in its own group
  (desktop only; disabled + `title` + inert-on-select while any Glasshouse pane
  is open, D10) → `useOpenExplain()`, and the **D3 chrome swap**: while a program
  is active the disc + wordmark give way to a single islanded **"About all.haus"**
  button at z-60 (registered as the `disc` explainable root — slice 2 deferred
  this because the disc annotation anchors to the About button, the only control
  on screen during a program, not the swapped-away ∀); the button opens `/about`
  through the new `useAboutOverlay` store + `AboutOverlay.tsx` (a standard
  Glasshouse wrapping the same `AboutContent`, ephemeral/no-URL like Explain),
  and the swapped chrome is suppressed entirely while the About pane is open
  (it owns its own dismiss), restored on close — the presence registry drives
  the suppression for free. D2 hover guard added to `useAuthorHover`
  (`AuthorModal.tsx`): `onMouseEnter` early-returns while Explain is active and
  an already-open modal closes on activation. `AboutOverlay` mounts desktop-only
  next to `ExplainOverlay` in `WorkspaceView`. `tsc` + eslint (0 err) +
  hairlines + `next build` clean. Remaining: first-run program (slice 6) + the
  on-screen copy pass (slice 7).

- **2026-07-15** — **Explain slice 4 (bubble renderer) shipped — inert until a
  program opens.** `ExplainOverlay.tsx` replaces the stub bubble with the real
  renderer (EXPLAIN-ADR D11/D9). The new `Bubble` two-pass self-measures
  (`useLayoutEffect` size → `placeBubble`) and places itself in the side with
  the most free room — right → left → below → above, else max-free — clamped to
  the viewport with a `MARGIN`; draws a 2px crimson leader (`<svg><line>`, stroke
  via `style` per the SVG-can't-resolve-`var()` rule) from the target's
  facing-edge midpoint to the bubble's near-edge midpoint plus a 4px dot
  (`<circle r=2>`) at the target end; and free-floats centred with **no** leader
  for `alwaysFloat` beats or a target whose element has deregistered (D8). Live
  measurement is a `getBoundingClientRect` re-read every render, invalidated by a
  `measureTick` bumped from a `ResizeObserver` on the floor root + (while pinned)
  the pinned target's `[data-vessel-scroll]` container (new marker attribute on
  `Vessel.tsx`'s scroll body) + a window-resize listener — **no `scroll`
  trigger**, the floor is frozen (D1). Drag suspension is a new `explain` store
  seam — `draggingFeedId` + `setDragging`, wired to `WorkspaceView`'s vessel
  drag start/end — that hides the pinned bubble and suppresses hover mid-drag;
  it is **inert in v1** (the scrim swallows pointerdown, so a vessel drag cannot
  begin while Explain is active) but the seam is complete for the sanctioned v2
  that forwards pointer deltas. Reduced motion (`prefersReducedMotion`) drops the
  leader draw + slide, opacity-only enter. `tsc` + eslint (0 err) + hairlines +
  `next build` all clean. Nothing opens a program yet (∀-menu row is slice 5), so
  still inert in production. Build plan slice 4.

- **2026-07-15** — **Explain slice 3 (store + scrim + pointer routing +
  hit-testing) shipped — inert until a program opens.** The engine's visible
  layer (EXPLAIN-ADR D1/D9/D12), still with no live trigger (the ∀-menu row is
  slice 5). New `web/src/stores/explain.ts`: the D12 state machine
  (`idle → active` on `open(program)`, back on `close()`), two concurrent
  channels with no mode enum — pinned (`index` cursor, `next`/`prev`/`pin`) +
  transient `hover` (`setHover`, does not touch `index`); DOM-free, so `open`
  takes a pre-resolved `Program` (registry→sequence resolution is slice 4/5) and
  `pin` mints an on-the-fly annotation for a hover-only non-representative card
  (D5); no history push (ephemeral chrome). New
  `web/src/components/workspace/ExplainOverlay.tsx`: a z-50 flat wash
  (`rgb(var(--ah-true-black-rgb)/0.14)`, **no** `backdrop-filter` per D9 — feeds
  stay legible behind their own labels) rendered as a single full-viewport
  catcher that intercepts every pointer event, so the `overflow:hidden` floor is
  frozen while active (D1); `pointermove` → live coordinate hit-test → hover,
  click → pin-or-dismiss. Hit-testing resolves **leaf > vessel > floor** via
  `document.elementsFromPoint` + `closest('[data-explain]')` for tagged leaves
  and registry-root element-identity for roots, skipping the overlay's own chrome
  (`data-explain-chrome`); the hover bubble's copy folds the `vessel` provenance
  fork (D7) off the anchored vessel's registration params. `WorkspaceView` mounts
  `<ExplainOverlay />` **desktop-only** (`!isMobile`, build-plan §2 mobile guard).
  The bubble is a deliberate STUB (a positioned box with a crude viewport clamp)
  — the real placement (right→left→below→above), 2px crimson leader + 4px end-dot,
  live `getBoundingClientRect` + `ResizeObserver` invalidation, drag suspension
  (`onDragFrame`) and reduced-motion path are slice 4 (D11). Web `tsc` + root
  eslint (0 errors) + hairline tripwire + `next build` all clean. Slices 4–7
  (bubble renderer, Explain program + menu row + chrome swap, first-run, copy
  pass) remain. → `docs/adr/EXPLAIN-BUILD-PLAN.md` §3.3.

- **2026-07-15** — **Explain slice 2 (registration substrate + `data-explain`
  tagging) shipped — no visible UI.** The engine's discovery layer (EXPLAIN-ADR
  D4/§8), landable ahead of the engine. New `web/src/lib/explain/registry.ts`:
  the 12-kind `ExplainKind` union, Appendix-A copy as data (Explain labels
  A.2/A.3 + the six first-run beats A.1, both verbatim, no em-dashes), the
  provenance-fork selectors (`explainVesselLabel` / beat-1 copy fork on
  `fromStarter`, D7), and the pure derived-ordering fn `buildExplainSequence`
  (floor → per-vessel leaves by `sort_rank` → representative card kinds → disc,
  D4/D5). New `web/src/components/workspace/ExplainProvider.tsx`: a context
  holding a live `Map` of explainable ROOTS + `useExplainable(kind, opts)` for
  registration (reuses the caller's existing ref so a registration tracks the
  node through drag/reorder; remount-race-guarded delete; inert no-op outside a
  provider). Wiring: `WorkspaceView` wraps the desktop floor in
  `<ExplainProvider>` and passes `sortRank`/`fromStarter` to each `Vessel`;
  `Floor` registers the `floor` root; `Vessel` registers the `vessel` root
  (keyed by feedId, `order: sortRank`, `params: {feedName, fromStarter}`) and
  tags `vessel.name` (the numeral/drag-handle roundel) + `vessel.resize`;
  `VesselBar` tags `vessel.gear`/`vessel.hide` (via a `dataExplain` passthrough
  on the shared `BarButton`) + `vessel.addSource`; the post components tag `card`
  (`PostCardShell` chassis), `card.byline` (a `dataExplain` passthrough on the
  shared `Byline`, so it stays untagged in thread/playscript contexts),
  `card.reply` + `card.quote` (`PostActions`). Nothing consumes the Map yet —
  the store/scrim/overlay are slice 3, the ∀-menu row + chrome swap + `disc`
  registration are slices 4-5. Web `tsc` + root eslint (0 errors) + hairline
  tripwire + `next build` all clean. Slices 3–7 (engine + first-run) remain.
  → `docs/adr/EXPLAIN-BUILD-PLAN.md` §3.2.

- **2026-07-14** — **Explain ADR scoped + slice 1 (`from_starter` wire) shipped.**
  Scoped `docs/adr/EXPLAIN-ADR.md` (first-run onboarding + the Explain annotator)
  into `docs/adr/EXPLAIN-BUILD-PLAN.md` — a file-verified implementation plan
  (new/modified files with line refs, build order as independently-landable
  slices, decisions/risks). Correcting the ADR's stated state: `ForallMenu` is
  under `components/workspace/` (not `layout/`); the first-login ceremony is dead
  code today (`setCeremony` commented out, `WorkspaceView.tsx:928-935`), so D6's
  ceremony gate is trivially satisfied but should still subscribe defensively; and
  the `from_starter` wire touches **6** backend sites, not 3. **Slice 1 (the wire)
  shipped:** exposes the existing `feeds.cloned_from_feed_id` provenance (migration
  114) as a computed `from_starter` boolean on the feed wire object — D7, so first-
  run/Explain copy can fork "starter clone vs neutral" off the anchored vessel.
  Gateway `feeds/shared.ts` (`FeedRow.from_starter` + `feedRowToResponse` +
  `loadFeed` SELECT) and `feeds/crud.ts` (`EXISTS` subquery on the list/order/PATCH
  reads — `feeds.` alias on the PATCH RETURNING; literal `false` on the
  `createFeedForOwner` INSERT since a new feed is never a clone); web
  `WorkspaceFeed.fromStarter` (kept **required** — no `WorkspaceFeed` literals in
  fixtures, so nothing broke). No column/migration/`schema.sql` regen. Uses the
  stricter `EXISTS(… AND t.is_starter_template)` over `IS NOT NULL` (survives a
  renamed/deleted/un-flagged template). Gateway + web `tsc` clean; the `EXISTS`
  expression verified both branches against the dev DB in a rolled-back txn
  (template→false, clone-of-template→true, hand-created→false). `bootstrap.ts`
  inherits the field for free via `listFeedsForOwner` + `feedRowToResponse`.
  Slices 2–7 (the engine + first-run program) remain. → `docs/adr/EXPLAIN-BUILD-PLAN.md`.

- **2026-07-14** — **Payments ADR §1.2 completed — settlement/read-attribution
  conservation property tests (the superset half).** Closes the "still open" note
  from the §1.2 reconciliation-job entry below. The correctness argument for
  `confirmSettlement`'s apportionment lived only in prose (`settlement.ts:587–596`):
  reads advance to `platform_settled` by the TIME predicate `read_at <= settled_at`,
  NOT by which reads' grosses summed to the charged `amount_pence` — so read↔
  settlement pairing is *approximate*, yet money must conserve GLOBALLY. New
  `payment-service/tests/settlement-attribution-conservation.test.ts` (5 tests)
  promotes that to executable properties by driving the **real** `confirmSettlement`
  (incl. the real `applyLedgerDelta` + `recordLedger`) against a stateful in-memory
  model of `{tab_settlements, reading_tabs, read_events, ledger}` with **numeric
  virtual timestamps** so the advance window is deterministic. §1.1 forbids touching
  the apportionment SQL, so the properties are pinned by OBSERVATION, never by
  reimplementation. Asserted: **P1** each accrued read reaches `platform_settled`
  under exactly one settlement (the `state='accrued'` guard — no double-settle, no
  loss); **P2** `Σ(writer_accrual) == Σ perReadNet(gross)` over settled NON-pub
  reads, once each (F2: publication reads advance but earn no personal accrual);
  **P3** reader parity `−Σ(reader ledger) == balance` after every confirm; **P4**
  the fee split conserves (`amount == fee + net`; `Σgross == writer net + implicit
  platform fee`; per-row-then-floor keeps the dust with the writer); **P5** GLOBAL
  conservation under approximate attribution — two scenarios: reads attribute to
  the settlement whose time-window covers their `read_at` (`Σ charged == Σ settled
  read gross`), and a settlement whose `amount_pence` ≠ `Σ(advanced read gross)`
  because subscription debt rides the same tab (writers still earn only their reads;
  the tab still drains to a balanced ledger). Plus a double-webhook idempotence
  check (second confirm no-ops: reads settle once, writers earn once). Suite 163
  green (was 158; +5), typecheck clean. **§1.2 is now fully shipped** — scheduled
  control (below) + property superset (here).

- **2026-07-14** — **Payments ADR §1.2 shipped — scheduled ledger-reconciliation
  job with alert + halt-payouts on mismatch.** Promotes the reader-tab parity
  invariant (`−SUM(reader ledger) == reading_tabs.balance_pence`) from a manual
  psql script to an enforced control. New `payment-service/src/services/reconcile-ledger.ts::reconcileLedger`
  runs the five "must always be empty" reader-tab checks — B1 reader parity, A1
  read_accrual magnitude, A3 tab_settlement magnitude, A7 dispute-stake integrity,
  A6 orphans (the halt-worthy subset of `scripts/reconcile-ledger.sql`, which
  stays the comprehensive human-run superset; the payout-side B2/A4/A5/A9/A10
  checks are *expected-nonzero* and deliberately omitted so a benign known gap
  can't false-halt every payout). **Response on ANY mismatch** (§1.2's demanded
  "action on mismatch", never detect-and-log): `runLedgerReconcileAndEnforce`
  emits a `logger.fatal` alert (`alert:'payouts_halted'`) AND halts payouts via a
  durable `platform_config.payouts_halted` flag (`payment-service/src/lib/payout-halt.ts`,
  first-writer-wins so the ORIGINAL divergence reason survives a re-run). The
  three payout cycles (`runPayoutCycle`/`runPublicationPayoutCycle`/`runTributePayoutCycle`)
  check the flag at entry — before the resume sweep — and no-op past it, freezing
  ALL outbound money. Settlement (charging readers) is deliberately NOT halted:
  the hazard a divergence guards against is irreversible money leaving on books
  that don't balance, and halting charges only strands readers. Scheduled 3×/day
  (`workers/ledger-reconcile.ts`, 01:45/09:45/17:45 UTC — the 01:45 run gates the
  02:30 payout). Manual controls (internal, `requireInternalToken`): `POST
  /reconcile-ledger` (run + enforce), `GET /payouts/halt-status`, `POST
  /payouts/resume` (clear once a human reconciles). No migration — the flag lives
  in the existing `platform_config` k/v table. 7 tests (`tests/ledger-reconcile.test.ts`:
  halt round-trip + first-writer-wins + every check independently trips the halt +
  clean-books-no-halt); the existing conformance harnesses stay green (their
  query-router default returns empty rows, so the gate reads not-halted). Suite
  158 green, typecheck clean. **Superset half (settlement/read-attribution
  conservation property tests) shipped 2026-07-14** — see the §1.2-completed entry
  above; §1.2 is now fully closed.

- **2026-07-14** — **Payments ADR §1.1 step 2 shipped — saga primitive extraction
  (`executeStripeIdempotent`), all four flows.** The one hazardous-and-identical
  step every money-moving Stripe create shares — idempotent call → terminal-vs-
  ambiguous classify → re-throw on ambiguous (never roll back → never double-pay)
  → on terminal return `{ ok:false, err }` so the FLOW runs its OWN per-flow
  cleanup — extracted to `payment-service/src/lib/stripe-idempotent.ts` (+ a
  `stripeErrorCode(err, fallback)` leaf helper for the `code ?? type ?? fallback`
  idiom the four cleanups repeated). Classifier stays **passed-in and named** at
  each call site (`isTerminalTransferError` for the three transfer sagas, the
  narrower-on-purpose `isTerminalChargeError` for the settlement charge). All four
  flows routed through it, **one commit each**, order writer → settlement →
  publication → tribute (tribute against the shipped post-Dial-A shape); each flow
  still reads reserve → call → complete → confirm top-to-bottom, its terminal
  cleanup (`fail*PayoutTerminal` / settlement's PI-id-COALESCE + card-action flag)
  untouched in the flow. Publication's two context-rich per-split logs (terminal
  → mark split failed + continue; ambiguous → re-throw for the sweep) preserved.
  **No boolean flow flags, no primitive-owned control flow / cleanup** — the ADR's
  banned shapes. `statusGuardedTransition` **assessed and NOT extracted**: the
  four guarded flips carry different extra SET columns with positional params, so
  a generic version would be a dynamic-SQL builder over money tables (a worse
  hazard than four readable clones), and its one hazardous bit — the `rowCount`-
  gated ledger post — is a one-liner whose extraction needs the banned callback
  inversion (same reason `resumeSweep` stayed cloned). 8 new primitive unit tests;
  the item-7 conformance battery stayed green after every flow. Full payment-
  service suite **151/151** (143 prior + 8), typecheck clean throughout. Spec:
  `docs/audits/PAYMENTS-FIXES-AND-DILEMMAS.md` §1.1 step 2 + Build scope item 8.

- **2026-07-14** — **Payments ADR §1.1 step 1 shipped — the saga conformance
  battery, all four flows.** The drift-pinning suite that §1.1 makes mandatory
  *regardless of the refactor* (it lets us keep running four cloned sagas safely,
  and is the executable form of several §1.2 invariants). 32 new tests across
  `payment-service/tests/conformance-{settlement,writer-payout,publication-payout,tribute-payout}.test.ts`
  (+ `tests/support/conformance.ts`), each DRIVING the real service against a
  stateful in-memory model of its tables + ledger and a Stripe double that models
  idempotency replay (a repeated create under the same key mints nothing new — the
  crux of exactly-once on resume) and programmable terminal/ambiguous outcomes.
  Covers the full §1.1-step-1 checklist per flow: crash between reserve and the
  Stripe call → resume completes exactly once; crash after the call before local
  complete → resume dedups on the stable key; terminal error → failed state +
  correct rollback (settlement: card-action flag + unfreeze; payouts: claimed
  reads/accruals released); ambiguous error → **NO rollback**, row stays pending
  for resume; settlement webhook double-delivery + out-of-order; the **publication
  multi-leg crash** (crash after leg 2 of 4 → legs 1–2 never re-paid, legs 3–4
  finish exactly once, parent completes only when every leg has); resume-sweep
  idempotency; and — settlement only, via the REAL `applyLedgerDelta` — ledger
  parity (`−SUM(reader entries) == balance`) plus the no-clamp regression (a
  confirm whose amount exceeds a since-dropped balance drives the column NEGATIVE,
  never `GREATEST(0,…)` — the money-losing bug class, now pinned by construction
  *and* by test). Tribute battery written against the **post-Dial-A** shape
  (accruals only released→paid; root-only `tribute_carve`). Full payment-service
  suite 143/143 green (111 prior + 32). **Not** part of this: §1.1 step 2 (the
  `executeStripeIdempotent` / `statusGuardedTransition` primitive extraction) —
  the battery is the green baseline that de-risks it. The lock-ordering go/no-go
  gate (§1.1 step 1's other half) already ran 2026-07-13 (settlement lock-order
  fix). Spec: `docs/audits/PAYMENTS-FIXES-AND-DILEMMAS.md` §1.1 + Build scope item 7.

- **2026-07-14** — **Payments ADR §1.4 + §1.5 shipped — the decision-independent
  "this week" build queue is now clear** (only §2.3 counsel sign-off remains).
  **§1.5 (tax-schema pre-positioning):** migration `155_tax_schema_prepositioning.sql`
  adds nullable `vat_pence int` / `vat_rate_bps int` / `tax_point timestamptz` to
  `tab_settlements`, left **unused** — a Part-2 Merchant-of-Record pivot (§2.1
  Branch B) would make the platform seller-of-record and put a VAT position on
  every settlement; retro-deriving that from history is miserable, nullable
  columns now are cheap. Added `vat` to `LedgerTriggerType` (`shared/src/lib/ledger.ts`,
  a TS union — no DB CHECK, so no DDL there). `schema.sql` regenerated by
  hand-appending the three columns to the `tab_settlements` CREATE in pg_dump
  attnum order + the `155…` seed line; **all four `check-schema-drift.sh` checks
  green** (Check 2 round-trip confirms the hand-edit is byte-canonical), and the
  migration applied to the dev DB (recorded in `_migrations` with its sha256).
  `shared` typecheck + ledger-adjacency tripwire clean. **§1.4 (chargeback-attribution
  policy):** added the settlement-set-not-per-penny paragraph to the refund/chargeback
  section of `docs/HOW-MONEY-MOVES.md` — reversals are computed against a
  settlement's *read set as a whole*, never a per-charge → per-article pairing
  (which the reserve↔confirm accrual gap makes unanswerable in principle); money
  conserves globally but reader refund copy + writer clawback views must both
  describe reversals as settlement-level. ADR status + §D/§F/§B4 updated (next
  migration number is now 156).
- **2026-07-14** — **Payments ADR §1.8 `applyLedgerDelta` + §1.3(1) dispute-stake
  tests shipped** (the "star" of Part 1, and its paired test gap). The
  column⇄ledger same-signed-delta mirror — the one invariant here that has
  actually lost money (all three 2026-06-20 HIGH findings were a `reading_tabs.balance_pence`
  UPDATE and its adjacent `recordLedger` drifting apart) — was held at ~9 call
  sites by a *comment*, not a mechanism. New primitive
  `shared/src/lib/ledger.ts::applyLedgerDelta(client, {accountId, counterpartyId,
  deltaPence, triggerType, refTable, refId, touch?})`: UPSERTs the tab by
  `reader_id` (create-or-update — tab-less dispute/pledge/subscription accounts),
  moves `balance_pence` by the signed `deltaPence` with **no clamp**, and posts
  the mirror ledger entry at **−deltaPence** (the reader-tab convention
  `balance == −SUM`; the sign is *derived*, so a mismatched/clamped pair is
  unrepresentable). Returns `{ledgerId, balancePence, tabId}`. All **9** §C-inventory
  sites routed through it: accrual `recordGatePass` + `convertProvisionalReads`
  (per-read loop), `confirmSettlement` + `reverseSettlement` (its reader
  `tab_settlement_reversal` moved into the primitive and filtered out of the
  writer/tribute-leg loop), `logSubscriptionCharge` (the writer `subscription_earning`
  stays a plain `recordLedger`), spend→subscription credit-back, pledge fulfilment,
  and the dispute-stake **debit + refund**. confirmSettlement keeps its own prior
  `reading_tabs FOR UPDATE` (the 2026-07-13 lock-order fix — the primitive takes
  no lock of its own). **Adjacency tripwire rewritten** (`scripts/check-ledger-adjacency.sh`):
  Guard 1 counts both funnels (`applyLedgerDelta`/`recordLedger`); new **Guard 2**
  permits the raw `balance_pence = balance_pence [-+]` / `+ EXCLUDED` / `GREATEST`
  marker ONLY in `shared/src/lib/ledger.ts` and flags any bypass; Guard 3 is the
  payout-INSERT registry scan. **Tests:** 6 new `applyLedgerDelta` unit tests
  (mirror/no-clamp/upsert/touch/returns; `payment-service/tests/ledger.test.ts`);
  `settlement-ledger-parity.test.ts` reworked to assert the confirm→applyLedgerDelta
  delta (the primitive's own mirror is proven in the unit tests); writer-accrual +
  transfer-reversal mocks updated for the new export; and **`gateway/tests/dispute-stake.test.ts`**
  (5 tests, §1.3(1)) drives POST/DELETE `/disputes` through the *real* `applyLedgerDelta`
  against a stateful scripted client, proving `−SUM(ledger) == balance` across the
  full £5 debit→withdraw round-trip plus the guards (cited-author no-stake, duplicate
  `ON CONFLICT` no-op, idempotent withdraw). Typecheck clean; root promise-safety
  lint 0 errors; 116 payment-service + 325 gateway tests green. Decision-independent;
  it was the "before disputes un-dark" gate for the dispute path. Next in the
  §F queue: §1.4 chargeback-attribution policy paragraph, §1.5 tax-schema
  migration 155, §2.3 baseline sign-off to counsel.

- **2026-07-13** — **Settlement lock-order deadlock fixed + payments ADR Part 1
  scoped.** Scoping the payments ADR (`PAYMENTS-FIXES-AND-DILEMMAS.md`) ran its
  item-1 lock-ordering gate ("verify all four money sagas lock in the same order;
  STOP and report if they differ") against the code. The three payout flows
  (writer/publication/tribute) anchor on different tables and never co-lock an
  `accounts` row with a payout row — no cross-flow contention. **Settlement was the
  outlier and had a real defect:** `confirmSettlement` locked `tab_settlements`
  (its `stripe_charge_id` claim) *before* `reading_tabs` (the balance debit) —
  the **opposite** order from `reserveSettlement` (`178→224`) and `reverseSettlement`
  (`864→871`), which both take `reading_tabs FOR UPDATE` first. `reconcileSettlements`
  inherits confirm's order, so a reconcile-driven `confirmSettlement` racing a
  `reverseSettlement` (refund/dispute webhook) on the same settlement could form a
  lock cycle → Postgres deadlock-kills one txn on the money path. **Fix:**
  `confirmSettlement` now takes `SELECT balance_pence FROM reading_tabs WHERE id=$1
  FOR UPDATE` before claiming the settlement row (`payment-service/src/services/settlement.ts`,
  above the `stripe_charge_id` UPDATE), matching the sibling order; the lock is
  held through the balance debit below, so no extra round-trip. Typecheck clean;
  the 17 settlement/parity/writer-accrual tests pass unchanged; the added `SELECT`
  is not a `balance_pence` write so the ledger-adjacency tripwire is untouched.
  **Also written:** the *Appendix — Build scoping* in `PAYMENTS-FIXES-AND-DILEMMAS.md`
  — verified file:line targets for §1.8 (9 tab-write sites, 2 are upserts, 1 posts
  two ledger entries), §1.5 (migration 155; the ledger vocabulary is a TS union,
  not a DB CHECK), the Dial-A blast radius (~8 files + 1 migration), and four
  corrections where the code differs from the ADR body: paid-DM charge path is
  unbuilt (not untested), gift links are a free comp (no money), §1.6 merchant-posture
  is greenfield, §1.5 vocab is TS-only. → `PAYMENTS-FIXES-AND-DILEMMAS.md` Appendix;
  CONSOLIDATED-TODO §1 item 12.

- **2026-07-13** — **Tribute model ruling: Dial A adopted (consent-gated,
  forward-only accrual).** Design/compliance decision (docs only; code rework
  tracked, not yet done). The tribute ADR is amended away from accrue-from-creation:
  **no `tribute_accruals` row (no held share) exists until a tribute is `live`**
  (consented + the inspirer is a real, onboarding account); before consent the
  author keeps their full payable and sees only a projection, and accrual runs
  **forward-only** from consent (pre-consent reads paid the author in full, never
  clawed back — retroactive recompute explicitly rejected). **Why:** the
  accrue-from-creation model depended on characterising a share held for a
  *non-consenting* party as "still the author's money" with *no ring-fencing*,
  which collides head-on with any future Stripe funds-segregation (segregation
  ring-fences the writer float, asserting exactly what that framing denies —
  `PAYMENTS-FIXES-AND-DILEMMAS.md` §2.2). Dial A removes the held share entirely,
  so the collision dissolves, residual #2 + the characterisation point become
  moot (compliance collapses to residual #1, the platform-wide Stripe-PI baseline),
  and segregation would now compose cleanly if ever taken. It is also a **net
  code deletion** — `held`/`swept`/`returned`, the author swept-return columns,
  and the chain swept-return-to-parent plumbing all retire; an accrual is only
  ever `released → paid` (+ `voided` on chargeback). **Cost accepted:** the "money
  was always waiting for you" cushion is gone (a late accepter earns only forward).
  **Gate change:** `TRIBUTES_ENABLED` now has two pre-flag gates — compliance
  residual #1, and the Dial-A code rework (`UPSTREAM-EDGES-BUILD-PLAN.md` ›
  *Dial-A rework*). Docs updated: `UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md` (Decision +
  reframed dials/recommendation), `UPSTREAM-EDGES-ADR.md` (amendment + Decisions
  4/5 + schema states + C6), `UPSTREAM-EDGES-BUILD-PLAN.md` (Dial-A rework section +
  Phase 3/5 superseded banners), `UPSTREAM-EDGES-AUDIT-FIXES.md`, `CLAUDE.md`
  (Money-ledger invariant), `PAYMENTS-FIXES-AND-DILEMMAS.md` §2.2, CONSOLIDATED-TODO §1.

- **2026-07-13** — **Selectable + linkable feed-card text** (CONSOLIDATED-TODO
  §12). Feed cards now let you highlight/copy body text and click bare URLs,
  without losing click-to-focal or drag-card-across-feeds. The conflict was that
  the card shell (`web/src/components/post/chassis.tsx`) pinned
  `draggable={true}` (a draggable element swallows the mousedown that starts a
  selection) and fired `onClick={onExpand}` on any body click with no guard (a
  drag-select ended in an expand).
  - **Shared drag-surface judgment** — factored `isPaneDragSurface` out of
    `Glasshouse.tsx` into `web/src/lib/dragSurface.ts` (`isDragSurface` +
    `hasOwnText` + `NO_DRAG_SELECTOR`); Glasshouse now imports it (behaviour
    byte-identical). It answers "did this pointerdown land on grabbable chrome,
    or on text / a link / a control / a scrollbar gutter?"
  - **Dynamic `draggable`** (`chassis.tsx`) — instead of a static attribute, an
    `onPointerDown` resolves `el.draggable` per gesture via `isDragSurface`:
    bare chrome (padding/margins) → armed, so HTML5 drag-to-another-feed
    (`x-vessel-card` → `Vessel.tsx` `moveSource`) is untouched; body text / link
    / control → disarmed, so selection and clicks work. Set imperatively on the
    ref so it lands before the same gesture's `dragstart` (no re-render race).
  - **Guarded `onClick`** (`chassis.tsx`) — a body click still focuses the card,
    but bails when `window.getSelection()` is non-empty (ending a highlight) or
    the target is inside an `<a>`, so finishing a drag-select or clicking a URL
    never expands. A plain click (empty selection) on chrome or text still
    focuses — requirement (a) preserved.
  - **Linkify plain-text bodies** (`web/src/components/post/PostBody.tsx`) — bare
    `http(s)` URLs in native/external plain-text notes render as
    `<a target="_blank" rel="noopener noreferrer">` with `stopPropagation` (same
    treatment quote tiles use), only in the expanded/full modes (a truncated
    one-line URL is meaningless). Trailing sentence punctuation is trimmed;
    URL-balanced brackets kept. HTML/markdown notes already carried real `<a>`.
  - Touch path unchanged (tap = focal; selectable text is a pointer affordance,
    matching the hover-only card panels). Pre-flight: `check-hairlines.sh` on the
    four touched files (clean), `next build` (green), root eslint (0). **Not yet
    exercised in a running browser** — the DOM-interaction behaviour (selection
    vs drag vs click, linkify) wants a manual pass after `docker compose build
    web`.

- **2026-07-13** — **Pledge drives + commissioning parked behind a feature flag
  (default OFF).** The whole crowdfund/commission subsystem ships dark while
  it's out of play, same shape as the `TRUST_SYSTEM_ENABLED` / trust parking:
  a server switch `PLEDGES_ENABLED` (`shared/src/lib/env.ts::pledgesEnabled`)
  and its client twin `NEXT_PUBLIC_PLEDGES_ENABLED`
  (`web/src/lib/featureFlags.ts::pledgesEnabled`), both default OFF (absent ⇒
  off). Nothing is deleted — flip both to `"1"` to revive the feature whole.
  - **Gateway** (`gateway/src/routes/drives.ts`) — one plugin-scoped
    `onRequest` hook 403s (`feature_disabled`) every `/drives` route when off,
    so no drive/pledge/commission can be created or read. The route
    registration itself **stays** (keeps the CI ledger-adjacency check's
    `drives` money-path satisfied), and the fulfilment plumbing
    (`matchDriveForPublish` / `fulfillDrive` / drive-expiry) is left inert —
    with no open drive the publish-time match is a harmless no-op. Tables, the
    `pledge_fulfil` ledger trigger type, and the `draftId` threading are all
    untouched.
  - **Web entry points hidden** in lockstep: the Ledger "my pledges" list
    (`LedgerPanel` → `PledgesSection`), the dashboard Proposals tab's
    commissions + drives halves — fetches, filter pills, "New pledge drive"
    button, create form, and the two card sections (`ProposalsTab`; the
    subscription-offer half stays), the DM "Commission" button + modal
    (`MessageThread`), the profile drive fetch/cards (`WorkTab` skips the
    `/drives/by-user` call entirely), and the `commission_request`
    notification-preference category (`NotificationPreferences`).
  - Historical `commission_request` / `drive_funded` / `pledge_fulfilled`
    notifications still render (`NotificationsPanel` display types left as-is)
    — correct, since none can be newly created.
  Validation: `tsc` clean on shared + gateway, `next build` clean.

- **2026-07-12 (tenth entry)** — **Same-day commit audit: four fixes (two DoS
  guards on the follow-import readers, two workspace-UI bugs).** A four-agent
  adversarial review of the day's eleven commits confirmed every audited
  invariant held (one-way inbound, pure-offer sheet, exclusion symmetry,
  feed-derived subscriptions, SSRF, migration/schema hygiene, hairlines) and
  surfaced four fixable defects, all fixed same-day:
  1. **AP follow pager unbounded** (`activitypub-resolve.ts::
     fetchMastodonFollowing`) — loop progress was measured in PARSED accounts,
     so a hostile instance (origin derives from a user-pasted handle) serving
     non-empty pages of unparseable entries plus an endless same-origin
     rel=next chain looped forever inside the request handler. Fixed with a
     hard page ceiling (`cap/80 + 7`); ceiling hit returns `complete: false`,
     which the sync engine already treats as removal-suppressing. Same ceiling
     added to atproto `getFollows` (`cap/100 + 7`) — its AppView host is
     pinned, but empty-page-with-fresh-cursor responses (legitimately emitted
     for all-deactivated pages) plus a cursor regression would have wedged the
     sweep. Tests: hostile-pager cases in `activitypub-follow-reader.test.ts`
     + `atproto-discovery.test.ts`.
  2. **OPML parse quadratic in nesting depth** (`opml.ts::parseOpml`) —
     jsdom's XML parse is O(depth²): a measured 336KB / 12k-deep upload (well
     under the 2MB cap) cost ~31s of synchronous CPU on the single-threaded
     gateway per request. Fixed with `opmlShapeOk`, a linear quote-aware
     pre-parse scan (depth ≤ 100, outlines ≤ 50k; quote-awareness so `'/>'`
     inside an attribute value can't fake a self-closing tag and evade the
     depth count) — the same payload now rejects as `opml_invalid` in 2ms,
     and the depth cap also bounds `collect()`'s recursion (closing the
     500-instead-of-400 overflow window). Tests: depth/evasion/breadth cases
     in `opml.test.ts`.
  3. **`adoptFeed` impure updater** (`WorkspaceView.tsx`) — the `known` flag
     was assigned inside the `setVessels` updater and read synchronously
     after, and two zustand writes lived inside it; that only works while
     React evaluates the updater eagerly, and the arrivals drain loop (routine
     for a multi-feed OPML import) queues updates, deferring later updaters to
     the render phase (stale `known`, setState-during-render). Restructured:
     membership check + store writes outside the updater, same-tick dedup via
     `vesselsRef`, the updater pure. Companion fix: the drain effect's
     wholesale `clear()` could wipe an announce landing between render and
     effect — `feedArrivals.clear` replaced by batch-scoped `consume`.
  4. **Sync-now Apply double-fire** (`FeedSyncSection.tsx`) — no in-flight
     guard during the `confirmSync` await, so a double-click POSTed confirm
     twice; the loser 404s and painted an error beside a sync that started.
     Added a `confirming` state folded into `busy` + disabled buttons.
  Remaining low-severity audit residue queued in CONSOLIDATED-TODO §0c.
  Validation: gateway vitest 320 passed, `tsc` clean, root eslint 0 errors,
  `next build` clean, hairline tripwire clean, 12k-depth payload timed at 2ms.

- **2026-07-12 (ninth entry)** — **Container healthchecks: every backend has
  reported "unhealthy" forever (cosmetic, but it masks real failures).**
  Spotted during the follow-import prod flip: gateway/payment/keyservice/
  key-custody showed `(unhealthy)` on prod AND dev while serving fine. Cause:
  the compose healthchecks probe `http://localhost:<port>/health` with busybox
  wget, but in-container `localhost` resolves to `::1` (alpine) while Fastify
  listens on `0.0.0.0` (IPv4-only) — connection refused on every probe since
  the checks were added. nginx had the same ::1 bind problem **plus** its
  port-80 `location /` is a bare 301 to https, which wget would follow out
  through public DNS and back. Fix: all wget healthchecks now probe
  `127.0.0.1`, and nginx gets a dedicated `location = /nginx-health { return
  200; }` on the :80 server (no redirect, no upstream). Verified in dev: all
  four backends flip to `(healthy)` within one probe interval. A permanently
  red healthcheck is worse than none — it trains the operator to ignore the
  column, and anything gated on `service_healthy` (the blossom dependency
  already is) can never be gated on these services until this works.

- **2026-07-12 (eighth entry)** — **Follow-graph import Phase 3 "Bring your
  world" (FOLLOW-GRAPH-IMPORT-ADR §7.4 / §8 Phase 3).** Two decisions settled
  at build (recorded in the ADR §7.4 build note): no signup wizard exists
  (CONSOLIDATED-TODO §3.3 unbuilt), so the step is a first-session Glasshouse
  sheet riding the founder-feed-mint signal in the workspace bootstrap (zero
  feeds = brand-new account — the parked ceremony's own discriminator), and
  the `import` resolver context ships subscribe-shaped (external-first
  ranking; an exact native-username hit does not short-circuit the external
  world — the squatter case matters more for import, which consumes only
  external sources). Gateway: `ResolveContext` + `contextPriority` +
  `runExternal` gain `import` (resolver-merge.ts / resolver.ts; unit test
  added). Web: `BringYourWorld.tsx` (lazy-chunked; capabilities-gated so a
  dark `FOLLOW_IMPORT_ENABLED` renders nothing and never burns the
  once-per-user seen-key, which is written only on actual dismissal;
  suppressed when a deep-linked overlay already claimed the Glasshouse;
  D7-strict pure offer reusing `FollowImportSection` — paste + OPML — with the
  evergreen Network/FeedComposer paths named in closing copy); WorkspaceView
  trigger + render; `useResolverInput`/`resolver.resolve` context unions
  widened; `FollowImportSection` passes `context: 'import'`. Verified live in
  the dev stack (gateway + web rebuilt): fresh-signup capabilities expose all
  three protocols + OPML; `import` ≡ `subscribe` and ≠ `general`/`dm` on
  squatted ('steveruizok' minted natively → general returns 1 native, import
  returns native + 3 externals) and unsquatted queries; async atproto chain
  completes under `import`; test accounts removed after. Checks: gateway
  vitest + tsc, root eslint 0 errors, hairline tripwire clean, `next build`
  green (it caught one missed union in `lib/api/resolver.ts`). Residual: a
  browser-level look at the sheet on next dev browse. Remaining on the ADR:
  prod flag flip; AP sub-brake soak + one authed self-import.

- **2026-07-12 (seventh entry)** — **Fresh-DB graphile_worker crash-loop:
  durable fix (was CONSOLIDATED-TODO "later" item 12, found in the sixth-entry
  run-through).** `schema.sql` carried the whole `graphile_worker` schema from
  past pg_dump regens, but graphile's own `migrations` bookkeeping table shipped
  **empty** (data doesn't ride a schema-only dump, and unlike `_migrations` it
  was never re-seeded) — so a fresh schema.sql-booted DB made the worker re-run
  its migration 1 into `relation "jobs" already exists` and crash-loop. Fix:
  one cleansing regen of `schema.sql` via throwaway-from-committed with
  `--exclude-schema=graphile_worker` (7801 → 7236 lines; graphile-worker owns
  its schema lifecycle end-to-end and recreates it cleanly on first boot);
  the same flag added to the drift guard's Check-2 pg_dump so a future regen
  that forgets it round-trips dirty and **fails the guard** (enforced, not
  documented-only); regen drill amended in CLAUDE.md + the drift-guard header.
  Safety checked before the cut: every `graphile_worker.add_job` call site is
  request-time (no boot-time dependency on the schema existing), and migration
  137's enqueue is already guarded on the schema being installed. Drift guard:
  all four checks green post-regen. Prod note: nothing to deploy-time here —
  the fix matters on the next fresh boot (DR restore), which now works.

- **2026-07-12 (sixth entry)** — **Follow-graph import dev-stack run-through
  PASSED + the claimed-count truncation bug fixed (FOLLOW-GRAPH-IMPORT-ADR §11.6
  "flip after a dev-stack run-through" — the run-through half is now done).**
  Full stack rebuilt (gateway/web/feed-ingest images were 6 weeks stale) with
  the two flags newly wired into `docker-compose.yml` (`FOLLOW_IMPORT_ENABLED`,
  `FOLLOW_IMPORT_ACTIVITYPUB_ENABLED`, both `:-0` defaults per house pattern)
  and exercised live against real networks: **1a atproto** @bsky.app 11/11 and
  @pfrazee.com 618/618 (batching + the §6.5 >50-source volume default → weight
  1.0; real handles/names/avatars via the D6 metadata pass-through; synthetic
  `last_fetched_at` on every source); **1b Nostr** 251/251 kind-3 contacts as
  bare hex (relay-free invariant; `markFollowListDirty` correctly no-opped for
  a non-discovery-opted account); **1c AP public leg** @Gargron@mastodon.social
  717/717, `unresolved: 0` (every Account entity carried `uri` — no WebFinger
  fallback needed); **1d OPML** folder→feed mapping with the dead entry counted
  in `failed` (D6 probe-on exception), live entries imported. **Phase 2 loop**:
  preview → confirm applied a real `−1` removal; sync removals appended NO
  exclusion (`recordExclusion: false`); a local exclusion suppressed the
  re-add (`upToDate: true` with the excluded account still remotely followed);
  a manual re-add revoked the exclusion (§6.3 symmetry); `importBinding` +
  `lastSyncedAt` ride `GET /workspace/feeds/:id/sources`. §6.4 rails held at
  ~1,600 sources (no tick starvation; ingest spread across all protocols).
  **One bug found and FIXED — `truncated` derived from the remote's claimed
  count**: all three readers compared fetched length against `followsCount`
  (atproto) / `following_count` (AP), but those counts include deactivated/
  suspended accounts the list endpoints omit, so nearly every aged account
  read as permanently truncated — and §11.5's truncation guard then suppressed
  sync REMOVALS forever (verified live: @pfrazee.com counts 647, lists 618).
  `truncated` now comes only from the pagination machinery: `getFollows` /
  `fetchMastodonFollowing` return `{…, complete}` (false on cap-bounded read,
  mid-pagination failure, or malformed page; the Nostr reader was already
  exact and is untouched), the readers set `truncated: !complete`, and the
  claimed count stays display-only in `total`. Post-fix the 647-vs-618 sync
  previews `removalsSkipped: false`. Files: `gateway/src/lib/atproto-resolve.ts`
  (getFollows → `AtprotoFollowsRead`), `gateway/src/lib/activitypub-resolve.ts`
  (fetchMastodonFollowing → `MastodonFollowingRead`),
  `gateway/src/lib/follow-import.ts` (both readers + import),
  `gateway/tests/activitypub-follow-reader.test.ts` (shapes + a count-drift
  regression test), `docker-compose.yml`. Root eslint 0 errors; 30/30
  follow-import tests green. **Also found (separate item, CONSOLIDATED-TODO
  §8.12): a schema.sql-booted fresh DB crash-loops feed-ingest** — the dump
  carries graphile_worker's tables but its `migrations` bookkeeping ships
  empty, so graphile re-runs migration 1 into `relation "jobs" already
  exists`; dev unblocked with `DROP SCHEMA graphile_worker CASCADE` (the
  worker recreates it). Remaining before full light-up: the prod env flip
  (deploy-time), the AP sub-brake's §6.4 soak + one authed self-import
  against a real linked token, Phase 3 onboarding.

- **2026-07-12 (fifth entry)** — **Follow-graph import Phase 1c ActivityPub
  (FOLLOW-GRAPH-IMPORT-ADR §5.3/§11.4) — Mastodon-API follow-graph reader,
  dark behind `FOLLOW_IMPORT_ENABLED` × the new §6.6 sub-brake
  `FOLLOW_IMPORT_ACTIVITYPUB_ENABLED` (default off pending the §6.4
  poller-fairness soak).** **The gating live scope check ran first** (§2's
  re-consent risk): (a) verified against mastodon/mastodon main —
  `following_accounts_controller.rb` authorises `:read, :'read:accounts'`, so
  the already-granted `read:accounts` covers the endpoint, **no re-consent
  flow needed**; bonus finding: `hide_results?` is bypassed when
  `current_account.id == @account.id`, so the authed self-call reads hidden
  follows too. (b) Live against mastodon.social: `lookup` + `following` are
  public; the REST Account entity carries `uri` (the actor URI) for local AND
  remote entries, so canonicalisation is free on ≥4.2 origin instances;
  pagination is a Link header `rel="next"` (`max_id`), newest-follow-first
  (the cap keeps the freshest slice); hidden follows yield an EMPTY LIST, not
  an error. Residual live gap: the authed leg wasn't exercised against a real
  token (no linked AP presence in dev) — do one authed self-import on a
  linked account before flipping the sub-brake in prod. **Reader**
  (`activitypub-resolve.ts` + `follow-import.ts`): input omnivorous (acct /
  @acct / profile URL / actor URI) → WebFinger pins the canonical host (the
  actor URI's origin is the API host — split-domain safe) → a matching linked
  presence (handle = acct) supplies the bearer token from `credentials_enc`
  (bad token → one public retry) → public `lookup` for the instance-local id
  + `following_count` → paged `following` read under `FOLLOW_IMPORT_CAP`,
  same-origin-only Link-header pager (the header is remote-controlled input),
  atproto-mirroring failure contract (first page fails → null; later →
  partial). Hidden detection = public leg + empty + `following_count > 0` →
  new `hidden` graph-result reason → 422 `follows_hidden` ("link the account
  to import"). Entries canonicalise to actor URIs via the entity `uri`, with
  a per-host-throttled WebFinger fallback (4 host-groups parallel, sequential
  within a host) for pre-4.2 origins; unresolvable entries are dropped but
  COUNTED (`unresolved`, threaded to the create response + status line —
  no-silent-caps). **Sync-safety fix that fell out**: `unresolved > 0` now
  suppresses sync removals exactly like truncation (a dropped-but-still-
  followed entry must not read as an unfollow), folded into
  `removalsSkipped`. **Post-link offer** (§7.1): the Mastodon callback now
  appends `&follows=<following_count>` (from the existing
  `verify_credentials` response) to its success redirect — only while AP
  import is live — mirroring Bluesky; `PostLinkImportOffer` generalised to
  both networks (origin identity is protocol-shaped: DID for atproto,
  user@instance for activitypub — the AP `external_id` is a per-instance
  numeric id the reader can't use, which also fixed NetworkReachPanel's
  per-presence affordance to pass `externalHandle` for AP); SettingsPanel
  mounts the offer for `linked=mastodon`; FollowImportSection copy/placeholder
  go capability-aware. `IMPORTABLE_PROTOCOLS` became `importableProtocols()`
  (env-dependent), so the capabilities list lights up `activitypub` with no
  web change when both flags flip. Vitest: new
  `activitypub-follow-reader.test.ts` (13 cases: pager same-origin
  enforcement, cap, failure split, sub-brake, malformed, public happy path,
  hidden detection, authed bypass-of-hidden + bearer contract, WebFinger
  fallback + unresolved accounting, stale-token public retry); gateway suite
  312 green; root eslint 0 errors; `next build` clean; hairline tripwire
  clean; no migration (Phase 2's schema already fits). Remaining: flip
  `FOLLOW_IMPORT_ENABLED` after a dev-stack run-through; flip the AP
  sub-brake only after the §6.4 soak + one live authed self-import; Phase 3
  onboarding.

- **2026-07-12 (fourth entry)** — **Follow-graph import Phase 2 "Sync now"
  (FOLLOW-GRAPH-IMPORT-ADR §11.5) — exclusion-aware re-sync of import-bound
  feeds, dark behind `FOLLOW_IMPORT_ENABLED`.** **Migration 154**:
  `follow_imports` gains `kind` (`import`|`sync`), `removals jsonb`,
  `removal_cursor`, `removed`, and a `preview` status (a persisted plan
  awaiting confirmation — never claimed by the sweep); the unfinished partial
  index now covers previews. **Routes** (`follow-imports.ts`):
  `POST /follow-imports/sync {feedId}` re-reads the bound origin graph, diffs
  (remote − exclusions) against current same-protocol membership
  (`computeSyncDiff`, pure + unit-tested), and persists the `+N/−M` plan as a
  `preview` run (superseding any unconfirmed prior preview for the feed; 409
  while a run is in flight; a zero diff stamps `last_synced_at` and returns
  up-to-date with no row). **Removals are suppressed when the graph read was
  truncated** — past the cap the server can't tell "unfollowed" from "outside
  the newest-N window", so a capped read must never drive removals; the skip
  is surfaced (`removalsSkipped`, no-silent-caps). `POST
  /follow-imports/:id/confirm` flips preview→pending and kicks the sweep;
  `DELETE /follow-imports/:id` cancels a preview (previews also GC'd by the
  sweep after a day). **Engine** (`follow-import.ts`): sync runs apply
  removals BEFORE adds, cursor-persisted per batch (restartable like the add
  side); each removal resolves its `feed_sources` row at apply time
  (already-gone → silent skip) and goes through `removeSource` with the new
  `recordExclusion: false` option — **a sync removal mirrors a remote
  unfollow, not local intent, so it must NOT append an exclusion** (else a
  re-follow at the origin could never sync back in); sync adds re-check
  exclusions at apply time (a deliberate removal between preview and confirm
  wins over the stale plan); the >50-source sampled-volume default is
  import-only (by sync time the feed's volume character is the user's);
  completion stamps `last_synced_at` as before. **Exclusion symmetry fix
  (both `addSource` external branches)**: a manual re-add of a source to an
  import-bound feed now DELETEs the matching `feed_import_exclusions` row
  (§6.3's "the user who wants it back re-adds it" — previously the exclusion
  survived the re-add, so `computeSyncDiff` would have counted the re-added
  member as a removal and sync would undo the user's evident intent);
  `computeSyncDiff` additionally leaves any residual excluded-but-member row
  untouched in both directions. **Web**: `GET /feeds/:id/sources` now carries
  `importBinding` (protocol, origin identity, `last_synced_at`) for bound
  feeds; new `FeedSyncSection` in the FeedComposer (shown only when the
  binding's protocol is in the `followImportProtocols` capability list) —
  origin line + "Sync now" → `+N to add · −M to remove` preview with sample
  names and the one-way reassurance ("nothing is unfollowed there by us") →
  Apply/Cancel → 2s progress poll → completion summary + source-list reload;
  API client gains `syncPreview`/`confirmSync`/`cancelSync` and the run shape
  gains `kind`/`removed`/`removalsTotal`. Vitest: 4 new engine cases
  (removals-before-adds + no-exclusion contract, removal-cursor resume,
  apply-time exclusion skip, failed-removal accounting) + 2 `computeSyncDiff`
  cases; gateway suite 299 green; schema.sql regenerated from a
  throwaway-from-committed DB + drift guard all green; root eslint 0 errors;
  `next build` clean; hairline tripwire clean. Remaining: 1c ActivityPub
  (live scope check first, §6.4 soak), Phase 3 onboarding.

- **2026-07-12 (third entry)** — **Follow-graph import Phase 1d OPML upload
  (FOLLOW-GRAPH-IMPORT-ADR §5.4/§11.4) — RSS subscriptions import from a
  reader export, dark behind `FOLLOW_IMPORT_ENABLED`.** **Parser/planner**
  (`gateway/src/lib/opml.ts`, pure + unit-tested): jsdom in strict-XML mode
  (already a gateway dep — the §11.4 "new XML dep" turned out unnecessary);
  folders map to one feed per folder with nested folders flattened into their
  top-level ancestor, loose entries + folders beyond `OPML_MAX_FEEDS` (10)
  fold into the base feed (named from `feedName` param → OPML head title →
  "Imported feeds"), per-feed URL dedupe, non-http(s)/unparseable xmlUrls
  counted as `invalidEntries` (surfaced, never silent), and the per-import
  1000 cap applied across the plan in order with truncation surfaced.
  **Route**: `POST /follow-imports/opml` (3MiB bodyLimit; text in JSON) mints
  one feed + `follow_imports` run per planned feed in one transaction — with
  **no `feed_import_bindings` row** (OPML is a snapshot by nature, §5.4:
  "Sync now" doesn't apply, re-import = new run) — and returns all runs plus
  the aggregate plan facts. **Engine**: rss runs keep the liveness probe ON
  (`skipProbe: run.protocol !== 'rss'` — the D6 exception: reader exports
  rot; addSource normalises the URL + backfills the feed title, and dead
  entries land in `failed`, reported in the summary). `readFollowGraph('rss')`
  now points at the upload. **Capabilities**: `followImportOpml` — a separate
  boolean, deliberately NOT an entry in `followImportProtocols` (that list
  gates resolver-match "Import follows" affordances, and a plain rss feed URL
  has no follow graph to read). **Web**: `followImports.createOpml`,
  `useOpmlImport` (multi-run sibling of `useFollowImportRun` — one 2s poll
  across all unfinished runs, every minted feed announced via
  `useFeedArrivals`), and the upload block in `FollowImportSection`
  (client-side DOMParser preview → "N feed URLs in M folders / creates up to
  K feeds" confirmation per §6.5 → per-run progress lines + the aggregate
  truncation / folded-folders / invalid-entries / dead-entries copy).
  Vitest: `opml.test.ts` (14 cases) + an engine case for the rss probe
  contract; gateway suite 293 green; root eslint 0 errors; `next build`
  clean; hairline tripwire clean. No migration (reuses 153's tables).
  Remaining: 1c ActivityPub (live scope check first, §6.4 soak), Phase 2
  "Sync now", Phase 3 onboarding.

- **2026-07-12 (second entry)** — **Follow-graph import Phase 1a/1b web
  surfaces (FOLLOW-GRAPH-IMPORT-ADR §7/§11.4) — atproto + Nostr imports are
  now user-visible, still dark behind `FOLLOW_IMPORT_ENABLED`.**
  **Capabilities gate**: `/linked-accounts` capabilities gains
  `followImportProtocols` (`IMPORTABLE_PROTOCOLS` from `follow-import.ts`,
  empty while the flag is dark) — every web affordance keys off it, so 1c/1d
  light up server-side with no web change. **Post-link offer (§7.1)**: the
  Bluesky OAuth callback rides `&follows=<followsCount>` on its existing
  `?linked=` redirect (the count is free — the callback already calls
  `getProfile` for the handle), threaded through the /settings shim →
  overlays dispatcher → `useSettingsOverlay` → `SettingsPanel`, which mounts
  `PostLinkImportOffer` (offer + Not now; separate from the auto-dismissing
  connect banner so it persists). **NetworkReachPanel (§7.2)**: per-presence
  "Import follows" on the linked row (protocols in the capability list) plus
  the paste-an-identity `FollowImportSection` (D8 — universal-resolver input;
  resolved external accounts with readable graphs offer "Import follows";
  resolvable-but-unimportable networks say so). **FeedComposer (§7.3)**: an
  importable resolver match adds "↳ or import everyone they follow as a new
  feed" under the option row. **Shared machinery**: `web/lib/api/follow-imports.ts`
  client; `useFollowImportRun` (start + 2s progress poll, one run at a time
  per surface) + `FollowImportStatus` (progress/summary line — truncation
  always stated per the no-silent-caps rule, Nostr's names-self-heal caveat
  said plainly); `useFeedArrivals` store so the live workspace adopts the
  minted feed immediately (`WorkspaceView.adoptFeed`, also dedupes the
  NewFeedPrompt path). **Bookkeeping**: the two §10 invariants (one-way
  inbound; opt-in per run) added to CLAUDE.md; boot.test.ts drift fixed
  (follow-imports module was missing from the route mirror) + given an
  explicit 30s timeout (it was flaking at vitest's 5s default under the full
  parallel suite — pre-existing at HEAD, not introduced here). Gateway suite
  278 green; root eslint 0 errors; `next build` clean; hairline tripwire
  clean. Remaining: 1c ActivityPub (live scope check first, §6.4 soak), 1d
  OPML, Phase 2 "Sync now", Phase 3 onboarding.

- **2026-07-12** — **Follow-graph import Phase 0 + 1a/1b backend
  (FOLLOW-GRAPH-IMPORT-ADR §11, migration 153) — engine, rails, and the
  atproto/Nostr graph readers; dark behind `FOLLOW_IMPORT_ENABLED`.**
  **Prerequisite refactors** (§11.1): `addSource` exported with an options bag
  (`skipProbe` — the per-call D6 liveness skip; `enqueueRunAt` — jittered
  `run_at` threaded into both subscribe-time `add_job` calls); `removeSource`
  extracted from the DELETE route (route + future Phase-2 sync both call it);
  `createFeedForOwner` extracted from `POST /feeds`; exclusion hooks in
  `removeSource` AND the move handler (`recordImportExclusion` — INSERT…SELECT
  gated on a protocol-matching `feed_import_bindings` row, inside the existing
  transaction). **Migration 153**: `follow_imports` (run row with `identities`
  jsonb + `cursor` for deterministic restart), `feed_import_bindings`,
  `feed_import_exclusions`; schema.sql regenerated + drift guard green.
  **Engine** (`gateway/src/lib/follow-import.ts`): `runFollowImportSweep`
  claims the oldest pending/running run, loops 25-identity batches within one
  invocation, DUPLICATE→skipped / per-source failure→failed (never fails the
  run), seeds synthetic `last_fetched_at` (§6.4a poll stagger), applies the
  >50-source sampled-volume default (bulk weight 4.0→1.0) at completion, and
  stamps `last_synced_at`; registered on the gateway 1-min scheduler + startup
  under advisory lock 100007, with a best-effort immediate kick from POST.
  **Routes** (`gateway/src/routes/follow-imports.ts`): `POST /follow-imports`
  (read graph once → cap 1000 most-recent-first → feed + binding + run row in
  one transaction; truncation surfaced, never silent) and `GET
  /follow-imports/:id` progress poll; 404 while the flag is off. **Graph
  readers**: `getFollows` (atproto-resolve, paginated public AppView) and
  `fetchNostrContacts` (nostr-relay, newest kind-3 wins, p-tag dedup keeps the
  last occurrence, relay hints → metadata only) with npub/nprofile/hex/NIP-05
  origin normalisation; activitypub (1c) and OPML (1d) refuse with
  `import_unsupported` pending §6.4 soak / the upload endpoint. **Poller
  fairness** (§6.4a, `feed-ingest-poll.ts`): the per-host cap now applies
  INSIDE the selection window (window function, host extracted in SQL
  mirroring the JS grouping) so a 500-source single-host import can no longer
  starve the entire poller to ~2 jobs/tick. Vitest: engine batching / resume
  from cursor / DUPLICATE→skipped / feed-deleted abort / volume default
  (`follow-import-engine.test.ts`), exclusion hooks on delete + move
  (`feed-source-exclusions.test.ts`). Remaining for Phase 1 proper: web
  surfaces (post-link offer, NetworkReachPanel, FeedComposer affordance,
  progress UI) — then the two §10 invariants land in CLAUDE.md.

- **2026-07-10** — **Publication-subscription distribution (CONSOLIDATED-TODO
  §1.3, migration 152) — the last hole in the subscription money model.**
  A publication subscription collected the reader leg (tab debit +
  `subscription_charge`, F1/migration 140) and then the money sat: no earning
  ledger entry (deliberate — publication distribution is modeled at payout
  time) and no payout leg (the writer cycle's sub CTE excludes
  `publication_id IS NOT NULL`; the publication pool summed only
  `read_events`). Now the publication payout cycle claims and distributes it.
  **Migration 152**: `subscription_events.publication_payout_id` (FK →
  `publication_payouts`; `writer_payout_id` couldn't be overloaded the way
  `read_events`' is — it carries an FK to `writer_payouts`), partial claim
  index, and `publication_payouts.sub_net_pence` (the sub leg recorded
  separately — `total_pool_pence` stays Σ gross reads). **Cycle** (`payout.ts`):
  eligibility UNIONs reads + settled unclaimed publication sub earnings
  (threshold on readNet + subNet); `computePublicationSplits` gains
  `subNetPence`, added to the pool AFTER the pooled fee (sub earnings are
  already net — fee floored per charge — the same never-through-the-fee rule
  as the writer cycle's `sub` CTE); reserve claims sub events gated
  `settled_at IS NOT NULL` (migration-146 collection gate — never ungated).
  **Reserve also converted to claim-first-then-sum (RETURNING)** — the old
  sum-then-stamp had the same settlement race audit F6 closed in the writer
  cycle (a read settling between sum and stamp was claimed but never
  distributed); article-override earnings now key on the claimed set. A
  subscription-only pool (zero reads) qualifies and distributes. **F5
  chargeback** (`settlement.ts` loader): proration denominator is now
  `total_pool_pence + sub_net_pence` — splits are paid from both legs but a
  read chargeback reverses only the read-derived slice (subscription debt on
  chargeback stays the recorded platform-absorbs posture, chargeback.ts
  header). **Display** (`/publications/:id/earnings`): summary folds both
  legs into net/pending/paid + breaks out `subscriptionNetPence`; payout rows
  carry `subNetPence`; also fixed the summary keying on
  `articles.publication_id` → the denormalised `read_events.publication_id`
  (invariant conformance — display now matches what the pool distributes);
  web `PublicationEarningsTab` shows a "From subscriptions" card + per-payout
  subscription line. Validation: payment-service build + 110 tests (5 new
  `computePublicationSplits` sub-leg tests), gateway build + 263 tests, web
  `next build` clean, root eslint 0 errors, drift guard 4/4 green, ledger
  adjacency green, migration applied to dev. NOT runtime-verified (needs
  container rebuild + a pub-subscription → settle → cycle walk; queued in
  CONSOLIDATED-TODO §11). The remaining publication-sub caveat: renewal
  charges still ride the shared expiry worker — nothing §1.3-specific left.

- **2026-07-10** — **Discovery-expansion post-ship review: six fixes + the
  §8.3 author-deletion tombstone + the squatter amendment (migration 151).**
  Same-day five-agent review of the shipped RESOLVER-DISCOVERY-ADR phases
  found six bugs; all fixed, plus two owner-decided design amendments.
  (1) DM/invite implicit pick treated a lone SPECULATIVE fuzzy match as
  unambiguous — Enter DM'd/invited a name-similar stranger
  (`MessagesInbox`/`MembersTab`/`DmFeeSettings` now gate on
  `confidence !== 'speculative'`; MembersTab renders pick rows for a lone
  unresolved match). (2) Stale-Enter race: during the 300ms debounce window
  `matches` answered the PREVIOUS query while `resolving` was false —
  `useResolverInput` now tracks `resolvedFor` and exposes `pending`
  (also hardens `doneEmpty`); the three pick surfaces gate on it.
  (3) A literal NUL byte committed inside `searchKnownWorld`'s dedupe-key
  template made `resolver.ts` classify as BINARY — grep/ripgrep silently
  skipped the whole 1,400-line file (any grep-based audit/tripwire was blind
  to it); now the backslash-u0000 escape. (4) Catalog `rss_feed` vs known-world
  `external_source(rss)` never deduped (`rssfeed:` vs `rss:` key-spaces) —
  the same feed rendered under both Matches and Suggestions; unified on
  `rss:` in `resolver-merge.ts`. (5) Catalog alias-in-query over-match:
  unbounded `q.includes(a)` let short generic aliases ("thor" in "thorough",
  "paid") hijack queries and outrank every network branch via the precision
  tie-break — that direction now requires ≥5-char aliases on word boundaries
  (`aliasInQuery`). (6) `mergeCatalogs` lacked the script's multi-tenant
  feed-host exemption — one curated feedburner/megaphone head entry would
  silently delete every generated tenant on that host at load; the set moved
  to `discovery-catalog.ts` (script imports it back) and the merge dedupes
  those hosts by full URL. **§8.3 tombstone (migration 151)**: the ADR's
  "honour deletes" claim covered items, not the AUTHORS the known-world index
  surfaces (no code path ever deleted an `external_authors` row) —
  `external_authors.deleted_at` added; stamped by AP actor/outbox HTTP 410
  (typed `ApFetchStatusError`; 410 also deactivates the source immediately)
  and nostr kind-0 `deleted:true` riding the existing metadata ratchet
  (stamp + clear, poll AND backfill so the ratchet can't swallow it);
  `searchKnownWorld` excludes tombstoned authors and their source-leg twins
  (atproto signal deferred — Jetstream doesn't subscribe account events).
  **Squatter amendment**: an exact native username hit no longer suppresses
  the external world in SUBSCRIBE context (a user named "guardian" shadowed
  The Guardian) — known-world + discovery run alongside; exact still ranks
  first; invite/dm/general keep the short-circuit; fuzzy natives stay
  suppressed by an exact hit. Tests: gateway 263 passed (+5 new: boundary
  matcher ×3, multi-tenant merge, rss cross-shape dedupe, squatter
  orchestration), feed-ingest 209 passed, web 136 passed (1 pre-existing
  `collision.test.ts` failure, untouched by this work), drift guard 4/4
  green, root eslint 0 errors, `next build` clean. Remaining review findings
  queued in CONSOLIDATED-TODO §0b.

- **2026-07-10** — **Resolver audit F1: addSource liveness verification +
  error-space split (HIGH — the resolver was advisory).**
  `RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md` §F1, fix shape (b). The
  `(protocol, sourceUri)` branch validated syntax only — a well-formed dead
  RSS URL, nonexistent DID, or random hex pubkey got 201 Created plus a live
  subscription, and the failure surfaced only as an asynchronously climbing
  `error_count` the user never saw; all real verification lived in `/resolve`,
  on the write path by frontend convention alone. New
  `gateway/src/lib/source-liveness.ts::verifySourceLiveness(protocol,
  sourceUri, relayUrls?)` runs pre-transaction in `addSource`: normalises the
  input to its canonical stored form (AP acct → actor URI via webfinger,
  atproto handle → DID via `getProfile`, npub/nprofile → hex via nip19 — the
  omnivorous-input rule; it subsumes the §5.2 `resolveApSourceUri`
  down-payment, now retired) and probes liveness per protocol (rss: fetch +
  rss-parser confirm, **JSON Feed accepted** — ingest supports it; atproto:
  AppView `getProfile`; nostr: kind-0 on hint ∪ default relays; AP: actor
  document fetch, canonical id stored). Error space split per the audit:
  malformed → 400 `{error:'invalid_source_uri', message}`, unreachable → 422
  `{error:'source_unreachable', message}` (was one collapsed 404; also fixes
  the misleading-404 minor note for atproto handles — they now just work).
  Probe metadata (feed title / profile name / avatar) backfills display
  fields when the caller sends none. A `(protocol, sourceUri)` pair already
  held as a healthy row (`is_active, error_count=0, last_fetched_at` set)
  skips the probe — canonical-form picks stay fast. Operator brake
  `SOURCE_LIVENESS_ENFORCED=0` (docker-compose + DEPLOYMENT.md) skips probes
  for canonical inputs, keeping normalisation. Frontend: `apiErrorMessage`
  helper in `web/src/lib/api/client.ts`; FeedComposer renders the server
  verdict instead of the raw ApiError string; VesselBar gains an inline
  dropdown error (was `console.error`-only silence). Tests: 26-case
  `gateway/tests/source-liveness.test.ts` (per-protocol canonical/normalise/
  malformed/unreachable/brake matrix); `resolveApSourceUri`'s block replaced
  by `isAcctShape` tests. **Verified live end-to-end** against the dev DB
  with the compiled gateway: all five negative verdicts (incl. the audit's
  random-hex-pubkey 201 → now 422), Guardian RSS title backfill,
  `jay.bsky.team` → DID canonicalisation, `@Gargron@mastodon.social` acct
  add, and duplicate-via-handle → 409. Gateway tsc + 257 tests, `next build`,
  hairline tripwire, root eslint 0 errors all clean.

- **2026-07-10** — **Resolver audit F4: the three omnivorous-input violators
  moved onto `useResolverInput`.**
  `RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md` §F4. DM new-conversation
  (`MessagesInbox.tsx`) and DM fee override (`DmFeeSettings.tsx`) were
  username-only `GET /v1/search?type=writers` taking `results[0]` blind
  (with `alert()` errors); the publication invite (`MembersTab.tsx`) used the
  resolver but through a hand-rolled debounce with no stale-request guard
  (fast typing could land an old match over a newer one). All three now ride
  `useResolverInput` (contexts `dm`/`dm`/`invite` — native-only server-side):
  matches render as clickable rows and the action fires on a PICKED account,
  never a first-result guess (Enter picks only an unambiguous single match);
  errors are inline text, no `alert()`. `MatchOption` gains an additive
  `account?: {id, username, displayName}` carried from `native_account`
  matches (matchToOptions) so person-picking surfaces act on the account
  rather than a feed-source add. MembersTab keeps its pre-F4 conveniences:
  a single match resolves implicitly ("Resolved: …"), multiple matches need
  an explicit pick, and no-match falls back to invite-by-email (message now
  distinguishes email-shaped input); the hook's `genRef` closes the race.
  Fee override picks into a clearable chip; Add is disabled until a person
  is selected. Validated: web tsc clean, `next build` clean, resolve tests
  extended (24 passed), hairline tripwire clean, root eslint 0 errors.
  (Pre-existing, unrelated: `web/tests/collision.test.ts` "pushes upward"
  fails on the clean tree too — not introduced here.)

- **2026-07-10** — **Resolver audit F2: atproto backfill failure accounting +
  retry (HIGH — the silent data-loss hole).**
  `RESOLVER-SOURCE-INPUT-AUDIT-2026-07-09.md` §F2. The atproto backfill's
  outer catch was log-only — a failed backfill left the source
  `is_active=TRUE, error_count=0`, looking healthy while producing nothing —
  and all subscribe-time ingest jobs were `max_attempts := 1`, which for
  atproto meant NO retry ever (the 60s poll scheduler skips the protocol
  while Jetstream is healthy, and Jetstream only carries posts *after*
  subscribe). Fix, both halves:
  (1) `feed-ingest-atproto-backfill.ts` now runs the same error-count /
  backoff / deactivation accounting as the nostr backfill on its outer catch
  (`feed_ingest_max_error_count` / `feed_ingest_error_backoff_factor` via
  `getPlatformConfig`, replacing the one-off raw `platform_config` read),
  then **re-throws** so graphile-worker retries; a first-page `getAuthorFeed`
  HTTP failure now throws into that path instead of falling through to the
  success branch and resetting `error_count = 0` (a mid-pagination failure
  still keeps the partial backfill as success). The enrichment-failure
  accounting (2026-07-06 residual) is untouched — listener-owned self-heal.
  (2) `gateway/routes/feeds/sources.ts` gains `externalFetchMaxAttempts`:
  5 attempts for `feed_ingest_atproto_backfill` at both subscribe-time
  enqueue sites, 1 (unchanged) for the poll-recovered protocols — their
  retry IS the poll scheduler. Interactions checked: the listener's
  enrichment filter backs off on the same `error_count` (compatible — a live
  event resets it); deactivation at the cap drops the DID from Jetstream,
  which is the intended terminal state for a deleted account. Tests: new
  `feed-ingest-atproto-backfill.test.ts` (5 — accounting params + rethrow on
  page-0 HTTP failure and network throw, deactivation at cap, success reset,
  mid-pagination partial-success) + `externalFetchMaxAttempts` pinned in
  `feed-sources-enqueue.test.ts`. Validated: feed-ingest 209 passed +
  gateway 235 passed, both `tsc` clean, root eslint 0 errors.

- **2026-07-10** — **Resolver discovery expansion Phase 4: generated catalog
  (discharges audit F7 — the last built phase; the ADR's remaining items are
  deferred-by-design).** `RESOLVER-DISCOVERY-ADR.md` §7.1. New
  `scripts/gen-discovery-catalog.ts` (offline, operator-run): pulls candidates
  from Wikidata (CC0; P1019 "web feed URL" per news/media/blog/podcast class,
  one SPARQL query per class, sitelink count as prominence rank; en label
  required, aliases from 9 Latin-script langs) plus optional licence-vetted
  local OPML (`--opml`, repeatable — none used for v1, Wikidata alone cleared
  the floor); dedupes by feed host in rank order (best-ranked per host wins,
  with a multi-tenant feed-host exemption — megaphone/libsyn/feedburner/… —
  where dedup is by full URL, else one podcast platform tenant would silently
  swallow the rest); probes every candidate through `safeFetch` + real
  rss-parser confirm (the same bar as the runtime `tryRssFetch`), in rank
  order with early stop at target, so dead feeds never enter. §7.1 alias
  hygiene at generation: lowercase, NFKD diacritic-fold, ≥3 chars, capped 8,
  plus a bare-form alias with the leading article stripped. Output
  `gateway/src/lib/discovery-catalog.generated.ts` (marked generated,
  committed; 500 entries, all probed live 2026-07-10). Runtime:
  `discovery-catalog.ts` gains `mergeCatalogs` (curated head keeps priority;
  a generated entry colliding with a head feed host is dropped at load —
  head-vs-generated only, generated-vs-generated dedup is generation-time),
  `foldDiacritics` + `feedHost`, and the module-level `FULL_CATALOG`;
  `searchCatalog` scans the merged list with a diacritic-folded query
  ("Süddeutsche" now matches the folded aliases) — still pure, zero-I/O,
  linear scan (§7.1 perf ceiling ~5k). Script exits 1 below the 300-entry
  acceptance floor; a test pins the same floor + per-entry hygiene
  invariants. Tests: 7 new in `discovery-catalog.test.ts` (16 total — head
  priority, merge host-dedupe semantics, folding, generated hygiene).
  Validated: gateway 235 passed / 17 skipped, `tsc` clean, root eslint 0
  errors. Web untouched (catalog hits ride the existing `rssFeed` match
  shape). Remaining ADR items are deliberately deferred: branch 4 web-search
  bridge behind `DISCOVERY_WEBSEARCH_ENABLED` (build-triggered by a measured
  zero-result rate), FASP provider (§5.1 adoption bar).

- **2026-07-10** — **Resolver discovery expansion Phase 3: bridge-aware merge +
  rendered confidence tiers (discharges audit F3 + F5.4).**
  `RESOLVER-DISCOVERY-ADR.md` §6. The pure bridge helpers relocated from
  `feed-ingest/src/tasks/identity-link-detect.ts` to
  `shared/src/lib/bridge-identity.ts` (gateway can't import feed-ingest;
  structural `BridgeSourceLike` input so `DetectSourceRow` passes unchanged;
  feed-ingest re-imports + re-exports and its 32 existing tests pin the move —
  `nostr-tools` added to shared deps). New `gateway/src/lib/resolver-merge.ts`
  (owns the match-shape types — second bite of the §8.5 decomposition):
  `mergeMatches(existing, incoming, context)` = alias dedupe (per-protocol
  key-space + AP acct ↔ actor URI cross-keys; higher confidence wins, ties keep
  the persisted candidate) → bridge-collision drop (a mirror whose decoded
  origin key collides with a native candidate is dropped; twin-less mirrors
  survive) → §6.2 sort (confidence rank → context priority → branch
  precision). Every match-set assembly in `resolve()`/`resolveAsync()` now
  passes through it (replacing raw pushes), so each `storeAsyncResult` write
  persists a merged, ordered set. Bridge keys ride new additive `ResolverMatch`
  hint fields (`handle`/`actorUrl`/`proxy` — never rendered, never re-enter
  addSource): Bluesky discovery + atproto exact/probable + known-world + AP
  exact carry `handle`, AP discovery carries `actorUrl`, and `discoverNostr`
  lifts the NIP-48 `["proxy", origin, protocol]` tag from the now-retained
  `NostrCandidate.tags` (`nostr-search.ts`). All three bridge directions
  collapse (Bridgy Fed both ways + Mostr, incl. the acct-only npub form and a
  NIP-48-proxied nostr mirror of a native AP actor). §6.2 refinement recorded
  in the ADR: branch precision applies only within the speculative tier (where
  branch ≡ match shape), so known-world trgm score order survives the stable
  sort with no provenance field. Frontend (§6.4, audit F3):
  `partitionMatchOptions` in `web/src/lib/workspace/resolve.ts` → `sections`
  on `useResolverInput`; Matches/Suggestions rendered on all three surfaces in
  their own contrast vocabulary (FeedComposer `TOKENS.hintFg`, VesselBar
  vessel-palette `barTextMuted`, IdentityLinkControl `.label-ui text-grey-600`
  partitioned after its `linkable` filter); the Matches header only renders
  when both sections are present. Tests: `gateway/tests/resolver-merge.test.ts`
  (18, pure), 3 orchestration-harness extensions (bridge dedupe e2e, NIP-48
  drop, final-row ordering — 28 total), 4 web partition tests. Validated:
  gateway 228 passed / 17 skipped, feed-ingest 204, shared 81, web 24
  (resolve), `tsc` clean ×3, root eslint 0 errors, hairline tripwire clean,
  `next build` green.

- **2026-07-10** — **Resolver discovery expansion Phase 2: `activitypub_discovery`
  + addSource acct handling.** `RESOLVER-DISCOVERY-ADR.md` §5. New
  `gateway/src/lib/ap-account-search.ts`: `ApAccountSearchProvider` interface
  (the FASP hedge — a Fediscovery `account_search` provider slots in with no
  resolver changes once §5.1's adoption bar clears) with the v1
  `mastodon_instances` provider — unauthenticated `GET /api/v2/search?type=accounts`
  (free since Mastodon 4.0; no `resolve`, deliberate — webfinger happens once,
  at pick time) against `MASTODON_DISCOVERY_INSTANCES` (comma-separated, default
  `mastodon.social`; docker-compose + DEPLOYMENT.md rows added, distinct from
  the ASSISTED allowlist). Good-citizen guards per §5.2: `safeFetch` 5s
  timeout, per-(instance, query) 5-min LRU memo (errors/429 memo an empty
  result, suppressing immediate retries), per-instance concurrency 1
  (tail-chained), per-instance fail-soft to `[]`, min query length 3. Acct
  canonicalisation: domainless local accts get the instance host appended;
  cross-instance dedupe by lowercased canonical acct; `Account.uri` (actor
  identifier) carried on the candidate for known-world dedupe. Resolver:
  `activitypub_discovery` registered at both trigger sites (free_text +
  no-exact-hit platform_username), gated `discover && !skipExternal` like its
  siblings; `discoverActivityPub` maps candidates to speculative activitypub
  matches (sourceUri = canonical acct) deduping against existing AP matches on
  BOTH key-spaces (acct + actor URI — a Phase A known-world hit wins, it's
  probable). Pick path (§5.2 correction, down-payment on audit F1):
  `addSource`'s AP branch now accepts an acct via new
  `resolveApSourceUri` (`activitypub-resolve.ts`) — https actor URI passes
  through; acct shape (optional leading @) webfingers to the actor URI before
  the transaction; failure → the existing 404. Tests: 13 new provider tests
  (`ap-account-search.test.ts`), 8 new `resolveApSourceUri` tests, harness
  extended (AP branch in the gating matrix + isolation + known-world-dedupe;
  25 orchestration tests). Validated: gateway suite 207 passed / 17 skipped,
  `tsc` clean, root eslint 0 errors.

- **2026-07-10** — **Resolver discovery expansion Phase 1: known-world index
  (migration 150).** `RESOLVER-DISCOVERY-ADR.md` §4. New Phase A branch
  `searchKnownWorld` (`gateway/src/lib/resolver.ts`): pg_trgm fuzzy match over
  the external identities the platform already holds — `external_authors`
  (identity = `stable_handle`: nostr hex / atproto DID / AP actor URI, all
  addSource-able verbatim) UNION addSource-able `external_sources` (identity =
  `source_uri`; `is_active AND orphaned_at IS NULL`, protocols restricted to
  `rss`/`nostr_external`/`atproto`/`activitypub` — email sources excluded).
  Wired into the `free_text` case and the no-exact-hit `platform_username`
  branch, in `Promise.all` with `searchPlatform`, gated `!skipExternal`
  (invite/dm stay native-only); zero network I/O so hits land instantly,
  pre-Phase-B, as `confidence:'probable'`. Min query length 3 (trigram noise +
  enumeration surface, ADR §8), over-fetch ×2 then dedupe author/source twins
  on `(protocol, identity)` preferring the source row, cap 5. Migration 150
  adds the four GIN trgm indexes (display_name/handle × authors/sources);
  schema.sql regenerated from a fully-migrated throwaway (pg_dump + seed
  re-append in one step), drift guard all four checks green; dev DB migrated.
  8 new tests on the Phase 0 harness (Phase-A instant + probable mapping,
  platform_username fallback, exact-hit short-circuit, min-length no-query,
  invite/dm native-only, twin dedupe source-wins, cap-5). Frontend untouched —
  known-world hits ride the existing `externalSource` match shape (tier
  rendering is Phase 3). Validated: gateway suite 184 passed / 17 skipped,
  `tsc` clean, root eslint 0 errors, live SQL exercised against dev.

- **2026-07-10** — **Resolver discovery expansion Phase 0: orchestration
  harness (audit F8) + nostr-search extraction + structural chain isolation.**
  `RESOLVER-DISCOVERY-ADR.md` Phase 0. New
  `gateway/tests/resolver-orchestration.test.ts` (15 tests) exercises
  `resolve()`/`resolveAsync()` through the public surface (`resolve` +
  `getAsyncResult` over a faked `resolver_async_results`/accounts store, all
  network chains mocked at module seams, zero live I/O): Phase A→B assembly +
  enrichment, the `discover`/`skipExternal`/context gating matrix (invite/dm
  never register discovery chains; exact-username short-circuit), incremental
  partial persistence order (catalog partial lands before network branches,
  final row `complete`), initiator scoping (+ non-UUID guard), and per-chain
  failure isolation. Two source changes ride it: (1) the Nostr relay leaves
  (`searchNostrProfiles`/`fetchNostrProfile`/`parseNostrProfileContent` +
  socket lifecycle) extracted behaviour-identically to
  `gateway/src/lib/nostr-search.ts` — first bite of the `resolver.ts`
  decomposition (CONSOLIDATED-TODO §8.5) and the mockable seam the harness
  needed (the NIP-50 chain was in-file, unreachable by `vi.mock`); resolver
  drops its `ws`/`pinnedWebSocketOptions` imports. (2) `safeChain` wraps every
  Phase B chain call in `resolveAsync` — previously isolation relied on each
  leaf catching internally, so a throwing chain rejected the discovery
  `Promise.all`, dropped sibling results, and stranded the async row `pending`
  until TTL; now it degrades to "no candidates from that chain" with a warn
  log, structurally. ADR amended with the 2026-07-10 build-time verifications
  (§4.2 AP identity shape = actor URI, addSource-ready; §5.2 pick-path
  correction — picks go straight to `addSource`, so Phase 2 teaches its AP
  branch acct→webfinger→actor-URI, a down-payment on audit F1; §6.4
  per-surface header styling). Validated: gateway suite 176 passed / 17
  skipped (pre-existing skips), `tsc` clean, root eslint 0 errors.

- **2026-07-09** — **thread context never clips (parents/replies at full
  length).** In an expanded conversation, long ancestors/replies were
  truncated by the feed card's collapse-truncate (220/200-char text cuts, an
  8-line clamp on external HTML bodies), and the only way to read the rest was
  clicking the entry — which re-roots the whole thread on it. The §4
  capability-matrix table already said thread-parent/thread-reply body text is
  "full"; the implementation had drifted by reusing the feed level's `full`
  body mode. Fix: `LEVEL_SPEC["thread-parent"]`/`["thread-reply"]` now use the
  unclipped `expanded` body mode (`web/src/lib/post/level-spec.ts`), so thread
  entries render whole bodies (articles: full standfirst) with no clamp. Feed
  cards and quoted-embed minis keep their truncation — clipping is a
  collapsed-feed affordance only. ADR §4 note added recording the
  interpretation. Validated: web `tsc` clean, `next build` clean, level-spec
  matrix tests 17/17, hairline tripwire clean on touched files.

- **2026-07-09** — **quote-tile click-to-focus parity (native quotes + surface
  wiring).** Audited the "clicking any card focuses it as the expanded
  conversation's focal" rule across first-order feed cards, thread
  ancestors/replies, and quoted embeds. Body clicks and ancestor/reply re-root
  were already uniform (one engine: `PostThread`/`usePostThread`/`level-spec`);
  the gaps were all in quote embeds. (1) **Native quote tiles never focused the
  quoted post** (`QuotedEmbed.tsx`): only the external branch forwarded
  `onQuoteOpen` — a native note quoting a native post rendered an inert tile,
  and one quoting an external post linked straight out to origin. Now every
  quote tile with a wired host focuses the quoted post in place
  (`role="button"` + keyboard, `stopPropagation`, the `QuotedPostTile`
  grammar), including the previously-inert no-preview and `stub` buttons
  (closing the old "Phase 3" TODO); the origin permalink link-out survives only
  as the static-context fallback (no `onQuoteOpen`) — in-place focus wins, the
  out-link stays reachable from the focused post's source-attribution line.
  (2) **`SourceSurface` + `AuthorProfileView` collapsed cards passed no
  `onQuoteOpen`**, so even external quote tiles were static there: their
  `expanded: Set<postId>` became `Map<hostId, rootId>` (the WorkspaceView
  `expandQuote` grammar) so a quote click roots the thread on the QUOTED post.
  (3) **Failed re-root no longer strands the thread**
  (`usePostThread.ts::reroot`/`fetchFocal`): a re-root target whose `/thread`
  fetch fails (e.g. a quoted post's context-only twin reclaimed by
  `external-context-gc`) reverts the focal to where it was instead of deriving
  against a missing node — unless the target is already renderable from the
  pool (only its descendant page failed), where the click is kept. Known
  residual (pre-existing, unchanged): a quote whose target is an
  `article`-type post expands it as a thread focal rather than opening the
  reader (the host-side `type !== "article"` guard can't see the target's type
  pre-fetch), and the article focal's click then opens the reader, not
  collapse. Validated: web `tsc` clean, `next build` clean, root eslint 0
  errors, hairline tripwire clean on touched files (the one vitest failure,
  `collision.test.ts`, pre-exists on clean HEAD). CLAUDE.md card-behaviour
  bullet updated (quote-tile rule now native+external; stale
  `ConversationView`/`ExternalAncestorRail` wiring pointers replaced with the
  live `PostThread`/`usePostThread` engine).
- **2026-07-09** — **follow/unfollow symmetry audit (3 fixes).** Audited every
  profile-type follow affordance (native profile page/overlay, `/author/:id`,
  `AuthorModal` hover card, publication surfaces, NetworkPanel/FollowingTab)
  for the rule *"anywhere you can follow, you can unfollow when following"*.
  (1) **Dead unfollow in the profile feed-picker**
  (`ProfileFollowControl.tsx::toggleFeed`): the `!target.protocol ||
  !target.sourceUri` guard sat above both branches, but removal only needs the
  `feed_sources` row id — a followTarget with those absent rendered a
  "Following ▾" picker whose untick silently no-opped. Guard now scoped to the
  add branch, mirroring `AuthorModal.handleClick`. (2) **Self-follow button**:
  `resolveNativeAuthor` (`gateway/src/lib/author-resolve.ts`) emitted
  `followTarget` even for `viewerId === userId`, so hovering your own byline /
  viewing your own `/author/:id` offered a FOLLOW whose click 400'd
  (`Cannot follow yourself`) and silently reverted. Now omitted for self —
  one gateway change covers both client consumers, which already render
  nothing without a followTarget. (3) **Tier-D follow parity**
  (`AuthorModal.tsx`): the tier-D branch didn't pass `feedId` to
  `FollowButton` (tier C did), so a followable tier-D RSS byline hovered
  inside a feed had no follow affordance at all; now passed, and the button
  still self-gates on protocol (email stays affordance-free). Non-gaps
  verified in the same audit: WriterActivity toggle, PubFollowButton
  (hover→Unfollow), NetworkPanel/FollowingTab unfollows, and the per-feed
  "FOLLOW while following elsewhere" hover-card label (deliberate — the
  profile picker is the all-feeds view). Validation: gateway tsc, web tsc +
  `next build`, hairline tripwire, root eslint 0 errors.
- **2026-07-09** — **commit-audit §0 findings fixed (items 1–7: 3 HIGH, 2 MEDIUM,
  2 LOW)** from the four-agent review of the July 7–8 ships (CONSOLIDATED-TODO §0,
  queued at `2fda554`). (1) **nginx `/media/` public-write exposure**: the blanket
  proxy exposed Blossom's `PUT /upload` + `DELETE /<sha>` to the open internet
  (BUD-02 auth accepts any self-signed kind-24242 event — internal-only
  reachability IS its access control). Now a quoted-regex location admitting only
  `^/media/[0-9a-f]{64}(\.[a-z0-9]+)?$` with `limit_except GET` (GET implies HEAD;
  DELETE on a hash path → 403; everything else under `/media/` falls through to
  web → 404). `nginx -t` verified in a throwaway container — the unquoted `{64}`
  quantifier is a syntax error, hence the quotes. **Prod needs the nginx
  force-recreate** (bind-mount inode trap). (2) **Draft guess vs scheduled
  drafts**: the first-save untagged-draft guess (`drafts.ts`) now filters
  `scheduled_at IS NULL`, so a new article's first autosave can no longer
  COALESCE-overwrite a *waiting scheduled* draft (which the scheduler would then
  publish under the wrong slot and delete). (3) **Drive fulfilment timing**: the
  web pipeline now sends `draftId` only on the FINAL index call (the only call
  for free; step-5/v2 for paywalled) so a pledge drive can never match — and
  charge pledgers — before the vault seals (`web/src/lib/publish.ts`). (4)
  **Fulfilment failure must block the draft delete**: `checkAndTriggerDriveFulfilment`
  split into `matchDriveForPublish(client,…)` (txn-scoped match/stamp) +
  `queueDriveFulfilment` (post-commit async kick). The index route runs the match
  INSIDE the article-index transaction — a match failure rolls back the whole
  index and the client keeps the draft (retry converges) instead of committing an
  article whose drive is permanently orphaned once the draft delete SET NULLs
  `pledge_drives.draft_id`. The scheduler's two call sites no longer swallow the
  error (`.catch(log)` removed) — failure restores `scheduled_at`, retry next
  cycle. (5) **Cleanup-script predicate**: `scripts/cleanup-orphaned-drafts.sql`
  Tier 1 now requires `a.published_at IS NOT NULL`, so an in-review publication
  submission's draft (deliberately kept while pending) can no longer classify as
  an auto-deletable orphan. Unblocks the §11 prod run. (6) **Paywalled publish
  email deferred to completion**: step 2 (v1 anchor index) sends `sendEmail:false`;
  the step-5 v2 index carries the new `emailAsNew` flag (echoing step 2's `isNew`,
  now returned by `POST /articles`), and the route emails when
  `(isNew || emailAsNew) && sendEmail !== false` — so subscribers are never
  emailed links to an article whose vault failure soft-deletes it. Edits still
  never email (both flags false). (7) **Blossom rollback docs corrected**
  (ADR Sequencing §5 + Phase 3 + compose comment): a revert serves only
  PRE-cutover blobs; post-cutover blobs live solely in `blossom_data` and need a
  Blossom→disk copy script (unwritten) before the soak-cycle rollback is real.
  Item 8 (cosmetic tail) stays queued, batched with §7. Validation: gateway tsc
  + 161 tests green; root eslint 0 errors; web `next build` green (the one web
  test failure is the documented pre-existing `collision.test.ts` flake);
  `nginx -t` pass. NOT runtime-verified — the §11 verify list covers it.
- **2026-07-08** — **Stripe webhooks routed through nginx.** The webhook handler
  (`payment-service/src/routes/webhook.ts`, `POST /webhooks/stripe`) is registered
  with **no prefix**, so it does not sit under the `/api/` → gateway proxy. `nginx.conf`
  had no matching `location`, so the path fell through to `location /` (web) and 404'd
  — Stripe events never reached the payment service. Added a dedicated
  `location = /webhooks/stripe` → `http://payment:3001` block (set-var + shared
  `127.0.0.11` resolver, matching the `/media/` convention; raw body forwarded
  untouched for signature verification). Prod activation still needs the Stripe
  dashboard endpoint pointed at `https://all.haus/webhooks/stripe`, the signing
  secret(s) in `payment-service/.env`, and an nginx **force-recreate** (single-file
  bind-mount inode trap). Docs: `DEPLOYMENT.md` *Known limitations* › Stripe.
- **2026-07-08** — **media uploads moved onto the Blossom blob store (BUD-02)**
  (commit `9664366`; `docs/adr/ADR-blossom-migration.md` Phases 1–3, **live on
  prod**). The gateway now crunches to WebP then signs a kind-24242 auth with the
  uploader's custodial key and `PUT`s the blob to the internal Blossom server
  (pinned `6.2.0`), verifying the returned hash before the `media_uploads`
  insert; nginx proxies `/media/<sha256>.webp` → Blossom. Public URL scheme
  unchanged (`PUBLIC_MEDIA_URL/<sha256>.webp`), so no stored-URL rewrites. Phase 0
  spiked the real image and settled three facts the repo couldn't: v6 Deno config
  schema (rewrote `blossom-config.yml`), `rules: []` rejects all uploads (needs an
  `image/*` rule + 100y expiration so pruning is a no-op), and the image ships
  only `deno` (healthcheck switched off `wget`). One-off
  `scripts/migrate-media-to-blossom.ts` backfills disk blobs (idempotent, HEAD-
  deduped). `media_data` kept mounted for rollback; **Phase 4** (drop the volume +
  dead disk code) waits one soak cycle. Cutover gotchas — logged in the ADR's
  *Deployment notes* and `DEPLOYMENT.md`: `up -d gateway` reuses the old image
  (must `build --no-cache`), and nginx's single-file bind-mount serves a **stale**
  config after `git reset` (needs `up -d --force-recreate nginx`, not `reload`).
- **2026-07-08** — **duplicate-draft-after-publish fixed (drafts row targeting
  + post-publish cleanup + drive FK)** (migration 149). Reported symptom: a
  scheduled article that had been drafted, saved, then scheduled persisted in
  the dashboard in **two forms** — a leftover draft and the published article.
  Root: the editor never told the server *which* draft row it was editing —
  autosave, the "Save draft" button, and the schedule-save all `POST /drafts`
  with no id. For a new article the gateway guessed the row via
  SELECT-then-INSERT ("most recent untagged draft, else INSERT") with no
  concurrency guard, so the 3s debounced autosave racing the explicit Save
  both saw "no draft" and **both INSERTed** — a duplicate. Every later save +
  the schedule action then targeted only the newest twin; the scheduler
  published and deleted that one, orphaning the older twin (full text intact)
  in the dashboard forever. A second deterministic path: **publish-now never
  deleted the working draft at all** (only the *scheduler* path deleted the
  row it published), so any autosaved article published via the button left
  its draft behind every time. Fixes: (1) the editor now echoes its
  `currentDraftId` (and editing `dTag`) through every save; `POST /drafts`
  targets that exact row first, keeping the "most recent" guess only for the
  genuine first save — now under a per-writer `pg_advisory_xact_lock`
  (`draft_new:<writer>`) so concurrent first saves converge on one row. A
  stale/deleted `draftId` falls through to create (no content loss). (2)
  `useArticleEditorInit.handlePublish` deletes the working draft after a
  successful publish (best-effort; publication submissions that land *in
  review* keep their draft); `publishArticle` forwards `draftId` to the index
  route (wiring publish-now pledge-drive fulfilment too). A pending autosave
  is cancelled before publish/schedule so it can't recreate the row. (3)
  migration 149 makes `pledge_drives.draft_id` `ON DELETE SET NULL` (was
  action-less) and the drive-fulfilment match is now *awaited* before any
  draft delete — closes a latent wedge where a drive-backed scheduled draft's
  post-publish DELETE threw, reset `scheduled_at`, and republished every 60s.
  Also closes the family of clobbering bugs the row-guess caused (autosave
  writing into the wrong draft when an older one is reopened; an edit-mode
  autosave shadowing a published article; a new-article autosave overwriting a
  waiting *scheduled* draft). Verified with a harness driving the real
  `draftRoutes` + `publishScheduledDrafts` against the dev DB (9/9 checks:
  concurrent-save convergence, id pinning, stale-id recovery, scheduled
  publish deletes the draft, drive matched before delete). Files:
  `gateway/src/routes/drafts.ts`, `gateway/src/workers/scheduler.ts`,
  `gateway/src/routes/articles/publish.ts`,
  `web/src/components/editor/ArticleEditor.tsx`,
  `web/src/hooks/useArticleEditorInit.ts`, `web/src/lib/drafts.ts`,
  `web/src/lib/publish.ts`, `web/src/lib/api/articles.ts` (already had
  `draftId`), `migrations/149_pledge_drives_draft_fk_set_null.sql`, `schema.sql`.
  **Prod cleanup** (the fix does not retroactively remove the twins already
  stranded before deploy): `scripts/cleanup-orphaned-drafts.sql` — dry-run by
  default, deletes only the Tier 1 exact-content-match set with `-v apply=true`
  (Tier 2 title-only + drive-linked candidates reported for manual review,
  never auto-deleted). → CONSOLIDATED-TODO §11 verification-debt bullet.

- **2026-07-07** — **paywall publish + unlock hardened end-to-end** (commit
  `339b43e`; prompted by a live prod failure: 'Vault encryption failed: 400 —
  [object Object]' + a £5-starter-float unlock failure, both traced to one
  root). Root: the editor auto-suggests **£0.00** for <700-word articles and
  the gateway `IndexArticleSchema` accepted paywalled price 0 while the
  key-service `PublishVaultSchema` requires positive — so a short paywalled
  article indexed live, vault encryption 400'd, and the result was a
  **poisoned article** (live, paywalled, no vault key) that then broke reader
  unlocks (price 0 fails gate-pass validation; a priced-but-vaultless article
  charged the float then 404'd key issuance forever). Fixes, publish side:
  editor pre-publish validation (`web/src/lib/publish-validation.ts`: gate ⇒
  price ≥ 1p, non-empty paywalled section, no paywall in publications; NaN
  guard on the price field); `IndexArticleSchema` superRefine mirrors the
  vault schema; `publishArticle` reworked to the scheduler's convergent shape
  (paywalled v1 **signed only**, payload-tagged v2 is the only relay event;
  NEW-article vault/v2 failure soft-deletes the index row — no poisoned
  residue). **Publication paywalls hard-blocked** (submit/approve/
  `publishToPublication`, `PublicationPaywallUnsupportedError`): that pipeline
  has NO vault step — it silently discarded the paywall body and would charge
  readers for content never stored; scheduler un-schedules such drafts.
  Reader side: **gate-pass backstop** — before any charge, verify vault_keys
  row + price ≥ 1p, else 409 `article_misconfigured` (closes the whole
  charge-for-undeliverable class); unlock retry no longer fails silently (the
  stale-closure error guard); distinct 402 copy + add-card CTA
  (`web/src/lib/unlock-errors.ts`); PaywallGate copy now matches server
  behaviour (card ⇒ tab; float-covers-price ⇒ allowance; price > remaining ⇒
  honest over-float copy) and refreshes the allowance figure post-unlock; 15s
  timeouts on gate-pass/proxy hops (F7 idempotency makes retry safe).
  Cross-cutting: `shared/lib/validation.ts::zodValidationError` — paywall-path
  zod 400s return `{error:'validation_failed', message, details}`, never a raw
  flatten object. Validated: shared 81 · gateway 161 · key-service 11 ·
  payment 105 · web 132 (one pre-existing collision.test failure, unrelated);
  `next build` green; root lint 0. NOT runtime-verified (containers need a
  user restart). **Prod follow-up**: run
  `SELECT a.id, a.title FROM articles a LEFT JOIN vault_keys vk ON
  vk.article_id = a.id WHERE a.access_mode='paywalled' AND vk.id IS NULL AND
  a.deleted_at IS NULL` — unpublish hits, check `read_events` for charges
  against them, and have the test writer re-publish from their draft.

- **2026-07-07** — **EXTERNAL-AUTHOR-HISTORY-ADR implemented — all four phases**
  (commits `3b2d51d`…`57099e1`; spec `docs/adr/EXTERNAL-AUTHOR-HISTORY-ADR.md`,
  status updated). External author profiles no longer render empty histories.
  Groundwork fixed a **live bug** on its own: the §1.5 one-way door — an event
  first persisted as a thread-hydration context row was never promoted when the
  same post later arrived through real ingest (invisible in feeds + profile
  forever). All three ingest writers (the newly extracted
  `feed-ingest/src/lib/nostr-ingest.ts`, `insertAtprotoItem`,
  `insertActivityPubItem`) now promote: flags cleared, `source_id` re-homed on
  external_items AND feed_items (kind-5 deletion application and feed
  membership both match on `source_id`); real rows keep exact prior semantics.
  Part A: `feed_ingest_nostr_backfill` (migration-less; NIP-65-first relay set
  persisted onto `relay_urls`, 168h/5-page/200-item `until` pager, forward-only
  cursor handoff, distinct job key `feed_ingest_backfill_<id>` so the 60s poll
  can't job-key-clobber it) + the §2.6 relay-less-source repair. Part B:
  profile-view timeline hydration (migration **148**
  `external_items.is_profile_hydrated`; shadow sources `is_active=FALSE`, no
  subscription row; per-author 10-min TTL guard; kill switch
  `AUTHOR_TIMELINE_HYDRATION_ENABLED` default ON) for nostr + atproto +
  activitypub, with the atproto/AP fetchers pinning `author_uri` to the
  profile's exact `stable_handle` (else the identity trigger files the rows
  under a different author record — implementation hazard recorded in the ADR).
  Validated: shared 78 · feed-ingest 212 · gateway 178 (DB-integration suites
  against dev); drift guard exit 0; root lint 0 errors; `next build` green.
  NOT runtime-verified (containers need a user restart); prod: migration 148
  before service restart.

- **2026-07-06** — **four-day commit audit — Wave 3 (P0 + five P1s)**. A
  multi-agent review of the 2026-07-04→06 commits found the remediation waves
  themselves had opened seams; all six confirmed money findings fixed same-day
  (migrations **146–147**). **P0 — subscription collection gate**: subscriptions
  charged the tab (F1) but nothing made the charge COLLECTIBLE — no card gate on
  subscribe, settlement skips card-less accounts, and the payout claim had "no
  state gate", so a card-less burner could fund a colluding writer's real Stripe
  payouts. Now: subscribe/reactivate require a card on file (402
  `card_required`, both writer + publication routes; web surfaces it), card-less
  renewals expire instead of charging, `subscription_events.settled_at`
  (migration 146) is the subscription twin of `platform_settled` — stamped by
  `confirmSettlement` (created_at ≤ snapshot) or at charge time when pre-paid
  credit covers it (post-charge balance ≤ 0) — and every payout
  eligibility/peek/claim gates on it; a periodic threshold settlement sweep
  (`sweepDueSettlements`, settlement-reconcile cycle) collects tab debt that
  accrues with no gate pass (subscription renewals, lapsed readers). **P1s**:
  free voting capped at one vote per (voter, target, direction) — repeat =
  idempotent no-op (`counted: false`), closing F9's unbounded-tally hole;
  `processPublicationSplits` now splits terminal/ambiguous per the Stripe
  invariant (ambiguous re-throws for the resume sweep — no more failed-but-paid
  orphan splits); migration 147 backfills pre-F4 `initiated` payouts carrying a
  `stripe_transfer_id` to `completed` (so `transfer.reversed` reaches them and a
  stray `transfer.failed` can't unwind a paid payout); the F10 cap holds over
  the FINAL member set (partial payroll payloads), invite re-accept zeroes a
  resurrected member's stale share, both write paths serialise under a
  `pub_shares` advisory lock, and `computePublicationSplits` clamps standing bps
  cumulatively at 10000 (deterministic seniority order — the defensive floor is
  real now); the publication pool selects/claims/finalises on
  `read_events.publication_id` (the exact complement of the writer cycle) —
  never `articles.publication_id`, which double-claimed reads when an article
  joined a publication and stranded them when it left. **Verify:** payment 100 ·
  gateway 142 (incl. new card-less-renewal, settled-stamp, standing-clamp
  tests); `check-ledger-adjacency` / `check-schema-drift` (schema.sql
  regenerated canonically, seed 147) / `check-hairlines` / root lint / `next
  build` all green; migrations applied to dev. **Residuals — ALL resolved in
  the same-day follow-up (no new migrations):** the `transfer.reversed`
  handlers now handle **partial** reversals (cumulative `amount_reversed` →
  ledger-derived delta under the row lock, flip `reversed` only at full; the
  tribute carve re-credit prorated to the same fraction; covered by
  `transfer-reversal.test.ts`); the chargeback×manual-reversal stack and the
  unreversed subscription-earning leg are recorded as **deliberate one-sided
  postures** (`chargeback.ts` header + the economy-audit doc — both entries are
  real Stripe facts / platform absorbs, the guard is operational); auth-cache
  invalidation added to delete-account and moved AFTER the moderation-suspend
  transactions, with the cache itself now tested (hit / TTL-expiry /
  invalidation); atproto handle enrichment records failures honestly
  (`error_count`/`last_error` no longer wiped by a failed run) and the 60s
  self-heal backs off to daily after 6 failed attempts; the mobile pip
  `.reverse()` was **removed** — the 2026-07-04 change did the opposite of its
  own stated "Feed 1 leftmost" intent (visibleSorted already runs Feed 1
  first), so code now matches CLAUDE.md/ADR §X (correction note added there)
  and the pip aria-label agrees with the FeedComposer title; `scripts/seed.ts`
  swept of `is_writer`/`is_reader` (dev seeding works against a 145+ DB) and
  `shared/tests/session.test.ts`'s dead isWriter-claim tests replaced with a
  real `createSession` round-trip; DEPLOYMENT.md carried the one-off
  build-before-migrate note for the 145–147 deploy. **Deployed to prod
  2026-07-06** (build → up → migrate, per the note; the one-off note is now
  replaced by a general destructive-migration caution in DEPLOYMENT.md
  › Upgrading).

- **2026-07-06** — **is_writer/is_reader dropped (migration 145)** — the
  migrate-hardening §3 decision, resolved same-day as **drop** (the
  "moderation lever" alternative was illusory: nothing gated publishing on
  `is_writer`, and `accounts.status` is the real lever — auth middleware
  already 403s non-active accounts). Migration 145 drops both columns + the
  genesis-only partial index; the session JWT loses its `isWriter` claim (old
  cookies carry it as an ignored extra — no invalidation), `createSession`
  narrows, `/me` + followers responses drop the field, the export-route
  writer guard is deleted (export-mandatory invariant), drives keeps a plain
  existence check, and the six web gates go (LedgerPanel always fetches
  earnings, DashboardPanel always shows subscribers/proposals, ExportModal
  always offers full export, NetworkPanel's always-true "· writer" chip
  removed). **Dev-DB repair in passing:** dev was in a partially-applied
  tribute state (126 objects present but unrecorded, 127/128 half-in, 129
  recorded, 130–144 never applied); dropped the empty partial tribute objects
  and replayed the chain — dev now matches prod's migration history through
  145, all rows checksummed. **Verify:** shared 71 + gateway 141 tests, tsc
  all touched services, `next build`, root lint 0 errors, drift guard 4/4,
  dev-DB no-op re-run.

- **2026-07-06** — **migrate.ts hardening** (`docs/audits/migrate-hardening.md`;
  no migration file — deliberately, see §2a). **§1** pending migrations now sort
  by numeric prefix with a lexicographic tiebreak (lexicographic order runs
  `1000_` before `999_`), with a fatal guard on any filename lacking a numeric
  prefix (NaN comparator = unspecified order); the three matching 3-digit /
  lexicographic assumptions in `check-schema-drift.sh` fixed in the same pass
  (Check 0 + Check 2 seed regexes → `[0-9]+_`, Check 3's chronological fold →
  `sort -n`). **§2** sha256 checksums: `_migrations.checksum` added as
  runner-owned **bootstrap DDL** (`ADD COLUMN IF NOT EXISTS`, never a migration
  — the verify code touches the column on every run incl. pre-column DBs);
  recorded on apply at both INSERT sites; verified on every run — NULL backfills
  from the file on disk (correct by construction on fresh boots, which never
  executed the files), mismatch is fatal with no override flag. `schema.sql`
  regenerated canonically (throwaway-from-committed + migrate + pg_dump; diff vs
  old = exactly the new column). **Side-fix**: deleted `payment-service`'s
  `migrate` script (pointed at a nonexistent `src/db/migrate.ts`); CLAUDE.md's
  stale "each service has its own runner" line rewritten. **§3 (partial)**:
  `accounts.ts` header rewritten to the live model (full capability at signup;
  the operative axes are Stripe-shaped can-pay × can-be-paid), and signup's
  `createSession(…, isWriter: false)` fixed to `true` (matches the row just
  inserted + the OAuth path). §3's `is_writer`/`is_reader` column fate (drop vs
  moderation lever, with the export-route carve-out) stays an open decision.
  **Verify:** end-to-end runner test (999→1000 order, no-op re-run, edited-file
  fatal, bad-prefix fatal) against a throwaway DB; `check-schema-drift` all four
  checks green; shared build + 71 tests green.

- **2026-07-06** — **logic & economy audit — Wave 2 (the deferred items)**
  (`docs/audits/allhaus-logic-economy-audit.md` for the full status). Shipped the
  six items left deferred after Wave 1 (migrations **142–144**):
  **F9** removed paid voting — the `vote_charges` money path is stripped from
  accrual/settlement/payout/chargeback + the frontend paid path; votes cast free,
  the tables + historical `vote_charge` ledger entries stay inert (registered
  money paths 7→6). **F5** full publication-aware chargeback — a charged-back
  publication read reverses each PAID `publication_payout_splits` recipient
  prorated by read-gross÷pool (never the author), via `writer_payout_reversal` (no
  migration; it nets in `ledger_writer_earnings`). **F4** keys payout completion
  off the `transfers.create` response (no more "stuck at initiated"), adds a
  `transfer.reversed` handler (`payout_status += reversed`), guards `handleFailed*`
  on `status != completed`; the `transfer.paid/failed` branches are **kept as
  guarded no-ops** pending a live-Stripe check before deletion (owner decision).
  **F10** publication splits are a fixed share of the 10000 base (platform keeps
  the unallocated remainder — the sole-1-bps-gets-100% renormalisation is gone),
  with `SUM(bps) ≤ 10000` enforced at both write paths. **F14** persists
  `read_events.allowance_consumed_pence = max(0, min(remaining, amount))`;
  decrement kept at full amount to preserve the F3 meter (documented divergence
  from the audit's literal "cap the decrement"). **Wave 5**: periodic
  `resumePendingSettlements`, UTC calendar renewal arithmetic, `read_at<=settled_at`
  pairing note. **Verify:** payment/gateway/shared builds + `next build`; tests
  payment 98 · gateway 141 · shared 71; `check-ledger-adjacency` /
  `check-schema-drift` (schema.sql regenerated canonically) / `check-hairlines` /
  root lint (0 err) all green. **Still open (intentional):** the F4 paid/failed
  branch deletion (needs live-Stripe verification) and publication-*subscription*
  pool distribution (the open F1 follow-on).

- **2026-07-05** — **code-economy audit remediation** (`docs/audits/allhaus-code-economy-audit.md`
  §0 for the full disposition table). Implemented the safe/verifiable findings:
  the `readNetSql` sweep (8 inline fee-formula sites → the shared helper);
  auth account-check cache (8s in-process TTL in `middleware/auth.ts` +
  `invalidateAuthCache()` at all four write sites — the per-authed-request
  `accounts` SELECT was unconditional); deleted the dead `AccrualService` config
  cache (zero callers); unified `timeAgo` into `web/src/lib/format.ts`; collapsed
  the four `x-internal-token` checks in `payment.ts` to one constant-time
  preHandler; canonical `gateway/src/lib/uuid.ts` (~13 local `UUID_RE` defs →
  imports); migration **138** adds the two settled-unpaid partial indexes
  (`read_events(writer_id)` / `vote_charges(recipient_id)` — keyed on the real
  seek column, not the audit's all-NULL `writer_payout_id`). Corrections logged
  in-audit: `timeAgo` was not 3 identical copies (ConversationList is a compact
  variant, PlayscriptReply has none); `x-internal-token` was 4-in-one-file not
  5-scattered. **Deferred:** set-based ledger INSERTs (conflicts with the
  `check-ledger-adjacency.sh` per-file `recordLedger()` count; needs a clean-DB
  reconciliation), dropping the bare `idx_*_state` indexes (state-only scans
  exist, no EXPLAIN evidence), extending `knip` to gateway/web (CI job — needs a
  triage pass first), and splitting `payout.ts`. Gates green: payment-service
  88/88, gateway 141/141, root lint 0 errors, web `next build`,
  `check-schema-drift.sh` / `check-ledger-adjacency.sh` / `check-hairlines.sh`.

- **2026-06-25** — architecture-audit item **3 (unified append-only ledger,
  keystone) — writer-side accrual cutover (FINAL phase)** shipped (migration 136).
  The ledger now models writer EARNING, not just payout — closing the item-3
  deviation (§5 in the plan) for the writer side. Four new triggers in `ledger.ts`:
  `writer_accrual` (+read_net, acct=writer/cp=reader) posts per read at settlement
  (`settlement.ts confirmSettlement`); `tribute_carve` (−root gross, acct=author/
  cp=root inspirer) debits the author when a ROOT tribute's carve is *paid*
  (`payout.ts completeTributePayout`, root-only) — the single point the held share
  enters the ledger (build-plan guard #7 keeps held/released carve out until then);
  `writer_accrual_reversal` / `tribute_carve_reversal` on chargeback (`chargeback.ts`
  planner). New `SUM()` view `ledger_writer_earned` (trigger set disjoint from the
  paid-out `ledger_writer_earnings`) = `read_net − paid_root_carve`;
  `getWriterEarnings().earningsTotalPence` reads it (`= ledger_writer_earned −
  held|released_root_carve`, the projection supplying the reserved slice). Penny-
  exact in prod now (tributes dark ⇒ carve terms 0); carve fully modeled so
  `TRIBUTES_ENABLED` needs no further ledger work — writer-earnings parity is the
  standing gate. Pending/paid sub-split stays `read_events`-derived; publication-
  distribution still reconciliation-only. Adjacency floors bumped (settlement 2→3,
  payout 3→4). **Verify:** payment-service vitest 88 (3 new earned-side conservation
  cases + 1 forward-accrual test); `shared`+`gateway`+`payment-service` `tsc` clean;
  root lint 0 errors; `check-ledger-adjacency.sh` green; `check-schema-drift.sh` all
  four green (Check 0 = 136; new view present; round-trips clean). Spec:
  `docs/audits/WRITER-SIDE-LEDGER-CUTOVER.md`.

- **2026-06-25** — **Stripe integration audit — SHIPPED** (1 P0, 2 P1, 1 P2,
  + 1 follow-on). Full plan + implementation log:
  `docs/audits/STRIPE-INTEGRATION-AUDIT-2026-06-25.md`. All four findings were
  independently re-verified against source before any change (no overstated
  findings), then fixed in order. Migration 135 (`tab_settlements.failure_reason`,
  `accounts.card_action_required_at`); `schema.sql` regenerated + drift-clean.
  Swept the whole Stripe surface (reader/Connect onboarding in `gateway/routes/auth.ts`,
  the three-stage flow in `payment-service/services/`, `webhook.ts`, the reconcile
  workers, `chargeback.ts`); idempotency keys, three-phase durability, the F16
  reconcile sweep, and the ledger mirror all held up. Four open items:
  - **S1 (P0) — a declined / SCA-required off-session settlement orphans a
    permanently-`pending` settlement and freezes the tab.** `completeSettlement`
    (`settlement.ts:242`) has **no try/catch** around
    `paymentIntents.create({confirm:true, off_session:true})`; a `StripeCardError`
    throws before the PI id is stored, so the row stays `pending`, the eventual
    `payment_intent.payment_failed` webhook can't match it (looks up by the unstored
    `stripe_payment_intent_id`, `settlement.ts:561`), `reserveSettlement`'s pending
    guard (`:191`) blocks every future settlement, and `resumePendingSettlements`
    replays the same decline forever. Reader's tab grows unbounded, writer unpaid,
    no error. **Distinct from F16** (that backstopped a *dropped success webhook*;
    this is a *terminal failure at create time* that F16's reconcile — which only
    scans `completed` rows — never sees). **Fix:** catch terminal vs transient,
    store `err.payment_intent?.id`, flip to `failed` (unfreezes the tab) on terminal;
    re-throw on transient. + re-attempt backoff + a reader card-re-auth signal.
    Possible new `tab_settlements.failure_reason` column (migration + schema regen).
  - **S2 (P1) — reader cards attach with no server-side validation** (`auth.ts:402`):
    no SetupIntent confirm, so an unusable/3DS card attaches cleanly and only fails
    weeks later at settlement — i.e. it manufactures S1's failures. **Fix:** confirm
    a `usage:'off_session'` SetupIntent at attach time.
  - **S3 (P1) — Connect payability is one-way.** `isConnectPayable` only ever flips
    `stripe_connect_kyc_complete` TRUE (`webhook.ts:210`); nothing sets it FALSE when
    Stripe later disables `transfers`, and `account.application.deauthorized` is
    unhandled → payout-cycle churn against a no-longer-payable / stale account.
    **This subsumes the 2026-06-24 deferred follow-up (3) "Reverse flip"
    (feature-debt.md §1)** and adds the deauthorized case. **Fix:** make the flag
    track `isConnectPayable` both directions in webhook + sweep; handle deauthorized.
  - **S4 (P2) — webhook hardening:** verify the single `STRIPE_WEBHOOK_SECRET`
    actually receives Connect events (dashboard config, document in `DEPLOYMENT.md`);
    assert `event.livemode`; give partial refunds / `charge.dispute.created` (today
    log-and-skip, `webhook.ts:194`) an ops-visible review surface.
  - **S1 follow-on (P0-class) — payout-side transfer orphan.** Found while fixing
    S3: `completeWriterPayout` (`payout.ts:585`) and `completeTributePayout`
    (`:1401`) wrapped `transfers.create` in **no try/catch** either. A terminal
    rejection (revoked `transfers` capability) throws → no transfer object → no
    `transfer.failed` webhook → `handleFailedPayout`/`handleFailedTributePayout`
    (keyed on `stripe_transfer_id`) never fire → row stuck `pending`, earnings
    frozen, resume retries forever. (`completePublicationSplit` already caught it.)
    **Fix:** wrap both; on a deterministic `StripeInvalidRequestError`
    (`isTerminalTransferError` — narrow, because the failure mode is double-PAY)
    mark failed + release earnings via the now-shared `rollback*PayoutRows`
    helpers; re-throw anything ambiguous so resume retries with the stable key
    (never roll back → never double-pay).
  - **Shipped (order S1 → S3 → S2 → S4 + follow-on).** Verified:
    `payment-service` suite **84 passed** (new `charge-errors`, 19 cases);
    `tsc` clean (payment/gateway/shared); `next build` clean; schema-drift 4/4,
    ledger-adjacency, hairlines all green. S2 changes the card-attach flow
    (server SetupIntent + client `confirmCardSetup`) and still needs a live
    browser test with Stripe test cards (incl. a 3DS card) — can't run headless.

- **2026-06-25** — **Tribute/payment failure & confirmation edges** (2 HIGH,
  2 MEDIUM — second four-agent audit of the three-day tribute body of work; full
  write-up in `docs/adr/UPSTREAM-EDGES-AUDIT-FIXES.md` › *Second audit pass*,
  findings F15–F18). The ledger core, gateway routes, and frontend came back
  clean; every material risk was on the failure/confirmation paths the
  happy-path tests don't exercise — added only for the writer case as the new
  tribute/publication money flows landed.
  - **F15 (HIGH) — tribute & publication transfers had no `transfer.paid`/
    `.failed` handling.** `webhook.ts` routed both to `confirmPayout`/
    `handleFailedPayout`, which **only `UPDATE writer_payouts`**; tribute
    (`payout.ts:1417`) and pub-split (`:1092`) transfers matched no row → a
    failed transfer was never rolled back (accruals stayed `paid`, the
    `+tribute_payout` ledger entry stood for money that never landed; no re-pay)
    and a landed tribute transfer never reached `completed` (no such state
    existed). **Fix:** migration `134` adds `completed`/`completed_at` to
    `tribute_payouts`; `webhook.ts` routes by `transfer.metadata`; new
    `confirmTributePayout`/`handleFailedTributePayout` (rolls accruals back so
    the next cycle re-pays under a fresh row — new idempotency key) and
    `confirmPublicationSplit`/`handleFailedPublicationSplit`. `reconcile-ledger.sql`
    A10a/A10b exclude `failed` tribute_payouts (the failed `+` entry stays
    append-only, same posture as the writer path). Pub-split *auto re-pay*
    deferred (feature-debt.md — a correct retry needs a fresh split row; the
    stable idempotency key would dedupe a retry to the failed transfer).
  - **F16 (HIGH) — no backstop for a dropped `payment_intent.succeeded`.** A
    settlement flips to `completed` when the card is charged, but the tab debit /
    ledger credit / read advancement run in `confirmSettlement` on that webhook
    alone — a dropped event leaves the reader charged with no movement, reads
    stuck `accrued`, no error. **Fix:** `settlement.reconcileSettlements()` +
    `workers/settlement-reconcile.ts` (3×/day, wired in `index.ts`), the twin of
    `reconcileConnectKyc`: re-reads `completed`-but-unconfirmed settlements from
    Stripe past a 1h grace and confirms them (idempotent via the charge claim).
  - **F17 (MEDIUM, supersedes the F3 residual) — chargeback racing an in-flight
    payout created money.** `chargeback.ts` skipped a `claimed` in-flight accrual,
    so the reserved payout paid out clawed-back money with no reversing entry.
    **Fix:** reverse a claimed accrual *as if* it reached its terminal state
    (`paid`/`returned`, via the `sweptReturnKind` discriminator); conservation
    still nets `−read_net`; unclaimed accruals still voided. +4 conservation tests.
  - **F18 (MEDIUM) — `confirmSettlement` threw on an unknown PaymentIntent**,
    poisoning the webhook retry/dedup queue. **Fix:** log-and-return on no match,
    matching `reverseSettlement`/`handleFailedPayment`.
  - **Verify:** payment-service `tsc` 0 + vitest **65** (was 62; +3) · shared 83 ·
    `check-ledger-adjacency` 0 · `check-schema-drift` all 4 (134 migrations) ·
    root promise-safety lint 0. Docs: `UPSTREAM-EDGES-AUDIT-FIXES.md`
    (F15–F18 + F3-residual update), `feature-debt.md` (pub-split re-pay follow-up).

- **2026-06-24** — **Connect KYC gate: payability keyed on `transfers`, not
  `charges_enabled`** (HIGH — silent non-payment). The `account.updated` webhook
  (`payment-service/src/routes/webhook.ts`) was the **sole** path that flips
  `accounts.stripe_connect_kyc_complete = TRUE`, gated on `charges_enabled &&
  payouts_enabled`. But writers only ever RECEIVE via `transfers.create`
  (separate charges & transfers — readers are charged on the *platform* account,
  `settlement.ts:250`; writers never take card payments). `card_payments`/
  `charges_enabled` is therefore an **unused** capability on writer accounts —
  yet it gated getting paid. `card_payments` and `transfers` are independent
  capabilities with independent requirements hashes and **can diverge** (Stripe
  docs confirmed): a GB writer whose `card_payments` requirement lags `transfers`
  reaches `payouts_enabled=true` / transfers-active but never `charges_enabled`,
  so the `&&` never fires, KYC never flips, and the payout cycles
  (`payout.ts:385/1065/1495`) skip them **forever with no error** while earnings
  accrue. Also a hard blocker for ever adopting a transfers-only onboarding shape
  (`charges_enabled` would never flip true). **Fix:** extracted the single gate
  `isConnectPayable(account)` (`payment-service/src/lib/connect-payable.ts`) =
  `capabilities.transfers === 'active' && payouts_enabled`, imported by **both**
  the webhook and the new sweep so they cannot drift (drift is the bug class).
  **Backstop for missed webhooks** (`account.updated` is at-least-once, not
  always-once — one dropped event = permanently un-flipped writer): new
  `PayoutService.reconcileConnectKyc()` + self-scheduling worker
  (`workers/kyc-reconcile.ts`, 3×/day at 01:30/09:30/17:30 UTC, offset *before*
  the 02:30 payout cycle; wired in `index.ts`). Candidate = a Connect account,
  not yet KYC-complete, owed money in **any** of the six KYC-gated payout
  sources (six `EXISTS` clauses mirroring `runPayoutCycle`'s base/carve/ret CTEs,
  `processPublicationSplits`, and the tribute inspirer cycle's released/returns
  CTEs — so no `accounts.retrieve` is spent on an abandoned-onboarding £0
  account); re-reads via Stripe, applies the same `isConnectPayable`, flips with
  an idempotent `UPDATE … WHERE … = FALSE` (no-op if a webhook already won).
  Column names verified against `schema.sql`. **Regression-locked** by
  `payment-service/tests/connect-payable.test.ts` (6 cases pinning both
  divergence directions — transfers-active/charges-disabled *is* payable;
  charges-enabled/transfers-inactive is *not*). **Verify:** payment-service `tsc`
  exit 0 + vitest **62** (was 56; +6) + root promise-safety lint on all touched
  files exit 0; no money path's `recordLedger` adjacency touched (KYC flag only,
  no ledger write). **Deferred follow-ups (sketch, not built):**
  (1) **DB integration test for `reconcileConnectKyc`'s candidate SQL** — the six
  `EXISTS` clauses are the drift-prone surface (they track a *set of tables*, not
  amounts, so they can't drift from payout *math*, but they can drift from
  payout *eligibility* if a source table/column changes). The repo's test idiom
  is pure-function only (no test mocks `pool`/`stripe`), so this needs new
  DB-or-pool-mock fixtures — a deliberate infra decision, kept out of this change.
  Build it as: seed one account per source (read / vote / root-swept-return /
  pub-split / inspirer-released / inspirer-deeper-swept) + one abandoned £0
  account, assert candidate set = the six and excludes the £0 one.
  (2) **Multi-instance advisory lock** — wrap the sweep in `pg_advisory_lock`
  (gateway scheduler pattern) if payment-service ever runs >1 replica; single
  instance today, not required yet. (3) **Reverse flip** — neither path sets
  `kyc_complete` back to FALSE when Stripe later *disables* an account; lower
  risk (`transfers.create` fails loudly at payout time, not silently), left for
  its own ticket. Tracked in `feature-debt.md` §1.
  *(Originated from scrutinising a dropped-in Stripe Connect onboarding slice
  whose transfers-only capability shape was architecturally correct for this
  platform but would have 100%-broken the existing `charges_enabled` gate.)*

- **2026-06-16** — architecture-audit item **6 (DM reactions)** shipped.
  Migration **122** migrates `dm_likes` → `dm_reactions` while the table is empty
  (rename-in-place, not fresh-table+copy): `ALTER TABLE … RENAME TO`, add
  `reaction_type text NOT NULL DEFAULT 'like'`, swap `UNIQUE(message_id, user_id)`
  → `UNIQUE(message_id, user_id, reaction_type)`, and rename the carried-over
  pkey/FK constraints + `idx_dm_likes_message` to the new name for a clean dump.
  **No DB CHECK on the reaction set** (deviation from the plan's optional CHECK):
  the vocabulary (`DM_REACTION_TYPES = like/love/laugh/wow/sad/angry`, exported
  from `gateway/src/services/messages.ts`) is app-controlled + validated by the
  route's zod `z.enum`, so adding a reaction needs no migration. Service:
  `toggleMessageLike` → `toggleMessageReaction(messageId, userId,
  reactionType='like')`, now wrapped in `withTransaction` (closes the
  previously-unguarded toggle race; `23505` unique-violation resolves to
  "reacted"). Route keeps `/messages/:messageId/like` + the `{ liked }` response
  (back-compat) and accepts an optional `reaction_type`. **Web untouched** — per
  the plan's "web can stay single-`'like'` initially", `loadConversationMessages`
  filters to `reaction_type='like'` so `likeCount`/`likedByMe` are unchanged; the
  schema + API are reaction-ready for a future picker (the jsonb-grouped N+1 retire
  deferred with it). **Verify:** gateway `tsc` + root lint (0 err) + gateway vitest
  (141) + `check-ledger-adjacency.sh` (no money path touched) +
  `check-schema-drift.sh` (all four — Check 0 = 122; Check 3 nets the table/index
  rename = 268 objects; Checks 1/2 round-trip clean, diff = rename + new column +
  constraint swap + `122` seed) all green. Next: item 3 writer-side cutover
  (deferred), then 5 → 4.

- **2026-06-16** — architecture-audit item **3 (unified append-only ledger,
  keystone) — Phase 3 (reader-balance cutover + opening-balance backfill)**
  shipped. The read-side scope was narrower than the plan's "point balance reads
  at the views": only the **reader tab** is backed by a mutated running-total
  column (`reading_tabs.balance_pence`) with a symmetric ledger mirror, so it is
  the only read cleanly cut over. (1) **Closed a Phase-1 latent gap first** —
  `gateway/src/routes/articles/subscription-convert.ts` decremented the tab on a
  spend→subscription credit-back (`balance_pence = … − $1`) with **no**
  `recordLedger()`, a real movement with no mirror that diverged
  `ledger_reader_balance` from the column forward-only; the adjacency tripwire had
  missed it because its marker only matched `… = balance_pence +` (plus). Fixed:
  added the `recordLedger()` (new `subscription_credit` trigger, **+credit**,
  counterparty = writer), widened the marker to `balance_pence = balance_pence
  [-+]`, registered the file (six paths now). (2) **Migration `121`** backfills one
  `opening_balance` entry per tab = `(L − B)` (`L = −SUM(real reader entries)`,
  `B = reading_tabs.balance_pence`) so `−SUM(incl. opening) == B` to the penny, then
  `CREATE OR REPLACE VIEW ledger_reader_balance` to also count
  `subscription_credit`/`opening_balance`; inert on a fresh/empty DB (no tabs ⇒ no
  rows). (3) **`GET /my/tab`** (`gateway/src/routes/my-account.ts`) now reads the
  view, not the column. (4) **`reading_tabs.balance_pence` retained** as the locked
  operational total settlement reserves against (`SELECT … FOR UPDATE`) — display
  reads the ledger, settlement reads+locks the column; dropping it needs a
  settlement-concurrency redesign (later). (5) **Writer-earnings /
  publication-distribution reads NOT cut over** — `ledger_writer_earnings` sums money
  *paid out* but `getWriterEarnings()` sums *earned-incl-pending*, different
  quantities; those views stay reconciliation-only (reconcile Part B2 stays
  expected-nonzero; Part B1 reader-side must now be empty). **Verify:** builds
  (`shared`/`gateway`/`payment-service`) + root lint (0 err) + vitest (46+141) +
  `check-ledger-adjacency.sh` (widened marker fires, no new escapees) +
  `check-schema-drift.sh` (all four; only schema diff = view `WHERE … IN` gains the
  two triggers + `121` seed) all green; synthetic backfill reconciliation proven to
  `diff = 0` across partial-gap / pure-pre-Phase-1 / already-aligned accounts. Next:
  item 3 writer-side cutover (deferred), then 6 → 5 → 4.

- **2026-06-16** — architecture-audit item **3 (unified append-only ledger,
  keystone) — Phase 2 (read-model views + reconciliation)** shipped. Migration
  **120** adds the four `SUM()` read-models as plain (non-materialised) views over
  the append-only `ledger_entries`: `ledger_reader_balance` (tab debt =
  `−SUM(amount_pence)` over the four reader-tab triggers
  `read_accrual`/`vote_charge`/`pledge_fulfil`/`tab_settlement`),
  `ledger_writer_earnings` (`SUM` over `writer_payout` + `publication_split`),
  `ledger_publication_distribution` (splits resolved to their publication via
  `ref_id → publication_payout_splits → publication_payouts`), and
  `ledger_platform_tax` (downvote behaviour tax = `−SUM` of `vote_charge` entries
  with `counterparty_id IS NULL` — the NULL counterparty is what separates a
  downvote/platform charge from an upvote's author credit). Cheap + always-current
  against the Phase-0 indexes; **inert until Phase 3** (nothing reads them yet).
  Reconciliation is `scripts/reconcile-ledger.sql`: **Part A** row-level
  ledger↔source consistency (every entry vs its originating row in `|amount|` +
  counterparty — must always be empty; catches a wrong-magnitude/wrong-row
  dual-write) and **Part B** aggregate balance vs the live tables. **Deviation:**
  views ship `ledger_`-prefixed (plan named them bare) for namespace clarity; the
  `platform_tax` view is scoped to downvote behaviour charges per the plan's
  explicit wording. **⚠ Phase-3 prerequisite surfaced (plan gap):** the ledger
  began **empty at Phase 1** — historic balances were never backfilled — so
  `ledger_reader_balance` equals `reading_tabs.balance_pence` only for accounts
  with no pre-Phase-1 activity, and Part B's diff for everyone else is their
  un-backfilled opening balance, not a bug. Phase 3 must therefore post a one-time
  opening-balance entry per account **before** cutting reads over to the views,
  not just repoint reads. Verified: the four views compile + run against a
  throwaway DB built from `schema.sql` + 120 (0 rows, SQL valid);
  `check-schema-drift.sh` all four green (Check 0 lists 120; Check 3 counts the
  four views; Check 1 no-op + Check 2 canonical round-trip pass — diff = the four
  views + the two tables pg_dump's dependency-sort relocated under them + the
  `120` seed line, each object present exactly once); `check-ledger-adjacency.sh`
  green; no TS changed so build/lint/tests unaffected. Plan + CLAUDE.md invariant
  + this log updated. Next: Phase 3 (cut over reads — gated on the opening-balance
  backfill), then 6 → 5 → 4.

- **2026-06-16** — architecture-audit item **3 (unified append-only ledger,
  keystone) — Phase 1 (dual-write)** shipped. Every money MOVEMENT now emits a
  `ledger_entries` row via `recordLedger(client, …)` **in the same transaction**
  as the table write it records, across all five paths: `accrual.ts`
  (`recordGatePass` accrued read; `convertProvisionalReads` — one entry per
  converted read + per converted vote_charge), `settlement.ts`
  (`confirmSettlement`), `payout.ts` (writer payout + per publication split),
  `votes.ts` (accrued vote charge), `drives.ts` (pledge fulfilment). **Sign
  convention** (in `shared/src/lib/ledger.ts`): reader-tab entries mirror
  `reading_tabs.balance_pence` movements (accrual/vote/pledge **−amount**;
  settlement **+settled**) so `balance == −SUM`; writer/member payout entries are
  **+amount** with `NULL` (platform) counterparty so `SUM == ` historic payout
  sums; platform is never an `account_id` (the schema's `account_id NOT NULL`
  forbids the audit's literal net-to-writers/platform-fee rows at settlement —
  hence the writer side lands at payout). **Idempotency:** the four reader-tab
  sites are single-txn (one entry per row); the two payout sites re-run on
  crash-resume, so each gates its emit on the `pending→initiated` flip
  (`processPublicationSplits`' standalone status `pool.query` was wrapped in a
  `withTransaction` so flip+entry commit together). **CI tripwire**
  `scripts/check-ledger-adjacency.sh` (the plan's "CI grep") guards both a
  registered file losing its `recordLedger` call and a new unregistered
  money-write site; wired into the CI `backend` job; both guards verified to
  fire. Deviation (carried from Phase 0): still no live-DB rollback test — repo
  has no DB-backed harness, and the rollback property is now structural (caller's
  in-flight client); `payment-service/tests/ledger.test.ts` locks the helper
  contract (param order / signed passthrough / defaults) instead, with call-site
  sign correctness deferred to Phase 2 reconciliation. Verified: shared +
  payment-service + gateway builds clean; eslint 0 errors; knip unchanged vs
  baseline; drift guard all four green (no schema change); vitest 46
  payment-service (incl. 5 new) + 141 gateway green. Plan + this log updated.
  Next: Phase 2 (`SUM()` read-model views + penny reconciliation), then Phase 3
  (cut over reads), then 6 → 5 → 4.
- **2026-06-16** — architecture-audit item **3 (unified append-only ledger,
  keystone) — Phase 0** shipped. Migration **119** adds `ledger_entries` (signed
  `amount_pence`, FKs to `accounts(id)` on `account_id`/`counterparty_id`, indexes
  `(account_id,created_at)`/`(ref_table,ref_id)`/`(trigger_type)`) plus the
  append-only guard — `ledger_entries_append_only()` + a `BEFORE UPDATE OR DELETE …
  FOR EACH ROW` trigger that `RAISE`s, mirroring how 098 owns `feed_items`. New
  helper `recordLedger(client, entry)` in `shared/src/lib/ledger.ts` takes the
  in-flight `PoolClient` (same shape as `enqueueRelayPublish`), a typed
  `LedgerTriggerType`, and a plain signed-amount INSERT. **Phase 0 is inert — no
  callers, no reads.** schema.sql regenerated via pg_dump; drift guard all four
  green (Check 3 now counts the table/function/trigger/3 indexes); guard
  raise-on-mutate verified against a live DB (INSERT ok, UPDATE/DELETE both raise).
  Deviation: the planned `recordLedger` rollback unit test is deferred to Phase 1
  — `shared` has no DB-backed test harness and Phase 0 has no callers; the guard was
  verified directly instead. Plan header updated. Next: Phase 1 (dual-write the
  money paths — accrual/settlement/payout/votes/drives through `recordLedger`).
- **2026-06-16** — architecture-audit items **7**, **8**, **2(A)** shipped.
  **Item 7 (park trust)** — trust graph (Layer 1/2/4) gated behind
  `TRUST_SYSTEM_ENABLED` (server, in `shared/lib/env`) / `NEXT_PUBLIC_TRUST_ENABLED`
  (client), both default OFF: feed-ingest builds its crontab conditionally so the
  three trust schedules aren't registered (the bulk of the parked compute); UI
  degrades (`TrustPip` → neutral grey dot so `PipPanel`/`VolumeBar` stay reachable,
  trust sections + vouch tab + `VouchModal`/`TrustProfile` hidden, trust fetches
  skipped). Tables + `LEFT JOIN trust_layer1` untouched (degrade to NULL).
  **Item 8 (park traffology)** — both containers commented out in
  `docker-compose.yml`, nginx drops the `depends_on` and `/ingest/` → `404`, client
  beacon gated on `NEXT_PUBLIC_TRAFFOLOGY_ENABLED` (default OFF; authoritative gate
  is the article-page JSX, since `/traffology.js` is a hand-built artifact, not
  bundled). Schema + workspaces + gateway `/concurrent/*` left in repo (fail soft).
  **Item 2(A) (denormalisation tidy)** — migration **118** drops the dead
  `feed_items.tier` column + `tier_consistency` CHECK (never read; `content_tier`
  enum / `biddability_tier` / `external_items.tier` all stay). Plan undercounted the
  write sites: `tier` was stripped from **15** `INSERT INTO feed_items` statements
  (a recursive grep surfaced them — tsc doesn't validate SQL strings) plus
  `FEED_SELECT`. schema.sql regenerated via pg_dump; drift guard all four checks
  green. ADR/plan `ARCHITECTURE-AUDIT-{ADR,IMPLEMENTATION-PLAN}-2026-06-15.md`
  headers updated. Next: item 3 (ledger keystone), then 6 → 5 → 4.
- **2026-06-16** — architecture-audit item **1a** (harden schema drift guard)
  shipped. Added **Check 3 (object presence)** to `scripts/check-schema-drift.sh`:
  a no-DB text check that folds every migration's `CREATE`/`DROP`/`ALTER…RENAME TO`
  into the net-surviving object set and asserts each survivor's defining statement
  is in `schema.sql` (exit 3 on a miss; CI surfaces it via the existing `schema`
  job). Caught a real latent drift — migration 022's `idx_read_events_reader_article`
  was seeded-applied but missing from `schema.sql` (fresh boots lacked the
  payment-verification index); fixed in `schema.sql`. ADR/plan
  `ARCHITECTURE-AUDIT-{ADR,IMPLEMENTATION-PLAN}-2026-06-15.md` + CLAUDE.md updated.
  Item 1b (genesis extraction) stays deferred.
- **2026-04-20** — round-3 batches A–G shipped (§64, §67, §70, §71, §72,
  §73, §74, §75, §76, §77, §78, §79, §80, §81, §82, §83, §84, §85, §86,
  §87). §64 — `IP_HASH_SALT` now
  `requireEnv`'d at module load in `traffology-ingest/src/routes/beacon.ts`
  instead of defaulting to a hardcoded salt. §67 — ranking UPDATE moved
  inside `aggregate-hourly.ts`'s `withTransaction`, so ranks can't drift
  away from the `total_readers` they're derived from (unused `pool` import
  dropped). §70 — Mastodon `Idempotency-Key` now `outbound_posts.id`
  instead of `sha256(text + replyTo)`, so draft edits between retries no
  longer defeat Mastodon's dedup window; `MastodonOutboundInput` gained
  `idempotencyKey`, caller in `outbound-cross-post.ts` passes `row.id`.
  §71 — partial-success warn log in `nostr-outbound.ts` when some relays
  reject (caller still marks `sent` per the one-accepts rule; the log
  gives us signal without changing semantics). §72 — outbound retry
  `jobKey` versioned as `outbound_cross_post_${id}_r${retry}` so
  Graphile Worker's dedup can't collapse the retry into the in-flight
  job and lose the backoff delay. §78 — `/.well-known/oauth-client-metadata.json`
  and `/.well-known/jwks.json` now set `Content-Type: application/json`
  - `Cache-Control: public, max-age=3600` so PDSes polling for JWKS
    rotation don't hammer origin. §79 — `outbound-token-refresh.ts` logs
    sanitised `{ errName, errMessage: str.slice(0, 200) }` instead of the
    raw error object, removing the DPoP/token-leak-through-logs surface.
    §80 — `atproto_oauth_pending_states` TTL bumped 10min → 15min so a
    callback arriving at `expires_at` can't race the 5min prune cron.
    §81 — loopback `redirect_uri` now reads `process.env.PORT ?? '3000'`
    instead of hardcoding `:3000`, so dev gateways on alternate ports
    don't silently fail with redirect mismatch. §82 — `atproto-oauth.ts`
    asserts `baseUrl.startsWith('https://')` before casting in the prod
    branch; typo'd `ATPROTO_CLIENT_BASE_URL=http://...` fails fast
    instead of producing malformed client metadata. §83 —
    `atprotoClientMetadata()` + `atprotoJwks()` single-call helpers
    deleted; the two well-known route handlers now call `getAtprotoClient()`
    directly. §84 — publication CMS title edit now dual-writes to
    `feed_items.title` in the same handler, closing the drift window
    that relied on the 05:00 reconcile cron. §87 — personal-draft
    scheduler now dual-writes the `feed_items` row inside a transaction
    (mirroring `routes/articles/publish.ts`), so scheduled personal
    articles appear in the unified timeline immediately instead of
    waiting up to 24h for reconcile. Paywalled branch's v2 event-id
    rewrite also wrapped in a transaction so articles + feed_items can't
    end up pointing at different events. §73 — dropped the stray
    `?? item.summary` fallback on RSS `content_preview` (was always
    redundant: the RSS adapter's own `rawHtml` fallback already derives
    `contentText` from `summary` when `contentText` would otherwise be
    null, so the second fallback in the ingest path just masked what
    was already happening). §74 — new `activitypub_instance_health_prune`
    task drops rows whose last_success_at AND last_failure_at are both
    &gt; 90 days old; weekly Sunday 07:00 UTC cron. §75 — Bluesky adapter's
    `renderHtml` now runs its output through `sanitizeContent` like RSS
    and ActivityPub, so if we ever broaden the RichText walk the
    sanitiser is already in the path. §76 — gateway boot now eagerly
    calls `getAtprotoClient()` before `app.listen`; a malformed
    `ATPROTO_PRIVATE_JWK` logs a warning and disables Bluesky OAuth
    instead of aborting boot. Loopback dev is a no-op there since no
    JWK is required. §77 — `outbound_token_refresh` now distinguishes
    transient atproto errors (PDS 5xx, `ECONNRESET`/`ETIMEDOUT` + the
    rest of the undici transport set, walked through `cause` up to 4
    levels) from terminal ones; transient errors leave `is_valid=TRUE`
    and retry next cron tick instead of hassling the user with a
    reconnect prompt over a 30-second PDS blip. §85 — added three
    drift-repair UPDATEs to `feed_items_reconcile` (articles: title +
    content_preview; notes: content_preview; external: title +
    content_preview + author_name + author_avatar) so the reconcile
    safety net closes drift as well as missing rows. Per-case counts
    mirrored in the WARN log. §86 — new
    `shared/src/lib/text.ts::truncatePreview` that uses
    `Array.from(text).slice(0, 200).join('')` (code-point-aware) so JS
    content_preview writes agree with Postgres `LEFT(..., 200)` for
    emoji/astral-plane content. Swapped in across nine feed_items write
    paths (gateway publish.ts, notes.ts, publication-publisher.ts ×2,
    scheduler.ts; feed-ingest feed-ingest-rss.ts, feed-ingest-nostr.ts,
    atproto-ingest.ts, activitypub-ingest.ts). Error-truncation
    `.slice(0, 200)` call sites (log messages, HTTP error bodies) kept
    as-is — not content_preview-producing. Deferred from this round:
    §65 (observation dedup — needs semantic decision on temporal
    bucketing), §66 (cron `jobKey` — graphile-worker's `known_crontabs`
    slot-dedup already blocks duplicate fires for a given minute, so
    the claimed bug reproduces only on clock skew > 60s; leaving for
    when that surfaces), §68 (concurrent-reader endpoint auth —
    docker-internal network mostly contains it; revisit when/if those
    endpoints get exposed), §69 (JSONB zod validation on
    observation.values — not load-bearing until a third observation
    type ships). All 8 workspace builds clean; gateway 24/24 tests +
    shared 28/28 + feed-ingest 42/42 tests green; knip clean.
- **2026-04-20** — §61 gate-pass orchestration shipped. New
  `gateway/src/services/article-access/` directory with three modules:
  `access-check.ts` (the `checkArticleAccess` function + `AccessCheckResult`
  interface, lifted unchanged from the old `services/access.ts`),
  `unlock-records.ts` (`recordSubscriptionRead` + `recordPurchaseUnlock`,
  also lifted unchanged), and `gate-pass.ts` (the new `performGatePass`
  orchestrator). Barrel `index.ts` re-exports `checkArticleAccess` (used
  by `routes/replies.ts`) and `performGatePass` (used by the route
  handler). Old `services/access.ts` deleted; gateway test path updated
  to import directly from `./access-check.js` so the orchestrator's
  module-load `requireEnv` calls don't fire in unit tests.
  `routes/articles/gate-pass.ts` is now a thin HTTP wrapper: it builds
  the input, calls `performGatePass`, and a `switch` over the
  discriminated `GatePassResult` translates each `kind` to the same
  status + body the inline handler used to send (200/400/402/403/404/
  500/502). The orchestrator catches `ECONNREFUSED`/`ENOTFOUND`/
  `fetch failed`-shape errors itself and returns
  `{ kind: 'service_unreachable' }`; anything else propagates so the
  route's outer try/catch can log + return 500. Side cleanups:
  `READER_HASH_KEY` and `INTERNAL_SERVICE_TOKEN` dropped from
  `routes/articles/shared.ts` (only the orchestrator needs them now —
  `PAYMENT_SERVICE_URL` stays because `routes/articles/earnings.ts`
  still uses it for proxying); the get-or-create-tab dance and the
  HMAC reader-pubkey-hash computation moved into private helpers
  (`getOrCreateTab`, `isNetworkError`) inside `gate-pass.ts`; the
  key-service POST collapsed into one `fetchContentKey` helper used
  by both the free-access and post-payment branches (was duplicated
  inline before). CLAUDE.md "Article access logic lives in…" pointer
  updated to the new directory layout. Gateway 24/24 tests + web
  75/75 tests + build green; knip clean.
- **2026-04-20** — stragglers §21, §36, §57 shipped; §37 deferred.
  §21 — `sendMessage` now returns `{ messageIds, skippedRecipientIds }`
  instead of silently dropping recipients whose `nostr_pubkey` is null.
  `SendMessageResult` type in `gateway/src/services/messages.ts`, web
  `messages.send()` return type in `web/src/lib/api/messages.ts`, and
  `MessageThread.tsx` all updated; the web client `console.warn`s on
  partial delivery so dev signal is there pending a proper UI surface
  (no UX spec for partial-delivery toast yet, so no visible widget).
  §36 — verified per-row `SUM(amount - FLOOR(amount * fee / 10000))`
  matches the existing "platform absorbs rounding dust" rule tested in
  `payout-math.test.ts:183` and `settlement.test.ts:135`. A 1p read at
  8% bps correctly floors fee to zero; summing-then-flooring would
  instead collapse N sub-penny fees into a non-zero aggregate. Comment
  at `payout.ts` eligibility query now documents intent + points at the
  existing tests, so the pattern isn't misread as a bug during the next
  audit pass. §57 — cursor parser UUID validation tightened from
  `id.length >= 36` to a proper `^[0-9a-f]{8}-…-[0-9a-f]{12}$` regex.
  Legacy fallback branch (no-id plain-unix-seconds) unchanged — still
  injects the sentinel max-uuid. §37 (Stripe apiVersion bump) —
  deferred: installed stripe SDK is v14.25.0, which pins
  `LatestApiVersion = '2023-10-16'` at the type level, so a bare
  `apiVersion` string swap won't compile. Requires a coordinated SDK
  dependency bump (v14 → v17+) + end-to-end Stripe flow testing that
  needs network + a Stripe test account. Stays as the opportunistic
  item the original audit framed it as — piggyback next time
  webhook.ts/payout.ts/settlement.ts are touched with those resources
  available. Gateway 24/24 tests, payment-service 41/41, web 75/75, all
  builds clean.
- **2026-04-20** — §53 mega-route-file split shipped: the three largest
  gateway route modules (`publications.ts` 1,353 lines / 29 routes,
  `articles.ts` 1,153 / 13 routes, `subscriptions.ts` 959 / 13 routes) now
  live in directories (`routes/publications/`, `routes/articles/`,
  `routes/subscriptions/`) composed by an `index.ts` that re-exports the
  single top-level function each gateway registrar already calls
  (`publicationRoutes`, `articleRoutes`, `subscriptionRoutes`). Files
  grouped by concern — publications: core CRUD, members, CMS, public
  reads, revenue/rate-card; articles: publish/index, gate-pass
  orchestration, earnings, writer-side manage, subscription-convert;
  subscriptions: reader↔writer lifecycle, writer's subscriber
  management, publication subs, event history, pricing settings.
  `subscriptions/index.ts` re-exports `logSubscriptionCharge` (consumed
  by `workers/subscription-expiry.ts`) so the API surface beyond the
  gateway is unchanged. Mechanical split with zero behavioural change.
  Gateway type-check + 24/24 tests green, web 75/75 tests green, all 8
  workspace builds clean.
- **2026-04-20** — §58/59 follow-up: knip `types` strict-gate cleanup.
  Dropped `export` on 45 internal-only type/interface declarations across
  14 files flagged by `knip --include types`: feed-ingest adapters
  (`MastodonOutbound{Input,Result}`, `ActorMetadata`,
  `OutboxFetch{Options,Result}`, `AtprotoReplyRef`,
  `AtprotoPost{Input,Result}`, `RssFetch{Options,Result}`,
  `NormalisedItem`), feed-ingest libs (`ActivityPubIngestSource`,
  `AtprotoIngestSource`, `TruncateOptions`), gateway libs
  (`ActorProfile`, `AtprotoProfile`, `SubscriptionEventParams`,
  `EnqueueCrossPostInput`, `SignedNostrEvent`, `EnqueueNostrOutboundInput`,
  `InputType`, `MatchType`, `Confidence`, `ResolverMatch`,
  `ResolverResult` — `ResolveContext` kept exported since `routes/resolve.ts`
  still imports it per §49), gateway middleware/services
  (`PublicationMember`, `AccessCheckResult`, `InboxConversation`,
  `ConversationMessage`, `SendMessageResult`, `DecryptRequest`,
  `DecryptResult`, `DmPricingSummary`, `PublishToPublication{Input,Result}`),
  key-custody (`GeneratedKeypair`), payment-service
  (`PortableReceiptParams`, `ReadClassification`, `Split`, `SplitResult`,
  `PayoutStatus`, `WriterPayout`, `HandledStripeEvent`), traffology
  (`GeoResult`, `UAResult`, `KnownDomain`). CI workflow simplified: the
  `--include=files,dependencies,exports,unlisted,binaries` gate is now
  the default `npx knip` run (types is part of the default set now that
  the baseline is zero). All 8 workspace builds clean, 113 backend tests
  green, 75 web tests green, knip clean on the full default gate.
- **2026-04-20** — §58/59 follow-up polish: deleted the dead
  `shared/src/index.ts` barrel (zero consumers — the 202-import rewrite
  standardised exclusively on `@platform-pub/shared/<subpath>.js`),
  dropped the now-unreachable `main` field and `"."` / `"./*"` entries
  from `shared/package.json`'s exports map (keeping only `./*.js`
  which is the form every consumer uses). Removed `tsc` from
  `knip.json` `ignoreBinaries` (each workspace declares `typescript`
  as a devDep, so knip resolves it). All 7 backend Dockerfiles got
  `RUN npm prune --omit=dev` between build and `NODE_ENV=production`
  — previously production images shipped the full dev toolchain
  (tsx/vitest/typescript). `ApiError` now exported from
  `web/src/lib/api/client.ts` so error handlers can `instanceof`
  it. All 113 backend tests + 75 web tests green, knip clean, web
  type-check clean.
- **2026-04-20** — §58 + §59 shipped together (they were coupled — knip
  can only see the full graph once workspaces eliminate the symlink dance).
  npm workspaces adopted at root with 8 members (`shared`, `gateway`,
  `payment-service`, `key-service`, `key-custody`, `feed-ingest`,
  `traffology-ingest`, `traffology-worker` — `web/` stays standalone).
  Each consumer now lists `"@platform-pub/shared": "*"` and imports via
  `@platform-pub/shared/<subpath>` (202 imports rewritten across services
  - test mocks). `shared/package.json` exposes an `exports` map so subpath
    imports work both in dev (npm hoists `@platform-pub/*` into
    `node_modules/@platform-pub/`) and inside Docker images. All 7 backend
    Dockerfiles rewritten to `npm ci --workspace=… --include-workspace-root`
    then per-workspace `npm run build` — no more symlink dance, no more
    per-service lockfiles (now one `package-lock.json` at root). Per-service
    tsconfigs set `"rootDir": "src"` (removes the workaround that let tsc
    silently accept rootDir violations via symlinked source). The conversion
    revealed latent type errors in `feed-ingest/src/adapters/rss.ts` —
    custom RSS fields (`'content:encoded'`, `author`) weren't in the default
    `Parser` generic; fixed by typing `Parser<unknown, RssItemExtras>` with
    explicit `customFields` item list. `traffology-ingest` + `-worker` got
    `--passWithNoTests` on their `test` script (no test files yet, but they
    declared `"test": "vitest run"` which fails CI with exit 1). Knip v6.5.0
    wired at root with `knip.json`: scripts/ as entry+project pattern for
    the repo's `.ts` scripts, shared-workspace override (its `exports` map
    lets knip reach all public surfaces), `ignoreBinaries` for `tsc`/`next`/
    `vitest`/`tsx`, `ignoreDependencies` list for workspace-transitive deps
    (`pino`, `pg`, `jose`, `nostr-tools`, etc. — imported transitively via
    `@platform-pub/shared`, so per-service `package.json` declares them but
    no direct imports appear). Dead-code sweep from knip's initial report:
    4 singleton-service classes dropped `export` (`VaultService`,
    `PayoutService`, `AccrualService`, `SettlementService` — only the
    `const xService = new XService()` singleton is imported externally), and
    3 genuinely unused functions deleted outright (`nip44Encrypt` HTTP
    wrapper in gateway's key-custody-client, `decryptArticleBodyXChaCha` in
    key-service/src/lib/crypto.ts, `getTotalCount` in traffology-ingest's
    concurrent-tracker). `countGraphemes` in feed-ingest/src/lib/text.ts
    unexported (internal-only). CI workflow rewritten: one `npm ci` at root
    replaces 5 per-prefix installs, build + test run via
    `npm run X --workspaces --if-present`, knip gates on
    `files,dependencies,exports,unlisted,binaries`. Types category excluded
    from the strict gate — a 46-type baseline remains (mostly internal-only
    input/result interfaces paired with exported functions; cleanup is
    mechanical but out of scope for this session). `web/` CI path unchanged
    (still standalone `cd web && npm ci`). Local verification: 7/7
    workspace builds clean, all tests green (11 key-service + 41
    payment-service + 19 key-custody + 42 feed-ingest + shared + gateway,
    traffology-\* pass-with-no-tests), ESLint 0 errors, knip clean on
    strict categories. Follow-up tracked: drop `export` on the 46 unused
    types, move web/ into the workspace once Next.js toolchain compat is
    verified, consider promoting `types` back into the knip strict gate
    once cleanup lands.
- **2026-04-20** — §55 markdown reorg shipped: cleared 5 stale
  LibreOffice lock files (none of the documents were open — leftovers
  from prior crashes dated Apr 12–16), then moved 22 of the 26
  root-level markdowns into `docs/adr/` (14 forward-looking specs:
  `ALLHAUS-ADR-UNIFIED`, `ALLHAUS-OMNIBUS`, `ALLHAUS-REDESIGN-SPEC`,
  `CODE-QUALITY`, `EMAIL-ON-PUBLISH-SPEC`, `GATEWAY-DECOMPOSITION`,
  `OWNER-DASHBOARD-SPEC`, `PUBLICATIONS-SPEC`, `REDESIGN-SCOPE`,
  `TRAFFOLOGY-MASTER-ADR-2`, `UI-DESIGN-SPEC`, `UNIVERSAL-FEED-ADR`,
  `platform-bucket-system-design`, `platform-pub-currency-strategy`)
  and `docs/audits/` (8 post-hoc reviews: `ADMIN-PAGE-AUDIT`,
  `AUDIT-BACKLOG`, `AUDIT-REPORT`, `FIX-PROGRAMME`,
  `SUBSCRIPTIONS-GAP-ANALYSIS`, `all-haus-frontend-audit`,
  `platform-pub-review`, `universal-feed-audit`). Four files remain
  at root per the §55 spec: `README.md`, `CLAUDE.md`, `DEPLOYMENT.md`,
  `feature-debt.md`. `git mv` used for the 17 tracked files so rename
  history is preserved; plain `mv` for the 5 untracked ones
  (`ALLHAUS-ADR-UNIFIED`, `ALLHAUS-OMNIBUS`, `AUDIT-BACKLOG`,
  `REDESIGN-SCOPE`, `platform-pub-review` — no prior commits, so zero
  history loss). Bulk path-rewrite via `perl -pi -e` with a negative
  lookbehind `(?<!/)FILENAME\.md` pattern (idempotent — already-prefixed
  refs skip) rewrote every remaining bare reference across `CLAUDE.md`,
  `feature-debt.md`, the moved docs (adr↔audits cross-refs), 7
  feed-ingest task/adapter files, `gateway/src/routes/reading-positions.ts`,
  and 8 migration SQL files. `planning-archive/` intentionally not
  touched — that's frozen historical snapshot. Post-rewrite grep across
  the whole tree (ex. planning-archive, .git, .claude) returns zero
  bare references, confirming the regex was exhaustive.
- **2026-04-20** — Day 7 §52 api.ts split shipped: 1,568-line
  `web/src/lib/api.ts` split into 16 modules under `web/src/lib/api/`
  (`client.ts` for the shared `request()` + `ApiError` infra, plus
  `auth`, `account`, `articles`, `feed`, `notifications`, `votes`,
  `messages`, `social`, `drives`, `admin`, `publications`, `resolver`,
  `external-feeds`, `linked-accounts`, `trust`, `writers`). `api.ts`
  is now a 25-line pure-re-export facade with a note flagging it as
  transitional — all 76 consumers keep working unchanged. Restored a
  `WriterProfile` type into the new `api/writers.ts` module: §48
  dropped it alongside the `writers` API grouping, but 4 consumers
  still import the type (`[username]/page.tsx`, `WriterActivity`,
  `WorkTab`, `SocialTab`), so the orphan import surfaced as a
  type-check failure in this session's verify step. Post-fix:
  type-check clean, 75/75 web tests green.
  §55 still deferred (LibreOffice lock files on 5 specs).
- **2026-04-20** — Day 6 P2 deletions + renames shipped: §47
  (deleted 8 orphan components — `NoteComposer.tsx`,
  `NotificationBell.tsx`, `ErrorBoundary.tsx`, `UserSearch.tsx`,
  `DrivesTab.tsx`, `ThereforeMark.tsx`, `OffersTab.tsx`,
  `FeaturedWriters.tsx`; removed the stale `[class*="NoteComposer"]`
  print selector in globals.css and updated stale comment references
  in `format.ts` and `ProposalsTab.tsx`); §48 (web `lib/api.ts`
  pruned — deleted unused `keys`/`follows`/`search`/`writers`
  groupings and their types `KeyResponse`, `WriterProfile`,
  `ProfileFollower`, `ProfileFollowing`, `PublicSubscription`;
  dropped `export` on `SignupInput`, `SignupResult`,
  `GatePassResponse`, `ResolvedContent`, `Publication`;
  `lib/ndk.ts` kind constants trimmed to the three actually
  used — `KIND_ARTICLE`, `KIND_NOTE`, `KIND_DELETION`; dropped
  redundant `export default` on the three editor nodes since
  all consumers use the named export; `decryptVaultContentAesGcm`
  left as a non-exported internal — the test exercises the
  XChaCha variant which remains exported); §49 (gateway
  `lib/errors.ts` deleted as orphan; `routes/resolve.ts` now
  imports `ResolveContext` type from the resolver lib so the
  inline string-union doesn't drift from the canonical type;
  `services/messages.ts` types reached by namespace import
  `* as messages`, no change needed); §50 (removed unused
  `date-fns`, `clsx` from web `package.json`; added missing
  explicit `@tiptap/core` + `prosemirror-state` deps to stop
  relying on transitive resolution through `@tiptap/react`);
  §51 (deleted 547-line orphan `provenance-ikb.jsx` at repo
  root); §54 (gateway routes renamed: `routes/feed.ts` →
  `routes/timeline.ts` with `feedRoutes` → `timelineRoutes`,
  `routes/feeds.ts` → `routes/external-feeds.ts` with
  `feedsRoutes` → `externalFeedsRoutes`, `routes/v1_6.ts` →
  `routes/my-account.ts` with `v1_6Routes` → `myAccountRoutes`;
  endpoint paths (`/feed`, `/my/tab`, etc.) unchanged so no
  client or test changes needed; CLAUDE.md references
  updated). §52 (api.ts split) and §55 (markdown reorg)
  deferred — §55 specifically because stale LibreOffice
  lock files on 5 specs suggest the user may still have
  them open. All 127 tests still green (52 gateway + 75 web).
- **2026-04-20** — Day 5 payments cleanup shipped: §32
  (`reservePublicationPayout` no longer duplicates the allocation
  maths — the DB fetches its own rows, maps to camelCase, and the
  result is passed through the pure `computePublicationSplits`;
  splits / platformFee / flatFee / remainingPool / flatFeeShareIds
  all destructure out of the pure result, so production and the
  payout-math unit tests now exercise the same code path); §34
  (`confirmPayout` adds `RETURNING id` and logs a `warn` when
  zero rows are updated — distinguishes unknown-transfer webhooks
  from legitimate duplicate deliveries); §35 (`handleFailedPayout`
  clears `completed_at = NULL` on the failed flip so reporting
  doesn't show a payout as both failed and completed; wraps
  `failed_reason` in `COALESCE` so a retry's reason doesn't stomp
  the first failure's context). §33 is already covered by §4's
  finalise split and noted in-code. All 15 payout-math tests still
  green.
- **2026-04-20** — Day 5 feed-ingest shipped: §22 (kind 30023
  now keyed on `naddr` — pubkey + kind + d-tag — via a new
  `isParameterizedReplaceable` helper; upsert is a ratchet:
  `ON CONFLICT (protocol, source_item_uri) DO UPDATE … WHERE
external_items.published_at < EXCLUDED.published_at`, returning
  `(xmax = 0) AS was_insert` so feed_items dual-writes distinguish
  insert-vs-revision-update; kind-5 deletion now also handles NIP-09
  `a`-tag addresses, reconstructing the naddr from
  `kind:pubkey:dtag` and matching source_item_uri); §23 (migration
  075 adds `external_sources.metadata_updated_at`, kind-0 profile
  writes gated on strictly-newer `created_at`, ratchet persists via
  `metadata_updated_at = CASE WHEN $5 IS NOT NULL THEN
to_timestamp(…) ELSE metadata_updated_at END`); §24
  (`fetchFromRelay` sends `['CLOSE', subId]` before socket close on
  timeout, guarded by `readyState === OPEN`); §25 (sub IDs
  `fi-${randomUUID()}`); §26 (per-relay validation runs through
  `Promise.all(rawEvents.map(async …))` — Schnorr verify is sync
  but the event loop can interleave IO between verifies now
  instead of pinning for the full batch); §27 (AP `newCursor`
  advances only past Create/Note/isPublic-passing activities);
  §28 (AP pagination requires `CUTOFF_STREAK_THRESHOLD=5`
  consecutive below-cutoff items before stopping, so scheduled
  posts / per-page ordering jitter don't truncate the run); §29
  (`WILDCARD_DID_THRESHOLD=150` — above it, Jetstream subscribes
  without `wantedDids` and `handleMessage` drops events whose DID
  isn't in `sourceByDid`); §30 (DID-set changes while staying
  above the wildcard threshold skip the reconnect entirely —
  filter is in-memory only); §31 (new `appendWithinBudget` in
  `lib/text.ts` counts graphemes on body + tail, reserves tail
  length before truncating body; outbound-cross-post uses it so
  Mastodon quote URLs survive long-body truncation). All feed-ingest
  type-checks pass; gateway tests still green.
- **2026-04-20** — Day 4 P1 structural shipped: §13 (BLUESKY_HANDLE
  regex restricted to `.bsky.social`/`.bsky.team`; new `dotted_host`
  classification handles bare-domain inputs by racing URL/RSS discovery
  and atproto probe in parallel — RSS hosts no longer burn an AppView
  round-trip); §14 (`nostr_profile` Phase B chain — temporary WS to
  relay hints from `nprofile`, falling back to `NOSTR_PROFILE_RELAYS`
  defaults, REQ kind 0, picks newest by `created_at`, populates
  displayName/about/picture on the matching `nostr_external` source);
  §15 (`status: 'pending' | 'complete'` on `ResolverResult` — seed row
  is `pending`, Phase B overwrites with `complete`; web client polls on
  status, not pendingResolutions length); §16 (`ResolveContext` wired —
  `invite`/`dm` skip all external Phase B chains since those surfaces
  only act on native_account matches, which Phase A already produced);
  §17 (`tryWellKnownPaths` runs all 7 probes via `Promise.all` and
  picks first hit by WELL_KNOWN_PATHS order; per-origin memo with 5-min
  TTL, 1000-entry cap); §18 (migration 074 — pg_trgm GIN indexes on
  `accounts.username` + `accounts.display_name` so `searchPlatform`
  ILIKE no longer full-scans); §45 (raw BEGIN/COMMIT/ROLLBACK in
  `publications.ts` × 3 and `tags.ts` × 1 → `withTransaction`,
  notifications insert moved out of the transaction so it can't roll
  back the membership write); §46 (all 7 service Dockerfiles now
  `npm run build` and `node dist/src/index.js` — type-check happens at
  image-build time, no per-boot tsx transpile cost); §19 (DM send
  loop collapsed — new `nip44EncryptBatch` in key-custody decrypts
  the sender's privkey once and encrypts for all recipients in one
  HTTP hop; sendMessage drops missing-pubkey recipients before
  encrypt, then writes all rows via a single multi-row INSERT inside
  the transaction). All gateway/web/key-custody tests still pass.
- **2026-04-20** — Day 3 P1 mechanical shipped: §38+§39 (shared
  `slugify`/`generateDTag` in `shared/src/lib/slug.ts`, gateway
  scheduler/publication-publisher/articles now import from it; web keeps its
  mirror with a comment — test already asserts identical output); §40
  (`expireAndRenewSubscriptions` → `workers/subscription-expiry.ts`,
  `expireOverdueDrives` → `workers/drive-expiry.ts`; `logSubscriptionCharge`
  stays in `routes/subscriptions.ts` and is imported by the worker since the
  in-process subscribe/renew endpoints also use it); §41 (advisory-lock IDs
  centralised in `shared/src/lib/advisory-locks.ts`, `JETSTREAM` consolidated
  with the gateway IDs, 100003 gap documented); §42 (`requireEnv` /
  `requireEnvMinLength` adopted by key-service, key-custody, payment-service);
  §43 (five `(req as any).session?.sub` in traffology → `req.session!.sub!`);
  §44 (deleted `db/client.ts` re-export shims in all three services, imports
  go directly to `shared/src/db/client.js`); §56 (docker-compose header
  refreshed to list all 13 services); §20 (dropped duplicate `rsa2` join in
  `loadConversationMessages`, read `nostr_pubkey` from `rsa`); §6 (`listInbox`
  mute filter moved inside `array_agg FILTER`, HAVING guards 1:1 DMs with
  muted counterparty, block check mirrors the send path's "hide if any member
  has blocked me"). All gateway/web/shared tests still pass (155 total).
- **2026-04-19** — Day 2 remainder shipped: §11 (group-DM duplicates
  confirmed; migration 073 adds `send_id UUID` to `direct_messages`,
  `sendMessage` emits one UUID per logical send across all N rows and
  wraps the inserts + conversation bump in a transaction,
  `loadConversationMessages` uses `DISTINCT ON (send_id)` preferring the
  row addressed to the viewer so NIP-44 decryption stays correct).
  §12 (pulled the DM 402 path entirely — removed `dm_payment_required`
  branch from `sendMessage`, the route handler, and `MessageThread.tsx`;
  `dm_pricing` table + admin CRUD kept so config persists for when a real
  charge-and-unblock endpoint ships; dead `getDmPrice` helper removed).
  §5 (renamed `publishNip17Async` → `publishConversationPulse` with a
  docstring explaining it is a conversation-activity beacon, not real
  NIP-17; real gift-wrap remains a separate, deferred feature).
- **2026-04-19** — Day 2 P0 Stripe orphans shipped: §3 (writer payout split
  into reserve→Stripe→complete with stable idempotency key `payout-${payoutId}`;
  new `resumePendingWriterPayouts` recovers crashed mid-flight payouts on the
  next cycle), §4 (publication payout same shape, N-multiplied — per-split
  `pub-split-${payoutId}-${accountId}` stable keys, per-split independent
  status updates so one Stripe failure no longer rolls back the others). §4
  subsumes §33 (dead "mark completed" block replaced by deterministic flip
  in finalisation) and, as a bonus, gives KYC-waiting splits a retry
  mechanism — previously they sat pending forever with no path forward. No
  migrations: schema already allowed `stripe_transfer_id NULL` and
  `'pending'` status for both tables.
- **2026-04-19** — Day 1 P0 shipped: §1 (scheduler vault ordering), §2 (Stripe
  webhook `processed_at` nullable dedup), §7 (`recordSubscriptionRead` wrapped
  in transaction), §8 (await the expiry-warning insert), §9 (new
  `expiry_warning_sent` event_type — migration 072), §10 (subscription charge
  reads `platformFeeBps` from config). Migrations 071–072 added.

---

## P0 — correctness bugs (fix first)

### 1. Scheduler: v2 encryption failure leaves paywalled article with no vault

**Verified:** `gateway/src/workers/scheduler.ts:127-232`. `publishPersonalDraft`
publishes v1 (free teaser) to the relay at :159, inserts the article at
:169-199 with `access_mode='paywalled'`, **then** tries v2 encrypt at :206.
Catch at :224 logs and continues. Draft is deleted on the outer success path.
Result: article is live on the relay (free content only), DB marks it
paywalled, no payload tag. Readers unlock and get nothing. Writer thinks it
shipped.

**Fix:** invert ordering — create vault first, build both events, publish v1
and v2 in sequence, insert DB row with final `event_id` once. Any failure
before DB insert leaves the draft on `article_drafts` for retry. Wrap in a
single logical unit; relay publish can't truly be rolled back but the DB
commit can anchor the "done" state.

### 2. Stripe webhook dedup race (event loss on crash)

**Verified:** `payment-service/src/routes/webhook.ts:56-78`. INSERT marks
event-seen _before_ handler runs. If the process dies between INSERT and
`handleStripeEvent` return, the dedup row survives, Stripe retry hits the
duplicate branch and acks, event is lost. The `DELETE on catch` at :71 helps
only when the handler returns an error — a crash bypasses it.

**Fix:** add `processed_at TIMESTAMP NULL` column to `stripe_webhook_events`,
set it only on successful completion, dedup on `processed_at IS NOT NULL`.
Gives you a reconciliation log of attempted-but-failed events as a bonus.

### 3. Stripe transfer orphan — writer payouts

**Verified:** `payment-service/src/services/payout.ts:342-361`. Inside
`withTransaction`, `stripe.transfers.create` runs at :342 _before_ the
`writer_payouts` INSERT at :355. If the INSERT (or either subsequent UPDATE)
throws, the transaction rolls back — but the Stripe transfer already
happened. Idempotency key is `payout-${writerId}-${randomUUID()}` per call
(:351), so retries don't dedupe against the orphan.

**Fix:** write payout row as `status='pending'` _before_ calling Stripe, then
update to `'initiated'` after. Use a stable idempotency key
`payout-${payoutId}` so retries land on the same transfer.

### 4. Stripe transfer orphan — publication payouts (same shape, N-multiplied)

**Verified:** `payment-service/src/services/payout.ts:641-690`. Transfers
created in the loop at :661 _before_ `publication_payout_splits` rows INSERT
at :683. Any later throw rolls the transaction back with real transfers
pending. Idempotency key includes `randomUUID()` (:671) so retries don't
dedupe.

**Fix:** insert all split rows as `status='pending'` first in one batch, then
iterate transfers updating to `'initiated'` or `'failed'`. Key on
`pub-split-${payoutId}-${accountId}` — no UUID.

### 5. NIP-17 publish is a fiction

**Verified:** `gateway/src/services/messages.ts:550-563`. `publishNip17Async`
signs a kind-14 event with `content: ''` and a `['conversation', convId]`
tag, publishes to the relay. No gift-wrap (1059), no seal (13), no
ciphertext, leaks conversation ID, reveals sender, decrypts to nothing. The
`event as any` cast on :558 is the tell. Real content lives in `direct_messages`
as NIP-44 envelopes; relay gets platform-internal metadata carrying a NIP-17
sticker.

**Fix:** choose one — rename to `publishConversationPulse` and own the
honest meaning, or stand up gift-wrap properly (kind-13 seal around the
kind-14, kind-1059 wrap around the seal, one wrap per recipient). Shipping
this as "NIP-17" is actively misleading.

### 6. `listInbox` mute filter drops whole conversations

**Verified:** `gateway/src/services/messages.ts:126-127`.

```sql
LEFT JOIN mutes m ON m.muter_id = $1 AND m.muted_id = cm.user_id
WHERE m.muter_id IS NULL
```

`cm` is pre-aggregation, so in a 3-person group where you've muted one
person, the entire conversation vanishes from your inbox — not just the
muted speaker. Also no block filter even though send/create both enforce it,
so a convo with someone who later blocked you stays in your inbox and 403s
on send.

**Fix:** move the mute check to filter members _inside_ `array_agg` (or
aggregate into `member_ids` then filter down), and mirror the `blocks`
check the send path uses.

### 7. `recordSubscriptionRead` is two non-atomic inserts

**Verified:** `gateway/src/services/access.ts:100-121`. Two `pool.query`
calls, no transaction. If the second fails, the unlock sticks but the
`subscription_events` audit row is missing. Not catastrophic (the read did
happen) but the ledger drifts, and every other paired-write path in the
codebase uses `withTransaction`.

**Fix:** five-line wrap in `withTransaction`.

### 8. Expiry-warning dedup INSERT is fire-and-forget

**Verified:** `gateway/src/routes/subscriptions.ts:1099-1103`. `pool.query(…)`
without `await`, `.catch` attached. Function returns before the insert
lands. SIGTERM between email send and DB write → reader gets the warning
email twice next cycle.

**Fix:** add `await`. One character.

### 9. Expiry-warning marker abuses `event_type='subscription_charge'`

**Verified:** `gateway/src/routes/subscriptions.ts:1098-1103` inserts
`event_type='subscription_charge'`, `amount_pence=0`, description magic-
string `'Expiry warning sent'`. Dedup at :1086 matches on the description.
`SUM(amount_pence)` queries stay correct (amount is 0), but any
`COUNT(*) WHERE event_type='subscription_charge'` over-counts.

**Fix:** add `'expiry_warning_sent'` to the `event_type` enum, use it.
Migration + two lines.

### 10. Platform fee hardcoded in subscription-charge path

**Verified:** `gateway/src/routes/subscriptions.ts:1118` —
`Math.round(pricePence * 0.08)`. `gateway/src/routes/v1_6.ts:79-82` and
`gateway/src/routes/publications.ts:1259` both read
`platform_config.platform_fee_bps`. `shared/src/db/client.ts:91` exposes it
as `platformFeeBps` already loaded. Change the config row and subscription
earnings silently stay at 8%.

**Fix:** `Math.round(pricePence * platformFeeBps / 10000)` reading from the
config object the function already has. One line + regression test.

### 11. **Verify first** — group-DM sender-side duplicates

**Flagged by `docs/audits/platform-pub-review.md` §1.** `direct_messages` has one
`recipient_id` per row, so a group send inserts N rows. The
`loadConversationMessages` WHERE at `messages.ts:182` matches
`sender_id = $2` OR `recipient_id = $2`, so the sender sees their own
message N times (once per recipient row).

Determines whether the rework is "tidy the N+1" or "rethink data model".
Verify by sending a group DM and inspecting the returned list before
doing anything else — five minutes. Fix likely needs a message-envelope
row + per-recipient-ciphertext row rather than N envelope rows.

### 12. **Verify first** — is the DM 402 `dm_payment_required` ever consumed?

**Flagged by `docs/audits/platform-pub-review.md` §1.** `sendMessage`
(`messages.ts:296-308`) returns 402 with a price when any recipient
charges. Grep shows the string `dm_payment_required` only in the
definition and the throw — no endpoint takes payment and then unblocks
the send. Until one exists, this feature is "block with a price tag on
it", not a paywall.

Also all-or-nothing for groups (comment at :296 says "Full per-recipient
charging is a fast-follow"). Either ship the charge-and-unblock endpoint
or pull the 402 path until it's ready — the current state is worst of
both.

---

## P1 — real bugs and drift hazards

### Resolver (`gateway/src/lib/resolver.ts`)

**13. Bluesky handle regex eats dotted RSS hosts.** `BLUESKY_HANDLE`
(:135) matches any `word.word.word`, and the classifier at :149 tests it
before `AMBIGUOUS_AT` / `PLATFORM_USERNAME`. Paste `myblog.substack.com`
into the subscribe field and it classifies as a Bluesky handle and burns
an AppView round-trip before falling through. Almost certainly why
RSS-only inputs feel slow.
**Fix:** order URL > npub > did > fediverse > **ambiguous_at** >
**bluesky_handle** (existing checks), and require `.bsky.social` /
known bsky suffixes before the generic-dotted fallback, or gate
Bluesky-handle behind a successful AppView probe.

**14. Nostr inputs skip profile enrichment.** For npub/nprofile/hex_pubkey
Phase A emits an `external_source` match with only the hex pubkey
(:189-238). No Phase B kind-0 fetch. Paste an npub, see "unknown account".
Bluesky and Fediverse both enrich via `fetchActorProfile` /
`atprotoGetProfile`. This is the "half-wired branch" most clearly
present in this file.
**Fix:** add a `nostr_profile` entry to the Phase B pending chain;
resolver opens a temporary relay connection, REQs kind 0 for the pubkey,
updates the match.

**15. `pendingResolutions` has ambiguous completion signal.** `resolveAsync`
writes `pendingResolutions: []` on finish, but a mid-flight poll sees the
seed row with the original array. No way to tell "still running" from
"done, no matches".
**Fix:** add `status: 'pending' | 'complete'` or `completed_at` to
`resolver_async_results`. Poll returns the column.

**16. `ResolveContext` is dead.** Type has four values, passed into
`resolveAsync` at :301, read nowhere. `gateway` knip run flagged all six
public types from `resolver.ts` as unused externally, confirming it.
**Fix:** remove the parameter, or actually use it to bias which chain
runs first.

**17. `tryWellKnownPaths` serial loop is a silent amplifier.** 7 paths ×
default timeout = 7× slowdown on dead origins. No cache, two users pasting
the same URL hit origin 14×.
**Fix:** `Promise.any` over the first two, fall back to the rest only on
failure. Memoize ~5 min.

**18. `searchPlatform` uses leading-wildcard ILIKE.** Line 697
`pattern = '%' + escaped + '%'`. Btree index can't help. Full scan per
free-text query.
**Fix:** `pg_trgm` GIN index on `username` + `display_name`, or prefix-
only fast path.

### DM path (`gateway/src/services/messages.ts`)

**19. N+1 on send hot path.** Lines 297-308 pricing loop, then :317-332
serial encrypt + insert. 10-person group = 20+ DB round-trips + 10 serial
key-custody HTTP hops.
**Fix:** one `getDmPrice` query with `ANY()`, one batched encrypt call
(if key-service doesn't have a batch endpoint, add one — the encryption
itself is CPU-bound, not blocking), single multi-row INSERT.

**20. `rsa`/`rsa2` duplicate join.** `messages.ts:219-221` joins
`accounts` twice on `rdm.sender_id`, one alias for username
(`rsa.username`), another for pubkey (`rsa2.nostr_pubkey`). Same join.
**Fix:** collapse to `rsa`, select both columns.

**21. Silent skip on missing recipient pubkey.** `messages.ts:319-322`
logs and continues on missing pubkey; message not delivered but send
returns success. No way for caller to know.
**Fix:** return `{ messageIds, skippedRecipientIds }` in the response
payload, or fail hard if anyone's missing a pubkey (shouldn't happen in
practice but "shouldn't" is load-bearing here).

### Feed-ingest (`feed-ingest/src/**`)

**22. Kind 30023 ignores replaceable semantics.** `feed-ingest-nostr.ts`
stores each kind-30023 under an `nevent` URI (:384), not `naddr`. Author
updates a draft → second feed item appears. Feed shows stale versions.
**Fix:** for replaceable kinds (10000-19999, 30000-39999), key on
`naddr1(pubkey, kind, d-tag)`; upsert rather than insert.

**23. Kind-0 profile updates race metadata-refresh task.** Ingest path at
`feed-ingest-nostr.ts:243-268` updates `display_name`/`avatar_url` on
`external_sources`; separate `source-metadata-refresh` task does the
same. Two writers, no timestamp ordering. `COALESCE($3, display_name)`
at :264 handles null but not staleness.
**Fix:** make ingest compare-and-set — only write if the kind-0 event's
`created_at` is newer than a stored `metadata_updated_at` column. Or
drop the ingest-side update entirely and let metadata-refresh own it.

**24. Nostr `fetchFromRelay` doesn't CLOSE on timeout.** Lines 304-366,
timeout at :319 resolves without sending `CLOSE`. Only EOSE path does
(:347). Misbehaving relays that never EOSE keep the sub open 10s then
get the socket yanked. Some relays flag this as abuse.
**Fix:** send `['CLOSE', subId]` in the timeout branch before resolving.

**25. Nostr sub ID collisions.** `subId = 'feed-ingest-${Date.now()}'`
(:313). Millisecond collisions on busy relays.
**Fix:** UUID or monotonic counter.

**26. Nostr `verifyEvent` pins a core.** Schnorr verification runs
serially inside the relay-fetch loop — 5 relays × 50 events = 250 serial
verifies in the ingest hot path.
**Fix:** `Promise.all` across events per relay. Worker thread only if
throughput becomes an issue.

**27. AP outbox cursor anchors to skipped activities.** `activitypub.ts:162`
sets `newCursor = activityId` regardless of whether the activity passed
the Create/Note/isPublic filters. Skipped Announce at the top of the
outbox → cursor anchors to a non-ingestable item. If that item ever
changes/disappears (some Mastodon instances do), dedup breaks.
**Fix:** only advance cursor past activities that pass all filters.

**28. AP `cutoffMs` stop condition brittle.** Lines 175-179 stops paging
once `publishedAt < cutoffMs`. Mastodon outboxes can contain scheduled
(future) posts or per-page ordering off-by-one. Single stray older item
ends pagination early.
**Fix:** page by activity count (e.g. 200) or until you see N consecutive
items below cutoff, not the first.

**29. Jetstream DID cap at ~150-200 sources.** `listener.ts:249` appends
every DID as a `wantedDids` query param; WebSocket upgrade URL is bounded
by Jetstream server (~8-16 KB). ADR claims arbitrary scale; this is the
pinch point.
**Fix:** two options — DID-hash shard across N listener processes (each
owns half of the DID space), or once DID count exceeds ~150, subscribe
to wildcard firehose and filter client-side. Either is a half-day.

**30. Jetstream DID-set change replays everything.** Any change tears
down and reopens from `oldestCursor()` across all sources (:227-239).
ON CONFLICT saves the DB but bandwidth/CPU burn.
**Fix:** spin up a second scoped listener for just the new DID(s),
catch-up to live, then merge into the main filter at the next
reconnect boundary.

**31. Mastodon outbound truncation clips the quote URL.** `outbound-
cross-post.ts:125` appends source URL to `text`, then
`truncateWithLink(combined, { max })` truncates the end. Long quotes →
URL (the part that makes it a quote) is what gets cut.
**Fix:** budget is `maxChars − URL length − separator`, applied to
`text` _before_ append.

### Payments (other)

**32. `computePublicationSplits` duplicate implementation.** 202 lines of
unit tests cover the pure function. `initiatePublicationPayout`
(`payout.ts:511`) **reimplements the same logic inline** at :535-629 —
flat fees, revenue_bps, standing shares, same order, same rounding. Bug
fixes have to land twice; the tests validate a function the DB path
doesn't use. The DB path also does `UPDATE publication_article_shares
SET paid_out = TRUE` inside the loop (:589) whereas the pure function
tracks IDs for the caller — it rolls back correctly by luck (transaction)
not design.
**Fix:** refactor `initiatePublicationPayout` to call the pure function,
then drive the DB writes off its result.

**33. Dead status-flag block at payout.ts:706-714.** Both disjuncts of
`allInitiated` check the same thing ("no splits with positive amounts").
The only time it's true is when the payout was empty, in which case
status was set to `'initiated'` at :635 and the UPDATE is a no-op. When
it's false (normal case), UPDATE sets status to `'initiated'` — already
what it was. Whole block does nothing. Intent was probably
`'completed'` when all transfers succeeded.
**Fix:** decide intent and implement it, or delete the block.

**34. `confirmPayout` is silent on missing row.** `payout.ts:407` straight
UPDATE, no `RETURNING`, no rowcount check. `transfer.paid` webhook for
an unknown `stripe_transfer_id` logs "confirmed" and returns success.
Stripe thinks it's fine; no payout record associates.
**Fix:** add `RETURNING id`, warn (and surface to reconciliation) when
rowcount is 0.

**35. `handleFailedPayout` status machine under-specified.** `failed_reason`
overwritten each call (no history). `completed_at` never cleared — a
completed payout that later receives `transfer.failed` (reversals can
cause this) ends up `status='failed'` _and_ `completed_at != NULL`.
**Fix:** null `completed_at` when transitioning to failed; append to a
`failure_history jsonb` or log table rather than overwriting.

**36. Writer-eligibility rounding bias.** `payout.ts:261` per-row
`SUM(amount - FLOOR(amount * fee / 10000))` differs from
`total - FLOOR(total * fee / 10000)` by up to N pence (one per row).
1p read × 5% fee → floor(0.05) = 0, writer gets 1p, platform gets 0.
Probably intentional (platform absorbs dust) — verify against accrual
tests and document.

**37. Stripe API version is two years old.** `apiVersion: '2023-10-16'`
pinned in webhook.ts and payout.ts. Comment at payout.ts:90 already
acknowledges it (`'transfer.paid' not in SDK v14 types`). Bump when
touching these files anyway.

### Scheduler / cross-service plumbing

**38. `generateDTag` duplicated three times.** `scheduler.ts:265-274`,
`publication-publisher.ts:363-372`, `web/src/lib/publish.ts:202`. The
web test at `publish.test.ts:45` asserts identical output to gateway —
duplication is known. `scheduler.ts:131` uses the local copy while the
file _also_ imports from `publication-publisher.js` (via
`publishToPublication`). Same file, two implementations.
**Fix:** move to `shared/src/lib/nostr.ts`, import from all three.

**39. Slug generation duplicated four times.** Identical pattern at
`articles.ts:66-71`, `scheduler.ts:163-167`, `scheduler.ts:267-271`
(inside `generateDTag`), `publication-publisher.ts:365-369`.
**Fix:** `slugify(title, maxLen)` in `shared/src/lib/slug.ts`. Subsumes
§38's slug step.

**40. Background workers exported from route files.**
`subscriptions.ts:937` exports `expireAndRenewSubscriptions`,
`drives.ts:822` exports `expireOverdueDrives`. `gateway/src/index.ts`
imports both and runs them under advisory locks. Inverted — `workers/`
already exists for this.
**Fix:** move both into `gateway/src/workers/`. Pair with P2 §48 (route-
file split) so the empty shells don't carry legacy worker exports.

**41. Advisory-lock IDs have a hole (100003).** `gateway/src/index.ts:245-247`
defines SUBSCRIPTIONS=100001, DRIVES=100002, SCHEDULER=100004. 100003
missing — classic "removed a worker" smell. Feed-ingest jetstream
listener at `listener.ts:115` also uses advisory locks in a separate
service.
**Fix:** `shared/src/lib/advisory-locks.ts` exporting a const object.
Document the gap in a comment.

**42. Env helper ignored by three services.** `shared/src/lib/env.ts`
exports `requireEnv` / `requireEnvMinLength`. Gateway uses it;
`key-service/src/index.ts:18-23`, `key-custody/src/index.ts:28-33`,
`payment-service/src/index.ts:15-17` each hand-rolled `for (const name
of ...)`.
**Fix:** five-minute find-and-replace.

**43. Traffology `(req as any).session?.sub` casts.**
`gateway/src/routes/traffology.ts:30,58,80,115,195` — five casts, all on
routes that already have `preHandler: requireAuth`. Other gateway routes
use `req.session!.sub!`.
**Fix:** replace the five casts. If the module augmentation in
`gateway/src/types/fastify.d.ts` isn't reaching this file, fix the
typing-import or the `tsconfig` include.

**44. `db/client.ts` shims in three services.** `key-service/src/db/client.ts`,
`key-custody/src/db/client.ts`, `payment-service/src/db/client.ts` are
pure re-exports from `shared/src/db/client.js`. Gateway imports shared
directly.
**Fix:** delete the shims, update imports.

**45. Mixed transaction idioms inside same file.**
`gateway/src/routes/publications.ts` has 9 raw `BEGIN`/`COMMIT`/`ROLLBACK`
tokens, 0 `withTransaction`. Other route files use `withTransaction`
exclusively. Split is by file, not by operation.
**Fix:** mechanical convert in `publications.ts` (and `tags.ts` if
similar). No behavioural change.

**46. Start script mismatch with Dockerfile.** Each service
`package.json` declares `"start": "node dist/src/index.js"`;
`gateway/Dockerfile:13` runs `tsx gateway/src/index.ts`. `start` never
invoked, build target vestigial. Production is re-transpiling on every
boot with no type check in the container.
**Fix:** make the Dockerfile build and run the built JS. Flagged P1
not P0 because it works today — but "works" hides a real correctness
concern (no type check in prod build).

---

## P2 — housekeeping, dead code, refactor

### Dead code (delete now)

**47. Unused components.** Six confirmed orphans with zero imports:

- `web/src/components/feed/NoteComposer.tsx` (188 lines, replaced by
  `ComposeOverlay`)
- `web/src/components/ui/NotificationBell.tsx` (274)
- `web/src/components/ui/ErrorBoundary.tsx` (43)
- `web/src/components/ui/UserSearch.tsx` (105)
- `web/src/components/dashboard/DrivesTab.tsx` (93)
- `web/src/components/icons/ThereforeMark.tsx` (43)

`platform-pub-review` §5 also flagged `OffersTab.tsx` and
`FeaturedWriters.tsx` — double-check with a fresh grep before deletion.
`globals.css:551` has a stale `[class*="NoteComposer"]` selector; remove
in the same change. Also the six test files whose subjects are
themselves orphans.

**48. Knip findings in web.** `lib/api.ts`: `keys`, `follows`, `search`,
`writers` API groupings + a dozen orphan response types (`SignupResult`,
`GatePassResponse`, `ResolvedContent`, `Publication`, etc.) unused.
`lib/ndk.ts`: `KIND_VAULT`, `KIND_RECEIPT`, `KIND_DRAFT`, `KIND_CONTACTS`,
`KIND_REACTION` unused. `lib/vault.ts`: three decrypt helpers unused.
Editor nodes (`EmbedNode`, `ImageUpload`, `PaywallGateNode`): named +
default export of same thing.
**Fix:** delete the unused API groupings (one-liners). For vault helpers,
confirm they're not server-imported before deleting. For kind constants,
delete — planned surface that didn't land.

**49. Knip findings in gateway.** `src/lib/errors.ts` (15-line `sendError`
helper) imported by nothing; routes keep `reply.status().send()`. Either
adopt or delete.

All six public types from `resolver.ts` (`InputType`, `MatchType`,
`Confidence`, `ResolveContext`, `ResolverMatch`, `ResolverResult`) unused
externally → route handler returns raw output without typing it.

All six from `messages.ts` (`InboxConversation`, `ConversationMessage`,
`SendMessageResult`, `DecryptRequest`, `DecryptResult`, `DmPricingSummary`)
unused externally → same pattern.
**Fix:** either type the route responses against these (cheap, recovers
the service-to-route contract) or remove `export`. Pick one per file,
not one per type.

**50. Unused + unlisted deps.** `date-fns`, `clsx` in `package.json`,
never imported — free weight to cut. `@tiptap/core` and
`prosemirror-state` imported but not listed — resolve through transitive
`@tiptap/react`, will break if tiptap upgrades unbundled.

**51. `provenance-ikb.jsx` at repo root.** 547 lines, only `.jsx` file
in the repo, no imports.
**Fix:** `git rm`.

### Refactor / naming

**52. Split `web/src/lib/api.ts`.** 1,685 lines, 87 exports, already
grouped in-file by domain. Split into `api/{auth,articles,feed,…}.ts`;
keep `api.ts` as `export *` for one release; delete.

**53. Split three gateway mega-route-files.** `publications.ts` 1,353
lines / 29 routes, `articles.ts` 1,153, `subscriptions.ts` 1,138. Split
each into a directory. Pair with §40 so the worker extraction happens
at the same time.

**54. Rename ambiguous files.** `routes/feed.ts` → `timeline.ts`,
`routes/feeds.ts` → `external-feeds.ts`, `routes/v1_6.ts` →
`my-account.ts` (or split into `reading-tab.ts` + `account-statement.ts`).
Both v1_6 handlers are live — `AccountLedger.tsx:51` consumes
`/my/account-statement` — so this is a rename, not a deletion.

**55. Move audit/planning markdowns out of root.** 22 `.md` files at
root (audit claimed 32 — overstated).
**Fix:** `docs/adr/` for specs (ALLHAUS-REDESIGN-SPEC, UNIVERSAL-FEED-ADR,
ALLHAUS-OMNIBUS, etc.), `docs/audits/` for `docs/audits/platform-pub-review.md`,
`docs/audits/AUDIT-BACKLOG.md`, this file. Keep `README.md`, `CLAUDE.md`,
`DEPLOYMENT.md`, `feature-debt.md` at root.

**56. Stale docker-compose.yml header.** Comment at :1-17 lists 9
services; actual file also has key-custody, feed-ingest, traffology-
ingest, traffology-worker. 30-second fix.

**57. Cursor parser accepts non-UUID ids.** `routes/feed.ts:39-59` —
`id.length >= 36` check but no UUID format. No injection risk
(parameterised). Cosmetic.

---

## P3 — bigger moves (do when the return justifies it)

**58. Root `knip.json` + CI hook failing on new unused exports.** The
single biggest quality lever available. Refactor corpses — `lib/format.ts`
says `// Consolidated from ArticleCard, NoteCard, FeaturedWriters` and
those files are still there — would have become build errors at the
moment of creation. Pair with workspace setup (§59) so knip sees the
full graph.

**59. Adopt npm (or pnpm) workspaces.** Root `package.json` has no
`workspaces`. Dockerfiles do a symlink dance
(`RUN ln -sf /app/shared /app/gateway/shared`) to make
`../../shared/src/…` imports work. Per-service tsconfigs override
`rootDir` to `.` specifically so symlinked `shared/` compiles into each
service's `dist/`. The shims in §44 exist because of the same pressure.
**Fix:** one day, removes a whole category of papercuts.

**60. Outbox pattern for relay publishing.** Every `INSERT … ;
publishToRelay(signed)` with ad-hoc retry — the scheduler v1/v2 hazard
(§1), `recordSubscriptionRead` (§7), publication-publisher, notes
deletion — becomes "write intended-publish record in transaction,
worker picks it up". feed-ingest already runs Graphile Worker; extend it
to a gateway outbox. Week of work, biggest correctness dividend on
this list. Do the tactical fixes §1-10 first — they ship individually;
the outbox replaces them but shouldn't gate them.

**61. Gate-pass orchestration module.**
`routes/articles.ts`'s `/articles/:nostrEventId/gate-pass` handler,
`services/access.ts`, and payment-service each own a piece. Gateway
also computes `readerPubkeyHash` inline and manages tab creation — three
roles in one handler. Pull gateway-side orchestration into
`services/article-access/`. Half-day.

**62. Consider merging key-service + key-custody.** 918 + 447 lines, 15
files. Security split is real (different key material in each) but may
not justify two containers. Defer.

**63. Round-3 audit targets.** Not covered by either prior round:
Traffology ingest flow (`traffology-ingest`, `traffology-worker`), most
feed-ingest adapters (33 files, 4.7k lines), ATProto OAuth client setup
(`shared/src/lib/atproto-oauth.ts`), full sweep of `feed_items` insert
sites (publication-publisher, note ingest, external-feed dual-writes)
for `content_preview` / truncation consistency, full `ts-prune`
alongside `knip` across all services. **Scoped on 2026-04-20 — see
§64-§87 below for the produced findings.** ts-prune deleted from the
scope: knip's `types` gate subsumes it.

---

## Round-3 findings — §64-§87 (scoped 2026-04-20)

### Traffology (`traffology-ingest`, `traffology-worker`)

**64. `IP_HASH_SALT` silently defaults to `'traffology-default-salt'`.**
**Verified:** `traffology-ingest/src/routes/beacon.ts:21` —
`process.env.IP_HASH_SALT ?? 'traffology-default-salt'`. If the env var
is missing in prod, every deploy ships with the same hardcoded salt
baked into source; IP hashes become reversible against a precomputed
rainbow table of IPv4 space. **Fix:** adopt `requireEnvMinLength` from
`shared/src/lib/env.ts` (used by all other services per §42), fail fast
on boot if the salt is missing or too short.

**65. `insertObservation` has no ON CONFLICT — reruns duplicate rows.**
**Verified:** `traffology-worker/src/tasks/interpret.ts:349-358`.
Application-level `NOT EXISTS` guards in each `detect*` function at
`:66-70, :125-129, :183-188, :232-235, :308-313` are racy — interpret
reruns (worker restart, cron double-fire) can sail past the check
before the insert lands. **Fix:** add `UNIQUE (piece_id, observation_type)`
or `ON CONFLICT DO NOTHING` keyed on the same tuple.

**66. Aggregate cron tasks declared without `jobKey`.**
**Verified:** `traffology-worker/src/index.ts:39-49`. `aggregate_hourly`,
`aggregate_daily`, `aggregate_weekly` are cron-scheduled without
Graphile Worker's dedup key. A clock-skew double-fire would run the
whole pipeline twice; upserts protect final state but intermediate
queries see inconsistent snapshots mid-run. **Fix:** add
`jobKey: '${taskName}-${bucketTimestamp}'` so the second fire
coalesces.

**67. Rank UPDATE runs outside the hourly-aggregate transaction.**
**Verified:** `traffology-worker/src/tasks/aggregate-hourly.ts:182-204`.
`piece_stats`/`source_stats`/`half_day_buckets` inserts sit inside
`withTransaction`; the subsequent ranking UPDATE runs on the outer
`pool`. A crash between commit and ranking leaves writers seeing stats
with stale rank until the next hourly tick. **Fix:** move the ranking
UPDATE inside the same transaction.

**68. Concurrent-reader endpoints accept any `writerId` unauth'd.**
**Verified:** `traffology-ingest/src/routes/concurrent.ts:12-38`.
`GET /concurrent/:pieceId` and `GET /concurrent/writer/:writerId`
have no auth hook. The service is docker-internal today (nginx doesn't
route to :3005 directly, only the gateway reaches it over the compose
network), so the practical blast radius is any container inside the
compose network — not internet. **Fix:** either mirror
`INTERNAL_SERVICE_TOKEN` (as key-service uses) or push the auth
decision into the gateway route and keep ingest internal. Scoped to
P2 because the network boundary mostly contains it today.

**69. Observation `values` column is unvalidated JSONB.**
**Verified:** `traffology-worker/src/tasks/interpret.ts:349-358` accepts
`Record<string, unknown>`. Downstream queries cast fields
back to text/int at `:187, :312` with no guard. A schema drift in one
detect function silently produces NULLs in dashboards. **Fix:** a
discriminated union + zod parse at insert would pay for itself the
first time an observation type is added.

### Feed-ingest adapters

**70. Mastodon `Idempotency-Key` hashes user-editable text.**
**Verified:** `feed-ingest/src/tasks/activitypub-outbound.ts:112-113`
— key is `sha256('${replyTo}::${text}')`. If a cross-post fails, the
user edits the draft, and retry fires, Mastodon sees a new request
and may double-post. **Fix:** key on `outbound_posts.id` (the row is
written before the first attempt per §3's row-first idiom) — stable
across retries, not derived from mutable content.

**71. Nostr outbound treats any-relay-accepts as success.**
**Verified:** `feed-ingest/src/lib/nostr-outbound.ts:27-51` — returns
success if ≥1 relay accepts; caller at
`outbound-cross-post.ts:180` marks the outbound row `sent` and never
retries. Readers on rejecting relays never see the post. **Fix:**
return `{ succeeded, failed, total }` and leave retry logic to the
caller — probably "retry if `failed/total > 0.5`" with a cap.

**72. Outbound retry `jobKey` collides with the original enqueue.**
**Verified:** `feed-ingest/src/tasks/outbound-cross-post.ts:204-217`.
The retry enqueue uses `outbound_cross_post_${row.id}` — identical
to the original. Graphile Worker jobKey dedups, so the retry merges
with the already-in-flight job and loses the backoff delay. **Fix:**
versioned key `outbound_cross_post_${row.id}_r${retryCount}`, or drop
the jobKey entirely and rely on the `outbound_posts.status` FSM.

**73. RSS `content_preview` falls back to `summary` when other
adapters don't.** **Verified:** `feed-ingest/src/tasks/feed-ingest-rss.ts:131`
— `(item.contentText ?? item.summary ?? '').slice(0, 200)`. Nostr
(`feed-ingest-nostr.ts:237`), Mastodon (`activitypub-ingest.ts:81`),
Bluesky (`atproto-ingest.ts:86`) all use contentText only. RSS items
with null contentText + non-null summary render previews other
adapters wouldn't have. **Fix:** pick one — either everyone gets the
summary fallback or no-one does; most likely summary is the right
choice everywhere, RSS is just the only one that gets it today.

**74. `activitypub_instance_health` grows without bound.**
**Verified:** migration 056 defines the table; `activitypub-ingest.ts`
UPSERTs into it per poll. There's no prune cron for hosts that stopped
responding months ago. **Fix:** add a cleanup task mirroring
`resolver_results_prune` — delete rows whose last_success_at and
last_failure_at are both older than 90 days.

**75. HTML sanitisation lives at different layers per adapter.**
**Verified:** `adapters/rss.ts:99` runs `sanitizeContent` on raw HTML;
`adapters/activitypub.ts:266` same; `adapters/atproto.ts:331` builds
HTML from a RichText walk with no central sanitiser;
`feed-ingest-nostr.ts:206` has no HTML step at all. If the sanitise
rules change, RSS + Mastodon track; Bluesky drifts. **Fix:** wrap
the atproto HTML builder's output in `sanitizeContent` before write
so the three HTML-producing adapters share one code path.

### ATProto OAuth (`shared/src/lib/atproto-oauth.ts`)

**76. JWK parse happens lazily on first `getAtprotoClient()` call.**
**Verified:** `shared/src/lib/atproto-oauth.ts:92-162`. `buildClient()`
is invoked on first use; if `ATPROTO_PRIVATE_JWK` is malformed JSON
or missing required fields, the failure shows up on the first
OAuth-dependent request, not at server boot. The catch at `:96-99`
nulls the cache so subsequent callers hit the same error, which is
good for recovery but bad for boot-time detection. **Fix:** call
`getAtprotoClient()` in gateway's startup sequence behind a
try/catch — the prod branch (non-loopback) needs the JWK valid or
the server is functionally degraded anyway, so failing boot is
honest.

**77. DPoP refresh error has no recoverable-vs-terminal split.**
**Verified:** `feed-ingest/src/tasks/outbound-token-refresh.ts:97-102`
— any error from `client.restore(did, 'auto')` flips the account to
`is_valid=FALSE`. A transient PDS outage or DNS blip reads the same
as a revoked refresh token; users see "reconnect your Bluesky
account" for what should have been a 30-second dip. **Fix:** parse
the error — PDS 5xx / network → leave valid, retry next tick;
`invalid_grant` / `invalid_token` → flip invalid and surface the
reconnect prompt.

**78. `.well-known/*` endpoints lack explicit `Content-Type` and
cache headers.** **Verified:** `gateway/src/index.ts:212-213`. Both
`/.well-known/oauth-client-metadata.json` and `/.well-known/jwks.json`
rely on Fastify's default serialisation with no `Cache-Control`.
PDSes polling for JWKS rotation hit origin every request. **Fix:**
`reply.type('application/json').header('Cache-Control',
'public, max-age=3600')` on both.

**79. Token-refresh cron logs `{ err }` without sanitisation.**
**Verified:** `outbound-token-refresh.ts:98` logs the raw error object
on refresh failure. If the `@atproto/oauth-client-node` error message
ever embeds partial DPoP proof or token values, those land in logs.
Not verified in the current library version, but the shape is
fragile. **Fix:** `logger.warn({ err: { name: err.name, code: err.code,
message: err.message?.slice(0, 200) }, id, did })` — never pass the
raw object through.

**80. `atproto_oauth_pending_states` TTL is 10min with no grace window
before prune.** **Verified:** `shared/src/lib/atproto-oauth.ts:61`
(`ttlMs = 10 * 60 * 1000`) + `feed-ingest/src/tasks/atproto-oauth-states-prune.ts`.
A callback that arrives exactly at `expires_at` may race the 5min
prune cron. Edge-casey but not impossible. **Fix:** make prune
condition `expires_at < now() - interval '30 seconds'`, or bump TTL
to 15min.

**81. Loopback dev redirect_uri hardcodes `127.0.0.1:3000`.**
**Verified:** `atproto-oauth.ts:116`. If the dev gateway runs on a
different port (e.g. `PORT=3010` override), OAuth loopback silently
fails with a redirect mismatch. **Fix:** `process.env.PORT ??
'3000'` — one line.

**82. `baseUrl` cast to `https://${string}` without enforcement.**
**Verified:** `atproto-oauth.ts:140-141`. The loopback branch accepts
any `http://localhost…` or `http://127.0.0.1…` URL; the prod branch
casts `baseUrl` to `https://${string}` without checking the scheme
actually starts with `https://`. An operator setting
`ATPROTO_CLIENT_BASE_URL=http://all.haus` (scheme typo) passes the
non-loopback gate and produces malformed client metadata. **Fix:**
`if (!baseUrl.startsWith('https://')) throw new Error(…)` before the
cast.

**83. `atprotoClientMetadata()` + `atprotoJwks()` are single-call
passthroughs.** **Verified:** `atproto-oauth.ts:164-170`. Both are
`getAtprotoClient().then((c) => c.clientMetadata | c.jwks)`. The
only callers are the two well-known route handlers in
`gateway/src/index.ts`. **Fix:** inline at call sites, delete the
helpers.

### `feed_items` content-preview consistency

**84. Publication CMS article edit bypasses `feed_items`.**
**Verified:** `gateway/src/routes/publications/cms.ts:159-163` — PATCH
builds a dynamic UPDATE over `articles` columns (`title`, `summary`,
`price_pence`, `show_on_writer_profile`) with no corresponding
`feed_items` write. `title` is denormalised into `feed_items.title`
at publish time (`routes/articles/publish.ts:102`), so a title
edit drifts immediately. Price edits matter too — paywalled-vs-free
badging reads from the denormalised row. Drift window is bounded by
`feed_items_reconcile` (daily 05:00) but that's a 24h visible skew.
**Fix:** add a `feed_items` UPDATE for the changed columns inside
the same transaction; title, summary, price all map cleanly.

**85. `feed_items_reconcile` inserts missing rows but never repairs
drifted previews.** **Verified:**
`feed-ingest/src/tasks/feed-items-reconcile.ts:22-99`. Three INSERT
blocks use `ON CONFLICT DO NOTHING`. If §84 produced a drifted
title/preview and the row already exists, reconcile leaves it alone.
**Fix:** add a fourth pass — UPDATE `feed_items` where the source
row's `updated_at > feed_items.updated_at`, recompute `content_preview`,
`title`, `author_name`. Safety net, daily cadence, not hot path.

**86. `.slice(0, 200)` (JS) and `LEFT(…, 200)` (SQL) truncate at
different boundaries for multibyte content.** **Verified:** seven
adapters/routes use `.slice(0, 200)`; the reconcile SQL uses
`LEFT(…, 200)`. `.slice` counts UTF-16 code units, `LEFT` counts
characters in pg's default encoding. Same content hits different
truncation points if ingested via one path vs reconciled via another.
No active data loss today but will produce visible preview drift for
emoji-heavy / CJK content. **Fix:** one shared
`truncatePreview(content: string): string` in `shared/src/lib/text.ts`,
grapheme-aware via `Intl.Segmenter`; use everywhere JS-side and
either mirror the rule in reconcile or call via a plpython/deno UDF
(probably overkill — just pick the JS rule as canonical and drop
reconcile's LEFT).

**87. Scheduler's personal-draft publish skips the `feed_items`
dual-write.** **Verified:** `gateway/src/workers/scheduler.ts:167-197`
upserts into `articles` and stops — no corresponding `feed_items`
INSERT. `routes/articles/publish.ts:96-136` and
`services/publication-publisher.ts:194-250` both dual-write; the
scheduler path inlines its own article INSERT and forgot the
partner write. Scheduled personal articles don't appear in the
unified timeline until the 05:00 reconcile cron — up to 24h of
invisibility for the writer's scheduled drop. **Fix:** mirror the
dual-write from `publish.ts` inside the scheduler transaction;
since scheduler reuses its own vault-creation dance, extract a
shared `insertArticleWithFeedItem(tx, …)` helper so the two paths
don't drift again.

---

## Round-3 rejected claims (held over from §64-§87 audit)

- **feed-ingest `a`-tag split out-of-bounds on kind-5 deletion.**
  `feed-ingest-nostr.ts:290-298` — `const [kindStr, aPubkey, dTag] =
aAddr.split(':')` followed by `kindStr ?? ''`, `!aPubkey`,
  `Number.isFinite(kind)`, and `dTag ?? ''` — all three destructured
  values are defensively handled. Not a bug.
- **RSS dual-write fails silently on feed_items error.** Both
  INSERTs wrap in `withTransaction`; a feed_items throw rolls back
  the external_items row too. `if (!rowCount) return false` at
  `feed-ingest-rss.ts:108` is the ON-CONFLICT-DO-NOTHING dedup
  exit, not an error-swallow.
- **ATProto OAuth concurrent-authorize state collision.** The
  library generates a cryptographically-random `state` per
  `authorize()` call (`@atproto/oauth-client-node` internals); the
  `INSERT … ON CONFLICT (key) DO UPDATE` in `DbStateStore.set` never
  sees a collision between concurrent flows for the same user.
- **AES-256-GCM "silent garbage on wrong key".** AEAD tag check
  catches wrong-key decrypt as an authentication failure, not a
  silent corruption. The versioned-blob ambiguity concern conflates
  GCM with CTR mode.
- **ts-prune would catch anything knip misses.** Both use the same
  AST mark-and-sweep; knip's `types` gate (promoted to default on
  2026-04-20 per §58 follow-up) covers the exact category ts-prune
  was added for. Item deleted from the §63 scope.

---

## Rejected / overstated claims (held over from both audits)

- **`/my/account-statement` has no web consumer** — _wrong_. Consumed by
  `web/src/components/account/AccountLedger.tsx:51`. The rename (§54) is
  still worth doing; the endpoint is live.
- **32 markdown files in repo root** — actual is 22. Still cluttered
  (§55), but the bigger number in the audit was wrong.
- **42 `as any` in gateway** — actual is 38 across 14 files. Substantive
  claim — 5 of them are in `traffology.ts` as auth shortcuts (§43) —
  holds.
- **`content_preview .slice(0, 200)` in one place, who-knows-what
  elsewhere** — flagged in the first audit as TODO-verify, never
  confirmed. Folded into §63.

---

## Attack order (one focused week)

**Day 1 — P0**
§7 `recordSubscriptionRead` wrap, §8 `await` the warning insert, §9
event_type migration, §10 platform fee read from config, §1 scheduler
ordering inversion, §2 webhook dedup `processed_at` column. Each
small, each as its own commit with a regression test.

**Day 2 — P0 Stripe orphans + verify-firsts**
§3 writer-payout row-first + stable key, §4 publication-split same.
§11 group-DM duplicate verify (5 minutes) → fix if confirmed.
§12 DM 402 decision (ship unblock endpoint or pull the 402 path).
§5 NIP-17 naming decision (rename vs implement).

**Day 3 — P1 mechanical**
§38-39 shared slugify/dTag, §40 move workers, §41 advisory locks const,
§42 env helper adoption, §43 traffology casts, §44 db/client shims,
§56 docker-compose header, §20 `rsa`/`rsa2` collapse, §6 `listInbox`
mute filter fix.

**Day 4 — P1 structural**
§13-18 resolver fixes (ordering, Nostr enrichment, completion signal,
dead param, well-known paths, search index), §45 transaction idiom
convergence, §46 build-for-prod Dockerfile, §19 DM send N+1 collapse.

**Day 5 — P1 feed-ingest + payments cleanup**
§22 kind-30023 naddr, §23 kind-0 race, §24-26 Nostr hygiene,
§27-28 AP cursor/cutoff, §31 Mastodon truncate, §29-30 Jetstream
DID-cap, §32-35 payment-service tightening.

**Day 6-7 — P2 deletions + refactors**
§47-51 dead code. §52 split api.ts. §54 rename files. §55 move
markdowns.

**Later**
§60 outbox. §63 round-3 audit.
