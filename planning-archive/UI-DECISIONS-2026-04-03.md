# UI Decisions — 2026-04-03

Implementation notes for Claude Code. Each section describes a decision, the rationale, and what needs to change. Where files are referenced, paths are relative to `web/src/`.

---

## 1. Nav: Logo–wordmark vertical alignment

**Decision:** Nudge the wordmark ("Platform") upward so that the top and bottom of the capital P are roughly equidistant from the top and bottom of the triangle mark.

**Why:** The current `items-center` flex alignment centres by bounding box, but the P's cap height sits optically higher than the triangle's centre of mass. The result looks slightly misaligned.

**Implementation:** On the wordmark `<span>` inside the platform-mode logo lockup in `components/layout/Nav.tsx` (line ~311), add a small upward shift. Try `style={{ transform: 'translateY(-1px)' }}` and adjust by eye at the final rendered size. The exact value depends on the new font size (see §2).

---

## 2. Nav: Make the brand lockup ~30% bigger

**Decision:** Scale up the logo mark and wordmark by roughly 30%.

**Current values (platform mode):**
- `ThereforeMark size={22}` 
- Wordmark `text-[20px]`

**New values:**
- `ThereforeMark size={29}`
- Wordmark `text-[26px]`

The nav bar height is currently `h-[56px]`. Either increase to `h-[60px]` for more breathing room, or keep at 56 and let the lockup sit tighter — try both and judge visually. Update the mobile sheet `top-[56px]` offset if the bar height changes.

**Files:** `components/layout/Nav.tsx` — the platform-mode header (line ~296 onwards).

---

## 3. Nav: Canvas-mode mark — same size, just grey

**Decision:** The canvas-mode (article pages, author pages) ThereforeMark should be the same size as the platform-mode mark, not smaller. Being grey and losing the wordmark is recessive enough.

**Current:** Canvas mode uses `size={16}`, platform mode uses `size={22}`.

**New:** Canvas mode uses `size={29}` (same as the new platform-mode size from §2), `weight="heavy"`, greyed as it already is (`text-grey-400`).

**File:** `components/layout/Nav.tsx` — the canvas-mode header (line ~251).

---

## 4. Nav: Remove the "← Feed" button from canvas mode

**Decision:** Remove the "← Feed" link from the canvas-mode nav bar. The logo mark already links to `/feed` (logged in) or `/` (logged out), so the button is redundant.

**Current:** The canvas nav has three elements: mark, "← Feed" link, avatar.
**New:** Two elements: mark (left), avatar (right).

**File:** `components/layout/Nav.tsx` — remove the `<Link href="/feed">` block (lines ~258–264) from the canvas-mode header.

---

## 5. ThereforeMark: Consistent size ratio everywhere

**Decision:** The mark should have one deliberate weight wherever it appears. Currently, the nav uses `weight="heavy"` (radius 4.0) while all ornamental uses (paywall gate, end-of-article, homepage, about page, auth page) use `weight="light"` (radius 2.8). This makes the ornamental marks look noticeably thinner even at the same pixel size.

**New rule:** Use `weight="heavy"` everywhere. If this feels too bold as an ornamental divider, introduce a `weight="medium"` (radius ~3.4) for ornamental contexts and use it consistently.

**Files to update:**
- `components/article/ArticleReader.tsx` (line 276) — end-of-article ornament
- `components/article/PaywallGate.tsx` (line 63) — paywall ornament
- `app/page.tsx` (line 102) — homepage closing ornament
- `app/about/page.tsx` (line 46)
- `app/auth/page.tsx` (line 83)

All currently use `weight="light"`. Change to `weight="heavy"` (or `weight="medium"` if that weight is introduced).

---

## 6. ThereforeMark: Animation

**Decision:** Add three CSS-driven animations to the ThereforeMark:

### 6a. Page-load spin (article pages)
When an article page first renders, the three dots briefly orbit around the triangle's centroid (~cx=13, cy=9.5 in the viewBox) and settle back. Duration: ~400–500ms, ease-out. Pure CSS `@keyframes` triggered by a class applied on mount.

### 6b. Hover spin (everywhere the mark appears as a link)
On `:hover` of the mark (specifically when it's inside an `<a>` or `<Link>`), the same orbital animation plays. Pure CSS, no JS needed.

### 6c. Paywall ellipsis bounce
When the paywall gate scrolls into view, the three dots rearrange into a horizontal ellipsis (three dots in a row), hold for ~150ms, then spring back to triangle formation. Total duration: ~600ms (200ms to ellipsis, 150ms hold, 250ms spring back). Each circle's `cx`/`cy` is keyframed individually. Trigger via an IntersectionObserver on the gate component — this is the only JS needed for animations, and it's trivially small.

### Implementation approach
- Add the keyframes in `globals.css` under `@layer components` or as standalone `@keyframes` blocks.
- Each `<circle>` in the SVG needs individual animation via `transform-origin` set to the centroid, or individual `cx`/`cy` keyframes.
- The `ThereforeMark` component (`components/icons/ThereforeMark.tsx`) needs to accept an optional `animate?: 'spin' | 'ellipsis'` prop that applies the appropriate CSS class.
- For the hover animation, the parent link applies a class on hover that targets the SVG circles.
- For the paywall ellipsis, `PaywallGate.tsx` uses an IntersectionObserver to add the animation class when the gate enters the viewport.

These animations add negligible page weight (CSS keyframes only, one small IntersectionObserver). They degrade gracefully — if CSS animations don't run, the static triangle renders. This is fully compatible with RESILIENCE.md.

---

## 7. Paywall gate: Remove the bottom legend

**Decision:** Remove the "Pay per read / Subscribe for more / Cancel anytime" footer text from the paywall gate.

**File:** `components/article/PaywallGate.tsx` — delete lines 105–111 (the `<div className="mt-8 flex items-center justify-center...">` block).

---

## 8. Paywall gate: Deduplicate the subscription price

**Decision:** The subscription price currently appears both in the legend text ("Or subscribe to [writer] for **£5.00/mo**") and on the subscribe button ("Subscribe £5.00/mo"). Say the price once, in the legend with the bold treatment it already has. The button should just say "Subscribe".

**File:** `components/article/PaywallGate.tsx` — in the subscribe section (lines ~84–103):
- Keep the legend: `Or subscribe to {writerName} for <strong>£{subPricePounds}/mo</strong> to read everything`
- Change the button text from `Subscribe £${subPricePounds}/mo` to just `Subscribe`

---

## 9. Paywall gate: Smart subscription nudge (spend-threshold prompt)

**Decision:** When a reader has spent ≥70% of a writer's monthly subscription price on that writer's articles in the current calendar month, show a quiet observational line below the subscribe option. This replaces the removed legend from §7.

### Display logic

- **Trigger:** `writerSpendThisMonthPence >= subscriptionPricePence * 0.7` AND `writerSpendThisMonthPence <= subscriptionPricePence`
- **One-shot per reader/writer/month:** Once shown, don't show again for this combination until next calendar month. Track via a `subscription_nudges_shown` table or a simpler flag mechanism.
- **Over-threshold:** If `writerSpendThisMonthPence > subscriptionPricePence`, the conversion offer disappears. Instead show: `You've spent £{amount} on {writerName} this month. A subscription is £{subPrice}/mo.` No special offer, just the two numbers.

### Conversion offer (within threshold)

When the nudge is active (spend is 70–100% of sub price), the offer is to **convert that month's spending into a subscription**. The reader pays nothing additional — their existing per-article spend for that writer this month becomes their first month's subscription. The subscription renews at full price next month.

**Copy (within threshold):**
> You've spent £{amount} on {writerName} this month. Subscribe now and that spending converts to your first month.

**Copy (over threshold):**
> You've spent £{amount} on {writerName} this month. A subscription is £{subPrice}/mo.

**Styling:** Same typographic register as byline metadata — `font-mono text-[12px] text-grey-400`. No call-to-action button attached to this text; the subscribe button is already right there.

### Backend changes

**New gateway endpoint or extension to existing article metadata:**
- When serving the paywall gate data for an authenticated reader, include `writerSpendThisMonthPence` in the response.
- Query: `SELECT COALESCE(SUM(amount_pence), 0) FROM read_events WHERE reader_id = $1 AND writer_id = $2 AND read_at >= date_trunc('month', now())`
- The composite index on `(reader_id, writer_id)` from migration 022 makes this fast.

**Nudge tracking:**
- New table `subscription_nudge_log` with columns: `reader_id`, `writer_id`, `month` (date, first of month), `shown_at`, `converted` (boolean).
- On first render of the nudge, the client calls a small endpoint to mark it as shown.
- Subsequent paywall renders for the same reader/writer/month check this table and suppress the conversion offer (but can still show the over-threshold observational text).

**Subscription conversion flow:**
- When a reader subscribes via the conversion offer, the backend creates the subscription at full price and credits back the reader's `read_events` spend for that writer/month to their tab (as a credit entry in the ledger).
- The subscription `current_period_end` is set to the end of the current calendar month on first creation, then renews at full monthly intervals.

---

## 10. Author gifting: Named grants (improved UI)

**Decision:** The existing free pass system (author grants access to a specific user) works, but the UI is buried in a dashboard overflow menu and requires typing an exact username.

### Changes

- **Surface on the article page:** After an author views their own article, show a "Gift" action alongside Share/Report. Opens a modal with a follower typeahead (search from the author's follower list) and a "Grant access" button.
- **Improve the dashboard panel:** The existing `FreePassManager` should use a typeahead/search instead of a raw text input. Search against the author's followers first, then all platform users.
- **Notification:** Already exists (`free_pass_granted` notification type). No change needed.

### Files
- `components/article/ArticleReader.tsx` — add Gift action for own content
- `components/dashboard/FreePassManager.tsx` — replace text input with typeahead
- New component: `components/ui/UserSearch.tsx` — reusable typeahead for user lookup

---

## 11. Author gifting: Capped gift links

**Decision:** Authors can generate a shareable URL that grants free access to a paywalled article, with a configurable redemption limit (default 5).

### URL format
`/article/{dTag}?gift={token}`

### Backend

**New table: `gift_links`**
```sql
CREATE TABLE gift_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES articles(id),
  creator_id UUID NOT NULL REFERENCES accounts(id),
  token TEXT NOT NULL UNIQUE,
  max_redemptions INT NOT NULL DEFAULT 5,
  redemption_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gift_links_token ON gift_links(token);
CREATE INDEX idx_gift_links_article ON gift_links(article_id);
```

**New endpoints:**
- `POST /articles/:articleId/gift-link` — creates a gift link, returns `{ token, url, maxRedemptions }`
- `GET /articles/:articleId/gift-links` — lists gift links for author dashboard
- `DELETE /articles/:articleId/gift-link/:linkId` — revokes a gift link

**Redemption flow (in gate-pass handler):**
1. Check for `gift` query param on article page load.
2. Validate token: `SELECT * FROM gift_links WHERE token = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
3. Atomic redemption: `UPDATE gift_links SET redemption_count = redemption_count + 1 WHERE id = $1 AND redemption_count < max_redemptions RETURNING *`
4. If successful, create `article_unlocks` row with `unlocked_via = 'author_grant'`.
5. If zero rows returned, link is exhausted — reader sees normal paywall.

### Frontend

- Add "Create gift link" to the article Share dropdown (only for the author).
- Show a small modal: redemption limit (default 5, editable), then generate and copy URL.
- In the dashboard `FreePassManager`, show gift links with redemption stats ("3 of 5 used") alongside named grants. Allow revoking.

---

## 12. Commissions and pledge drives: Architecture

**Decision:** Commissions should be a prominent, socially visible feature — not a hidden dashboard tool. The interaction pattern is: a conversation becomes a deal.

### Commission button on author profiles

- By default, every author profile shows a "Commission" button alongside Follow/Subscribe.
- Authors can hide it in Settings (new toggle: `show_commission_button`, default true).
- Hiding the button does NOT disable the API — anyone can still commission an author programmatically. The button is a shingle, not a gate.

**New column:** `accounts.show_commission_button BOOLEAN NOT NULL DEFAULT TRUE`

### Commission creation from profiles

Tapping "Commission" opens a minimal form:
- **What do you want them to write about?** (free text, required)
- **How much are you offering?** (amount field, required)
- **Open to other backers?** (toggle, default off)

This creates a `pledge_drives` row with `origin = 'commission'`. The creator's amount becomes the first pledge.

### Commission creation from conversations

Anywhere notes and replies are possible (reply threads, note cards), add a "Commission" action alongside Quote and Reply.

- Tapping it pre-fills the pitch text from the conversational context (e.g., quoting the note being replied to).
- Opens the same minimal form as above.
- The resulting commission is linked to the parent note/reply via a new column: `pledge_drives.parent_note_event_id TEXT` (the Nostr event ID of the note that spawned the commission).
- The commission appears inline in the thread as a distinct card type — visually different from a note, with the amount prominent.

### Commission cards as quotable social objects

Commission cards are quotable entities, just like articles and notes:
- They have their own Nostr event kind and `eventId` (already the case via `pledge_drives.nostr_event_id`).
- The existing quote mechanism works with them: selecting text or using the Quote action creates a note with an embedded commission preview (title, target author, current total, progress bar).
- New component: `components/feed/CommissionCard.tsx` — renders the commission in feeds and threads.

### Privacy model for pledges

- The commission card itself is **public**: anyone can see the title, target author, description, total raised, pledge count.
- Individual pledge amounts and pledger identities are **private**: you know the total, not who put in how much.
- Anyone can **quote** a commission card into their own feed to publicly announce support (or opposition). The act of quoting is the public performance; the act of pledging is private.

### Pledge button on ProfileDriveCard

The reader-facing `ProfileDriveCard` currently has no pledge action. Add:
- A "Pledge" button that opens an inline amount input.
- On submit, calls `drives.pledge(driveId, amountPence)`.
- The pledge is added to the reader's tab.

**File:** `components/profile/ProfileDriveCard.tsx`

### Feed integration

- Active commissions with momentum (e.g., >50% funded or recent pledge activity) surface as their own card type in the For You feed.
- When someone quotes a commission card, their note appears in the feed with the embedded preview.
- Commission cards also appear in the target writer's notification stream.

### Author acceptance flow

When an author accepts a commission (already partially built in `DriveCard.tsx`), the acceptance flow should allow them to specify:
- What they're committing to deliver (confirm or refine the commissioner's description)
- Deadline (optional)
- Whether the resulting piece will be paywalled or free to backers

These terms become part of the public record of the drive.

### Delivery and fulfilment

For v1, fulfilment is author-declared:
- The author links a published article to the drive (via `pledge_drives.article_id`, which already exists in the schema).
- Backers get automatic access via `article_unlocks` with `unlocked_via = 'pledge'` (already in the enum).
- If backers feel cheated, the existing report system handles disputes.

No escrow or arbitration system at launch — social trust handles this at small scale.

### Schema changes needed

```sql
-- Add conversational threading to pledge drives
ALTER TABLE pledge_drives ADD COLUMN parent_note_event_id TEXT;
CREATE INDEX idx_drives_parent_note ON pledge_drives(parent_note_event_id)
  WHERE parent_note_event_id IS NOT NULL;

-- Add commission button visibility to accounts
ALTER TABLE accounts ADD COLUMN show_commission_button BOOLEAN NOT NULL DEFAULT TRUE;

-- Add acceptance terms to pledge drives
ALTER TABLE pledge_drives ADD COLUMN acceptance_terms TEXT;
ALTER TABLE pledge_drives ADD COLUMN deadline TIMESTAMPTZ;
ALTER TABLE pledge_drives ADD COLUMN backer_access_mode TEXT
  CHECK (backer_access_mode IN ('free', 'paywalled')) DEFAULT 'free';
```

### New components needed

- `components/feed/CommissionCard.tsx` — renders commission in feeds/threads
- `components/ui/CommissionForm.tsx` — the minimal commission creation form (reused on profiles and in reply threads)
- Update `components/feed/NoteCard.tsx` and `components/replies/ReplyItem.tsx` to include "Commission" action
- Update `components/profile/WriterActivity.tsx` to show the Commission button
- Update `components/profile/ProfileDriveCard.tsx` to include pledge action
- Update `components/dashboard/DriveCard.tsx` to include acceptance terms flow

---

## 13. Naming consideration (not for implementation)

The name "Therefore" is under consideration as a replacement for "Platform". The three-dot therefore symbol (∴) is already the brand mark. Domain options being explored include `therefore.pub` (preferred — reads as "therefore, publish" and the .pub TLD means publication) and `therefore.xyz` (attractive formal-argumentation aura but .xyz has spam/phishing reputation issues that could cause deliverability and trust problems).

This is a naming decision, not an implementation task. No code changes until confirmed.
