# Settings Rationalisation Spec

Platform currently has six overlapping surfaces for user configuration. This spec replaces them with four clearly scoped hubs, eliminates two standalone pages (`/settings` and `/history`), and gives every function exactly one home.

---

## Organising principle

Every user-facing configuration surface answers one question:

| Hub | Question | Audience |
|---|---|---|
| **Profile** | "Who am I here?" | Everyone |
| **Account** | "What have I spent?" | Everyone |
| **Social** | "How do I experience others?" | Everyone |
| **Pricing** | "What do I charge?" | Writers only |

Profile is base camp — your identity and the financial plumbing that connects you to the platform. Account is your financial activity log. Social is your control panel for the environment around you. Pricing is the writer's rate card. If a function doesn't answer one of these four questions, it's a standalone page (Dashboard, Following, Messages, Notifications).

---

## Hub 1: Profile — "Who am I here?"

Route: `/profile`

Everything you'd set up on your first day, and the place you'd return to if you wanted to take stock of your whole presence. Identity, financial infrastructure, data export.

### Contents

**Identity**
- Display name (editable)
- Bio (editable)
- Avatar upload/remove (editable)
- Username (read-only)
- Public key (read-only)

**Financial plumbing**
- Payment card (add/view/update via Stripe Elements)
- Stripe Connect onboarding for writers ("Connect your bank account")
- Stripe Connect verification status

**Data portability**
- Export my data (button → modal)

### Design notes

- Card and Stripe live here because they're infrastructure — you set them up once, like filling in your bio. They're not ongoing financial activity (that's Account).
- Export lives here because it's "give me everything about me" — conceptually adjacent to the identity section.
- The Stripe Connect section only appears for writers (or users upgrading to writer status).

### Migration

- Profile page already has identity fields. Add: public key row (from `/settings`), payment card section (from `/settings` and `/account` PaymentSection), Stripe Connect section (from `/settings`), export button (from `/settings`).
- Organise as three visual groups: Identity, Payment, Data.

---

## Hub 2: Account — "What have I spent?"

Route: `/account`

Your financial activity log. What you've read, what it cost, what you're committed to. No configuration — just visibility and management of ongoing financial relationships.

### Contents

**Summary**
- Net balance header (earnings minus reading costs)
- Free allowance remaining / total

**Ledger**
- Unified chronological list of all reads (paid and free)
- Paid reads show amount; free reads show "Free" or £0.00
- Default filter: "Paid only" (so the ledger looks clean and financial)
- Toggle/filter: "All reads" (includes free reads — replaces the old `/history` page)

**Ongoing commitments**
- Active subscriptions (view, cancel, toggle visibility)
- Pledges (view status, amounts)

### Design notes

- Reading history is absorbed into the ledger as a filter state rather than a separate page. Every read is a transaction — free reads are just transactions at zero cost.
- The "Paid only" default keeps the ledger financially meaningful for light users. "All reads" is available for anyone who wants the full chronological record.
- The balance header, ledger, subscriptions, and pledges tell one coherent story about the user's relationship with the platform as a reader.

### Migration

- Account page already has BalanceHeader, AccountLedger, SubscriptionsSection, PledgesSection.
- Remove PaymentSection from Account (moves to Profile).
- Extend AccountLedger to include free reads with a filter toggle.
- Delete `/history` route — redirect to `/account` (or `/account?filter=all` to preserve deep links).

---

## Hub 3: Social — "How do I experience others?"

Route: `/social` (new page)

Your control panel for the social environment. Everything here is about managing how other users' content and behaviour reaches you.

### Contents

**Feed**
- Feed reach dial (Following / Following+ / Extended / Explore)
- Persists selection across sessions

**Boundaries**
- Blocked accounts (list, unblock)
- Muted accounts (list, unmute)

**DM access**
- DM fee setting (set a price for DMs from non-followers)
- Framed as a spam/griefer gate, not a revenue feature

### Design notes

- The feed dial also appears inline on the `/feed` page itself for quick switching. The Social hub is where you go to understand and configure it; the feed page is where you use it in context.
- Blocks and mutes currently have no dedicated UI — they're applied via buttons on profiles but there's no central list view. This hub is where those lists live.
- DM fees sit here rather than in Pricing because the primary purpose is controlling the inbox experience, not generating revenue. The copy should reflect this ("Discourage unwanted messages" rather than "Earn from DMs").
- Reporting is contextual (triggered from content via report buttons) and doesn't need a home in this hub. A future "My reports" status view could live here.

### Migration

- New page: `web/src/app/social/page.tsx`.
- Feed dial: new component, also rendered on `/feed` page.
- Blocks/mutes: new list components querying existing `blocks` and `mutes` tables.
- DM fee: move from `/dashboard?tab=settings` (currently a placeholder).

---

## Hub 4: Pricing — "What do I charge?"

Route: `/dashboard?tab=pricing` (tab within Dashboard)

The writer's rate card. Everything here is a commercial decision about what readers pay for your content.

### Contents

- Monthly subscription price
- Annual discount percentage
- Default article price (new — optional per-writer default for paywalled articles)
- Stripe Connect verification status (read-only, informational)

### Design notes

- This is the existing Dashboard "Settings" tab, renamed to "Pricing" and with the DM pricing placeholder removed (moved to Social).
- Stripe Connect status stays here as a read-only indicator because writers need to see their payout eligibility in the same place they set prices. This is not duplication — Profile has the onboarding/setup flow, Pricing has the verification badge.
- The tab bar becomes: **Articles · Drafts · Pledge drives · Pricing**

### Migration

- Rename `DashboardTab` value `'settings'` → `'pricing'`.
- Rename `WriterSettingsTab` component → `PricingTab`.
- Remove DM pricing placeholder (moves to Social hub).
- Add `?tab=settings` → `?tab=pricing` redirect for existing bookmarks/deep-links.
- Update tab label rendering.

---

## Eliminated pages

| Route | Disposition |
|---|---|
| `/settings` | **Deleted.** Contents distributed to Profile (identity, payment card, Stripe Connect, export) |
| `/history` | **Deleted.** Reading history absorbed into Account ledger with "All reads" filter. Redirect `/history` → `/account` |

---

## Standalone pages (unchanged)

These don't belong to any hub — they're activity streams, workspaces, or social graph views.

| Route | Name | Contents |
|---|---|---|
| `/feed` | Feed | Content feed (with inline reach dial for quick switching) |
| `/dashboard` | Dashboard | Articles, drafts, pledge drives, pricing tab |
| `/following` | Following | Following + followers lists (public, mirrored on writer profiles) |
| `/messages` | Messages | DM conversations |
| `/notifications` | Notifications | Activity stream |

---

## Navigation changes

### Desktop avatar dropdown

```
Profile
Messages
Notifications
───────────────
Account          £X.XX
Social
───────────────
Export my data
Admin (if admin)
Log out
```

Changes from current:
- "Settings" link removed
- "Reading history" link removed (absorbed into Account)
- "Social" link added

### Mobile sheet

```
Feed
Write
Dashboard
Following
───────────────
Messages
Notifications
───────────────
Profile
Account
Social
Export my data
───────────────
Log out
```

Changes from current:
- "Settings" link removed
- "Reading history" link removed
- "Social" link added

### Dashboard tab bar

```
Before:  Articles   Drafts   Pledge drives   Settings
After:   Articles   Drafts   Pledge drives   Pricing
```

---

## File changes summary

| File | Action |
|---|---|
| `web/src/app/settings/page.tsx` | **Delete** |
| `web/src/app/history/page.tsx` | **Delete** (or redirect to `/account`) |
| `web/src/app/social/page.tsx` | **Create** — new Social hub |
| `web/src/app/profile/page.tsx` | Add: public key row, payment card section, Stripe Connect section, export button |
| `web/src/app/account/page.tsx` | Remove PaymentSection import. Extend ledger with free reads + filter toggle |
| `web/src/components/account/AccountLedger.tsx` | Add free reads, add paid/all filter |
| `web/src/components/account/PaymentSection.tsx` | **Move** to profile (or refactor into profile-scoped component) |
| `web/src/app/dashboard/page.tsx` | Rename tab `'settings'` → `'pricing'`, rename component, add redirect fallback, remove DM pricing |
| `web/src/components/layout/Nav.tsx` | Remove "Settings" and "Reading history" links, add "Social" link in both dropdown and mobile sheet |
| `web/src/components/social/FeedDial.tsx` | **Create** — feed reach selector, used in both `/social` and `/feed` |
| `web/src/components/social/BlockList.tsx` | **Create** — list/unblock UI |
| `web/src/components/social/MuteList.tsx` | **Create** — list/unmute UI |
| `web/src/components/social/DmFeeSettings.tsx` | **Create** — DM fee configuration |

---

## Final state

| Surface | Question | Contents |
|---|---|---|
| `/profile` | Who am I here? | Name, bio, avatar, username, pubkey, card, Stripe, export |
| `/account` | What have I spent? | Balance, ledger (all reads), subscriptions, pledges |
| `/social` | How do I experience others? | Feed dial, blocks, mutes, DM fees |
| `/dashboard?tab=pricing` | What do I charge? | Sub price, annual discount, default article price |
| `/feed` | What am I reading? | Content feed with inline reach dial |
| `/dashboard` | What have I written? | Articles, drafts, pledge drives |
| `/following` | Who do I follow? | Following + followers |
| `/messages` | Who's talking to me? | DM conversations |
| `/notifications` | What's happened? | Activity stream |

Nine surfaces. Nine distinct questions. Zero overlap.
