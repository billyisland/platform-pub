# UI Design Spec — Unbuilt Features

Design specification for all unbuilt UI features listed in `feature-debt.md`, consistent with all.haus's established design philosophy. Each feature describes where it lives, how it looks, how it behaves, and what states it has.

Last updated: 2026-04-13. Batch 1 completed in v5.29.0. Batch 2 completed in v5.30.0.

---

## Design principles (reference)

These are observed from the existing codebase, not invented here. Every design below follows them.

1. **Editorial minimalism.** Black (#111), white, five greys, crimson accent. Sharp corners everywhere — no border-radius. Decoration is the enemy.
2. **Three-voice typography.** Mono 11px caps for infrastructure (labels, nav, metadata). Serif (Literata) for content and headlines. Sans (Jost) for interactive UI.
3. **Flat card hierarchy.** White cards (`bg-white px-6 py-5`) on the default page background. Cards never nest. Sections within a page are separated by `space-y-10` or explicit black rules.
4. **Inline feedback.** No toasts. Success = `text-grey-600 text-ui-xs` near the action. Error = `text-red-600`. Messages auto-clear or persist until the next action.
5. **Two confirmation patterns.** Simple destructive actions use `confirm()`. Actions involving money, irreversibility beyond a single record, or multi-step consequences use a custom modal (fixed overlay, `bg-black/40 backdrop-blur-sm`, white card, cancel/confirm button pair).
6. **Actions as text links.** Secondary actions (Cancel, Remove, Unpin) are `text-[13px] font-sans text-grey-300 hover:text-black`. Primary actions use the `.btn` class.
7. **Settings as stacked sections.** White cards in `space-y-10`, each with a `label-ui text-grey-400` header and optional `text-ui-xs text-grey-600` description.
8. **Dashboard uses tab pills.** `tab-pill` mono-caps, active = black bg/white text, inactive = grey-100/grey-600. Tab state synced to `?tab=` URL param.
9. **Empty states.** Centered `py-20`, `text-ui-sm text-grey-400`, with an underlined action link below.
10. **Loading.** `animate-pulse bg-white` blocks matching the shape of the expected content.

Container widths: `max-w-article` (640px) for single-column pages, `max-w-content` (960px) for dashboards and account pages, `max-w-feed` (780px) for feed-like lists.

---

## Part 1 — Backend exists, no UI

These endpoints are wired and tested. Each section describes the frontend needed to surface them.

---

### 1.1 Unpublish personal article

**Where:** Dashboard > Articles tab, per-row action.

**Current state:** Each published article row has Edit and Delete actions. Delete destroys the article. There is no way to revert a published article to draft.

**Design:**

Add an "Unpublish" text link in the action cluster, between Edit and Delete:

```
Edit   Unpublish   Delete
```

All three are `text-[13px] text-grey-300 hover:text-black`, separated by `gap-3`.

**Interaction:** Click "Unpublish" > browser `confirm('Revert this article to draft? It will be removed from your public profile but not deleted.')` > on confirm, call endpoint, update row status to "draft" in local state.

**After unpublish:** The article disappears from the Articles tab (which shows published articles) and reappears in the Drafts tab. If the user is currently viewing Articles, show a brief inline message: `"Moved to drafts."` in `text-ui-xs text-grey-600`, below the row that just vanished, auto-clearing after 3 seconds.

---

### 1.2 Reading history page

**Where:** New page at `/reading-history`. Linked from Account page (below the ledger) and from the avatar dropdown menu.

**Layout:** `max-w-feed` container, same structure as the feed page but without the composer or reach toggle.

**Header:**

```
Reading history                    (serif 2xl, font-light, tracking-tight)
```

**Content:** Chronological list (newest first) of previously-read articles. Each item is a simplified article card:

```
┌─────────────────────────────────────────────┐
│ WRITER NAME · 14 MAR                  mono  │
│ Article Title Here                    serif  │
│ First 120 chars of standfirst...      sans   │
└─────────────────────────────────────────────┘
```

Cards are `bg-white px-6 py-4`, separated by 2px `border-grey-200` (not spaced — this is a continuous list). No vote controls, no share button. The card is a plain link to the article.

**States:**
- Loading: Three `h-16 animate-pulse bg-white` blocks.
- Empty: Centered `py-20`, "Nothing read yet." in grey-400, with a link: "Browse the feed" → `/feed`.
- Pagination: Infinite scroll using the same pattern as the feed (intersection observer, load more on scroll).

**Avatar dropdown entry:** Add "Reading history" between existing menu items, using the same `block px-4 py-2 text-[14px] text-black hover:bg-grey-100` style.

---

### 1.3 Subscriber list for writers

**Where:** Dashboard, new tab: "Subscribers". Personal dashboard tabs become:

```
ARTICLES   DRAFTS   SUBSCRIBERS   DRIVES   OFFERS   PRICING
```

This tab only appears if `user.isWriter` is true.

**Layout:** Same pattern as MembersTab — a `bg-white` table with `label-ui` column headers.

**Table columns:**

```
SUBSCRIBER      SINCE         PLAN        STATUS      AMOUNT
Jane Writer     12 Jan 2026   Monthly     Active      £5.00/mo
John Reader     3 Dec 2025    Annual      Active      £48.00/yr
Alex Someone    8 Nov 2025    Monthly     Cancelled   Access until 8 Dec
```

- Subscriber: display name as link to profile, with square avatar (h-8 w-8) inline.
- Since: `toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })`.
- Plan: "Monthly" or "Annual" in grey-400.
- Status: "Active" in black, "Cancelled" in grey-300.
- Amount: tabular-nums, right-aligned.

**Summary header:** Above the table, a stats row:

```
┌─────────────────────────────────────────────────────┐
│  142                £710.00              3           │
│  ACTIVE             MONTHLY REVENUE     NEW THIS    │
│  SUBSCRIBERS        (EST.)              MONTH       │
│                                                     │
│  (serif 2xl)        (serif 2xl)         (serif 2xl) │
│  (label-ui below)   (label-ui below)    (label-ui)  │
└─────────────────────────────────────────────────────┘
```

Three stat blocks in a `flex` row, each `flex-1 text-center`. Value in `font-serif text-2xl text-black`, label in `label-ui text-grey-400 mt-1`.

**Empty state:** "No subscribers yet." with a link: "Set up subscription pricing" → `?tab=pricing`.

---

### 1.4 Delete / archive publication

**Where:** Dashboard > Publication context > Settings tab, below the existing save form.

**Design:** A new section separated from the settings form by a 4px black rule (`h-[4px] bg-black my-10`), establishing visual severity.

```
DANGER ZONE                                          label-ui text-crimson

Archive this publication
Archiving hides it from readers but preserves all content, members, and
subscriber records. You can restore it later.               text-ui-xs grey-600

  [ Archive publication ]                                   btn-soft

────────────────────────────────────────── (border-grey-200 my-6)

Delete this publication permanently
This cannot be undone. All articles will be detached and returned to their
authors as personal drafts. Subscribers will be cancelled and refunded for
any remaining prepaid period.                               text-ui-xs grey-600

  [ Delete publication ]                                    btn, bg-crimson text
```

**Archive flow:** `confirm()` dialog — "Archive [Name]? It will be hidden from all readers." On confirm, call `DELETE /publications/:id`, which archives (not hard-deletes). Update dashboard to remove the publication from the context switcher, or show it greyed with an "Archived" badge.

**Delete flow:** Custom modal (not `confirm()`), because this is irreversible and affects multiple parties.

Modal content:

```
┌────────────────────────────────────────────────┐
│                                                │
│  Delete [Publication Name]?            serif   │
│                                                │
│  This publication has:                 sans    │
│  · 23 published articles                      │
│  · 4 members                                  │
│  · 89 active subscribers                      │
│                                                │
│  Articles will be returned to their authors    │
│  as personal drafts. Active subscribers will   │
│  be cancelled.                                 │
│                                                │
│  Type the publication name to confirm:         │
│  ┌──────────────────────────────────┐          │
│  │                                  │  input   │
│  └──────────────────────────────────┘          │
│                                                │
│  [ Cancel ]              [ Delete forever ]    │
│   btn-soft                btn-accent (crimson) │
│                           disabled until match │
└────────────────────────────────────────────────┘
```

The "Delete forever" button remains `disabled:opacity-50` until the typed text matches the publication name exactly. This is the only place in the UI that uses a type-to-confirm pattern — the severity warrants it.

---

### 1.5 Transfer publication ownership

**Where:** Dashboard > Publication context > Settings tab, inside the danger zone (below archive, above delete).

**Design:**

```
Transfer ownership
Hand this publication to another member. You will become an editor.
Only members with the editor-in-chief role are eligible.    text-ui-xs grey-600

  [ Transfer ownership ]                                    btn-soft
```

Button disabled with `opacity-50` and tooltip "No eligible members" if no editor-in-chief exists.

**Flow:** Click opens a modal:

```
┌────────────────────────────────────────────────┐
│                                                │
│  Transfer ownership of                 serif   │
│  [Publication Name]                            │
│                                                │
│  Select the new owner:                 sans    │
│                                                │
│  ○ Jane Writer (Editor-in-Chief)               │
│  ○ Alex Editor (Editor-in-Chief)               │
│                                                │
│  You will become an editor. This cannot        │
│  be undone without the new owner's help.       │
│                                        grey-600│
│                                                │
│  [ Cancel ]              [ Transfer ]          │
│   btn-soft                btn-accent           │
│                           disabled until pick  │
└────────────────────────────────────────────────┘
```

Radio options: `flex items-center gap-3 px-4 py-3 bg-grey-100 mb-2`. Selected = `bg-black text-white`. Same toggle button pattern as FeedDial and PricingTab.

After transfer: redirect to personal dashboard with inline message "Ownership transferred."

---

### 1.6 Edit publication member role

**Where:** Dashboard > Publication context > Members tab, per-row action.

**Current state:** MembersTab shows Name, Role, Title, Share (bps), and a "Remove" action for non-owners.

**Design:** Add a "Change role" text link before "Remove" in the actions column:

```
Change role   Remove
```

Both `text-grey-300 hover:text-black text-[13px]`.

**Flow:** Click "Change role" > inline dropdown replaces the role cell:

```
┌──────────────────────────────────────────────────────────────┐
│ Jane Writer   [Contributor ▾]   Sub-editor   2500   Save  × │
└──────────────────────────────────────────────────────────────┘
```

The role cell becomes a `<select>` (same `bg-grey-100 px-3 py-1.5 text-sm` style as the invite form). "Save" is a `text-[13px] text-black font-medium`. "×" cancels and restores the static display. This is inline editing — no modal needed for a single-field change.

---

### 1.7 Accept / decline commission

**Where:** Notification centre (when a commission arrives) and Dashboard > Drives tab (for pending commissions).

**Current state:** Commission drives created from DM threads land in notifications, but the target writer has no way to respond.

**Design — notification row:** Commission notifications already render in the notification list. Add two inline buttons to the notification body:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔵 Jane Writer commissioned "Portrait of a City" · £50.00  │
│    [ Accept ]  [ Decline ]                                  │
│     btn-sm      text-[13px] text-grey-300 hover:text-black  │
└─────────────────────────────────────────────────────────────┘
```

"Accept" uses `btn text-sm` (small primary button). "Decline" is a text link.

**Decline flow:** Click > `confirm('Decline this commission? The reader will be notified.')` > call `POST /drives/:id/decline`.

**Accept flow:** Click > call `POST /drives/:id/accept`. Notification updates to show "Accepted" in grey-400. The drive now appears in the writer's Drives tab as an active drive with its own DriveCard.

**Design — Drives tab:** Pending commissions (status = "pending_acceptance") appear in a new section above active drives:

```
PENDING COMMISSIONS                              label-ui text-grey-400

┌─────────────────────────────────────────────────────────────┐
│ COMMISSION                                          £50.00  │
│ Portrait of a City                            serif medium  │
│ From: Jane Writer · Requested 12 Apr                        │
│                                                             │
│ [ Accept ]   Decline                                        │
└─────────────────────────────────────────────────────────────┘
```

Same card structure as DriveCard. Accept/Decline follow the same interaction as the notification version.

---

### ~~1.8 Pin drive to profile~~ (ALREADY DONE)

Already implemented before this spec was written. `DriveCard.tsx` has a "Pin to profile" / "Unpin" toggle and a "Pinned" badge. The API client method exists.

---

### 1.9 Edit existing drive

**Where:** Dashboard > Drives tab > DriveCard actions.

**Current state:** DriveCard has Pin and Cancel actions. No edit capability.

**Design:** Add "Edit" as a third text link in the DriveCard action row:

```
Edit   Pin to profile   Cancel
```

`text-[13px] text-grey-300 hover:text-black`.

**Flow:** Click "Edit" > The DriveCard expands in-place to reveal the edit form (same fields as DriveCreateForm: title, description, funding target). The form replaces the card content, with Save and Cancel buttons at the bottom.

**Constraints shown in UI:** If the drive has existing pledges:
- Title: editable.
- Description: editable.
- Funding target: editable, but show `text-ui-xs text-grey-400` note below: "Target cannot be set below current pledged amount (£X.XX)."
- Validation: if new target < currentTotalPence, show `text-red-600` error and disable save.

**After save:** Form collapses back to the static DriveCard display. Brief "Updated." message in `text-ui-xs text-grey-600`.

---

### 1.10 Admin direct suspend

**Where:** Admin area (currently only has the reports page). Add a user lookup section.

This is an admin tool, so it should be functional rather than polished. Follow the existing admin page's patterns.

**Design:** Admin page gets a second section (or tab, if the admin page grows further):

```
SUSPEND ACCOUNT                                  label-ui text-grey-400

Search by username or email:
┌──────────────────────────────────┐
│                                  │  bg-grey-100 input
└──────────────────────────────────┘

(search results appear below as a short list)

┌─────────────────────────────────────────────────────────────┐
│ Jane Writer · jane@example.com · Active                     │
│                                                  [ Suspend ]│
└─────────────────────────────────────────────────────────────┘
```

**Flow:** Click "Suspend" > `confirm('Suspend this account? They will be logged out immediately.')` > call endpoint. Row updates to show "Suspended" status, button changes to "Unsuspend" (if that endpoint exists).

---

## Part 2 — New features (no backend or frontend)

These require migrations, routes, and components.

---

### 2.1 Bookmarks / save for later

**Components needed:** BookmarkButton, `/bookmarks` page.

#### BookmarkButton

Appears on: article cards in the feed, article pages (in the action bar alongside vote/share).

**Design:** A simple outline bookmark icon, same position and scale as ShareButton.

```
▲ 12 ▼    ◇ Bookmark    Share
```

- Default: `text-grey-300 hover:text-black`, outline bookmark glyph.
- Bookmarked: `text-black`, filled bookmark glyph.
- Click toggles state immediately (optimistic update), calls `POST/DELETE /bookmarks/:articleId`.
- No confirmation needed — this is a low-stakes, easily reversible action.

On article cards, the bookmark icon sits in the action row (`flex items-center gap-4`), after vote controls and before share. Label is hidden on cards (icon only with `sr-only` text). On the full article page, it can include the "Bookmark" text label.

#### /bookmarks page

**Where:** Linked from avatar dropdown menu ("Bookmarks") and from the navigation bar as an optional addition if the user has bookmarks.

**Layout:** `max-w-feed` container.

**Header:** `font-serif text-2xl font-light tracking-tight mb-10` — "Bookmarks".

**Content:** List of bookmarked articles, most recently bookmarked first. Each item is a standard ArticleCard (the same component used in the feed), with full vote controls, share, and the bookmark button (now filled, since everything here is bookmarked).

Unbookmarking from this page removes the card from the list with no confirmation. The card fades or simply disappears from the list on next render.

**Empty state:** "No bookmarks yet." with link "Browse the feed" → `/feed`.

---

### 2.2 Hashtags / topics / tags

**Components needed:** TagInput (editor), TagDisplay (cards/articles), `/tag/:tag` browse page.

#### TagInput (editor)

**Where:** Article editor, below the standfirst field, above the body.

**Design:** A row of tag pills with an inline text input:

```
┌─────────────────────────────────────────────────────────────┐
│  nostr ×    writing ×    bitcoin ×    [ Add tag...       ]  │
└─────────────────────────────────────────────────────────────┘
```

Container: `bg-grey-100 px-3 py-2 flex flex-wrap items-center gap-2`.

Each tag pill: `bg-white px-2 py-0.5 font-mono text-[12px] uppercase tracking-[0.06em] text-black flex items-center gap-1`. The × is `text-grey-300 hover:text-black cursor-pointer`.

The input field: no background (transparent over grey-100), no border, `font-mono text-[12px] uppercase tracking-[0.06em]`, placeholder "Add tag...". Submits on Enter or comma.

**Autocomplete dropdown:** As the user types, matching existing tags appear below in a dropdown:

```
┌──────────────────────┐
│ NOSTR          (142) │
│ NOSTR-DEV       (23) │
│ NOSTRICH         (8) │
└──────────────────────┘
```

`bg-white border border-grey-200 shadow-sm`, items are `px-3 py-2 text-[12px] font-mono uppercase tracking-[0.06em] hover:bg-grey-100`. Count in `text-grey-300` right-aligned.

**Constraints:** Maximum 5 tags. After 5, the input disappears and is replaced by `text-ui-xs text-grey-300` note "5 tags maximum". Tags are normalised to lowercase, hyphens allowed, no spaces.

#### TagDisplay

**On article cards:** Tags appear below the standfirst, before the action row:

```
NOSTR  ·  WRITING  ·  BITCOIN
```

`font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300`. Tags are links (`hover:text-black`) to `/tag/:tag`. Separated by `·` with `mx-1.5`.

**On article pages:** Same style, positioned below the byline/date metadata.

#### /tag/:tag browse page

**Layout:** `max-w-feed` container.

**Header:**

```
#NOSTR                                    font-mono text-2xl uppercase
142 articles                              label-ui text-grey-400 mt-1
```

**Content:** Feed of articles tagged with this tag, sorted by recency. Uses the same ArticleCard component as the main feed. Infinite scroll.

**Empty state:** "#[TAG] — No articles yet." (This would only appear if all tagged articles were deleted.)

---

### 2.3 Reposts / reshares

**Components needed:** RepostButton, feed integration.

#### RepostButton

Appears on: article cards in the feed, alongside vote controls and bookmark/share.

**Design:** A repost glyph (↻ or similar simple rotation icon), same scale as other action icons.

```
▲ 12 ▼    ↻ 3    ◇    Share
```

- Default: `text-grey-300 hover:text-black`, with repost count next to it in `text-[13px] font-mono tabular-nums`.
- Reposted by current user: `text-crimson` icon, count in `text-crimson`.
- Click toggles. First repost: immediate. Un-repost: immediate. No confirmation — same stakes as a bookmark.

Count of 0 shows no number (just the icon). Count >= 1 shows the number.

#### Feed integration

When an article appears in the feed because someone reposted it, it shows a "reposted by" line above the article card:

```
↻ REPOSTED BY JANE WRITER                 font-mono text-[11px] text-grey-300
                                           uppercase tracking-[0.06em]
┌─────────────────────────────────────┐
│ (normal article card)               │
└─────────────────────────────────────┘
```

The "reposted by" line is a link to the reposter's profile, `hover:text-black`. The article card itself is unchanged. If multiple people reposted, show only the most recent: "Reposted by Jane Writer" (not "and 3 others" — keep it clean).

---

### 2.4 Email-on-publish (settings toggle)

Covered in `EMAIL-ON-PUBLISH-SPEC.md`. The UI surface is:

**Writer side:** Dashboard > Pricing tab (or a future "Distribution" section). Toggle: "Email subscribers when you publish." Default on for new writers. Uses the same toggle-button pattern as FeedDial (two buttons: On / Off, `bg-black text-white` for active, `bg-grey-100` for inactive).

**Reader side:** Per-subscription toggle already exists in SubscriptionsSection — the "Notify" / "Muted" button (`text-[13px] text-grey-300 hover:text-black`). This controls whether a reader receives email from that writer. No additional UI needed on the reader side.

---

### 2.5 Subscription Phase 2 items

#### Free trials

**Where:** Dashboard > Pricing tab, below the subscription price selector.

**Design:** New section within the pricing card:

```
FREE TRIAL                                       label-ui text-grey-400

Offer new subscribers a free trial before billing begins.
                                                 text-ui-xs text-grey-600

  [ Off ]  [ 7 days ]  [ 30 days ]
    active    inactive    inactive
```

Three-button toggle group, same pattern as the monthly/annual pricing selector. Active = `bg-black text-white`, inactive = `bg-grey-100 text-black hover:bg-grey-200/60`. Each button `px-4 py-3 text-left w-full` (stacked vertically on mobile, horizontal on desktop).

When a trial is active, the subscribe button elsewhere in the platform changes from "Subscribe — £5/mo" to "Start free trial — then £5/mo".

#### Gift subscriptions

**Where:** Writer profile page, alongside the existing Subscribe button.

**Design:** A "Gift" link next to or below the subscribe button:

```
[ Subscribe — £5/mo ]
  Gift a subscription                    text-[13px] text-grey-300 underline
```

**Flow:** Click > modal:

```
┌────────────────────────────────────────────────┐
│                                                │
│  Gift a subscription to               serif    │
│  [Writer Name]                                 │
│                                                │
│  RECIPIENT                             label   │
│  ┌──────────────────────────────────┐          │
│  │ email@example.com                │  input   │
│  └──────────────────────────────────┘          │
│                                                │
│  MESSAGE (OPTIONAL)                    label   │
│  ┌──────────────────────────────────┐          │
│  │                                  │  text    │
│  │                                  │  area    │
│  └──────────────────────────────────┘          │
│                                                │
│  £5.00/mo · Monthly subscription               │
│                                 text-ui-xs     │
│                                                │
│  [ Cancel ]              [ Gift — £5.00 ]      │
│   btn-soft                btn-accent           │
└────────────────────────────────────────────────┘
```

After purchase: modal shows "Gift sent! [Recipient] will receive an email." with a "Done" button.

#### Welcome email

**Where:** Dashboard > Pricing tab, below the free trial section.

**Design:**

```
WELCOME EMAIL                                    label-ui text-grey-400

Send an automatic email when someone subscribes.
                                                 text-ui-xs text-grey-600

  [ Off ]   [ On ]
    active    inactive

(When "On" is selected, a textarea appears below:)

MESSAGE                                          label-ui text-grey-400
┌──────────────────────────────────────────────────────┐
│ Thanks for subscribing! Here's what to expect...     │
│                                                      │
└──────────────────────────────────────────────────────┘
                                    bg-grey-100 textarea, 6 rows

  [ Save ]                                              btn text-sm
```

#### Subscriber import/export

**Where:** Dashboard > Subscribers tab, top-right action area.

**Design:** Two text links in the header:

```
SUBSCRIBERS                               Import   Export
                                          text-[13px] grey-300
```

**Export:** Click > downloads a CSV immediately. No modal. File name: `subscribers-YYYY-MM-DD.csv`.

**Import:** Click > modal:

```
┌────────────────────────────────────────────────┐
│                                                │
│  Import subscribers                    serif   │
│                                                │
│  Upload a CSV with columns: email, plan        │
│  (monthly/annual). Matching accounts will      │
│  receive complimentary subscriptions.          │
│                                 text-ui-xs     │
│                                                │
│  ┌──────────────────────────────────┐          │
│  │  Drop CSV here or click to       │          │
│  │  browse                          │          │
│  └──────────────────────────────────┘          │
│   bg-grey-100, dashed border-grey-300          │
│                                                │
│  [ Cancel ]              [ Import ]            │
│   btn-soft                btn, disabled until  │
│                           file selected        │
└────────────────────────────────────────────────┘
```

After import: modal shows summary — "47 subscribers imported, 3 emails not found (skipped)." with a "Done" button.

#### Subscriber analytics

**Where:** Dashboard > Subscribers tab, between the summary header and the subscriber table.

**Design:** Three mini charts in a `flex` row, each in its own white card:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ GROWTH       │  │ CHURN        │  │ MRR          │
│ +12 this mo  │  │ 2.1%         │  │ £710         │
│ ┈┈┈╱╲╱───── │  │ ───╲╱──┈┈┈  │  │ ╱╱╱╱╱╱╱──── │
└──────────────┘  └──────────────┘  └──────────────┘
```

Each card: `bg-white px-4 py-4 flex-1`. Label in `label-ui text-grey-400`. Value in `font-serif text-xl text-black`. Chart is a minimal sparkline — a simple `<svg>` with a single `<polyline>` in grey-300, 30px tall, showing the last 12 data points. No axes, no grid, no interactivity. The sparkline is a glanceable trend indicator, not an analytics tool.

#### Custom subscribe landing page

**Route:** `/:username/subscribe`.

**Layout:** `max-w-article` container, centered.

**Design:**

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌────┐                                                     │
│  │    │  Writer avatar (h-16 w-16)                          │
│  └────┘                                                     │
│                                                             │
│  Subscribe to Jane Writer                     serif 2xl     │
│                                                             │
│  Monthly essays on technology, culture, and    sans, grey-600│
│  the future of independent publishing.        (from bio)    │
│                                                             │
│  ┌───────────────────────────────────────────┐              │
│  │  £5 / month                               │   option     │
│  └───────────────────────────────────────────┘              │
│  ┌───────────────────────────────────────────┐              │
│  │  £48 / year  (save 20%)                   │   option     │
│  └───────────────────────────────────────────┘              │
│                                                             │
│  [ Subscribe ]                                 btn-accent   │
│                                                             │
│  What you get:                         label-ui text-grey-400│
│  · Full access to all paywalled articles                    │
│  · Email notifications on new posts                         │
│  · Support independent writing                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Plan options use the same toggle-button pattern: `px-4 py-3`, active = `bg-black text-white border-2 border-black`, inactive = `bg-white border-2 border-grey-200 hover:border-grey-300`.

If the viewer is already subscribed: show "You're subscribed" with current plan details and a "Manage subscription" link to `/account`.

If the viewer is not logged in: "Subscribe" button links to `/auth?mode=login&redirect=/:username/subscribe`.

---

## Part 3 — Missing table-stakes UI

Features any user would reasonably expect.

---

### 3.1 Account deletion / deactivation

**Where:** `/account` page, new section at the bottom, below subscriptions and pledges.

**Design:** Separated from the rest of the page by a 4px black rule.

```
CLOSE YOUR ACCOUNT                               label-ui text-crimson

────────────────────────────────────────── (4px black rule above)

Deactivate
Your profile and content will be hidden. You can reactivate by
logging back in.                                 text-ui-xs grey-600

  [ Deactivate account ]                                 btn-soft

────────────────────────────────────────── (border-grey-200)

Delete permanently
Your content will be removed and your account data erased.
This cannot be undone.                           text-ui-xs grey-600

  [ Delete account ]                                     btn, crimson bg
```

**Deactivate flow:** `confirm()` — "Deactivate your account? Your content will be hidden until you log back in."

**Delete flow:** Custom modal (irreversible, affects data across the system):

```
┌────────────────────────────────────────────────┐
│                                                │
│  Delete your account?                  serif   │
│                                                │
│  This will:                            sans    │
│  · Cancel all active subscriptions             │
│  · Settle your reading tab                     │
│  · Remove all published articles               │
│  · Publish Nostr deletion events               │
│                                                │
│  Any outstanding earnings will be paid out     │
│  to your connected Stripe account.             │
│                                                │
│  Enter your email to confirm:                  │
│  ┌──────────────────────────────────┐          │
│  │                                  │  input   │
│  └──────────────────────────────────┘          │
│                                                │
│  [ Cancel ]              [ Delete my account ] │
│   btn-soft                btn-accent (crimson) │
│                           disabled until match │
└────────────────────────────────────────────────┘
```

Type-to-confirm with email address (same severity pattern as publication delete).

---

### 3.2 Change email address

**Where:** `/account` page, new section or inline with existing account info display.

**Current state:** Email is displayed but not editable.

**Design:** Show current email with a "Change" text link:

```
EMAIL                                            label-ui text-grey-400
you@example.com                          Change
                                         text-[13px] grey-300 hover:black
```

**Flow:** Click "Change" > the email text is replaced by an input + Save/Cancel:

```
EMAIL                                            label-ui text-grey-400
┌──────────────────────────────────┐
│ new@example.com                  │  bg-grey-100 input
└──────────────────────────────────┘
  Save   Cancel                          text-[13px], Save = font-medium
```

On "Save": call endpoint > show `text-ui-xs text-grey-600`: "Verification email sent to new@example.com. Check your inbox." The display reverts to showing the original email until verification is complete.

Verification is handled by a magic link to the new email (same auth pattern the platform already uses). Once clicked, the email updates everywhere.

---

### 3.3 Change username

**Where:** `/profile` page. Currently the username field is read-only.

**Design:** Username field gets a "Change" text link (same pattern as email above):

```
USERNAME                                         label-ui text-grey-400
@janedoe                                 Change
                                         text-[13px] grey-300 hover:black
```

**Flow:** Click "Change" > input field appears:

```
USERNAME                                         label-ui text-grey-400
┌──────────────────────────────────┐
│ newusername                      │  bg-grey-100 input
└──────────────────────────────────┘
Checking availability...             text-ui-xs text-grey-400 (while typing)
✓ Available                          text-ui-xs text-black (if available)
✗ Already taken                      text-ui-xs text-red-600 (if taken)

  Save   Cancel

Requests to your old URL will redirect for 90 days.
                                         text-ui-xs text-grey-400
```

Debounced availability check on keystroke (300ms). Input validation: lowercase, alphanumeric + hyphens, 3–30 chars.

**Cooldown:** If the user changed their username recently (within 30 days), show `text-ui-xs text-grey-400`: "You can change your username again on [date]." and hide the "Change" link.

---

### 3.4 Publication logo / avatar upload

**Where:** Dashboard > Publication context > Settings tab, above the name field.

**Design:** Same pattern as profile avatar upload on `/profile`:

```
LOGO                                             label-ui text-grey-400

┌────────┐
│        │  Click or drag to upload               text-ui-xs text-grey-400
│  LOGO  │  Recommended: 256×256px, square.
│        │
└────────┘

(If logo exists: show the image, with "Remove" text link below)
```

The upload zone: `h-24 w-24 bg-grey-100 flex items-center justify-center cursor-pointer`. On hover: `bg-grey-200/60`. Clicking opens a file picker (accept: image/*). Drag-and-drop supported via standard `onDragOver`/`onDrop`.

After upload: the image replaces the grey square immediately (optimistic). A hidden `<input type="file" ref={fileRef}>` is triggered by click on the zone (same pattern as `/profile`).

---

### 3.5 Publication layout template picker

**Where:** Dashboard > Publication context > Settings tab, below the about field, above the danger zone.

**Design:**

```
HOMEPAGE LAYOUT                                  label-ui text-grey-400

Choose how your publication homepage is arranged.
                                                 text-ui-xs text-grey-600

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│                 │  │  ┌─┐ ┌─┐ ┌─┐   │  │                 │
│  ───────        │  │  │ │ │ │ │ │   │  │  ──── ──── ──── │
│  ───────        │  │  │ │ │ │ │ │   │  │                 │
│  ───────        │  │  └─┘ └─┘ └─┘   │  │  ──── ──── ──── │
│                 │  │                 │  │                 │
│  Blog           │  │  Magazine       │  │  Minimal        │
│  (active)       │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

Three cards in a `grid grid-cols-3 gap-4` (stacks to `grid-cols-1` on mobile).

Each card: `px-4 py-5 text-center cursor-pointer border-2 transition-colors`.
- Active: `border-black bg-white`.
- Inactive: `border-grey-200 bg-white hover:border-grey-300`.

The illustration area: a `h-20 mb-3` zone with a simplified wireframe drawn using thin grey-300 lines (divs or SVG). Below it: the template name in `font-sans text-[14px] text-black`.

Selection is immediate — clicking a template saves it without a separate save button. Brief "Layout updated." message in `text-ui-xs text-grey-600`.

---

### 3.6 Leave publication

**Where:** Dashboard > Publication context > Members tab, visible to non-owner members.

**Design:** A text link at the bottom of the members list, outside the table:

```
Leave this publication                   text-[13px] text-grey-300 hover:text-black
                                         mt-4, below the table
```

This link only appears for members who are not the owner.

**Flow:** `confirm('Leave [Publication Name]? Your articles will remain in the publication but you will lose editorial access.')` > on confirm, call endpoint, redirect to personal dashboard with message "You left [Name]."

---

### 3.7 Notification preferences

**Where:** `/social` page, new section between "Feed reach" and "Block list".

**Design:** A white card following the standard settings-section pattern:

```
NOTIFICATION PREFERENCES                         label-ui text-grey-400

Choose which events generate notifications.
                                                 text-ui-xs text-grey-600

┌─────────────────────────────────────────────────────────────┐
│ New followers                                    [ On/Off ] │
│ Replies to your articles                         [ On/Off ] │
│ Mentions                                         [ On/Off ] │
│ Quotes of your work                              [ On/Off ] │
│ Commission requests                              [ On/Off ] │
│ Publication events                               [ On/Off ] │
│ Subscription activity                            [ On/Off ] │
└─────────────────────────────────────────────────────────────┘
```

Each row: `flex items-center justify-between px-4 py-3 border-b border-grey-200/50 last:border-b-0`.

Left side: `text-[14px] font-sans text-black`.

Right side: A two-state toggle. Two small buttons side by side:

```
[ On ] [ Off ]
```

Active state follows the FeedDial pattern: active button = `bg-black text-white px-2.5 py-1 text-[12px] font-mono uppercase tracking-[0.06em]`, inactive = `bg-grey-100 text-grey-400 px-2.5 py-1 text-[12px] font-mono uppercase tracking-[0.06em] hover:text-black`.

Each toggle saves immediately on click (no save button). Use optimistic updates.

---

### 3.8 Publication follow button on pub pages

**Where:** Publication homepage masthead.

**Current state:** Publication homepages render the name, tagline, and member list, but no follow button. Only writer follows are surfaced.

**Design:** Add a "Follow" button in the masthead area, below the tagline:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  THE DAILY DISPATCH                      serif 2xl         │
│  Independent journalism, reimagined      sans, grey-600    │
│                                                             │
│  [ Follow ]                              btn text-sm       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**States:**
- Not following: `btn text-sm` — "Follow"
- Following: `btn-soft text-sm` — "Following" (grey bg, grey-600 text)
- Hover while following: text changes to "Unfollow", `text-crimson`
- Loading: "..." (same pattern as subscription toggles)

If the viewer is the publication owner: hide the follow button (you don't follow your own publication).

If the viewer is not logged in: "Follow" links to `/auth?mode=login&redirect=...`.

---

### 3.9 Note deletion from profile

**Where:** Writer profile > Activity tab > Notes section.

**Current state:** Notes are displayed but cannot be deleted from the UI.

**Design:** Each note card gets a "Delete" text link in its footer:

```
┌─────────────────────────────────────────────────────────────┐
│ Note content here...                                        │
│                                                             │
│ 14 MAR · 2 REPLIES                              Delete     │
│ (mono 11px grey-300)                   text-[13px] grey-300 │
└─────────────────────────────────────────────────────────────┘
```

**Flow:** Two-step inline confirmation (same pattern as existing NoteCard delete):
1. Click "Delete" > text changes to "Confirm?" in `text-crimson`.
2. Click "Confirm?" within 3 seconds > delete. After 3 seconds, reverts to "Delete".

This matches the existing `confirmDelete` + timeout pattern used elsewhere.

---

### 3.10 Session management

**Where:** `/account` page, new section between the ledger and subscriptions.

**Design:**

```
ACTIVE SESSIONS                                  label-ui text-grey-400

┌─────────────────────────────────────────────────────────────┐
│ Chrome on macOS                                 This device │
│ Last active: now                                            │
├─────────────────────────────────────────────────────────────┤
│ Safari on iOS                                      Revoke  │
│ Last active: 2 hours ago                                    │
├─────────────────────────────────────────────────────────────┤
│ Firefox on Linux                                   Revoke  │
│ Last active: 3 days ago                                     │
└─────────────────────────────────────────────────────────────┘

Revoke all other sessions                text-[13px] text-grey-300 mt-4
```

`bg-white divide-y divide-grey-200/50`.

Each row: `px-6 py-4 flex items-center justify-between`.
- Left: device/browser info in `text-[14px] text-black`, last active in `font-mono text-[12px] text-grey-300`.
- Right: "This device" badge (`font-mono text-[12px] text-grey-400`) for the current session, or "Revoke" (`text-[13px] text-grey-300 hover:text-black`).

**Revoke flow:** Click "Revoke" > immediate revocation (no confirm — revoking a session is safe and reversible by logging in again). Row fades out.

**Revoke all:** `confirm('Sign out of all other devices?')` > call endpoint.

---

### 3.11 Conversation management

**Where:** DM / messages view, per-conversation actions.

**Design:** Each conversation in the conversation list gets a kebab menu (three vertical dots) on hover:

```
┌─────────────────────────────────────────────────────────────┐
│ Jane Writer                                      ⋮         │
│ Last message preview...            2h ago                   │
└─────────────────────────────────────────────────────────────┘
```

The `⋮` appears on hover (`opacity-0 group-hover:opacity-100 transition-opacity`), positioned right. Click opens a dropdown:

```
┌──────────────────┐
│ Mute             │
│ Archive          │
│ ──────────────── │
│ Delete           │
└──────────────────┘
```

Standard dropdown styling: `bg-white border border-grey-200 shadow-lg`, items `px-4 py-2 text-[14px] hover:bg-grey-100`.

- **Mute:** Silences notifications for this conversation. No confirmation. Muted conversations show a muted icon (🔇 or similar) in the list.
- **Archive:** Moves to an "Archived" section (collapsed by default at the bottom of the conversation list). No confirmation.
- **Delete:** `confirm('Delete this conversation? This only removes it from your view.')` > removes from list.

---

### 3.12 Report feedback to reporter

**Where:** Notification system (no UI to build — this is a backend-triggered notification).

**Design:** When an admin resolves a report, the reporter receives a standard notification:

```
┌─────────────────────────────────────────────────────────────┐
│ Your report has been reviewed.                              │
│ The content you reported has been [removed / found to not   │
│ violate our guidelines].                 2h ago             │
└─────────────────────────────────────────────────────────────┘
```

Same notification row styling as existing notifications. No avatar (system notification). The notification type is "report_resolved" — the existing fallback renderer in NotificationBell handles unknown types, but this should get its own renderer with appropriate copy.

The message does not identify the specific content or the admin who handled it — just the outcome. This prevents gaming the report system.

---

### 3.13 RSS discovery links

**Where:** Writer profile pages, publication homepages, and HTML `<head>` of those pages.

**Design — visible links:**

On writer profile pages, add an RSS icon in the profile header, aligned with the existing action buttons (Follow, Subscribe, etc.):

```
  [ Follow ]   [ Subscribe ]   RSS
                                ↑ text-[13px] text-grey-300 hover:text-black
                                  links to /rss/:username
```

"RSS" as a text link (no icon needed — consistency with the text-link action pattern used throughout the UI). Mono 11px uppercase, same style as metadata labels.

On publication homepages, same approach — an "RSS" link in the masthead, after the follow button:

```
  [ Follow ]   RSS
```

**Design — HTML head tags:**

Add `<link>` tags to the `<head>` of profile and publication pages:

```html
<link rel="alternate" type="application/rss+xml"
      title="Jane Writer on all.haus"
      href="/rss/janedoe" />
```

For publications:

```html
<link rel="alternate" type="application/rss+xml"
      title="The Daily Dispatch"
      href="/api/v1/pub/daily-dispatch/rss" />
```

These enable RSS reader auto-discovery. No visual component — handled in the page's Next.js `metadata` export.

---

## Part 4 — Patterns reference

Recurring patterns used across the specs above, codified for consistency.

### Danger zone

Used in: publication settings, account deletion.

```
(4px black rule: h-[4px] bg-black)

DANGER ZONE                              label-ui text-crimson

(sections below, each separated by border-grey-200)
```

The crimson label-ui is the only use of crimson in a label-ui position. It signals irreversibility.

### Type-to-confirm modal

Used in: publication delete, account delete.

Reserve for actions that are both irreversible and affect other users (subscribers, members). Never use for single-record deletes or reversible actions.

Structure: serif title, bullet list of consequences, text input that must match a known string (publication name, email address), two buttons (cancel + destructive action in crimson). Destructive button disabled until input matches.

### Inline editing

Used in: member role change, email change, username change.

Pattern: static display with a "Change" text link → input replaces the static value → Save/Cancel text links below → reverts to static on save or cancel. No modal.

### Settings toggle

Used in: notification preferences, email-on-publish, free trials, welcome email.

Two-button group: `[On] [Off]` or `[Option A] [Option B] [Option C]`. Active = `bg-black text-white`. Inactive = `bg-grey-100 text-grey-400 hover:text-black`. Mono 12px uppercase tracking.

Saves immediately on click. No save button.

### Summary stat row

Used in: subscriber tab header, subscriber analytics.

`flex` row of stat blocks, each `flex-1 text-center`. Value in `font-serif text-xl text-black` (or `text-2xl` for larger displays). Label in `label-ui text-grey-400 mt-1`.

### Action text link

Used in: table row actions, card footers, settings modifications.

`text-[13px] font-sans text-grey-300 hover:text-black disabled:opacity-50`. For destructive secondary actions: same style, with two-step confirm (text changes to "Confirm?" in `text-crimson`, 3-second timeout).

---

## Implementation priority

Consistent with the attack order in `feature-debt.md`:

**Batch 1 — high impact, moderate effort: DONE (v5.29.0)**
- ~~2.1 Bookmarks~~ — full stack: migration, routes, BookmarkButton, /bookmarks page, feed integration
- ~~2.2 Tags/topics~~ — full stack: migration, routes, TagInput in editor, TagDisplay on cards, /tag/[tag] page
- ~~1.1 Unpublish article~~ — gateway endpoint + dashboard button with confirm dialog
- ~~3.7 Notification preferences~~ — migration, endpoints, NotificationPreferences component on /social
- ~~3.8 Publication follow button~~ — PubFollowButton on publication homepage masthead

**Batch 2 — table-stakes completeness: DONE (v5.30.0)**
- ~~1.3 Subscriber list~~ — SubscribersTab with summary stats + table, conditional writer-only dashboard tab
- ~~3.1 Account deletion~~ — migration 049, deactivate + delete routes, DangerZone component with type-to-confirm modal
- ~~3.2 Change email~~ — change-email + verify-email-change routes, EmailChange component on /account
- ~~3.3 Change username~~ — change-username + check-username routes, UsernameChange component on /profile
- ~~3.13 RSS discovery~~ — generateMetadata with RSS alternate link + visible RSS links on writer profile and pub homepage

**Batch 3 — publication management:**
- 1.4 Delete/archive publication
- 1.5 Transfer ownership
- 1.6 Edit member role
- 3.4 Publication logo upload
- 3.5 Layout template picker
- 3.6 Leave publication

**Batch 4 — engagement & social:**
- 2.3 Reposts (needs feed algorithm maturity)
- 1.2 Reading history
- 1.7 Accept/decline commission
- 1.9 Edit drive
- 3.9 Note deletion
- 3.11 Conversation management

**Batch 5 — subscription depth:**
- 2.5 Free trials, gift subs, welcome email, import/export, analytics, custom landing page

**Batch 6 — operational:**
- 3.10 Session management
- 3.12 Report feedback
- 1.10 Admin direct suspend
