# MOBILE-LAYOUT-ADR: The Mobile Workspace — Single-Feed Paging

**all.haus Architectural Decision Record**
**Status:** Proposed, 2026-06-08. Revised 2026-06-11 (hidden-state residency decided,
numbering unified across surfaces, shell reconciled with the chromeless-workspace
invariant, stale references fixed). Not yet sliced into the build plan. Supersedes the
pre-workspace mobile view, which has not been touched since the canvas was built.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** WORKSPACE-FULL-VIEW-SPEC, UI-DESIGN-SPEC, CARD-BEHAVIOUR-ADR (§VIII touch idiom), UNIVERSAL-FEED-ADR
**Affects:** `web/src/components/workspace/*`, `web/src/stores/workspace.ts`, `gateway/src/routes/feeds.ts`, `schema.sql`, `migrations/`

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_. Where it
> names a file, endpoint, column, or constant, treat that as the intended shape unless
> you find a concrete reason it cannot work — in which case stop and flag it rather than
> improvising a divergent design. Phasing is in §VIII; Slice 1 is the data spine and
> precedes everything else.

---

## I. Problem statement

The mobile view has not been reworked since the workspace canvas landed. The canvas is
an inescapably pointer-spatial paradigm: `Vessel.tsx` is a ⊔-chassis the user drags to
position, resizes, reorients (⊔/⊏), and merges by dragging one onto another, with each
feed's `{x, y}` held in the `positions` map in `stores/workspace.ts`. None of that has a
touch translation. Drag-to-arrange on a 380px viewport is not a degraded version of the
desktop interaction — it is no interaction at all.

So mobile is not a responsive reflow of the workspace. It is a **different interaction
model that presents the same feeds**: one feed per screen, paged horizontally. The
desktop's spatial affordances do not shrink onto the phone; they are simply absent
there, and the feed's identity is carried instead by its numeral.

---

## II. Design principles

1. **Reduction, not port.** The spatial canvas does not exist on touch. We do not
   apologise for its absence or gesture at a miniature of it; mobile is its own surface.

2. **Keep feed _character_, drop feed _arrangement_.** The colour scheme and density
   are properties of a feed and travel with it to mobile. Position, size, orientation,
   and merge are properties of the _canvas_ and stay on the desktop. Hide, though it
   began life in the layout store alongside position, is feed character — "I don't want
   to see this feed" is true of the feed, not of one screen's arrangement of it — and
   moves server-side accordingly (§V).

3. **The numeral is the spine.** A feed's number is both the identity the reader sees
   and the order they swipe through. This forces the numeral to become real, persisted
   state (§VII) rather than the render-time accident it is today.

4. **One gesture, one job** (per CARD-BEHAVIOUR §II.1). Horizontal swipe is claimed at
   the _page_ level for moving between feeds. This does not contend with card actions:
   CARD-BEHAVIOUR §VIII already fixes the touch idiom as tap-through plus the `⋯` action
   sheet, with no horizontal card swipe. The two gestures live on different objects.

---

## III. Shell

The mobile workspace gets a **thin mobile bar** — a new lightweight component, **not**
the existing black `<Nav>`. The topbar is full of route escapes (logo → `/`, the search
form, the compose button, every `MobileSheet` link), and the workspace chrome invariant
— no surface reachable from the workspace may escape to the black topbar — applies on
mobile exactly as on desktop. `LayoutShell` keeps the workspace chromeless; the bar
carries the wordmark, the **feed indicator strip** (§IV), and a burger opening the
**ForallMenu** — already the ∀ command surface for the overlays (messages,
notifications, search, ledger, profile, new-feed). Every affordance on the bar opens an
overlay or sheet; none navigates to a platform route.

On mobile those overlays become **full-screen sheets**; they exist today as overlays,
so this is presentation, not rearchitecting. Compose follows the desktop workspace's
existing bridge: the global `ComposeOverlay` is not mounted in the chromeless
workspace, so mobile compose goes through `useCompose.open(...)` → the workspace
`Composer`, same as desktop.

Below the bar, the rest of the viewport is the **active feed, full-bleed**. No vessel
walls, no chassis, no canvas — the ⊔ is a desktop chrome and does not render on mobile.

---

## IV. Moving between feeds

- **Vertical scroll** moves within the active feed (the existing `PullToRefresh`
  vertical gesture is unaffected — see §VI on axis orthogonality).
- **Horizontal swipe** pages between feeds, in **rank order** (§VII).
- A slim **indicator strip** in the mobile bar (§III) shows _feed N of M_ and supports
  tap-to-jump. This is non-negotiable: a pure swipe pager with no indicator is a known
  discoverability trap, and the strip doubles as the visible form of the rank order.
- **Resume and deep-links key off the feed `id`, never the numeral.** The numeral is a
  positional label and will shift under reorder, delete, and hide; a stored numeral
  would silently point at the wrong feed.

---

## V. Hidden feeds

**Hide becomes feed character and moves server-side.** Today `hidden` is per-device
localStorage layout state (`positions[feedId].hidden` in `stores/workspace.ts`), which
cannot drive the mobile rotation: a fresh phone would see every feed regardless of what
the desktop hid, and mobile has no vessel chassis to carry the hide affordance. So the
same migration that adds `sort_rank` adds `hidden boolean NOT NULL DEFAULT false` on
`feeds` (§VII); the desktop hide/unhide controls rewire to write through the feeds
`PATCH`, and the mobile per-feed settings sheet (§VI) gains a hide toggle. On first
hydrate after the migration, the desktop client pushes any locally-hidden flags up
(one-time reconciliation) so existing hides don't pop back on deploy.

Hidden feeds are **excluded from the swipe rotation**, and — one rule on both surfaces —
**numbering skips hidden feeds**: visible feeds number 1…N with no gaps, on the desktop
badges and the mobile pager alike. A gap in a swipe sequence (1 → 3 → 4) reads as a bug,
and a feed wearing different numerals on different surfaces would break principle 3.
The cost is that a feed's number can shift on hide/unhide — consistent with the numeral
already shifting on delete, and the correct trade. (Note: the desktop currently numbers
_all_ feeds, hidden included — `WorkspaceView.tsx` assigns numerals before filtering —
so for users with hidden feeds, Slice 1 visibly renumbers the desktop badges. That is
the unification taking effect, not a regression.)

---

## VI. Per-feed appearance, and what is dropped

**Retained:** the colour scheme, density, and the hide toggle (§V), surfaced through a
per-feed **settings sheet** — the mobile form of the FeedComposer gear that already owns
appearance on desktop. (Since 2026-06-11 the colour scheme — brightness's successor,
the six-swatch `SchemePicker` — already persists server-side on
`feeds.appearance.scheme`, migration 112, so it travels to mobile for free; **density is
the remaining per-device localStorage gap**, and `feeds.appearance` JSONB is its natural
landing spot — no new migration needed for a JSONB key. Density must follow the
scheme's precedence pattern exactly — server-persisted, mirrored into the layout store
as the per-device cache/fallback — one sync model, not a second.)

**Dropped on mobile:** orientation (meaningless at full-bleed — there is one column and
it is the screen), resize, drag-to-position, and merge-by-drag. These are canvas
operations with no spatial substrate on the phone.

**Axis orthogonality.** The pager (horizontal) and scroll/pull-to-refresh (vertical) sit
on perpendicular axes and do not contend. The first hazard is the orientation logic in
`Vessel.tsx`, where a horizontal vessel scrolls its _contents_ horizontally; that inner
horizontal scroll would fight the pager. Because orientation is dropped on mobile
(principle II.2), force vertical layout there and the hazard cannot arise. Second: card
_content_ can still scroll horizontally regardless of orientation — wide embeds,
`pre`/code blocks in articles, media — so the pager must **axis-lock with a pan
threshold**: claim the gesture only once a drag is decisively horizontal, and never
when it began inside a horizontally-scrollable element. Third, minor: the pip swallows
taps via a bubble-phase `stopPropagation` (`PipTrigger.tsx`), which a page-level pan
handler sees regardless — the pager and the pip must not both claim a drag begun on the
pip; resolve in favour of the pip.

---

## VII. Feed ranking and the `sort_rank` migration

This is the substantive data change, and it is shared by both surfaces.

Today there is **no order stored anywhere**. The numeral is derived live in
`WorkspaceView.tsx` as _sort feeds by `createdAt`, take the index + 1_. The `feeds` table
carries only `id`, `owner_id`, `name`, `appearance` (jsonb, migration 112 — the per-feed
colour scheme), and timestamps. The moment a user can re-rank
feeds, order becomes intentional state that must persist:

1. **Schema.** Add `sort_rank integer` and `hidden boolean NOT NULL DEFAULT false`
   (§V) to `feeds` — one new migration, with the matching `schema.sql` dump regenerated
   in the same step so the drift check stays green. Backfill `sort_rank` in current
   `createdAt` order so nothing jumps on deploy; `hidden` backfills to false, with the
   desktop client's one-time push of locally-hidden flags covering existing hides (§V).
2. **Derivation.** Switch the client numeral from the `createdAt` sort to `sort_rank`,
   numbering **visible feeds only** (§V). This unifies the two surfaces: desktop badges
   and mobile swipe order read the same field under the same rule, and "Feed 1" becomes
   a thing the user _chose_ rather than an accident of which feed they made first.
3. **Write path.** The feed `PATCH` already exists on `gateway/src/routes/feeds.ts`
   (rename + appearance); extend it to carry `hidden`, and add a bulk-reorder endpoint
   (or equivalent) to persist a re-rank. Ranks are plain integers, rewritten in full on
   each reorder — feeds per user are few, so lexorank-style fractional keys are
   unjustified complexity.
4. **UI.** A drag-to-rank list of all feeds in **FeedComposer**, which already owns
   rename / delete / source list / appearance and is the natural home.

**Rank and canvas position are fully independent — by design.** They answer different
questions: rank is "what number is this feed, and where does it sit in the swipe order";
position is "where does its vessel sit on the desktop canvas." They may freely disagree —
rank-1 may sit bottom-right on the canvas, and the desktop numeral badges will therefore
look scattered across the workspace. That is expected behaviour under decoupling, not a
defect to be reconciled.

---

## VIII. Phasing

Slices are ordered by dependency. Slice 1 is pure data/refactor and changes no visible
behaviour; the migration must land and be green before anything builds on it.

1. **Rank and hide as data.** Add `sort_rank` + `hidden` + migration + `schema.sql`
   dump + backfill; rewire the desktop hide/unhide controls to the `PATCH` and add the
   one-time local-hide reconciliation (§V); move the client numeral derivation from
   `createdAt` to `sort_rank`, numbering visible feeds only. No new UI surface; desktop
   looks identical except that badges now skip hidden feeds (§V — the unification).
2. **Reorder UI.** Drag-to-rank list in FeedComposer; the `feeds` reorder endpoint.
   Available on both surfaces (it is one component).
3. **Mobile shell.** The thin mobile bar (wordmark · indicator strip · burger →
   ForallMenu) — a new component, **not** the black `<Nav>`, per §III; ForallMenu
   overlays as full-screen sheets; compose bridged through `useCompose.open` → the
   workspace `Composer`; single full-bleed active feed; orientation/resize/position/
   merge suppressed on the mobile breakpoint.
4. **The pager.** Horizontal swipe over _visible_ feeds in rank order; indicator strip
   with tap-to-jump; hidden feeds excluded and 1…N renumbering; resume-by-`id`. Resolve
   axis-locking and the pip gesture precedence here (§VI).
5. **Per-feed appearance sheet.** Colour scheme, density, and the hide toggle on mobile
   via the settings sheet; density lands in `feeds.appearance` following the scheme's
   server-plus-local-mirror precedence pattern (§VI; migration 112 precedent).

Do not start Slice 4 before Slice 1 is green: the pager has no order to page through
until the rank exists.
