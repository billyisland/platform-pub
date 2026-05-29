# Workspace Full View — Diagnosis & Fixes

**Branch:** `workspace-experiment` (merged to `master` 2026-05-29)
**Scope:** Three reported bugs against `WORKSPACE-FULL-VIEW-SPEC.md`
**Date:** 2026-05-25

This document diagnoses three feed bugs and proposes fixes. Each section
states the symptom, the root cause with file/line references, and a concrete
patch. The fixes are independent and can land in any order.

The reporter has confirmed the affected vessels are in **standard / full**
density (not compact), so the compact-density render gate is _not_ the cause
of any of these. That confirmation narrows Q2 and Q3 to the issues below.

---

## Bug 1 — Feed does not refresh on scroll-to-top

### Symptom

On a workspace feed vessel, overscrolling at the top (wheel-up on desktop,
touch-drag-down on mobile) does not trigger a refresh. The spec (§8) requires
pull-to-refresh on every vessel.

### Root cause

`PullToRefresh` delegates scroll detection to `findScrollParent`, which only
recognises an element as a scroll container if its computed `overflow-y` is
`auto` or `scroll`:

`web/src/components/workspace/PullToRefresh.tsx` lines 19–27:

```ts
function findScrollParent(el: HTMLElement): HTMLElement {
  let cur = el.parentElement;
  while (cur) {
    const { overflowY } = getComputedStyle(cur);
    if (overflowY === "auto" || overflowY === "scroll") return cur;
    cur = cur.parentElement;
  }
  return el; // <-- fallthrough: returns the PullToRefresh div itself
}
```

But the Vessel's content div only sets `overflow-y: auto` **conditionally** —
when the user has manually resized the vessel to a fixed height.

`web/src/components/workspace/Vessel.tsx` line 380:

```ts
overflowY: heightSet && !isHorizontal ? "auto" : undefined,
```

`heightSet` is `effH !== undefined` (line 197), and `effH` is only defined
once the user drags the resize handle. A vessel at its **default intrinsic
height has no scroll container at all**.

Consequences for a default-height vessel:

- `findScrollParent` walks up, finds nothing with `overflow-y: auto|scroll`,
  and falls through to `return el` — returning the `PullToRefresh` wrapper
  itself.
- The guards `scroller.scrollTop > 0` (lines 56 and 98) then read
  `scrollTop` off the wrong element. The wrapper div is not the scroller, so
  its `scrollTop` is `0` regardless of where the page is scrolled.
- The gesture either never arms correctly or competes with page-level scroll.

**Net effect:** pull-to-refresh only works on a vessel the user has manually
given a fixed height. Default-height vessels — the common case — never
refresh on overscroll.

### Fix

The cleanest fix is to stop DOM-walking and have `Vessel` pass its content
div to `PullToRefresh` explicitly. The Vessel already owns that div and knows
exactly which element scrolls.

**Option A (preferred) — explicit scroll-container ref.**

In `Vessel.tsx`, add a ref to the content div and pass it down:

```tsx
// Vessel.tsx — add near the other refs (~line 120)
const scrollBodyRef = useRef<HTMLDivElement>(null);

// ...the content div (~line 371) gains the ref:
<div
  ref={scrollBodyRef}
  onPointerDown={(e) => e.stopPropagation()}
  style={
    {
      /* unchanged */
    }
  }
>
  {onRefresh ? (
    <PullToRefresh onRefresh={onRefresh} scrollRef={scrollBodyRef}>
      {children}
    </PullToRefresh>
  ) : (
    children
  )}
</div>;
```

In `PullToRefresh.tsx`, accept the ref and prefer it over `findScrollParent`:

```tsx
interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  scrollRef?: RefObject<HTMLElement>;
}

// inside the component, replace each `findScrollParent(el)` call site:
const scroller = scrollRef?.current ?? findScrollParent(el);
```

`findScrollParent` stays as a fallback but is no longer load-bearing.

**Option B (also required regardless) — make the content div always a real
scroll container.**

Even with Option A, a default-height vessel's content div is _not_
overflowing — it grows to fit content, so there is nothing to scroll and
`scrollTop` is always `0`. That actually satisfies the "at the top" guard,
which is fine. But the vessel body should still cap its height so long feeds
do not push the vessel off the floor. Consider giving the content div a
sensible `maxHeight` and `overflow-y: auto` unconditionally:

```ts
// Vessel.tsx content div style
overflowY: isHorizontal ? undefined : "auto",
maxHeight: heightSet ? undefined : DEFAULT_BODY_MAX_HEIGHT, // e.g. 70vh
```

This makes the body a genuine scroll container in all cases, which both fixes
pull-to-refresh detection and bounds vessel growth. If the design
deliberately wants unbounded-height vessels, skip this and rely on Option A
alone — but then confirm the spec's intent, because §8.1 explicitly assumes
the Vessel content div is the scroller.

### Verification

- Default-height vessel, desktop: wheel-up at the top shows
  `↑ PULL TO REFRESH`, then `RELEASE TO REFRESH`, then refetches.
- Default-height vessel, mobile: touch-drag-down at the top does the same.
- Fixed-height (resized) vessel: still works (regression check).

---

## Bug 2 — Likes / replies / reposts not visible on feed items

### Symptom

Engagement counts (heart / speech-bubble / repost) do not appear on workspace
feed items.

### What is NOT the cause

- **Density gate:** ruled out — vessels are in standard/full. `EngagementRow`
  in `VesselCard.tsx` is rendered at line 1458, _outside_ the
  `expanded ? (...) : (...)` ternary, so it renders in both collapsed and
  expanded states for standard/full density.
- **Data plumbing:** verified intact end-to-end on this branch.
  `FEED_SELECT` (`gateway/src/routes/feeds.ts` lines 1061–1062) selects
  `ei.like_count / reply_count / repost_count`; `rowToItem` (lines 1168–1170)
  maps them; `mapExternalApiItem` (`WorkspaceView.tsx` lines 137–139) carries
  them; `EngagementRow` renders them.
- **Engagement-refresh cron:** verified present and scheduled —
  `external_engagement_refresh`, every 30 min (`feed-ingest/src/index.ts`
  line 96), task at `feed-ingest/src/tasks/external-engagement-refresh.ts`.
  The task's query correctly uses `external_items.protocol` (the
  `source_protocol` name belongs to `feed_items`, a different table).

### Root cause — `EngagementRow` visibility rule

`web/src/components/workspace/VesselCard.tsx` lines 675–679:

```ts
const hideRepost = protocol === "nostr_external" || protocol === "rss";
const hideLike = protocol === "rss";
const hideReply = protocol === "rss";
const showLike = !hideLike && (likeCount > 0 || onLike);
const showReply = !hideReply && (replyCount > 0 || onReply);
const showRepost = !hideRepost && (repostCount > 0 || onRepost);
if (!showLike && !showReply && !showRepost) return null;
```

A count column renders **only if** the count is `> 0` **or** an interaction
handler is present. There are two distinct failure modes here:

**2a. Counts are genuinely zero because nothing has populated them.**
The migration default for `like_count / reply_count / repost_count` is `0`.
The snapshot cron only updates items **published within the last 7 days**
(`LOOKBACK_DAYS = 7`). Any item older than 7 days at ingest, or ingested
while the worker was down, keeps `0`. With `onLike`/`onReply`/`onRepost`
undefined (e.g. no linked account for that protocol — see below), the whole
row collapses to `return null`. **Result: no engagement row at all.**

**2b. Interaction handlers are undefined, so zero-count items show nothing.**
`onLike` / `onRepost` are only passed when a **linked account** exists for
the item's protocol (`ExternalVesselCard` lines 1463–1485 — `matchingAccount`
gates them). `onReply` is passed for all non-RSS items. So for a user with
**no linked accounts**, a zero-count Bluesky/Mastodon item has
`onLike = undefined`, `onRepost = undefined`, and only `onReply` defined —
meaning the row renders, but shows only an empty reply icon. For Nostr-
external, repost is hidden and like needs an account, so a zero-count item
shows only the reply icon. This is technically per-spec (§5) but reads as
"engagement is broken" because the row is nearly empty.

**Likely real-world cause:** combination of 2a and 2b — the snapshot cron has
not populated counts (worker not running in the environment, or items too
old), so every item is at `0`, and without linked accounts the rows are
empty or absent. **First diagnostic step: check whether the
`feed-ingest` worker is actually running and whether
`external_engagement_refresh` has logged `"external engagement refresh
complete"`.** If the worker is down, that alone explains the symptom.

### Fix

**Fix 2a — backfill + widen the snapshot window once.**
If the deployment has existing external items at `0`, run a one-off backfill
(or temporarily raise `LOOKBACK_DAYS`) so historic items get counts. Also
confirm the `feed-ingest` worker is deployed and the cron is firing — grep
logs for `external engagement refresh complete`.

**Fix 2b (design call) — always show the engagement row in standard/full.**
If the intent is that the row is always visible (even at all-zero counts, as
a consistent affordance), change the collapse rule so it does not vanish:

```ts
// VesselCard.tsx ~line 679 — instead of `return null` on all-zero:
// keep the row for non-RSS items so counts read as "0", not "absent".
if (protocol === "rss") return null;
```

This is a product decision: current code hides a fully-zero row entirely.
The spec (§1.1, §2.4) implies the engagement row is a standard part of the
card in both modes, which argues for keeping it visible. Confirm intent
before applying 2c.

### Verification

- With the worker running, after one cron cycle, Bluesky/Mastodon items
  published in the last 7 days show non-zero counts.
- A user with no linked accounts still sees counts (numbers), just with
  non-interactive (greyed) buttons.
- RSS items show no engagement row (correct per §2.2 / §5.5).

---

## Bug 3 — A feed item that is a reply does not show its parent

### Symptom

When a workspace feed item is itself a reply (`source_reply_uri` is set), the
parent post is not shown above it. The spec (§3.1) requires the parent to
render as a first-class tile, _"not collapsed, ghosted, or visually
diminished,"_ with the reply directly below it.

### Root cause — `ParentContextTile` is gated behind the expand toggle

`web/src/components/workspace/VesselCard.tsx`, `ExternalVesselCard`,
lines 1349–1352:

```tsx
{
  expanded ? (
    <>
      {external.sourceReplyUri && (
        <ParentContextTile itemId={external.id} palette={ctx.palette} />
      )}
      {/* ...full content, media, poll... */}
    </>
  ) : (
    <>{/* ...truncated body, media — NO ParentContextTile... */}</>
  );
}
```

The `ParentContextTile` is rendered **only inside the `expanded` branch**.
The collapsed branch has no parent tile at all.

And cards are collapsed by default — `WorkspaceView.tsx` line 229:

```ts
const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
```

`expandedCards` starts empty; `expanded` is `expandedCards.has(key)`
(line 899). So **every reply renders collapsed, with no parent**, until the
user clicks the card to expand it.

This contradicts §3.1, which describes the parent as a standalone first-class
tile visible in the feed _without_ any expansion interaction.

There are two secondary contributors worth checking alongside the primary
fix:

**3a. `source_reply_uri` may be NULL on older items.**
The collapsed _and_ expanded branches both guard on
`external.sourceReplyUri &&`. Spec §6A-4 flagged that the Mastodon parent
prefetch INSERT originally omitted `source_reply_uri`. That fix landed in
commit `4a8baac` — but only for items prefetched _after_ it. Any external
item ingested before `4a8baac` has `source_reply_uri = NULL`, so the tile
never renders regardless of expand state. Check the actual column value for
an affected item before assuming the render gate is the only problem.

**3b. Reply grouping diverts multi-reply cases.**
If two or more subscribed accounts replied to the same parent, `groupReplies`
(`feeds.ts` line 1533) collapses them into a `reply_group`, rendered by
`ReplyGroupCard` — which _does_ render `ParentContextTile` once, correctly.
A **single** reply stays a plain `external` item and goes through the
buggy expand-gated path above. So the bug presents specifically for
_solitary_ replies, which is consistent with the report.

### Fix

**Primary — render `ParentContextTile` in both states.**
Lift the parent tile out of the `expanded` ternary so it always renders for
reply items in standard/full density. In `ExternalVesselCard`, place it
immediately after `<Byline />` and before the `expanded ? ... : ...` block:

```tsx
<Byline ... />

{/* Parent context — first-class, always visible for replies (spec §3.1) */}
{external.sourceReplyUri && ctx.density !== "compact" && (
  <ParentContextTile itemId={external.id} palette={ctx.palette} />
)}

{expanded ? (
  <>
    {/* remove the ParentContextTile that was here */}
    {/* ...full content, media, poll... */}
  </>
) : (
  <>
    {/* ...truncated body, media... */}
  </>
)}
```

`ParentContextTile` already has a module-level cache (lines 13–20) keyed by
`itemId`, so rendering it unconditionally does not cause repeat fetches when
a card is expanded/collapsed.

Note: `ParentContextTile` fetches via `GET /external-items/:id/parent`, which
lazily fetches the parent from the source platform if not cached
(`gateway/src/routes/external-items.ts` line 184+). Rendering it for every
reply in a feed page will issue one request per reply. That is acceptable per
spec §13 ("lazy-fetch on render as fallback"), and the eager ingest-time
prefetch should cover most cases — but watch the network panel on a
reply-heavy feed. If it is too chatty, batch the parent fetch in the feed
response instead (out of scope for this fix).

**Secondary 3a — backfill `source_reply_uri`.**
For items ingested before commit `4a8baac`, `source_reply_uri` is NULL and no
fix to the render path will help. Either re-run the parent prefetch for
recent external items, or accept that pre-`4a8baac` items will not show
parents. Decide based on how much history matters.

**Secondary 3b — none needed.**
`ReplyGroupCard` already handles the multi-reply case correctly. No change.

### Verification

- A solitary reply item in a standard/full vessel shows its parent tile
  _without_ clicking to expand.
- The grandparent tag (`→ REPLYING TO @username`) appears on the parent tile
  when the parent is itself a reply (depends on §6A-3 grandparent
  persistence — verify separately if the tag is missing).
- A `reply_group` (2+ replies to one parent) still renders one parent tile
  via `ReplyGroupCard` (regression check).
- A reply item whose `source_reply_uri` is NULL shows no tile (expected) —
  confirm the NULL is a pre-`4a8baac` data-age artefact, not a fresh
  ingestion bug.

---

## Summary

| Bug                       | Root cause                                                                                                                   | Primary fix                                                                                                                        | Risk                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1. No scroll-to-refresh   | `findScrollParent` finds no scroll container on default-height vessels; `overflow-y` is set only on manually-resized vessels | Pass the Vessel content-div ref into `PullToRefresh` explicitly; optionally make the body a real scroll container with `maxHeight` | Low — localised to two components                                            |
| 2. No likes/replies       | Counts default to `0`; snapshot cron may not have run; `EngagementRow` collapses to `null` when all-zero with no handlers    | Confirm `feed-ingest` worker running; decide whether to keep the row visible at all-zero (design call)                             | Low                                                                          |
| 3. Reply parent not shown | `ParentContextTile` rendered only inside the `expanded` branch; cards default to collapsed                                   | Lift `ParentContextTile` out of the `expanded` ternary so it always renders for replies                                            | Low–medium — adds one parent fetch per reply on render; watch network volume |

All three are render-layer bugs on `workspace-experiment`. The backend data
path (feed query, engagement columns, reply grouping, parent endpoint) is
sound. None of the SQL or API contracts need to change for the primary fixes.

### Fixes applied

- **Bug 1** — `PullToRefresh` now accepts an explicit `scrollRef` prop; `Vessel` passes its content-div ref directly, bypassing the `findScrollParent` fallback on default-height vessels.
- **Bug 3** — `ParentContextTile` lifted out of the `expanded` ternary in `ExternalVesselCard`, so reply items show their parent tile without requiring click-to-expand.
- **Bug 2** — operational only (confirm `feed-ingest` worker running); no code typo exists (line 677 already reads `onReply`). Design call on always-visible row deferred.

### Remaining

1. Confirm the `feed-ingest` worker is running in the target environment (covers Bug 2's data side).
2. Decide on the `source_reply_uri` backfill for pre-`4a8baac` items (Bug 3 secondary).
