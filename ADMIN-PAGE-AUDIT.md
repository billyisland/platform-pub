# Admin & Settings Page Design Audit

Comprehensive audit of all administrative, settings, profile, dashboard, and similar pages. Assessed for consistent application of the three-voice typeface system, page layout, information hierarchy, and economical use of space.

## The Three Voices

Defined in `web/src/app/globals.css` and `web/tailwind.config.js`:

| Voice | Typeface | Intended Role |
|---|---|---|
| **Literary** | Literata (serif) | Article prose, author-facing content, reader experience |
| **Platform** | Jost (sans) | UI copy, body text, descriptions, buttons |
| **Infrastructure** | IBM Plex Mono (mono) | Labels, metadata, system status, data |

Key design tokens: `.label-ui` (mono, 11px, uppercase, 0.06em tracking), `.tab-pill`, `.btn`/`.btn-accent`/`.btn-ghost`, font-size tokens `text-ui-xs` (13px), `text-ui-sm` (14px), `text-mono-xs` (11px).

---

## Issue 1: Serif used for page titles on admin pages — wrong voice

Every settings/admin page title uses `font-serif`, but these are platform pages, not literary content. "Settings", "Network", "Ledger" are system words and should use Jost (sans), probably medium weight.

| Page | File | Current |
|---|---|---|
| Settings | `web/src/app/settings/page.tsx:32` | `font-serif text-2xl font-light` |
| Profile | `web/src/app/profile/page.tsx:98` | `font-serif text-2xl font-light` |
| Network | `web/src/app/network/page.tsx:92` | `font-serif text-3xl sm:text-4xl font-light` |
| Ledger | `web/src/app/ledger/page.tsx:51` | `font-serif text-2xl font-light` |
| Admin Reports | `web/src/app/admin/reports/page.tsx:47` | `font-serif text-2xl font-light` |
| Library | `web/src/app/library/page.tsx:43` | `font-serif text-2xl font-light` |

Network is also inconsistently sized at `text-3xl sm:text-4xl` when all others use `text-2xl`.

**Fix:** Replace with `font-sans text-2xl font-medium text-black tracking-tight` (or similar) on all admin pages. Reserve serif for article headings, publication names, and the literary reading experience.

---

## Issue 2: `btn-soft` is used in 8+ components but never defined

This class appears in production code but does nothing — these buttons render unstyled:

- `web/src/app/profile/page.tsx:131` (Upload photo)
- `web/src/app/network/page.tsx:155` (Unfollow)
- `web/src/components/account/DangerZone.tsx:58,116` (Deactivate, Cancel)
- `web/src/components/dashboard/PublicationSettingsTab.tsx`
- `web/src/components/profile/FollowingTab.tsx`
- `web/src/components/profile/FollowersTab.tsx`
- `web/src/components/profile/WriterActivity.tsx`
- `web/src/components/ui/VoteConfirmModal.tsx`
- `web/src/components/publication/PubFollowButton.tsx`

**Fix:** Define `.btn-soft` in `globals.css` as a secondary button variant — probably `bg-grey-100`, `color: grey-600`, Jost sans, same sizing as `.btn-ghost` but distinct intent (soft action vs ghost/background action).

---

## Issue 3: Inline font sizing bypasses design tokens

The design system defines `text-ui-xs` (13px), `text-ui-sm` (14px), and `text-mono-xs` (11px). Many components hand-roll sizes instead:

| Inline class | Components | Should be |
|---|---|---|
| `text-[14px] font-sans` | PaymentSection, DmFeeSettings, NotificationPreferences, PricingTab | `text-ui-sm` |
| `text-[13px] font-sans` | PaymentSection, DmFeeSettings, EmailChange, ReportCard, PricingTab | `text-ui-xs` |
| `text-[12px] font-mono` | PaymentSection, BalanceHeader, AccountLedger, ReportCard | `text-mono-xs` |
| `text-[11px]` | BookmarkCard, Traffology overview, dashboard draft dates | Needs a token or use `text-mono-xs` |
| `text-[10px]` | Traffology overview baseline labels | Needs a token |
| `font-mono text-[12px] uppercase tracking-[0.06em]` | PaymentSection (lines 38, 58), BalanceHeader (lines 17, 28, 29), ReportCard (lines 37-48) | `.label-ui` (which is literally this) |

The last row is particularly egregious — the longhand is character-for-character what `.label-ui` already does.

**Fix:** Replace all inline sizes with tokens. Where no token exists (10px, 11px), either introduce one or map to the nearest existing token.

---

## Issue 4: Form label styling inconsistent across pages

Three different approaches to form labels:

### A. Correct: `.label-ui text-grey-400`
Used in: Settings, Dashboard, Network, FeedDial, DmFeeSettings.

### B. Wrong voice: `text-ui-xs text-grey-300 uppercase tracking-wider`
Used in: Profile page (lines 105, 150, 166, 186). This uses Jost (sans) not Plex Mono, `tracking-wider` instead of `tracking-[0.06em]`, and grey-300 instead of grey-400. Different voice entirely.

### C. Body-text styling for labels: `text-sm text-grey-600`
Used in: Article editor "Allow replies" label (line 512), "Also show on your personal profile" (line 470). Uses platform body-text weight where infrastructure voice is needed.

**Fix:** Standardise all form labels to `.label-ui text-grey-400`. Profile page labels are the biggest offender.

---

## Issue 5: Editor settings panel — wasteful card layout

The article editor (`web/src/components/editor/ArticleEditor.tsx`, lines 444-516) stacks four separate full-width `bg-grey-100` blocks below the 780px-wide writing area:

1. **Tags** (mt-3) — TagInput component
2. **Publishing as** (mt-3, px-5 py-3) — dropdown + optional checkbox
3. **Price** (mt-6, px-5 py-4) — conditional, only when paywall gate inserted
4. **Allow replies** (mt-3, px-5 py-4) — single checkbox

The "Allow replies" toggle is a single checkbox consuming 780px of width. "Publishing as" is a single dropdown. These should share a card — a compact row of metadata fields. The price control could join too when present.

Additionally, within the "Publishing as" strip, the label uses `.label-ui text-grey-400` (infrastructure voice) while the secondary checkbox label "Also show on your personal profile" uses `text-sm text-grey-600` (platform body voice). Two different voices in the same 44px-tall strip.

**Fix:** Merge publishing-as, replies toggle, and price (when present) into a single settings card with a compact layout — e.g. a label-value grid or inline row.

---

## Issue 6: Inconsistent container widths

| Page | Width | Token | Content type |
|---|---|---|---|
| Settings | 640px | `max-w-article` | Simple form |
| Profile | 640px | `max-w-article` | Simple form |
| Network | 640px | `max-w-article` | Lists + settings cards |
| Library | 780px | `max-w-feed` | Article list |
| Dashboard | 960px | `max-w-content` | Tables + tabs |
| Ledger | 960px | `max-w-content` | Tables + balance |
| Admin Reports | 960px | `max-w-content` | Card list |

No clear logic. Network has tabular list content that would benefit from more width. Settings also caps its form to `max-w-md` (448px) inside `max-w-article` (640px), but Profile does the same inconsistently (some elements capped, others not).

**Fix:** Decide on a consistent rule. Suggestion: forms at `max-w-article` with inner `max-w-md`, tabular/list pages at `max-w-feed` or `max-w-content`.

---

## Issue 7: Section spacing has no rhythm

| Page | Section gap | Card padding |
|---|---|---|
| Settings | `space-y-10` (40px) | `px-6 py-5` |
| Profile | `space-y-8` (32px) | No cards — bare form |
| Network | `space-y-6` (24px) top, `mb-10` before tabs | `px-6 py-5` |
| Dashboard | No space-y; direct `mb-` usage | `px-6 py-5` |
| Ledger | No consistent system | `px-6 py-8` (BalanceHeader), `px-6 py-5` elsewhere |
| Library | `mb-10` between title and tabs | No cards on list items |

**Fix:** Pick a rhythm. Suggestion: 32px (`space-y-8`) between major sections, 24px within sections. Card padding standardised to `px-6 py-5`.

---

## Issue 8: NotificationPreferences toggle buttons reinvent the wheel

In `web/src/components/social/NotificationPreferences.tsx` (lines 60-77), the On/Off toggle buttons use:
```
px-2.5 py-1 text-[12px] font-mono uppercase tracking-[0.06em]
```
with conditional `bg-black text-white` vs `bg-grey-100 text-grey-400`.

The same "pick one of N" pattern appears in:
- FeedDial (option cards)
- PricingTab (auto/fixed picker)
- Various other selection UIs

All hand-rolled with slightly different styling.

**Fix:** Extract a shared selection/toggle pattern — either a utility class or a small component.

---

## Issue 9: Divider/danger-zone inconsistency

- DangerZone uses `<div className="h-[4px] bg-black my-10" />` — an arbitrary-value div
- The design system defines `.slab-rule-4` which does exactly this
- There's also `<div className="border-t border-grey-200 my-6" />` as a lighter separator within DangerZone
- Different pages use different divider approaches

**Fix:** Use `.slab-rule-4` for major section dividers. Define a light separator class if needed.

---

## Issue 10: Serif used for display names in Network lists

Network page (lines 146, 189): `font-serif text-base text-black` for writer/follower display names. Writer display names are user-generated metadata — they should be in sans. (Library/BookmarkCard using `font-serif text-lg` for article titles is defensible since those are literary content.)

**Fix:** Change to `font-sans text-base font-medium text-black`.

---

## Issue 11: Traffology pages have their own typography dialect

`web/src/app/traffology/overview/page.tsx` uses:
- `text-[10px] font-semibold uppercase tracking-[0.08em]` for stat labels (different tracking from `.label-ui`'s 0.06em)
- `text-[17px] font-bold` for stat values (no token)
- `text-[10px] font-bold uppercase tracking-[0.12em]` for section headers (yet another tracking value)

This creates a third, ad-hoc typographic register that doesn't match the infrastructure voice or any defined token.

**Fix:** Align with infrastructure voice. Stat labels should use `.label-ui` or a compact variant. Stat values need a token (or use an existing size with `font-mono tabular-nums`).

---

## Issue 12: No class for text-link button actions

Many components use inline text-button styling instead of a component class:

- `text-[13px] text-black font-medium` — EmailChange save
- `text-[13px] text-grey-300 hover:text-black` — EmailChange cancel
- `text-grey-400 hover:text-black` — dashboard table actions
- `text-ui-xs text-black underline underline-offset-4` — load-more actions
- `text-[13px] font-sans text-crimson hover:text-crimson-dark` — ReportCard actions

**Fix:** Define `.btn-text` (or similar) in `globals.css` for inline text-link actions. Possibly with `.btn-text-danger` variant for crimson destructive actions.

---

## Issue 13: Analytics should be a dashboard tab, not a toolbar link

Currently "Analytics" is a small `text-ui-xs text-grey-400` underlined link in the personal dashboard toolbar (`web/src/app/dashboard/page.tsx:275`), visually subordinate to the "New article" button. But Traffology is a full section with its own sub-views (feed, overview, piece detail) — it's a peer of Articles, Subscribers, and Proposals, not a secondary action.

It's also only available on the personal dashboard. Publication owners have no way to see analytics scoped to their publication.

**Fix:** Add "Analytics" as a proper `tab-pill` tab in both the personal tab set (`articles | subscribers | proposals | pricing | analytics`) and the publication tab set (`articles | members | settings | rate-card | payroll | earnings | analytics`). Remove the small toolbar link. The tab content hosts the Traffology views, scoped to the relevant context.

---

## Priority Order

| # | Issue | Status | Impact | Effort |
|---|---|---|---|---|
| 1 | Define `.btn-soft` | **Done** | Visible rendering bug on production buttons | Small — add to globals.css |
| 2 | Swap page titles to sans | **Done** | Wrong voice on every admin page | Small — 6 files, one line each |
| 3 | Replace longhand `.label-ui` rewrites | **Done** | Inconsistency, code bloat | Small — find-and-replace in ~20 components |
| 4 | Replace inline `text-[Npx]` with tokens | **Done** | ~15 components using ad-hoc sizes | Medium — many files, mechanical |
| 5 | Consolidate editor settings panel | **Done** | Wasteful layout, mixed voices | Medium — restructure ArticleEditor.tsx |
| 6 | Standardise form labels | **Done** | Profile page uses different voice | Small — profile/page.tsx labels |
| 7 | Normalise section spacing | **Done** | No grid rhythm | Medium — touch all admin pages |
| 8 | Normalise container widths | **Done** | Inconsistent page widths | Small — decide rule, update ~3 pages |
| 9 | Create `.btn-text` class | **Done** | Every text-action is bespoke | Small-medium — define class, migrate usages |
| 10 | Align Traffology typography | **Done** | Ad-hoc typographic register | Medium — overview + feed pages |
| 11 | Extract toggle/selection pattern | **Done** | Hand-rolled in multiple components | Medium — design pattern, refactor |
| 12 | Use `.slab-rule-4` for dividers | **Done** | Minor inconsistency | Small — DangerZone + PublicationSettingsTab |
| 13 | Promote Analytics to dashboard tab | **Done** | Hidden link, missing from publication view | Medium — add tab to both dashboard contexts, scope Traffology views |

### Notes on completed work

**Batch 1 (Issues 1–4, 6, 10, 12):** Resolved together. The label-ui sweep was broader than the original audit scope — ~20 components fixed vs the ~6 originally identified. Inline size token replacements also extended beyond the audited components into dashboard sub-components (DriveCard, DriveCreateForm, CommissionsTab, PublicationEarningsTab, etc.). Design system rules codified in CLAUDE.md to prevent drift.

**Batch 2 (Issues 5, 7–11, 13):** All remaining issues resolved.
- **Issue 5:** Publishing-as, price, and replies merged into a single settings card in ArticleEditor.tsx. Mixed voices fixed (checkbox labels now use `text-ui-xs text-grey-400`).
- **Issue 7:** Section spacing standardised to `space-y-8` on settings, network; `mb-8` on library tabs. Dashboard and ledger kept existing rhythm (already close).
- **Issue 8:** Network page widened from `max-w-article` to `max-w-feed` (780px) for list content.
- **Issue 9:** New `.btn-text`, `.btn-text-muted`, `.btn-text-danger` classes defined in globals.css. Migrated ~25 components from bespoke inline text-link styles. Also caught straggler inline sizes in BookmarkCard (`label-ui`, `text-ui-sm`) and dashboard form labels (`label-ui text-grey-400`).
- **Issue 10:** Traffology overview baseline labels → `label-ui`, stat values → `font-mono text-lg font-bold tabular-nums`, section headers → `label-ui font-bold`. Feed "Right now" label → `label-ui`. Layout header → `label-ui font-bold`.
- **Issue 11:** `.toggle-chip`, `.toggle-chip-active`, `.toggle-chip-inactive` classes defined. Applied in NotificationPreferences.
- **Issue 13:** `AnalyticsTab` component created, wrapping traffology feed + overview with sub-tab navigation. Added to both personal (`articles | subscribers | proposals | pricing | analytics`) and publication (`articles | members | settings | ... | analytics`) tab sets. Analytics toolbar link removed.

---

## Pages Audited

- `/settings` — `web/src/app/settings/page.tsx`
- `/profile` — `web/src/app/profile/page.tsx`
- `/network` — `web/src/app/network/page.tsx`
- `/dashboard` — `web/src/app/dashboard/page.tsx`
- `/ledger` — `web/src/app/ledger/page.tsx`
- `/library` — `web/src/app/library/page.tsx`
- `/admin/reports` — `web/src/app/admin/reports/page.tsx`
- `/traffology` — `web/src/app/traffology/page.tsx`
- `/traffology/overview` — `web/src/app/traffology/overview/page.tsx`

## Components Audited

- `web/src/components/editor/ArticleEditor.tsx` (lines 430-530)
- `web/src/components/account/EmailChange.tsx`
- `web/src/components/account/PaymentSection.tsx`
- `web/src/components/account/DangerZone.tsx`
- `web/src/components/account/BalanceHeader.tsx`
- `web/src/components/account/AccountLedger.tsx`
- `web/src/components/social/NotificationPreferences.tsx`
- `web/src/components/social/FeedDial.tsx`
- `web/src/components/social/DmFeeSettings.tsx`
- `web/src/components/admin/ReportCard.tsx`
