# NAV-ROW-MUSTER-ADR: Stable numerals and the muster row

**all.haus Architectural Decision Record**
**Status:** Proposed, 2026-07-25; **Phase 1 (stable numerals, §III), Phase 2
(the muster, §IV) and Phase 3 (polish, §VIII.3) all shipped 2026-07-25** —
Phase 4 (arrival flags, §VI) remains, deferred to its own ADR. Revised
2026-07-25 after a code review: the §IV
state flip now drives off a genuine viewport-intersection test (not the wider
`visibleIds` mount band), the roundel ring is 2px (a 1.5px ring broke the
no-single-pixel invariant and slipped its tripwire), the border-radius citation
is corrected, mobile labels announce number-and-position, and the open-pane click
behaviour (§V) and two overstatements are resolved.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** WORKSPACE-COLUMN-LAYOUT-ADR (the nav row §VI, virtualization §VII, the regimented view §V), MOBILE-LAYOUT-ADR (feed numbering via `feeds.sort_rank`; hide via `feeds.hidden`; the indicator strip §IV), FORALL-CUT-AND-LOCKUP-ADR (the lockup's position at the row's right end), PRINCIPLES
**Affects:** `web/src/components/workspace/NavRow.tsx`, `WorkspaceView.tsx`, `FeedComposer.tsx`, `MobileWorkspace.tsx`, `Vessel.tsx`
**Naming note:** this row's marks are **roundels**, and the row is the **muster**. They are not pips. `PipPanel` / `PipTrigger` / `[data-pip-trigger]` already own "pip" for the per-author trust mark on a card (CARDS-AND-PIP-PANEL-HANDOFF). `Vessel.tsx` already calls the corner numeral a roundel (`setRoundelHovered`), and "muster" belongs to the same register as §V's parade ground. Do not introduce a second pip vocabulary.

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_.
> Where it names a file, constant, or function, treat that as the intended
> shape unless you find a concrete reason it cannot work — in which case stop
> and flag it rather than improvising a divergent design. §III must ship before
> §IV: the muster is unbuildable on the current numbering.

---

## I. Problem statement

The nav row (WORKSPACE-COLUMN-LAYOUT-ADR §VI) is a 56px reserved band. The row
element itself (`NavRow.tsx`) renders empty; the ∀ lockup is docked into its
right end separately, by `ForallMenu anchor="row"`, not as a child of the row.
Its own comments describe the row as "a silent reserved band … otherwise
invisible." That was the right call when it
replaced the floating disc and the difference lens; it leaves most of the row's
width negatively defined, and there is one job it is unusually well placed to do.

The floor scrolls horizontally and virtualizes (§VII). A feed is therefore in one
of three conditions, and the workspace currently makes only the first legible:

1. **In view** — a vessel you can see.
2. **On the floor, panned off** — mounted, in the layout, outside the viewport.
   Nothing on screen says how many of these there are or which way to scroll.
3. **Minimised** — `feeds.hidden`, spliced out of the layout, reachable only by
   opening the ∀ menu and reading its restore rows.

So the workspace has no persistent answer to "how many feeds do I have, and
where am I among them". The ∀ menu answers it on demand, which is the wrong
shape for orientation — orientation should be ambient.

A second, prior problem blocks any fix. Numerals are currently assigned over the
*visible* set (`WorkspaceView.tsx`, `visibleSorted` → `feedNumerals`), so hiding
a feed renumbers every feed after it and the hidden feed loses its numeral
entirely (`FeedComposer` renders `–` for it). A numeral that changes meaning when
a neighbour is minimised cannot be the identity in a status row, because the
status row's whole content is which feeds are minimised.

## II. Design principles

1. **The numeral is identity, not position in the visible run.** A feed keeps its
   number. If you know feed 4, feed 4 is the same feed tomorrow and while feed 3
   is minimised.
2. **Orientation is ambient; it does not demand anything.** PRINCIPLES: a control
   "stays visible without demanding attention." The muster reports state. It does
   not solicit.
3. **Panning changes weight, never position.** The set of on-screen feeds changes
   continuously as you scroll. A row that re-lays-out on every frame of a pan is
   noise at the edge of vision. Roundels are fixed in a lattice of fixed cells and
   change size *within* their cell.
4. **The row is global chrome, not a feed island.** Ground stays `--ah-bone`, and
   the roundels are ink, bone and grey. Per-feed colourways stop at the vessel.
5. **One reorder surface.** Ranking stays in the FeedComposer's drag list. The
   muster reports and navigates; it does not edit.

## III. Stable numerals

**Decision.** Numerals are assigned over the **live** feed set — every
undeleted feed, hidden included — in `sortRank` order, ties broken by
`createdAt` then `id`. That is today's comparator applied to a wider domain.

Consequences, stated plainly because one of them is a visible behaviour change:

- **A hidden feed keeps its number.** It is not reassigned while the feed is away
  and not handed to a neighbour.
- **The visible run has gaps.** Minimise feed 3 and the vessels on the floor read
  1, 2, 4, 5. This is intended: the gap is the information. A reader who notices
  a missing 3 has learned something true.
- **Renumbering happens in exactly one place** — the FeedComposer's drag-rank
  list (the `FeedRankList` component, committing through its `onReorder`
  callback; there is no function literally named `handleReorderFeeds`). That
  list's `order` already includes hidden feeds, so a hidden feed can be dragged
  to a new number without being restored first. Nothing else assigns numerals.

Nothing in the schema changes. `feeds.sort_rank` already carries the order and
the numeral was always a projection of it; this ADR widens the projection's
domain from the visible set to the live set.

### III.1 What this touches

- **`WorkspaceView.tsx`.** `feedNumerals` derives from a new `liveSorted`, not
  from `visibleSorted`. `visibleSorted` stays — it is still the layout and parade
  ordering — but it is no longer the numbering domain. The comment at ~line 341
  asserting that visible feeds "read 1..N with no gaps" and that hidden feeds
  "carry no numeral until restored" is now false and must be rewritten, not left
  to rot.
- **`FeedComposer.tsx`.** In the rank list (~line 1292), `const num = f.hidden ?
  null : ++numeral` becomes the stable numeral for every row. The `–` placeholder
  goes. Hidden rows keep their existing muted weight, so the list still reads
  minimised-vs-not at a glance; it just stops lying about their number.
- **`MobileWorkspace.tsx`.** The indicator strip stays **positional** — the
  filled pip's ordinal position remains the swipe order, and mobile shows no
  numerals (MOBILE-LAYOUT-ADR §IV is unchanged in substance). Its `aria-label`s
  currently speak `i + 1`. This is a genuine tension, not a clean fix: the mobile
  strip **excludes** hidden feeds, so its pips are gapless, but the stable numeral
  is not — swap `i + 1` for the stable numeral alone and a screen-reader user
  hears "go to feed 4" for the *third* of four pips, gap-numbered labels on a
  gapless row. Positional "3 of 4" is not wrong either; it just disagrees with the
  desktop numeral. **Decision: announce both** — the label carries the stable feed
  number *and* its position (e.g. `"Feed 4, 3 of 4"`), so the number matches the
  desktop and the ordinal still tells a linear-scan user where they are. Position
  alone keeps driving the swipe. The §V comment at ~line 88 about numerals reading
  1..N with no gaps is now false for the spoken number (still true for pip
  position) and must be rewritten to say so, not left to rot.
- **Regimented mode is unaffected.** `regimentedFeeds` maps `visibleIdsKey` to
  `{ id, sortRank: i + 1 }`, but that `sortRank` is a synthetic ordering key
  consumed by `regimentedLayout` and never persisted, never rendered.
  `materializeRegimented` writes a *layout*, not ranks. Because `visibleSorted`
  remains a subsequence of the live order, the parade still falls in numeral
  order — it simply reads 1, 2, 4, 5 across the ground instead of 1, 2, 3, 4.
  Leave it alone.

### III.2 Accepted cost

Numerals grow unboundedly for a user who accumulates and minimises many feeds:
a workspace can legitimately show 2, 9, 17. The binding constraint is the
**18px** panned-off/minimised disc with its 11px numeral — tighter than the 24px
in-view state — and two digits fit it; three do not. Three digits is deferred, on
the grounds that a user with 100+ feeds has problems the muster is not going to
solve.

## IV. The muster

A centred row of numbered roundels in the nav row, between the row's left edge
and the ∀ lockup, one roundel per live feed in numeral order.

**Cells are fixed; discs are not.** Each roundel occupies a 32px cell — 4 GRID,
a 24px disc plus an 8px gutter. The cell width never changes. Size encodes
state, so the discs grow and shrink as you pan, but **no roundel moves during a
pan** — the only thing panning changes is which discs are large. (Adding or
deleting a feed, or the overflow re-anchor below, does move roundels; those are
structural changes, not the continuous per-frame motion principle 3 forbids.)
This is what makes size-encoding safe here: without the fixed cell the row would
reshuffle on every scroll event and become the flicker in the corner of the eye
that principle 2 forbids.

**The muster shows every live feed; only the floor shows gaps.** A minimised feed
keeps its roundel here (18px, stone) — so the muster is a contiguous run with no
holes. The gaps §III describes (vessels reading 1, 2, 4, 5) are a property of the
*floor*, where the minimised feed's vessel is spliced out; in the muster that
same feed is present but greyed. The two readings agree: the floor says "3 isn't
laid out," the muster says "3 exists but is away."

| State | Disc | Fill | Ring | Numeral |
|---|---|---|---|---|
| In view | 24px | `--ah-ink` | none | `--ah-bone`, 12px |
| On floor, panned off | 18px | none | 2px `--ah-ink` | `--ah-ink`, 11px |
| Minimised | 18px | none | 2px `--ah-stone-350` | `--ah-stone-350`, 11px |

**The ring is 2px, not a hairline.** The no-single-pixel invariant floors any
structural border at 2px (`scripts/check-hairlines.sh`), and a sub-2px ring both
breaks that rule and *slips its tripwire* — the guard greps for the literal
`1px`, which never appears in `"1.5px"`, so a 1.5px ring would ship unflagged.
Drawn at the 2px floor the ring is the same weight as the a11y focus outline, the
one sanctioned non-hairline border. If 2px reads too heavy around an 18px disc,
the fallback is to drop the ring entirely and encode all three states by
fill+size alone (24px solid ink / 18px solid ink / 18px solid `--ah-stone-350`),
which is fully invariant-safe; the ring is the first choice only because the
hollow disc reads as "not here" more directly than a smaller solid one.

11px is the floor; do not go below it to fit a third digit (see §III.2).
Numerals are `font-sans` (Jost), matching the vessel's corner roundel and the
mobile bar's wordmark rather than the plex-caps infrastructure register — this
is identity, not metadata.

Circles are permitted: the no-single-pixel-lines invariant governs 1px *lines*,
not `border-radius`, and rounded marks are established sitewide by the ∀ disc,
the trust pip and the mobile pip's pill.

Transitions are `120–160ms ease-out` on radius and fill, matching the mobile
pip's `160ms` and the vessel's outline transition.

**Driving the state flip — not the mount band.** The three states turn on one
question: is the vessel *in the viewport*. That is **not** the virtualizer's
`visibleIds` set, which is the far wider **mount band** — `[panOffset −
viewport.w, panOffset + 2·viewport.w]`, three viewport-widths — so a feed a full
screen off to either side is still in it. Reusing `visibleIds` would paint up to
three screens of roundels as "in view" at once, exactly the over-report §I
defines "in view" against. The muster needs its own, tighter selector: a roundel
is *in view* when its derived rect intersects the real viewport `[panOffset,
panOffset + viewport.w]`; *panned off* when it is on the floor but does not; and
*minimised* when `feeds.hidden`. This is a new derivation, cheap (a loop over
`geom.rects`, same shape as `visibleIds`). It inherits the `VIRT_QUANT`
hysteresis for free by reading the same quantised `panOffset` — the value only
advances after 200px of real scroll — so a vessel straddling the edge still needs
a genuine scroll to flip, not a jitter; only the band boundaries differ.

**Centring and overflow.** The muster is centred on the viewport while its width
fits clear of the lockup with one GRID of margin. Past that it left-anchors and
scrolls in place — `overflow-x: auto`, `scrollbar-width: none` — exactly as the
mobile indicator strip already does. It never runs under the lockup and it never
grows the row.

**Dark mode.** The row inverts wholesale with `html.dark`, as it does now. The
roundels are drawn from row-relative tokens and invert with it; they are not
islanded like the ∀ disc.

## V. Interaction

One verb for all three states: **go to this feed.**

- **In view** → pan the floor so that feed sits at the leading edge.
- **Panned off** → smooth-scroll it into view.
- **Minimised** → restore it (`handleSetFeedHidden(id, false)`), then scroll to it.

**Clicking a roundel dismisses any open Glasshouse pane first.** The muster sits
at z-58, above the pane (z-56), so it is clickable while a reader/settings/
messages overlay is open (§VII). "Go to this feed" is a *floor* navigation, and
leaving a modal pane floating over the newly-scrolled floor is incoherent — so
the click closes the active pane (the presence registry's `close()`, the same
call the mobile disc-✕ makes) and *then* scrolls. This is the one exception to
"the muster reports and navigates, it does not edit"; it edits nothing, it just
gets out of the way of the navigation it performed. (The ∀ lockup beside it keeps
its own behaviour — it opens the menu over the pane, it does not close it.)

Hover reveals the feed's name in a quiet label above the disc, reusing the
`descriptiveName` treatment already attached to the vessel's corner roundel.

**Not in the muster:** drag-to-reorder (the FeedComposer's list owns ranking),
hide, delete, rename, or per-feed settings. Each vessel carries its own gear;
there is no single "active" feed on the desktop canvas for a settings click to
target, which is why the mobile "tap the active pip for feed settings" gesture
has no desktop twin here.

**The ∀ menu keeps its restore rows.** `hiddenFeeds` / `onRestore` stay. This is
the same discoverable-twin pattern MOBILE-LAYOUT-ADR §VI already uses for feed
settings, and the menu is where a user goes when they have forgotten the
workspace has a bottom row at all.

**Known asymmetry, out of scope.** Unhide re-enters the feed as a new right-most
column at factory size (§IV.5). So a restored feed 3 lands to the right of feed
9. The numeral is now stable but position is not derived from it, and this ADR
does not change that. Flagged for the layout ADR if it grates in use.

## VI. What the muster does not carry, and why

**Arrival flags are deferred to their own ADR.** The design intent is recorded
here so the deferral has a shape, not so it has a blank cheque. When they land:

- The criterion must be **authored by the user** — a keyword, an author, a paid
  drop they asked to be told about. Platform-authored marks ("new", "active",
  "trending in this feed") are **excluded by rule, not deferred**. PRINCIPLES
  requires a control that "stays visible without demanding attention", and the
  whole curation stance is against the platform ranking your attention with
  unnamed signals. A platform-lit dot in permanent view is exactly that pattern
  at 8px.
- **One mark, one colour** — crimson, the site's single accent, already the
  `badgeBg` in `ForallMenu`. Never a per-feed colourway; the row is chrome.
- **No counts.** A count is a scoreboard and invites you to clear it.
- **Clears on view**, not on dismissal. Looking at the feed is the acknowledgement.

Also absent, permanently: unread counts, per-feed colour, and any use of the row
as an overflow shelf for feeds the layout could not place.

## VII. Chrome semantics

`NavRow` currently renders `aria-hidden="true"` with `data-explain-chrome`. The
muster is interactive, so:

- `aria-hidden` comes off the row. `data-explain-chrome` stays, so the annotation
  walk keeps treating the ground as chrome, and the muster itself takes a
  `data-explain="navRow.muster"` label of its own.
- The container is a labelled group of buttons, **not** `role="tablist"`. Several
  feeds are "in view" at once, so there is no single selected tab and tab
  semantics would misreport the state to assistive tech. Each roundel is a
  `<button>` with an `aria-label` naming the feed, its numeral and its state.
- z-58 is unchanged. Verify the buttons' pointer events clear the floor-mode
  Explain scrim at z-50 and are not swallowed by an open Glasshouse pane
  (z-55/56), as the lockup already is. Because a roundel *is* reachable over an
  open pane, its click closes that pane before scrolling — the behaviour §V
  fixes; this section only asserts the click physically lands.

## VIII. Phasing

1. ~~**Stable numerals.**~~ **SHIPPED 2026-07-25.** §III — `WorkspaceView`
   numbering domain widened to the live set (shared `feedRankComparator` →
   `liveSorted`, `feedNumerals` over it; `visibleSorted` derived as its
   hidden-filtered subsequence, unchanged as the layout/parade ordering),
   `FeedComposer` rank list numbers every row (the `–` placeholder gone),
   `MobileWorkspace` gained a `numeralFor` prop and its pip aria-labels now
   announce both the stable number and the gapless position ("Feed 4, 3 of 4").
   Four stale comments rewritten (the two the ADR named plus the FeedComposer
   header and the regimented "starts at Feed 1" scroll comment). No new UI;
   regimented code left untouched. → FIX-PROGRAMME 2026-07-25.
2. ~~**The muster.**~~ **SHIPPED 2026-07-25.** §IV — `web/src/components/
   workspace/Muster.tsx`: fixed 32px cells, the three states (24px solid-ink
   in-view / 18px 2px-ink-ring panned-off / 18px 2px-stone-350-ring minimised),
   140ms ease-out on size+fill+ring+numeral, Jost numerals, centred track that
   clears the lockup by a symmetric 200px side-reserve and scrolls in place
   (`.scroll-silent`) past that. `WorkspaceView` gained the tighter in-view
   selector `musterInView` (`[panOffset, panOffset + viewport.w]`, distinct from
   the three-viewport `visibleIds` mount band and inheriting its VIRT_QUANT
   hysteresis), the `musterFeeds` list over `liveSorted`, and `goToFeed` (close
   any open pane → scroll the rect to one GRID from the leading edge; minimised
   restores then a geom-keyed effect scrolls once the rect exists). Included some
   of §IV's centring/overflow because it is structural (the track would run under
   the lockup without it), not deferrable polish. **HOW divergence from §VII,
   owned:** the muster is a **separate fixed z-58 layer** mounted beside NavRow
   (state locality — geometry/pan/feeds live in WorkspaceView), not a child of
   NavRow, so NavRow stays the pure `aria-hidden` band and the muster carries its
   own `role="group"` + per-roundel `aria-label`; the row's `aria-hidden` is
   therefore correct to keep (it is genuinely empty). The muster container is
   marked `data-explain-chrome` as the conservative default pending the Phase-3
   `data-explain="navRow.muster"` label. → FIX-PROGRAMME 2026-07-25.
3. ~~**Polish.**~~ **SHIPPED 2026-07-25.** §VIII.3 — the §V floating hover-name
   label (the vessel roundel's `ROUNDEL_TOKENS` treatment, floated *above* the
   disc since the muster sits at the screen's bottom edge; the `title` stand-in
   removed), a reduced-motion gate on the disc + label transitions
   (`prefersReducedMotion`), the Explain `navRow.muster` kind + copy, and the
   §VII a11y close-out (the group of aria-labelled buttons was already in place
   from Phase 2; the addition is a click-while-Explain-active guard that sheds
   the annotations instead of navigating). The overflow track gained a `max()`
   floor so a pathologically narrow viewport can't collapse it. **HOW-divergence
   from §VII, owned:** §VII imagined a passive `data-explain="navRow.muster"`
   tag the scrim would hit-test, but the as-built muster is a separate fixed
   layer *above* the floor-mode scrim (z-58 > 50) with `pointerEvents:auto`, so
   a pointermove over it never reaches the scrim and a passive tag is
   unreachable — exactly as for the ∀ disc. So the muster **reports its own
   hover** to the engine (the disc pattern in `ForallMenu`), floor mode only
   (pane-mode Explain annotates the pane alone), and the outer band keeps
   `data-explain-chrome` for every look-through path. → FIX-PROGRAMME 2026-07-25.
4. **Later ADR.** Arrival flags, under the §VI constraints.

## IX. Decided by default (flag to reopen)

- Numerals are unbounded and two digits is the ceiling (§III.2).
- A restored feed enters right-most, not at its numeral's position (§V).
- Mobile stays positional and numeral-free; only its labels change.
- No `⌘1..9`-style jump-to-feed hotkey. The `\` regimented toggle is the
  precedent that this would be easy and probably wanted; it is not in scope
  here, and the muster makes it more obviously missing rather than less.
- The row still has empty width to its left after the muster is centred. Left
  deliberately empty. The row's restraint was a decision, not an oversight, and
  one occupant is the most it should carry.
