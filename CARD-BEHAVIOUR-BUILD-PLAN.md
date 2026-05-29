# Card Behaviour — Build Plan

Implementation plan for `docs/adr/CARD-BEHAVIOUR-ADR.md`. Unifies click
semantics, conversational neighbourhood expansion, and author affordances
across all feed card types.

**Status:** Phase 1 shipped (2026-05-25). Phase 2 shipped (2026-05-26). Phase 3 shipped (2026-05-26). Audit fix-up (2026-05-27): migration 097 applied, provenance `@handle` wired, ExternalCard ActionSheet wired, source Follow in AuthorModal wired, ArticleCard bookmark in ActionSheet wired. Cleanup (2026-05-29): keyboard `focus-within` parity on secondary actions, `activitypub` label corrected to `VIA FEDIVERSE`, ExternalCard type consolidated to canonical `ndk.ts` export.

## Scope

**In scope:** Feed cards (`ArticleCard`, `NoteCard`, `ExternalCard`) in the
main timeline (`/` following, `/explore`). This is a behaviour/functionality
plan — click regions, expansion, hydration endpoints, author modal.

**Out of scope (deferred):** VesselCard (workspace) inherits the interaction
model in a later styling/condensation pass. Constructed external author
profile pages (§VI.3 — tracked in `feature-debt.md`). External-item
permalink page (§IX).

## What exists today

| Capability                             | Status                                                    | Key files                                                   |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Body click: `ArticleCard` / `NoteCard` | Navigates to article/note permalink                       | `ArticleCard.tsx:88`, `NoteCard.tsx`                        |
| Body click: `ExternalCard`             | Dead — does nothing                                       | `ExternalCard.tsx:140`                                      |
| Source attribution                     | Non-clickable `<span>` badge                              | `ExternalCard.tsx:158–172`                                  |
| "View original →"                      | Footer link, separate from attribution                    | `ExternalCard.tsx:341–348`                                  |
| Author hover modal                     | Does not exist                                            | —                                                           |
| Byline click                           | Sometimes a link (external), sometimes navigates (native) | Inconsistent per card type                                  |
| `is_reply` on `feed_items`             | Does not exist                                            | Reply filtering via `n.reply_to_event_id IS NULL` join      |
| Biddability tier                       | Does not exist                                            | `content_tier` enum is the provenance tier, not biddability |
| Thread/parent endpoints                | Exist for external items                                  | `external-items.ts:186–302` (parent + thread, with caches)  |
| Parent context component               | Exists in workspace                                       | `ParentContextTile.tsx`                                     |
| Touch action sheet / `⋯` menu          | Does not exist                                            | All actions always inline                                   |

## Key decisions

1. **Surface:** Feed cards only. VesselCard convergence is a later pass.
2. **Endpoints:** Reuse and extend existing `/external-items/:id/parent` and
   `/external-items/:id/thread` rather than building a new unified endpoint.
3. **Click change timing:** All card types change click semantics in Phase 1.
   Headline navigates, body click is wired (expands in Phase 2).
4. **Author modal richness:** Full as specified — outbound profile fetches
   from source platforms, tier-degraded content, Follow button.

---

## Phase 1 — Region map + back-end foundation

Ship: predictable clicks on every card, correct `↳` signalling, source
attribution as the single route out, biddability tier in the API. No
expansion yet. This phase removes the worst current confusion and lays the
schema foundation.

### Slice 1A: `feed_items.is_reply` migration + dual-write

**Migration 097.** Adds one boolean to `feed_items` and populates it for
existing rows.

**Schema change:**

```sql
ALTER TABLE feed_items ADD COLUMN is_reply BOOLEAN NOT NULL DEFAULT FALSE;
```

**Backfill (same migration):**

```sql
-- External items: reply if source_reply_uri is present
UPDATE feed_items fi SET is_reply = TRUE
FROM external_items ei
WHERE fi.external_item_id = ei.id
  AND ei.source_reply_uri IS NOT NULL;

-- Native notes: reply if reply_to_event_id is present
UPDATE feed_items fi SET is_reply = TRUE
FROM notes n
WHERE fi.note_id = n.id
  AND n.reply_to_event_id IS NOT NULL;
```

Articles are never replies; `DEFAULT FALSE` handles them.

**Dual-write updates (8 INSERT sites):**

| #   | File                                                    | Change                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `feed-ingest/src/lib/atproto-ingest.ts:85`              | Add `is_reply` column. Value: `item.sourceReplyUri != null`                                                                                                                                                                    |
| 2   | `feed-ingest/src/lib/activitypub-ingest.ts:72`          | Add `is_reply` column. Value: `item.sourceReplyUri != null`                                                                                                                                                                    |
| 3   | `feed-ingest/src/lib/email-ingest.ts:100`               | Add `is_reply` column. Value: `FALSE` (email has no reply concept)                                                                                                                                                             |
| 4   | `feed-ingest/src/tasks/feed-ingest-rss.ts:132`          | Add `is_reply` column. Value: `FALSE` (RSS has no reply concept)                                                                                                                                                               |
| 5   | `feed-ingest/src/tasks/feed-ingest-nostr.ts:266`        | Add `is_reply` column. Value: check for `e`-tag in the event (item has `sourceReplyUri` if it's a reply to another event)                                                                                                      |
| 6   | `gateway/src/routes/notes.ts:131`                       | Add `is_reply` column. Value: check `data.signedEvent?.tags` for an `e`-tag, or `FALSE` if no signed event. In practice native note replies don't populate `reply_to_event_id` currently, so this is defensive future-proofing |
| 7   | `gateway/src/routes/articles/publish.ts:119`            | Add `is_reply` column. Value: `FALSE`                                                                                                                                                                                          |
| 8   | `gateway/src/services/publication-publisher.ts:210,345` | Add `is_reply` column. Value: `FALSE` (both article INSERT sites)                                                                                                                                                              |

**Reconciliation update:**

`feed-ingest/src/tasks/feed-items-reconcile.ts` — add `is_reply` to all
three reconciliation INSERTs:

- Articles reconcile (line 24): always `FALSE`
- Notes reconcile (line 51): `n.reply_to_event_id IS NOT NULL`
- External reconcile (line 75): subquery `(SELECT ei2.source_reply_uri IS NOT NULL FROM external_items ei2 WHERE ei2.id = ei.id)` or just join the existing `ei` alias

**Also update `ON CONFLICT DO UPDATE` clauses** on the Nostr ingest path
(line 279) to include `is_reply = EXCLUDED.is_reply` so replaceable events
that gain/lose reply status are corrected.

**Feed query update:**

`gateway/src/routes/timeline.ts` — add `fi.is_reply` to `FEED_SELECT`.
`gateway/src/routes/feeds.ts` — same for workspace feeds if applicable.

**API response update:**

Add `isReply: boolean` to all three feed item response shapes
(`feedItemToResponse` or equivalent in `timeline.ts`).

**Frontend type update:**

Add `isReply: boolean` to `ArticleEvent`, `NoteEvent`, `ExternalFeedItem`
(or the shared base type) in `web/src/lib/ndk.ts` or the feed API types.

**Acceptance:**

- `SELECT COUNT(*) FROM feed_items WHERE is_reply` returns non-zero after
  backfill (there are existing AP/Bluesky replies in the feed).
- New external items ingested with `source_reply_uri` get `is_reply = TRUE`.
- New articles and RSS items get `is_reply = FALSE`.
- Reconciliation job correctly sets `is_reply` for orphaned rows.
- Feed API response includes `isReply` field on every item.

**Effort:** Half a day. Mechanical — one column, eight INSERTs, one backfill.

---

### Slice 1B: Biddability tier on feed API

**No migration.** Biddability is a pure function of data already present,
computed at response time per ADR §VII.2.

**Computation logic** (in `feedItemToResponse` or a shared helper):

```typescript
function computeBiddabilityTier(item: FeedRow): "A" | "B" | "C" | "D" {
  if (item.item_type === "article" || item.item_type === "note") return "A";
  switch (item.source_protocol) {
    case "nostr_external":
      return "A";
    case "atproto":
      return "A";
    case "activitypub":
      return "B";
    case "rss":
    case "email":
      return item.author_uri ? "C" : "D";
    default:
      return "D";
  }
}
```

Note: `author_uri` comes from the `external_items` LEFT JOIN already in the
feed query (`ei.author_uri`). The computation needs this value piped through.

**Files:**

| File                               | Change                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gateway/src/routes/timeline.ts`   | Add `ei.author_uri` to `FEED_SELECT` if not already present. Add `biddabilityTier` to response mapping using the helper. |
| `gateway/src/routes/feeds.ts`      | Same for workspace feed query (if the workspace feeds path is used by the main feed cards).                              |
| `web/src/lib/ndk.ts` or feed types | Add `biddabilityTier: 'A' \| 'B' \| 'C' \| 'D'` to external feed item type. Native items always `'A'`.                   |

**Acceptance:**

- Feed API returns `biddabilityTier` on every item.
- Native articles/notes always `'A'`.
- Bluesky items `'A'`, AP items `'B'`, RSS with author URI `'C'`, RSS
  without `'D'`.
- Frontend types carry the tier for conditional rendering in later slices.

**Effort:** 2–3 hours. Pure response-layer addition.

---

### Slice 1C: Click region map — all card types

The headline behaviour change: **headline navigates, body expands** (body
expansion content comes in Phase 2; Phase 1 wires the handler with a no-op
or subtle visual cue).

**ArticleCard** (`web/src/components/feed/ArticleCard.tsx`):

Current: `onClick={handleCardClick}` on the card container (line 88) →
navigates to `/article/${dTag}`.

Change:

- Remove `onClick` from the card container `<div>`.
- Add `onClick` with navigation to the **title element** only (the `<h2>`
  or equivalent). The title becomes the sole navigation trigger.
- Add a new `onClick={handleBodyExpand}` on the card body region (the area
  between byline and action row). Phase 1: `handleBodyExpand` sets an
  `expanded` state (visual cue only — e.g. a subtle background shift or
  nothing). Phase 2 fills this with real expansion.
- Ensure `cursor: pointer` moves from the card to the title.
- `stopPropagation` on action row buttons unchanged.

**NoteCard** (`web/src/components/feed/NoteCard.tsx`):

Current: no explicit whole-card click in the exploration, but note content
area may navigate.

Change:

- First line / content text: clicking navigates to note permalink.
- Body region: `handleBodyExpand` (same pattern as ArticleCard).
- Splitting the click target: wrap the content text in a navigable element,
  separate from the card container.

**ExternalCard** (`web/src/components/feed/ExternalCard.tsx`):

Current: body click does nothing (line 140). "View original →" is a footer
link (line 341–348).

Change:

- **Title/headline**: clicking opens the source URL in a new tab (interim
  destination per §IX — flag with a `// INTERIM: until external-item
// permalink page exists` comment).
- **Body region**: `handleBodyExpand` (same Phase 2 placeholder).
- **Remove** the "View original →" footer link. The source attribution line
  (Slice 1E) replaces it as the single route out.
- `cursor: pointer` on the body.

**QuoteCard** (`web/src/components/feed/QuoteCard.tsx`):

Follows the same region map as its parent type. If QuoteCard is always
embedded inside another card, it inherits that card's click semantics. If it
appears standalone, apply the ArticleCard/NoteCard pattern.

**Shared pattern — the body-expand handler:**

Create a shared hook or inline handler pattern:

```typescript
const [expanded, setExpanded] = useState(false);
const handleBodyExpand = (e: React.MouseEvent) => {
  e.stopPropagation();
  setExpanded((prev) => !prev);
};
```

Phase 1: `expanded` state exists but renders nothing (or a minimal visual
indicator like a subtle border change). Phase 2 uses `expanded` to trigger
neighbourhood hydration and rendering.

**Files:**

| File                                       | Change                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `web/src/components/feed/ArticleCard.tsx`  | Split headline from body click. Title navigates, body toggles expand state.         |
| `web/src/components/feed/NoteCard.tsx`     | Same split. Content area navigates to note permalink, body toggles.                 |
| `web/src/components/feed/ExternalCard.tsx` | Headline → source URL (new tab). Body → expand toggle. Remove "View original" link. |
| `web/src/components/feed/QuoteCard.tsx`    | Follow parent pattern if standalone.                                                |

**Acceptance:**

- Clicking an article title navigates to `/article/{dTag}`. Clicking the
  article body does NOT navigate.
- Clicking a note's content navigates to its permalink. Clicking the body
  does not navigate.
- Clicking an external card's headline opens the source URL. Clicking the
  body does not navigate and does not feel dead (cursor changes, visual
  feedback on click).
- Action row buttons (reply, quote, vote, bookmark, share) continue to work
  — `stopPropagation` prevents body-expand on these.
- No regression in existing navigation for articles and notes — the user can
  still get to the destination; the click target just moved from "entire
  card" to "headline."

**Effort:** 1 day. The trickiest part is splitting the click regions cleanly
in each card's JSX without introducing layout jank.

**Risk:** This is the most user-visible change in Phase 1. Test on desktop
and mobile viewports. The headline click target must be large enough to hit
comfortably (full title width, not just the text).

---

### Slice 1D: Provenance line (`↳ REPLYING TO`)

Renders a mono-caps signalling line above the byline on reply cards.

**Rendering rules (§V.2):**

- Show when `isReply === true` AND `biddabilityTier` is `'A'` or `'B'`.
- Never show on tier C/D (RSS/email have no parent concept).
- Copy: `↳ REPLYING TO A POST` universally in Phase 1. Phase 2 enriches
  this with the parent author handle when expansion hydrates the parent.

The `A POST` phrasing is the tier-B degradation the ADR explicitly permits.
Enriching with `@handle` requires parent data that may not be available
pre-expansion. Rather than adding a column or a join for a display string
that becomes redundant once the parent renders inline (Phase 2), ship the
generic form first.

**Component:**

New `ReplyProvenance` component (or inline in each card):

```tsx
function ReplyProvenance({ tier }: { tier: "A" | "B" | "C" | "D" }) {
  if (tier !== "A" && tier !== "B") return null;
  return (
    <div className="label-ui text-grey-400 mb-1">↳ REPLYING TO A POST</div>
  );
}
```

Rendered above the byline row in `ArticleCard`, `NoteCard`, `ExternalCard`
when `item.isReply && (item.biddabilityTier === 'A' || item.biddabilityTier === 'B')`.

**Files:**

| File                                       | Change                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| `web/src/components/feed/ArticleCard.tsx`  | Render `ReplyProvenance` above byline when applicable.    |
| `web/src/components/feed/NoteCard.tsx`     | Same.                                                     |
| `web/src/components/feed/ExternalCard.tsx` | Same. Primary consumer — most replies are external items. |

**Acceptance:**

- An external Bluesky reply card shows `↳ REPLYING TO A POST` above the
  byline in mono-caps grey.
- An external Mastodon reply shows the same line.
- An RSS item does NOT show the line, even if it somehow has `isReply` true
  (defensive — tier C/D filter catches it).
- A native article never shows the line.
- The line is not clickable (signalling only — §IV region map).

**Effort:** 2–3 hours. Tiny component, conditional rendering.

---

### Slice 1E: Source attribution as the single route out

The block-caps source line becomes a clickable link — the **one canonical
route to the original** — and the redundant "View original →" link is
removed.

**Current state:**

- `ExternalCard.tsx:158–172`: source badge is a `<span>` — not clickable.
- `ExternalCard.tsx:341–348`: "View original →" is a separate footer link.
- The two routes serve the same purpose and neither is the clear primary.

**Change:**

Make the entire source attribution cluster (`VIA {PROTOCOL} · {handle}`) a
single `<a>` tag:

```tsx
<a
  href={item.sourceItemUri}
  target="_blank"
  rel="noopener noreferrer"
  className="label-ui text-grey-400 hover:text-grey-600 transition-colors"
  onClick={(e) => e.stopPropagation()}
>
  {protocolLabel} · {item.authorHandle ?? item.sourceName}
</a>
```

- `stopPropagation` so it doesn't trigger body-expand.
- Opens in a new tab — the user leaves all.haus to see the original.
- Tier D with no `sourceItemUri`: render as non-clickable plain text
  (`<span>` instead of `<a>`). The line is still informative
  (`VIA RSS · Feed Name`) even when un-linked.
- Native cards (articles/notes) have no source attribution — no change.

**Remove** the "View original →" footer link from ExternalCard. The
attribution line IS the route out now. One route, predictably placed.

**Files:**

| File                                       | Change                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `web/src/components/feed/ExternalCard.tsx` | Make source badge a link to `sourceItemUri`. Remove "View original" link. |

**Acceptance:**

- Clicking `VIA BLUESKY · @handle` on an external card opens the source
  URL in a new tab.
- "View original →" link no longer appears anywhere on external cards.
- RSS items without `sourceItemUri` show un-clickable `VIA RSS · Feed Name`.
- Native cards are unchanged (no attribution line).

**Effort:** 2–3 hours. Simple DOM change.

---

### Phase 1 total — SHIPPED 2026-05-25

~2.5 days. Ships a coherent, testable improvement: every click region does
one predictable thing, reply cards are visually distinguished, and the route
to the original is singular and obvious.

---

## Phase 2 — Neighbourhood expansion

Ship: body-click expands parent + replies inline. One click shows the whole
conversational neighbourhood; second click collapses it.

**Prerequisite:** Phase 1 green (click map wired, `is_reply` populated,
biddability tier on API).

### Slice 2A: Extend existing endpoints for neighbourhood hydration

The gateway already has:

- `GET /external-items/:id/parent` — returns parent + grandparent tag
  (120s cache, `external-items.ts:186–256`)
- `GET /external-items/:id/thread` — returns `{ ancestors, descendants }`
  (60s cache, `external-items.ts:261–302`)

These serve the workspace's `ParentContextTile` and
`ExternalPlayscriptThread`. The neighbourhood expansion in the feed cards
needs the same data in a slightly different shape.

**Extend, don't replace.** The existing endpoints already do the hard work
(outbound fetches, protocol dispatch, caching). The feed expansion can call
them directly from the frontend or via a thin aggregation layer.

**Option A — client calls both endpoints:**

The frontend `handleBodyExpand` fires two parallel requests:

1. `GET /external-items/:id/parent` → renders the inset parent above.
2. `GET /external-items/:id/thread` → renders replies below (using
   `descendants` only; `ancestors` are redundant with the parent call).

Pro: zero backend change. Con: two HTTP calls per expansion.

**Option B — new aggregation endpoint:**

```
GET /api/v1/external-items/:id/neighbourhood
```

Internally calls the existing parent + thread resolution logic, returns a
unified `{ parent?, replies[], parentPartial: boolean }` payload.

Pro: one call. Con: a new endpoint wrapping existing logic.

**Decision: Option A.** Two parallel fetches is simpler, avoids a new
endpoint, and the calls are cached anyway. If latency proves annoying,
Option B is a straightforward follow-up. The frontend already has the
`useExternalThread` and `useLiveEngagement` hooks from the workspace — the
pattern is proven.

**For native items (articles/notes):**

Native reply threads already exist via `PlayscriptThread` /
`ReplySection.tsx`. The neighbourhood expansion for native items can reuse
the existing comment/reply fetching infrastructure. Native articles have
`GET /articles/:id/comments`; native notes have their reply tree.

**New hook: `useNeighbourhood`:**

```typescript
function useNeighbourhood(item: FeedItem) {
  // External: parallel parent + thread fetch
  // Native article: fetch /articles/:id/comments
  // Native note: fetch reply tree
  // Returns { parent?, replies[], loading, error, partial }
}
```

**Files:**

| File                                      | Change                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `web/src/hooks/useNeighbourhood.ts` (new) | Hook that dispatches to existing API endpoints based on item type. Returns unified `{ parent, replies, loading, error, partial }`. |
| `web/src/lib/api/external-items.ts`       | Ensure `parent()` and `thread()` API methods exist (they likely do from workspace work).                                           |

**Acceptance:**

- `useNeighbourhood` returns parent data for a Bluesky reply item.
- `useNeighbourhood` returns replies for an article with comments.
- Parallel fetches complete without race conditions.
- Cached responses are fast on second expansion.

**Effort:** Half a day.

---

### Slice 2B: Body-click expansion rendering

The core visual interaction. Body click hydrates and renders the
conversational neighbourhood inline.

**Layout (§V.1):**

```
   ┌─ parent card ────────────────┐   ← inset, dimmed
   └──────────────────────────────┘
 ┌─ ANCHOR CARD ───────────────────┐  ← stays put, unchanged
 └──────────────────────────────────┘
   ┌─ reply ──────────────────────┐   ← inset, dimmed
   ┌─ reply ──────────────────────┐
   └──────────────────────────────┘
```

**Key constraints:**

1. **Anchor does not move.** When the parent renders above, it must not push
   the anchor card down. This means the parent renders by growing the card
   element upward — practically, the parent is prepended and the feed
   container allows negative-direction growth. OR: use `scrollIntoView` /
   scroll adjustment to keep the anchor visually fixed. The latter is more
   robust.

2. **Inset rendering.** Parent and replies indent by one step (e.g. `ml-8`
   / 32px). Left bar dimmed one shade (grey-400 instead of grey-300 for
   external, grey-500 instead of black for native). No gap margin between
   parent and anchor — they read as "attached."

3. **Parent and replies are real cards** with full affordances. Votable,
   replyable, bylines hoverable. They are quieter but not crippled. Render
   them as the same card component with `dimmed` or `inset` prop.

4. **Toggle.** Second body click collapses — parent + replies removed,
   `expanded` set false.

**Implementation approach:**

Wire the Phase 1 `expanded` state to trigger `useNeighbourhood` fetch on
first expand. Render the result:

```tsx
{expanded && neighbourhood.parent && (
  <div className="ml-8 -mt-1">  {/* inset, no gap */}
    <NeighbourhoodCard item={neighbourhood.parent} variant="inset" />
  </div>
)}
<div> {/* anchor card — unchanged */}
  <ArticleCard item={item} ... />
</div>
{expanded && neighbourhood.replies.map(reply => (
  <div key={reply.id} className="ml-8 mt-2">
    <NeighbourhoodCard item={reply} variant="inset" />
  </div>
))}
```

**`NeighbourhoodCard`** — a lightweight card renderer for parent/reply items.
These items may be external (normalised from the thread endpoint) or native
(from the comments/reply tree). The component renders:

- Left bar (dimmed shade)
- Byline (author name, handle, timestamp)
- Content (text or HTML)
- Action row (reply, vote — same as the anchor card but quieter)

Reuse as much of the existing card components as possible. If the existing
cards accept a `variant="inset"` prop that controls brightness and indent,
prefer that over a new component.

**Scroll stabilisation:**

When the parent renders above the anchor, the browser's scroll position will
shift. Capture `anchor.getBoundingClientRect().top` before expansion,
re-measure after React commit, adjust `scrollTop` by the delta. This keeps
the anchor visually fixed.

**Files:**

| File                                                  | Change                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `web/src/components/feed/ArticleCard.tsx`             | Wire `expanded` to `useNeighbourhood`. Render parent above, replies below. Scroll stabilisation. |
| `web/src/components/feed/NoteCard.tsx`                | Same pattern. For native notes, replies come from the existing reply tree.                       |
| `web/src/components/feed/ExternalCard.tsx`            | Same pattern. Primary beneficiary — most external items are replies.                             |
| `web/src/components/feed/NeighbourhoodCard.tsx` (new) | Inset card renderer for parent/reply items from the neighbourhood.                               |
| `web/src/components/feed/FeedList.tsx` or equivalent  | May need layout adjustments to accommodate expansion without breaking feed rhythm.               |

**Acceptance:**

- Clicking an external reply card's body shows the parent above (indented,
  dimmed) and replies below.
- The anchor card does not move when the parent renders.
- Clicking the body again collapses parent + replies.
- Parent and reply cards are fully interactive (votable, replyable,
  bylines hoverable).
- No layout jank on expand/collapse — smooth, no flicker.

**Effort:** 2 days. The scroll stabilisation and inset rendering are the
tricky parts.

---

### Slice 2C: Tier-driven failure and empty states

Expansion must handle failure as a designed state, not an error.

**States by tier (§V.5):**

| Tier                           | Parent                                                  | Replies                      | Empty state                                        |
| ------------------------------ | ------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| **A** (native, Nostr, Bluesky) | Renders normally                                        | Render normally              | —                                                  |
| **A/B** in flight              | Skeleton at inset position                              | Skeleton                     | —                                                  |
| **B** (Mastodon) fetch fails   | Quiet stub: `↳ PARENT POST · COULDN'T REACH {instance}` | Empty or partial             | Still has route to original via source attribution |
| **C/D** (RSS/email)            | No parent (never fetched)                               | Native all.haus replies only | `NO CONVERSATION YET — BE THE FIRST TO REPLY`      |

**Skeleton:**

Reuse the project's existing skeleton pattern (if one exists) or create a
minimal one: a grey shimmer bar at the inset indent, sized to approximate a
card. Shows during the fetch.

**Tier B failure stub:**

```tsx
<div className="ml-8 label-ui text-grey-400 py-3">
  ↳ PARENT POST · COULDN'T REACH {instanceDomain}
</div>
```

Not an error banner. A quiet, informative line. The source attribution on
the anchor card still works — the reader can open the original.

Extract the instance domain from the item's `sourceItemUri`
(e.g. `https://mastodon.social/users/...` → `MASTODON.SOCIAL`).

**Tier C/D empty state:**

```tsx
<div className="ml-8 label-ui text-grey-400 py-6 text-center">
  NO CONVERSATION YET — BE THE FIRST TO REPLY
</div>
```

Doubles as a reply affordance — clicking it could open the reply composer.

**Files:**

| File                                            | Change                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `web/src/components/feed/NeighbourhoodCard.tsx` | Add skeleton, failure stub, and empty-state variants.                                                    |
| `web/src/hooks/useNeighbourhood.ts`             | Return `partial: true` on tier-B fetch failure so the UI can render the stub. Carry the instance domain. |
| All three card components                       | Pass tier to expansion rendering for state selection.                                                    |

**Acceptance:**

- Expanding a Bluesky reply shows a skeleton, then the parent.
- Expanding a Mastodon reply where the instance is unreachable shows the
  quiet stub with the instance name — not an error banner.
- Expanding an RSS item with no replies shows `NO CONVERSATION YET`.
- Expanding an RSS item with native all.haus replies shows those replies
  (no parent).

**Effort:** Half a day. Mostly conditional rendering.

---

### Slice 2D: Thread walking controls

Bounded, reader-initiated thread traversal (§V.3).

**Upward (parent chain):**

If the expanded parent is itself a reply (it has its own `sourceReplyUri`),
render a `↳ SHOW PARENT` control on the parent card. Clicking it fetches
one more hop up and renders it above the existing parent, further indented.

Each fetch is one HTTP call (the existing `/parent` endpoint). The UI
nests: grandparent → parent → anchor → replies. Indent each ancestor one
additional step (32px per level, capped at 3–4 levels to prevent runaway
nesting).

**Downward (reply pagination):**

First expansion loads one page of replies (e.g. 10). If more exist, show:

```
SHOW N MORE REPLIES
```

Mono-caps, grey-400, underlined on hover. Clicking loads the next page.
Cursor-based pagination using the existing thread endpoint's `cursor`
support.

**Files:**

| File                                            | Change                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `web/src/components/feed/NeighbourhoodCard.tsx` | Add `↳ SHOW PARENT` control on parent cards that are replies.                        |
| `web/src/hooks/useNeighbourhood.ts`             | Support incremental parent fetching (add to parent chain). Support reply pagination. |

**Acceptance:**

- A Bluesky reply whose parent is also a reply shows `↳ SHOW PARENT` on
  the parent card.
- Clicking `↳ SHOW PARENT` fetches and renders the grandparent.
- A thread with 20+ replies shows the first 10 and `SHOW 10 MORE REPLIES`.
- Clicking the control loads the next page inline.
- No auto-fetching — every fetch is reader-initiated.

**Effort:** Half a day.

---

### Phase 2 total — SHIPPED 2026-05-26

~4 days. Ships the core interactive improvement: body click reveals the
whole conversational neighbourhood inline.

---

## Phase 3 — Author affordances

Ship: hover modal for author identity, byline-click routing, touch action
sheet.

**Prerequisite:** Phase 2 green.

### Slice 3A: Author/source metadata endpoint

A gateway endpoint serving the §VI.1 modal payload, shaped by biddability
tier. Consolidates existing author resolution paths — **one resolution path,
four output shapes.**

**Endpoint:**

```
GET /api/v1/author-card?type={native|external}&id={authorId|externalItemId}
```

`requireAuth`, rate-limited (30 req/min per user, same as resolver).

**Response shape:**

```typescript
interface AuthorCard {
  tier: "A" | "B" | "C" | "D";
  // Present on A/B — the person
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  // Present on C — the source/feed
  sourceName?: string;
  sourceDescription?: string;
  sourceUrl?: string;
  // Follow affordance
  followTarget?: {
    type: "user" | "source";
    id: string;
    isFollowing: boolean;
  };
}
```

**Resolution logic by tier:**

- **Tier A, native:** local DB lookup (`accounts` table). Display name,
  avatar, bio, follower/following counts from existing profile fields.
  Follow target: the user account. Reuse `useWriterName` resolution path.

- **Tier A, Bluesky:** `getProfile` via AppView
  (`public.api.bsky.app/xrpc/app.bsky.actor.getProfile`). Already used
  in `atproto-resolve.ts` for the resolver. Extract display name, handle,
  avatar, bio (`description`), follower/following/post counts. Follow
  target: the external source. Cache: 5-min in-memory.

- **Tier A, external Nostr:** kind-0 profile fetch from relay set. Already
  done in the resolver's Phase B chain. Display name, about, picture.
  Follow target: external source. Cache: 5-min.

- **Tier B, Mastodon/AP:** WebFinger + actor fetch. Already in
  `activitypub-resolve.ts` (`fetchActorProfile`). Extract display name,
  handle (acct), avatar, bio (summary), follower/following/post counts
  from the actor object. May fail — return partial data. Follow target:
  external source. Cache: 5-min.

- **Tier C (RSS with author URI):** source-level data only. Feed name,
  description from `external_sources`. No person. Follow target: the
  source. No outbound fetch needed.

- **Tier D (RSS without author URI):** bare author string from the item.
  `LIMITED INFO FROM THIS SOURCE`. Follow target: the source if
  subscribable, omitted if not.

**Outbound fetch resilience:** 5s hard timeout on all outbound calls. On
failure, return whatever data is locally available (source metadata from DB)
plus `partial: true`. The modal renders what it gets.

**Reuse, don't reimplement.** The resolver, `atproto-resolve.ts`, and
`activitypub-resolve.ts` already have the fetch + parse logic for Bluesky
and AP profiles. Import and call those helpers.

**Files:**

| File                                      | Change                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `gateway/src/routes/author-card.ts` (new) | New route file. Registered alongside existing routes.       |
| `gateway/src/lib/atproto-resolve.ts`      | Expose profile fetch as a reusable function if not already. |
| `gateway/src/lib/activitypub-resolve.ts`  | Same — expose actor profile fetch.                          |
| `gateway/src/index.ts`                    | Register the new route.                                     |

**Acceptance:**

- `GET /author-card?type=native&id={userId}` returns local profile data.
- `GET /author-card?type=external&id={externalItemId}` for a Bluesky item
  returns Bluesky profile data with follower counts.
- Same for a Mastodon item — returns whatever the actor doc provides.
- RSS item returns source-level data only.
- Timeout/failure returns partial data, not a 500.

**Effort:** 1 day.

---

### Slice 3B: Author modal (desktop hover)

A lightweight hover modal on byline hover — minimal bio, platform stats,
instant Follow.

**Trigger:** 300ms hover-intent delay on the byline cluster (author name +
avatar/pip). Dismiss on mouse-leave. Desktop only — touch has no modal
(§VIII).

**Implementation:**

```tsx
function AuthorModal({ item, anchorRect }: Props) {
  const { data, loading } = useAuthorCard(item);
  // Position relative to anchorRect (above or below byline)
  // Render tier-appropriate content
}
```

**Content by tier:**

| Tier  | Content                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------- |
| **A** | Avatar, display name, handle, bio (2 lines max), follower/following counts, Follow button               |
| **B** | Whatever webfinger + actor returned. Missing fields omitted (no empty rows). Follow button              |
| **C** | Feed name, feed description. Follow button (follows the feed/source)                                    |
| **D** | Bare author string + `LIMITED INFO FROM THIS SOURCE`. Follow button if source exists, omitted otherwise |

**Follow button behaviour:**

- Native authors: existing follow mechanism (POST /follows).
- External sources: existing subscribe mechanism (POST /external-feeds
  subscribe).
- Optimistic UI — button flips on click, reverts on failure.

**Hover-intent:**

Use a 300ms `setTimeout` on `mouseenter`, clear on `mouseleave`. If the
mouse leaves before 300ms, no modal. If the mouse enters the modal itself,
keep it open (the modal is part of the hover zone). Standard hover-card
pattern.

**Positioning:**

Render as a portal, positioned relative to the byline element's bounding
rect. Prefer rendering below the byline; flip above if near the viewport
bottom. Width: ~300px. Max height: ~400px.

**Files:**

| File                                            | Change                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `web/src/components/feed/AuthorModal.tsx` (new) | Hover modal component. Tier-aware content rendering.                      |
| `web/src/hooks/useAuthorCard.ts` (new)          | Hook wrapping `GET /author-card`. In-memory cache (5-min TTL per author). |
| `web/src/components/feed/ArticleCard.tsx`       | Wrap byline in hover-intent trigger → `AuthorModal`.                      |
| `web/src/components/feed/NoteCard.tsx`          | Same.                                                                     |
| `web/src/components/feed/ExternalCard.tsx`      | Same.                                                                     |

**Acceptance:**

- Hovering a native author's byline for 300ms shows a modal with avatar,
  name, bio, counts, and a working Follow button.
- Hovering a Bluesky author shows Bluesky profile data.
- Hovering a Mastodon author shows whatever was fetchable.
- Hovering an RSS feed's byline shows the feed name and description.
- Moving the mouse away dismisses the modal.
- Following from the modal works (optimistic, reverts on error).
- No modal on touch devices.

**Effort:** 1.5 days.

---

### Slice 3C: Byline click routing

Clicking (not hovering) the byline navigates to the author surface.

**Routing rules:**

- **Native authors:** `/{username}` — the existing writer profile page.
  No change from current behaviour, but make it consistent across all
  native card types.
- **External authors/sources:** navigate to the **source surface** —
  the `/subscriptions` page filtered to that source, or a dedicated source
  page if one exists. This is the interim destination per §VI.2 until
  constructed author profiles (§VI.3) ship.

**Files:**

| File                                       | Change                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `web/src/components/feed/ArticleCard.tsx`  | Ensure byline click navigates to `/{username}`.                                         |
| `web/src/components/feed/NoteCard.tsx`     | Same.                                                                                   |
| `web/src/components/feed/ExternalCard.tsx` | Byline click navigates to the source surface. `stopPropagation` to prevent body-expand. |

**Acceptance:**

- Clicking a native author's name navigates to their profile.
- Clicking an external author's name navigates to a source-related page.
- The click is distinct from hover (no 300ms delay; instant navigation).

**Effort:** 3–4 hours.

---

### Slice 3D: Touch adaptations + `⋯` action sheet

Desktop hover/click split maps to a principled touch equivalent (§VIII).

**Changes for touch:**

1. **Body tap → expand neighbourhood.** Identical to desktop click. No
   change needed — the Phase 2 `handleBodyExpand` works on tap.

2. **Byline tap → navigate to author surface.** No modal. The modal is a
   hover artefact; touch skips it. The 300ms hover-intent handler should
   check `window.matchMedia('(hover: hover)')` or similar to suppress on
   touch devices.

3. **Secondary actions behind `⋯`.** On touch viewports (or narrow
   viewports), secondary actions (quote, bookmark, share) move behind a
   single `⋯` button that opens a small action sheet.

**`⋯` action sheet:**

- Trigger: a `⋯` button rendered in the action row on touch/narrow
  viewports.
- Content: a small bottom sheet or popover with the secondary actions.
- Primary actions (reply, vote) remain always visible.

**Detection:** Use `@media (hover: none)` in CSS or a `useIsTouchDevice`
hook. Prefer CSS media query for the action row layout switch.

**Keyboard parity:** Secondary actions are also revealed on card
keyboard-focus (`focus-within`), so hover-gated controls are reachable
without a pointer.

**Files:**

| File                                            | Change                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `web/src/components/feed/ActionSheet.tsx` (new) | Bottom sheet / popover for secondary actions.                      |
| `web/src/components/feed/ArticleCard.tsx`       | Action row: primary always visible, secondary behind `⋯` on touch. |
| `web/src/components/feed/NoteCard.tsx`          | Same.                                                              |
| `web/src/components/feed/ExternalCard.tsx`      | Same.                                                              |
| `web/src/components/feed/AuthorModal.tsx`       | Suppress on touch devices.                                         |

**Acceptance:**

- On a touch device (or narrow viewport), secondary actions are behind `⋯`.
- Tapping `⋯` opens a small action sheet with quote, bookmark, share.
- Reply and vote remain always visible.
- Byline tap navigates directly — no modal.
- Tab-focusing a card reveals secondary actions (keyboard parity).

**Effort:** 1 day.

---

### Phase 3 total — SHIPPED 2026-05-26

~4 days. Ships the author identity layer and completes the touch adaptation.

---

## Full timeline

| Phase                                 | Slices | Effort    | Cumulative |
| ------------------------------------- | ------ | --------- | ---------- |
| **Phase 1** — Region map + foundation | 1A–1E  | ~2.5 days | 2.5 days   |
| **Phase 2** — Neighbourhood expansion | 2A–2D  | ~4 days   | 6.5 days   |
| **Phase 3** — Author affordances      | 3A–3D  | ~4 days   | 10.5 days  |

## Tracked deferred items

Per §VI.3 of the ADR, the following must be tracked in `feature-debt.md`:

> Constructed external author profile pages — unified cross-platform post
> history. Deferred from CARD-BEHAVIOUR-ADR §VI.3. Needs its own ADR.

**Status:** Already tracked in `feature-debt.md` per the 2026-05-25 work
session that created the ADR.

Also deferred:

- External-item permalink page (§IX) — headline click on external cards
  currently opens the source URL as an interim.
- Pre-fetching parents at ingest — rejected in favour of on-demand
  hydration. Revisit if the skeleton feels crummy.
- VesselCard unification — inherits the interaction model after the feed
  cards are green.

## File impact summary

**New files:**

| File                                            | Phase | Purpose                          |
| ----------------------------------------------- | ----- | -------------------------------- |
| `migrations/097_feed_items_is_reply.sql`        | 1A    | Schema change + backfill         |
| `web/src/hooks/useNeighbourhood.ts`             | 2A    | Neighbourhood hydration hook     |
| `web/src/components/feed/NeighbourhoodCard.tsx` | 2B    | Inset parent/reply card renderer |
| `gateway/src/routes/author-card.ts`             | 3A    | Author/source metadata endpoint  |
| `web/src/components/feed/AuthorModal.tsx`       | 3B    | Hover modal                      |
| `web/src/hooks/useAuthorCard.ts`                | 3B    | Author card data hook            |
| `web/src/components/feed/ActionSheet.tsx`       | 3D    | Touch action sheet               |

**Modified files (significant changes):**

| File                                            | Phase                      | Change                                                       |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `web/src/components/feed/ArticleCard.tsx`       | 1C, 1D, 2B, 3B, 3D         | Click region split, provenance line, expansion, hover, touch |
| `web/src/components/feed/NoteCard.tsx`          | 1C, 1D, 2B, 3B, 3D         | Same                                                         |
| `web/src/components/feed/ExternalCard.tsx`      | 1C, 1D, 1E, 2B, 2C, 3B, 3D | Same + source attribution link + failure states              |
| `gateway/src/routes/timeline.ts`                | 1A, 1B                     | Feed query + response: `is_reply`, `biddabilityTier`         |
| `feed-ingest/src/lib/atproto-ingest.ts`         | 1A                         | Add `is_reply` to feed_items INSERT                          |
| `feed-ingest/src/lib/activitypub-ingest.ts`     | 1A                         | Same                                                         |
| `feed-ingest/src/lib/email-ingest.ts`           | 1A                         | Same                                                         |
| `feed-ingest/src/tasks/feed-ingest-rss.ts`      | 1A                         | Same                                                         |
| `feed-ingest/src/tasks/feed-ingest-nostr.ts`    | 1A                         | Same                                                         |
| `feed-ingest/src/tasks/feed-items-reconcile.ts` | 1A                         | Add `is_reply` to reconciliation INSERTs                     |
| `gateway/src/routes/notes.ts`                   | 1A                         | Add `is_reply` to note feed_items INSERT                     |
| `gateway/src/routes/articles/publish.ts`        | 1A                         | Add `is_reply` to article feed_items INSERT                  |
| `gateway/src/services/publication-publisher.ts` | 1A                         | Add `is_reply` to both article feed_items INSERTs            |
