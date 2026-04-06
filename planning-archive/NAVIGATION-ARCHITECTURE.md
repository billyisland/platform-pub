# Platform — Navigation Architecture

A first-principles rethink of how Platform's UI is organised, consolidating the DESIGN.md redesign direction with the 29 unbuilt endpoints from FRONTEND-GAPS.md into a single coherent information architecture.

---

## The problem, stated plainly

The current codebase has 9 top-level sidebar items (Feed, Write, Profile, Notifications, Following, Followers, Dashboard, About, Search), a dashboard with 5 tabs, a separate settings page, and 29 backend endpoints with zero frontend. DESIGN.md proposes collapsing to 4 top-bar items + a dropdown. But it was written before the gaps audit. If we blindly follow DESIGN.md's nav spec and then bolt on DMs, pledge drives, free passes, subscriptions management, tab overview, and data export later, we'll end up with a cluttered dropdown or a sprawling dashboard. We need to solve for the full scope now.

Platform serves three distinct user modes, and they don't all need the same things at the same time:

1. **Reader** — browses the feed, reads articles, pays via tab, follows writers
2. **Writer** — publishes articles, manages earnings, runs pledge drives, grants free passes
3. **Social participant** — posts notes, replies, quotes, sends DMs

The navigation must serve all three without overwhelming any one of them.

---

## Design principles

These follow directly from the DESIGN.md positioning ("minimal and discreet enough that writers can project their own identities into its empty spaces"):

1. **Four things in the top bar, not more.** The horizontal bar has ~600px of usable space at desktop. Four mono-caps links + search + avatar is the limit. Five starts to feel like a toolbar.

2. **Progressive disclosure by role.** A pure reader who has never published should not see "Dashboard" or "Write" given equal prominence to "Feed". But we can't hide them entirely — discovery matters. Solution: role-aware ordering and subtle visual weight, not show/hide.

3. **Everything a writer needs lives in one place.** Dashboard is the writer's control room. It already has tabs. Adding more tabs is cheaper (cognitively and spatially) than adding more pages.

4. **One account, one ledger.** Platform has a single financial account per user. Money flows in (article earnings, funded drives) and money flows out (reading charges, pledges, subscriptions). The settlement engine already nets these. Splitting the view of that account across different pages actively misrepresents how the system works. All money lives in one place: `/account`.

5. **DMs get their own surface, not a tab.** Messaging is a mode, not a settings panel. It needs its own page with a conversation list and a thread view. But it doesn't need a top-level nav slot — it lives behind the notification/messages indicator.

6. **The avatar dropdown is the "me" menu.** Everything personal — profile, settings, following, followers, notifications, DMs, subscriptions, data export — is accessed from the avatar. This is a well-understood pattern (GitHub, Twitter, Substack all do it).

7. **Admin is a separate world.** The moderation dashboard is not for regular users. It's a different layout, a different permission level. It gets its own `/admin` route tree, not a tab in the regular dashboard.

---

## Proposed information architecture

### Top bar (platform mode, logged in)

```
[Platform]   FEED   WRITE   DASHBOARD   ABOUT   [____search____]   [avatar ▾]
```

Four primary destinations. Search input. Avatar with dropdown. Same as DESIGN.md proposed.

**Key change from DESIGN.md:** WRITE is always visible, even for pure readers. Clicking it either opens the editor (if writer) or shows a gentle "become a writer" prompt with Stripe Connect onboarding. This is an acquisition funnel, not a locked door.

### Top bar (platform mode, logged out)

```
[Platform]   FEED   ABOUT   [____search____]   LOG IN   [Sign up]
```

Two destinations. Auth actions replace the avatar.

### Top bar (canvas mode — article reader, writer profiles)

```
[Platform]   ← FEED                                              [avatar]
```

Minimal. Back link. Avatar (no dropdown indicator — it's there if you need it, quiet if you don't).

### Avatar dropdown menu

This is the "me" menu. Organised into three groups with subtle dividers:

```
┌─────────────────────────────┐
│  Sarah Chen                 │
│  @sarahchen                 │
│  ─────────────────────────  │
│  Profile                    │
│  Messages         (3)       │
│  Notifications    (2)       │
│  ─────────────────────────  │
│  Account          £4.20     │
│  Reading history            │
│  ─────────────────────────  │
│  Settings                   │
│  Export my data             │
│  Log out                    │
└─────────────────────────────┘
```

**Group 1: Identity** — who I am, who's talking to me.
- Profile → `/profile` (edit display name, bio, avatar)
- Messages → `/messages` (DM inbox — **new**)
- Notifications → `/notifications` (full page, works on all breakpoints)

**Group 2: Money and content** — my relationship with the platform's economy.
- Account → `/account` (**new** — unified ledger: earnings, reading charges, subscriptions, pledges, settlement status, free allowance, payment method)
- Reading history → `/history` (existing page — about content, not money)

**Group 3: Meta** — configuration and exit.
- Settings → `/settings` (account details, display preferences)
- Export my data → triggers download modal (**new** — calls `/account/export` and `/receipts/export`)
- Log out

**Why this structure:**
- "Following" and "Followers" are removed from the menu. They're accessible from the profile page (which already shows your public profile and should have following/followers counts as links). They are not navigation destinations — they're profile metadata.
- Notifications gets a badge count. Messages gets a badge count. These are the two "someone wants your attention" items.
- Account replaces the previous split of "My subscriptions", "Tab & balance", and the dashboard's Earnings/Accounts tabs. Every financial relationship — whether you're earning or spending — is visible in one ledger. The balance shown in the dropdown (£4.20) is the net position.
- Reading history stays separate because it's about content, not money. You'd browse it to find an article you read last week, not to check what you spent.

### Dashboard (writer's control room)

The dashboard is purely about managing what you publish and how you publish it. Financial data lives in `/account`.

```
ARTICLES   DRAFTS   DRIVES   SETTINGS
```

**Articles tab** — existing. Published articles list, view counts, earnings per piece. **New addition:** each article row gets a "⋯" menu with "Manage free passes" (opens inline panel showing existing grants, with "Grant access" form — calls `/articles/:id/free-pass` endpoints).

**Drafts tab** — existing. Local drafts list with resume/delete.

**Drives tab** — **entirely new**. The pledge drive / commission management surface.
- "New drive" button → creation form (crowdfund vs commission, target amount, description)
- Active drives list with progress bars
- Completed/cancelled drives
- Incoming commission requests with accept/decline actions

**Settings tab** — writer-specific settings:
- Subscription price (calls `PATCH /settings/subscription-price` — **new**)
- Stripe Connect status and re-onboarding link
- DM pricing / anti-spam settings (**new** — when endpoints exist)
- Comment defaults (enable/disable comments on new articles)

A prominent "View account →" link sits at the top of the Dashboard (or in the sidebar of the Articles tab) so writers can quickly jump to their financial ledger. But the Dashboard itself doesn't duplicate that data — it's about operations, not accounting.

**Why "Drives" and not a separate page:** Pledge drives are a writer tool. They exist in the same mental context as articles — "things I'm doing to get paid for my work". A writer checking their articles will naturally want to check their active drives. Collocating them reduces navigation jumps.

**Why writer settings are in the dashboard, not in `/settings`:** The `/settings` page (accessed from avatar dropdown) handles account-level concerns that apply to everyone. Writer-specific configuration (subscription pricing, DM pricing, Stripe Connect) is about the writing business, which lives in the dashboard.

### Messages (`/messages`) — new page

Two-panel layout (conversation list + active thread), collapsing to single-panel on mobile:

```
┌─────────────────┬──────────────────────────────┐
│ Conversations    │ Sarah Chen                    │
│                  │                               │
│ ● Sarah Chen  2m│ Hey, loved your piece on…     │
│   Tom Reed   1d │                               │
│   Mia Lopez  3d │ Thanks! I've been thinking…   │
│                  │                               │
│                  │ [________________________]    │
│                  │              [Send]           │
└─────────────────┴──────────────────────────────┘
```

- Conversation list with unread indicators
- Thread view with paginated message history
- New conversation via "New message" button (user search)
- Add members to existing conversations
- Mark-read on view (auto-calls `/messages/:id/read`)
- If writer has DM pricing set, show price before sending (402 handling)

This is the only feature that warrants a full new page. DMs are a communication mode, not a settings panel or a list to glance at. The notification bell's "sent you a message" items now link to `/messages/:conversationId`.

### Account (`/account`) — new page

The single source of truth for all money on Platform. Accessible from the avatar dropdown (all users) and linked from the Dashboard (writers).

```
YOUR ACCOUNT

┌─────────────────────────────────────────────────────┐
│  Net balance: +£12.40                               │
│  (settles when threshold reached)                   │
│                                                     │
│  Free allowance remaining: £3.40 of £5.00           │
│  ████████████████░░░░░░                              │
└─────────────────────────────────────────────────────┘

[ALL]  [INCOME]  [SPENDING]

─────────────────────────────────────────────────────
Today                                         +£0.30
  Reader read "The Architecture of Solitude"
─────────────────────────────────────────────────────
Today                                         −£0.20
  You read "Notes on Fermentation" by Tom Reed
─────────────────────────────────────────────────────
Yesterday                                     −£3.00
  Monthly subscription: Sarah Chen
─────────────────────────────────────────────────────
3 Apr                                        +£14.00
  Pledge drive funded: "Essays on Light"
─────────────────────────────────────────────────────
1 Apr                                        −£18.50
  Settlement — paid to your Stripe account
─────────────────────────────────────────────────────

SUBSCRIPTIONS
Sarah Chen         @sarahchen         £3/mo    [Cancel]
Tom Reed           @tomreed           £5/mo    [Cancel]

PLEDGES
Essays on Light    by Mia Lopez       £5.00    funded ✓

PAYMENT & PAYOUTS
Card: •••• 4242                       [Update]
Stripe Connect: Verified              [Manage]
```

**What it contains:**
- Net position at the top — positive (owed to you) or negative (you owe the platform)
- Free allowance meter (the first thing a new reader cares about)
- Unified chronological ledger: reading charges, article earnings, subscription income and outgoings, pledge commitments, drive payouts, settlements — all in one stream
- Filters: All / Income / Spending
- Active subscriptions section with cancel controls (absorbs the standalone `/subscriptions` page from v1)
- Active pledges section (drives you've backed — this is where a pure reader who backed a drive finds it, without needing to visit the Dashboard)
- Payment method and Stripe Connect status (moved from `/settings` — these are financial plumbing, they belong with the money)

**What it doesn't contain:**
- Analytics, trends, comparisons, graphs — that's a future Dashboard tab ("Insights" or "Analytics") for writers who want to understand their publishing business
- Reading history — that's about content discovery, not money, and stays at `/history`

**Why this replaces the previous split:** The earlier architecture had earnings in a Dashboard tab, reading charges in `/tab`, and subscriptions in `/subscriptions`. That's three views of one account, scattered across three locations. A writer who also reads (which is everyone) would have to visit two or three pages to understand their financial position. The unified ledger reflects how the system actually works: one account, credits and debits netting continuously, settling when the threshold is met.

### Admin (`/admin`) — separate route tree

Only accessible to admin users. Not in the regular nav at all. Admin users see a small "Admin" link in their avatar dropdown.

```
/admin
/admin/reports
/admin/reports/:id
/admin/users/:id
```

- Report queue with filters (pending, resolved, all)
- Report detail with content preview, reporter info, actions (remove content, suspend account, dismiss)
- User detail with suspension controls

---

## Notification routing

With DMs and drives now having frontend surfaces, notification types can route correctly:

| Notification type | Current destination | New destination |
|---|---|---|
| `new_follower` | `/:username` | `/:username` (unchanged) |
| `new_subscriber` | `/:username` | `/:username` (unchanged) |
| `new_reply` | `/article/:slug#reply-:id` | unchanged |
| `new_quote` | `/article/:slug` | unchanged |
| `new_mention` | `/article/:slug` | unchanged |
| `commission_request` | `#` (broken) | `/dashboard?tab=drives` |
| `drive_funded` | `#` (broken) | `/dashboard?tab=drives` |
| `pledge_fulfilled` | `#` (broken) | `/dashboard?tab=drives` |
| `new_message` | `#` (broken) | `/messages/:conversationId` |
| `free_pass_granted` | `#` (broken) | `/article/:slug` |

---

## Route map (complete)

### Existing routes (kept)

| Route | Register | Description |
|---|---|---|
| `/` | platform | Homepage (logged out) → redirects to `/feed` (logged in) |
| `/feed` | platform | Feed with For You / Following tabs |
| `/write` | platform | Article editor |
| `/dashboard` | platform | Writer control room (articles, drafts, earnings, drives, settings) |
| `/about` | platform | About page |
| `/auth` | platform | Login / signup |
| `/search` | platform | Search results |
| `/profile` | platform | Edit my profile |
| `/notifications` | platform | Full notification list |
| `/history` | platform | Reading history |
| `/settings` | platform | Account settings (display preferences, account details) |
| `/article/:slug` | canvas | Article reader |
| `/:username` | canvas | Public writer profile |

### Existing routes (removed as standalone pages)

| Route | Absorbed into |
|---|---|
| `/following` | Profile page (tab or expandable section) |
| `/followers` | Profile page (tab or expandable section) |

### New routes

| Route | Register | Description |
|---|---|---|
| `/messages` | platform | DM inbox and conversations |
| `/messages/:conversationId` | platform | DM thread |
| `/account` | platform | Unified financial ledger (earnings, charges, subscriptions, pledges, payment method) |
| `/admin` | platform (admin only) | Moderation dashboard |
| `/admin/reports` | platform (admin only) | Report queue |

---

## Mobile navigation

The hamburger opens a sheet (as DESIGN.md specifies). The sheet content mirrors the desktop top bar + avatar dropdown, stacked vertically:

```
FEED
WRITE
DASHBOARD
ABOUT
──────────
Search [___________]
──────────
Messages          (3)
Notifications     (2)
──────────
Profile
Account
Reading history
Settings
──────────
Log out
```

On mobile, Messages and Notifications are promoted above the divider because they have urgency (badge counts). Account shows the net balance inline. Everything else stays in order.

---

## What this achieves

**From 9 top-level items to 4.** The sidebar's Feed, Write, Profile, Notifications, Following, Followers, Dashboard, About, Search becomes: Feed, Write, Dashboard, About in the top bar. Search is an input field. Everything else is in the avatar dropdown or absorbed into existing pages.

**29 orphan endpoints get homes:**

| Feature area | Endpoints | Where it lives |
|---|---|---|
| Direct Messages (6) | `/messages` page | New page, avatar dropdown |
| Pledge Drives (11) | Dashboard → Drives tab | New dashboard tab |
| Free Passes (3) | Dashboard → Articles tab (per-article menu) | Inline in existing tab |
| Admin/Moderation (3) | `/admin` route tree | Separate admin UI |
| Subscription Price (1) | Dashboard → Settings tab | New field in existing tab |
| My Subscriptions (1) | `/account` page → Subscriptions section | Part of unified Account |
| Receipt Export (2) | Avatar dropdown → "Export my data" | Modal/download action |
| Account Export (1) | Avatar dropdown → "Export my data" | Modal/download action |
| Reader Tab (1) | `/account` page → Balance & ledger | Part of unified Account |
| DM Pricing (0+schema) | Dashboard → Settings tab | New field when endpoint exists |

**No feature is more than 2 clicks from the top bar.** The deepest path is: avatar → export my data → confirm download. Everything else is 1 click (top bar items) or 2 clicks (avatar dropdown → page).

**The two registers (platform/canvas) are preserved.** New pages are all platform-register. The canvas register (article reader, writer profiles) remains untouched — quiet, minimal, writer-first.

---

## Migration from current codebase

### Files to create
- `src/hooks/useLayoutMode.ts` — returns `'platform' | 'canvas'` based on pathname
- `src/components/layout/LayoutShell.tsx` — wraps children, applies register styles
- `src/components/layout/AvatarDropdown.tsx` — the "me" menu
- `src/app/messages/page.tsx` — DM inbox
- `src/app/messages/[conversationId]/page.tsx` — DM thread
- `src/app/account/page.tsx` — unified financial ledger
- `src/app/admin/page.tsx` — admin dashboard
- `src/app/admin/reports/page.tsx` — report queue
- `src/components/messages/ConversationList.tsx`
- `src/components/messages/MessageThread.tsx`
- `src/components/account/AccountLedger.tsx` — filterable transaction list
- `src/components/account/SubscriptionsSection.tsx` — active subscriptions with cancel
- `src/components/account/PledgesSection.tsx` — drives backed
- `src/components/account/PaymentSection.tsx` — card and Stripe Connect management
- `src/components/dashboard/DrivesTab.tsx` — pledge drive management
- `src/components/dashboard/FreePassManager.tsx` — per-article free pass panel
- `src/components/ExportModal.tsx` — data export confirmation and download

### Files to significantly modify
- `src/components/layout/Nav.tsx` — complete rewrite (sidebar → top bar)
- `src/app/layout.tsx` — remove sidebar offset, add LayoutShell
- `src/app/dashboard/page.tsx` — remove Credits/Accounts tabs, add Drives tab, refactor Settings tab, add Account link
- `src/app/settings/page.tsx` — move payment method and Stripe Connect to `/account`, keep account details and display prefs
- `src/components/ui/NotificationBell.tsx` — move into avatar dropdown, add message badge
- `src/app/profile/page.tsx` — add following/followers sections

### Files to remove (or redirect)
- `src/app/following/page.tsx` — functionality moves to profile page
- `src/app/followers/page.tsx` — functionality moves to profile page

### Routing changes in NotificationBell
- `commission_request` → `/dashboard?tab=drives`
- `drive_funded` → `/dashboard?tab=drives`
- `pledge_fulfilled` → `/dashboard?tab=drives`
- `new_message` → `/messages/${n.conversationId}`
- `free_pass_granted` → `/article/${n.article.slug}`

---

## Open questions

1. **Should the notification bell remain a separate dropdown, or fold into the avatar dropdown?** DESIGN.md doesn't show a separate bell. Recommendation: fold it in. The avatar dropdown shows "Notifications (3)" with the count. Clicking opens `/notifications`. No separate popover — that was a sidebar-era pattern. The badge count on the avatar itself (a small dot) signals unread activity.

2. **DM pricing configuration — endpoint doesn't exist yet.** The schema exists and the send-message flow enforces it (returns 402). An endpoint is needed: `PATCH /settings/dm-pricing` or similar. This should be added to the gateway before building the dashboard settings UI for it. For now, the UI can show the field as "coming soon" or omit it entirely.

3. **Following/Followers on the profile page — tabs or expandable sections?** Recommendation: two small counts ("142 following · 89 followers") that link to inline expandable lists on the same page. Not tabs — the profile page's primary purpose is editing your profile, and tabs would demote that.

4. **Account page: where does payment method configuration live?** Currently in `/settings`. Recommendation: move card setup and Stripe Connect status into the Account page's "Payment & payouts" section, since they're financial plumbing. `/settings` then becomes a lighter page focused on display name, username, and any future non-financial preferences. This is a clean separation: Account = money, Settings = identity and preferences.

5. **Account page: future analytics.** When writer analytics arrives (earnings trends, reader demographics, article performance), it should be a Dashboard tab — not part of the Account page. The Account page is a receipt book. The Dashboard is where you interpret and act on data. The ledger provides the raw transactions; analytics provides the insight. These are different tools even though they draw from the same data.
