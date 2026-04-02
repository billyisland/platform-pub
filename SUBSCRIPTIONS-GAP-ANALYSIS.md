# Subscriptions Gap Analysis

Where the platform stands against the state of the art (Substack), what separates us from bare adequacy, and how to close those gaps.

---

## The landscape

Substack's subscription model is simple but complete: writers set a price, readers pay monthly or annually, and every post gets emailed to subscribers. Around that core loop they've built gift subscriptions, free trials, founding member tiers, referral programs, subscriber analytics, and a discovery network. It's polished. It works. And writers stay because moving is expensive.

We have a genuinely different value proposition — Nostr-based ownership, pay-per-read alongside subscriptions, permanent article unlocks, 8% fees instead of 10%, and real data portability. But our subscription implementation is too skeletal to let those advantages breathe. A writer comparing us to Substack today wouldn't see a different philosophy; they'd see missing features.

---

## What we have today

### Working

- **Single-price monthly subscriptions** — writers set £1–£100/mo, readers subscribe from the profile page
- **Subscription access control** — subscribers read all paywalled articles at zero marginal cost
- **Permanent unlocks** — articles read during a subscription stay unlocked after cancellation (genuinely good; Substack doesn't do this)
- **Cancel with grace period** — cancellation preserves access until period end
- **Writer subscriber list** — dashboard shows each subscriber with engagement metrics ("good value" vs "at risk")
- **Subscription events audit log** — charge, earning, and read events tracked in `subscription_events`
- **Account statement integration** — subscription charges and earnings appear in the unified statement
- **Nostr kind 7003 attestations** — subscriptions are verifiable on-chain
- **MRR summary card** — dashboard shows active subscriber revenue

### Broken or incomplete

- **`/api/v1/subscription-events` returns 404** — the frontend calls this endpoint in the credits tab but the route was never implemented. Fails silently.
- **No reader subscription management page** — `GET /subscriptions/mine` exists and works, but there's no UI anywhere for "show me all my active subscriptions."
- **No subscription price setting in settings page** — `PATCH /settings/subscription-price` works, but the settings page has zero subscription controls. Writers can only set their price by API call.
- **PaywallGate doesn't mention subscriptions** — when a non-subscriber hits a paywall, the gate says "No subscription / Pay per read / Cancel anytime." It never offers "subscribe to this writer for £X/mo to unlock everything." This is actively pushing readers toward per-read payment and away from subscriptions.
- **No auto-renewal** — subscriptions expire after 30 days and move to `expired`. Readers must manually resubscribe. The expiry job runs hourly but only expires; it never renews. This means every subscriber relationship dies silently after a month.

---

## What separates us from Substack (state of the art)

These are capabilities Substack has that we entirely lack, grouped by how much they matter.

### Critical (writers will reject the platform without these)

| Gap | Why it matters |
|---|---|
| **Auto-renewal** | Without it, subscriptions are one-month trials that silently expire. Writers can't build recurring revenue. This is the single most damaging gap. |
| **Email delivery of posts** | Substack's core insight: the inbox is the feed. Writers expect new posts to reach subscribers' email. Without this, subscribers must remember to visit the site. |
| **Annual pricing** | Monthly-only pricing costs writers ~20–30% of potential revenue. Annual plans reduce churn and increase LTV. Substack offers monthly and annual with a configurable discount. |
| **Subscribe prompt at the paywall** | Our paywall gate actively discourages subscriptions. When a reader hits a paywall, they should see "subscribe for £X/mo to read everything" alongside the per-read option. |
| **Subscription price in writer settings** | Writers need a UI to set and change their subscription price. Currently impossible without API calls. |

### Important (noticeably absent, compensatable short-term)

| Gap | Why it matters |
|---|---|
| **Free trials** | 7-day or 30-day trials let writers convert hesitant readers. Substack makes this a toggle. |
| **Gift subscriptions** | "Buy a subscription for someone" is a significant revenue channel, especially around holidays and for institutional gifting. |
| **Comp subscriptions** | Writers need to grant free subscriptions to collaborators, friends, press — without it showing up as a financial transaction. The free pass system exists but isn't wired to subscriptions. |
| **Welcome email** | Substack sends a configurable welcome email on subscribe. It's the writer's first direct contact with a paying reader and sets expectations. |
| **Subscriber import/export** | Writers switching from Substack need to bring their list. Writers leaving need to take it. Without import, onboarding is manual. Without export, we're doing the lock-in we claim to oppose. |
| **Reader subscription management** | Readers need a page listing all their active subscriptions in one place, with cancel/resubscribe controls. |
| **Subscriber growth analytics** | New subscribers, cancellations, net growth, churn rate over time. Writers run their publication like a business — they need these numbers. |
| **Custom subscribe landing page** | A dedicated, shareable URL (`/username/subscribe`) with the writer's pitch, pricing, and a prominent subscribe button. Currently, subscription is a small button on the profile page among other content. |

### Nice-to-have (competitive polish, not dealbreakers)

| Gap | Why it matters |
|---|---|
| **Founding member tier** | A higher optional price for readers who want to pay more. Substack's founding members pay 2–5x the base price. Simple to implement (just a second price point). |
| **Referral programme** | Subscribers earn free months by referring others. Growth loop. |
| **Discovery network** | Substack's recommendation engine surfaces writers to new readers. Hard to replicate at small scale but important at scale. |
| **Mobile app** | Substack's reader app drives engagement. Expensive to build but significant for retention. |
| **Podcast/audio RSS** | Subscriber-only podcast feeds. Growing segment of Substack usage. |
| **Group/team subscriptions** | Institutional pricing for companies buying seats. |
| **Multiple tiers** | More than one subscription tier per writer (e.g. "supporter" and "patron"). Substack supports this. |
| **Subscriber-only community** | Chat or discussion space exclusive to paying subscribers. |
| **Custom domains** | `writer.com` instead of `platform.pub/writer`. |

---

## What separates us from bare adequacy (the MVP)

Bare adequacy means: a writer could plausibly choose this platform over Substack because our other features (Nostr ownership, pay-per-read, data portability, permanent unlocks, lower fees) compensate for subscription gaps — but the subscription system itself must not be *broken*. It must work reliably even if it's not feature-rich.

### The MVP must fix these

1. **Auto-renewal** — subscriptions must renew automatically. This is non-negotiable for "works reliably." Without it, writers see subscribers vanish after 30 days for no reason.
2. **Subscribe prompt at the paywall** — the paywall gate must offer subscription alongside per-read. Not doing so is leaving money on the table for writers and confusing readers.
3. **Subscription price in settings** — writers need to set their price through the UI, not by API call.
4. **Reader subscription management page** — readers need to see and manage their subscriptions.
5. **Fix the broken subscription-events endpoint** — the dashboard calls it; it needs to exist.
6. **Cancellation/renewal email notifications** — at minimum: "your subscription renewed," "your subscription was cancelled," and "your subscription is expiring soon."

### The MVP should include these

7. **Annual pricing** — monthly + annual with writer-configurable discount. This is straightforward and materially affects writer revenue.
8. **Comp subscriptions** — writers grant free subscriptions. Reuse the existing free pass infrastructure.
9. **Welcome email on subscribe** — one email template. High impact, low cost.

---

## Implementation plan

The plan is structured in three phases. Phase 1 gets us to the MVP — a subscription system that works reliably and doesn't embarrass us when compared to Substack. Phase 2 closes the important gaps. Phase 3 adds competitive polish.

### Phase 1 — Make it work (MVP)

The goal is a subscription system that auto-renews, is properly surfaced in the UI, and gives writers basic control. All of this builds on existing infrastructure.

**Step 1: Auto-renewal**

The single highest-impact change. Currently `expireAndRenewSubscriptions()` in `gateway/src/routes/subscriptions.ts` only expires subscriptions. It needs to:

- Attempt renewal for active subscriptions at period end
- Deduct from the reader's tab (same mechanism as initial subscription)
- Roll `current_period_start` and `current_period_end` forward 30 days
- Log `subscription_charge` and `subscription_earning` events
- Handle failure gracefully (insufficient funds / no payment method → notify reader, retry once, then expire)
- Publish updated kind 7003 Nostr event

Schema changes: add `auto_renew BOOLEAN DEFAULT TRUE` to `subscriptions` table so readers can opt out. The cancel flow should set `auto_renew = false` rather than immediately changing status — the subscription stays active until period end, then expires instead of renewing.

**Step 2: Fix broken and missing UI**

- **Subscription price in settings** — add a price input to `web/src/app/settings/page.tsx` that calls `PATCH /settings/subscription-price`. Slider or input, £1–£100, with "your subscribers pay £X/mo" preview.
- **Reader subscription management** — new page at `/my/subscriptions` listing all active/cancelled subscriptions from `GET /subscriptions/mine`, with cancel buttons and renewal dates.
- **Fix `/api/v1/subscription-events`** — implement the gateway route that the dashboard already calls. Return paginated subscription events for the authenticated user, filtered by role (writer/reader).
- **Subscribe option in PaywallGate** — when a non-subscriber hits the gate, show the writer's subscription price alongside the per-read price. "Read this article for £X, or subscribe to [writer] for £Y/mo to read everything." Link to the writer's profile or a subscribe action.

**Step 3: Basic subscription emails**

- **Renewal confirmation** — "Your subscription to [writer] renewed. £X has been added to your reading tab."
- **Cancellation confirmation** — "You've cancelled your subscription to [writer]. You'll have access until [date]."
- **Expiry warning** — sent 3 days before period end for non-auto-renewing subscriptions. "Your subscription to [writer] expires on [date]. Resubscribe to keep reading."
- **New subscriber notification to writer** — email (not just in-app notification) when someone subscribes.

Use the existing email infrastructure (`shared/src/lib/email.ts`), adding subscription-specific templates alongside the existing magic link template.

**Step 4: Annual pricing**

- Schema: add `subscription_period` column to `subscriptions` (`monthly` | `annual`) and `annual_discount_pct` to `accounts` (default 15%, writer-configurable 0–30%).
- API: extend `POST /subscriptions/:writerId` to accept `period: 'monthly' | 'annual'`; calculate annual price as `monthlyPrice * 12 * (1 - discount)`.
- UI: show both prices on the profile subscribe button and at the paywall gate. "£5/mo or £51/year (save 15%)."
- Renewal: annual subscriptions renew at 365-day intervals.

**Step 5: Comp subscriptions**

- New route: `POST /subscriptions/:readerId/comp` (writer grants free subscription to a reader)
- Creates a subscription with `price_pence = 0` and a `is_comp BOOLEAN` flag
- No charge, no tab deduction
- Surfaces in the writer's subscriber list as "Comp"
- Writers manage comps from the dashboard subscriber table (grant/revoke)

---

### Phase 2 — Close the important gaps

With the MVP shipped, these features close the gaps that noticeably separate us from Substack.

**Step 6: Free trials**

- Writer-configurable trial period (7 or 30 days, off by default)
- Trial creates a subscription with `is_trial = true`, zero initial charge
- At trial end, auto-converts to paid if `auto_renew` is true; otherwise expires
- Trial status visible to writer in subscriber list
- One trial per reader-writer pair (prevent abuse)

**Step 7: Gift subscriptions**

- New route: `POST /subscriptions/:writerId/gift` with `recipientId` or `recipientEmail`
- Purchaser pays; recipient gets the subscription
- If recipient doesn't have an account, create an invitation with a pending gift
- Gift subscriptions flagged in subscriber list as "Gift from [username]"
- Simple gift flow: "Gift this subscription" button on writer profile

**Step 8: Welcome email**

- Writer-configurable welcome message (plain text, stored in `accounts.subscription_welcome_message`)
- Sent automatically on subscribe
- Default template if writer hasn't customised
- Preview in settings

**Step 9: Subscriber import/export**

- **Export**: CSV download of subscriber list (email, username, status, started date, price). Available from dashboard.
- **Import**: CSV upload for writers migrating from Substack. Creates invitation emails to imported addresses. Doesn't create subscriptions — readers must still actively subscribe, but get a "you've been invited" email with a one-click subscribe link.
- This is important for the Nostr ownership story: your audience is portable.

**Step 10: Subscriber analytics**

- New dashboard section or dedicated `/dashboard?tab=analytics` tab
- Metrics: subscriber count over time, new subscribers per period, cancellations per period, net growth, churn rate, MRR trend, average subscription duration
- Data source: `subscriptions` and `subscription_events` tables already have everything needed
- Simple line charts (subscriber count, MRR) and summary cards (churn rate, average LTV)

**Step 11: Custom subscribe page**

- Route: `/[username]/subscribe`
- Pulls writer's bio, article count, subscriber count, pricing
- Large subscribe button, pricing comparison (monthly vs annual)
- Shareable URL writers can promote externally
- Writer can add a custom pitch paragraph (stored in `accounts.subscribe_pitch`)

---

### Phase 3 — Competitive polish

These features are differentiators at scale, not prerequisites for launching. Build them as the platform grows and as writer demand becomes clear.

**Step 12: Founding member tier**

- Writer sets a "founding member" price (2x–5x base price)
- Founding members get a badge on their profile and in comments
- Simple implementation: second price option in subscribe flow, `is_founding_member` flag on subscription
- Writers see founding member revenue separately in analytics

**Step 13: Referral programme**

- Subscribers get a unique referral link
- Successful referral (new paid subscriber) earns the referrer a free month
- Track referrals in a `subscription_referrals` table
- Show referral stats to subscribers on their subscription management page

**Step 14: Multiple tiers**

- Replace single `subscription_price_pence` with a `subscription_tiers` table
- Each tier has a name, price, and description
- Writers configure tiers in settings
- Different tiers could gate different content (requires `access_tier` on articles)
- Significant complexity — only build when single-tier proves insufficient

**Step 15: Subscriber-only posts**

- New article `access_mode`: `subscribers_only` (distinct from `paywalled`)
- Subscriber-only posts show in feed with a badge but can't be read without subscription
- No per-read purchase option — subscribe or don't
- Useful for community updates, behind-the-scenes content, Q&A

---

## Recommendation

Go straight to the MVP (Phase 1). It's five steps, all building on existing infrastructure, and none require new external services or architectural changes. The auto-renewal gap alone is severe enough that the subscription system is effectively broken without it — subscribers silently vanish after 30 days, which means writers can't build recurring revenue, which means they have no reason to choose this platform for subscriptions.

Phase 2 should follow immediately. Free trials, gift subscriptions, and subscriber analytics are the features that make a writer's decision to stay. Without them, writers will experiment with the platform but default back to Substack for their subscription business.

Phase 3 can wait for product-market fit and scale. These features matter when you have thousands of writers competing for readers. They don't matter when you're trying to convince the first hundred writers to try something new.

The honest assessment: the subscription system today is a working prototype that demonstrates the concept but isn't suitable for a writer who depends on subscription revenue. The MVP fixes that. The full Phase 2 makes it competitive. And the Nostr ownership story, pay-per-read option, permanent unlocks, and lower fees give writers genuine reasons to choose this platform over Substack — but only if the subscription foundation is solid enough that they don't have to think about it.
