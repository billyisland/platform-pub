# WIREFRAME PLAN

*Handoff document. April 2026.*

This document is the instruction set for the next session. It exists so that a fresh Claude, reading this and the referenced source documents, can pick up the wireframing work without re-derivation. It assumes the reader has access to `PRINCIPLES.md` and `WORKSPACE-DESIGN-SPEC.md` and has read both before starting.

The plan is ordered. Step 1 is not skippable. Everything from step 4 onward can be reordered or parallelised without much cost; steps 1–3 cannot.

## Orienting context

all.haus is an independent venture under development. The workspace is the reader's primary surface and is specified in `WORKSPACE-DESIGN-SPEC.md` (revised April 2026). That spec supersedes earlier drafts on four points: paid subscriptions ship at launch (micropayments deferred); per-item provenance is removed until algorithmic discovery features make it meaningful; a note composer ships at launch with an article-composer nudge; and feeds at the workspace level are ⊔-shaped vessels, not rectangular cards, with no visual distinction between inherited and user-made feeds.

The design system is established and non-negotiable for this work:

- Jost for platform UI, Literata for editorial content, IBM Plex Mono (always caps) for infrastructure labels.
- ∀ (universal quantifier) as the logo mark and the generator of new objects.
- ⊔ (disjoint union) as the vessel shape every feed takes at the workspace level.
- Crimson strictly functional: logo, paywalled content, prices, CTAs, active states. Nowhere else.
- Square avatars and inputs. No border-radius anywhere.
- Black nav and footer beams.
- Left-positioned colour bars on article cards (crimson for paywalled, black for free) — this applies to article cards inside a feed, not to the feed vessel itself.
- No hairlines, no keylines. The grammar leaves no place where a hairline would fit. Space and wall-weight do the framing work that borders would otherwise do.

The aesthetic register across the product is solid, chunky, confident. Anything faint, recessive, or over-accumulated is wrong for this system.

## Load-bearing principles

Two from `PRINCIPLES.md` recur throughout the spec and should be checked against at every step:

**Defaults are the product; configurability is the ceiling.** A user who touches nothing on day one still gets a functioning reading surface. Depth is reachable when reached for, not presented through tutorials.

**Every feed is a disjoint union.** The ⊔ operator is the honest name for what a feed is — sources combined into a single stream, with user-weighted operands. The UI is a direct manipulation surface for this expression; the rule engine underneath is never the surface.

## What is out of scope for this wireframing pass

The spec explicitly defers the *brightness-and-focus coupling* — reading mode vs arranging mode — to its own design pass. Do not try to wireframe "user is reading an article inside a vessel" in this session. If the question arises, flag it and move on; inventing an answer will contaminate the rest.

Cross-protocol reply edge cases are also deferred. Simple same-protocol reply covers almost all cases and is all that needs wireframing.

Multiple workspaces, workspace sharing, feed sharing, import/export beyond single-URL fork — all deferred indefinitely. Not to be wireframed.

## Step 1 — The ⊔ rendering study

**Cannot be skipped. Cannot be parallelised. Everything compounds on this.**

The spec commits to a heavy-walled, open-topped container shape but leaves four rendering variables to prototyping: wall thickness, opening width relative to base width, aspect ratio at rest, and interior padding. The constraint the spec sets is that the ⊔ must read unmistakably as a vessel and not as a rectangle with three borders.

Produce four or five variants of a single vessel. Vary wall thickness across the set; vary opening width within at least two of the variants. Render each on a grey-100 floor, populated with standard-density content (title, byline, brief preview — three or four items). Render each at primary brightness and at dim.

The call gets made by eye, not by spec. The deliverable is one canonical ⊔ with committed proportions, documented as a short appendix to this file: wall weight in pixels or rems, opening ratio, interior padding, aspect ratio at rest.

Sanity check: at dim, the heavy walls should still read as structural (medium grey on grey-100). At primary brightness they should feel like they could hold something. If either fails, adjust weight and try again.

## Step 2 — A single feed across the density and brightness matrix

Nine frames. The committed vessel from step 1, populated at each of three density states crossed with three brightness levels.

Density states from the spec:
- *Compact* — title only.
- *Standard* — title, byline, brief preview. This is the default.
- *Full* — title, byline, preview, thumbnail, source attribution.

Brightness levels:
- *Primary* — the attention-claiming state.
- *Medium-bright* — the default for new feeds.
- *Dim* — the peripheral state, approaching dark-mode at the limit.

Two things are being tested. First, whether the three densities read as three distinct states rather than three interpolations of the same state — if compact and standard look similar, the density control isn't doing its job. Second, whether crimson holds its meaning at dim. Paywall indicators, price markers, subscription CTAs must remain legible and distinctive across all three brightness levels. This is an engineering constraint, not a design preference. Test the extremes.

If crimson fails at dim, that's a finding worth capturing before moving on. It may mean crimson needs a brightness-compensating treatment at dim feeds, or it may mean the dim floor needs to stay lighter than it otherwise would.

## Step 3 — The workspace at rest, three scenarios

Now place multiple vessels on the grey-100 floor.

*Empty.* First login. The founder's feed alone on the workspace, populated, at medium-bright default. The ∀ workspace control visible in its candidate position (use corner bottom-right for this scenario; step 4 tests both). This is the frame a user sees immediately after the first-login animation completes.

*Moderate.* Four or five feeds at mixed orientations and brightnesses. At least one horizontal strip. At least one dimmed feed. At least one at primary brightness. Vary the sizes. This is the everyday workspace — a user a few weeks in who has arranged things.

*Crowded.* The carrying-capacity scenario. Enough feeds that the user feels pressure to rearrange — to dim some, collapse others, reorient some to peripheral strips. The spec describes this pressure as productive: it is the workspace's attention economics made physical. The frame should visibly exert that pressure without looking broken.

The test across all three: does the arrangement read as a room with furniture, or as a dashboard with widgets? A vertical ⊔ next to a horizontal strip at half brightness should look like what the spec describes — two objects of different attentional weights in a single space — not like two UI elements of different sizes.

Feeds do not overlap. This is a hard rule. They tile, stretch, collapse, and reorient, but they never stack on top of each other. Check every frame for accidental overlap.

## Step 4 — The ∀ workspace control, both candidate positions

The spec explicitly defers this to prototyping. Mock both.

*Corner.* Probably bottom-right for thumb reach on mobile. Small, persistent, present on the grey-100 floor at all times. Tapping opens a minimal menu with four items: *new feed*, *new note*, *fork feed by URL*, *reset workspace layout*.

*Floating edge.* The alternative. The ∀ sits on an edge of the workspace rather than anchored to a corner. Same menu on tap.

Frame each in two states: closed (just the ∀ on the floor) and open (menu visible). Take the frames into a prototyping tool that allows thumb-reach testing on a real screen. This decision does not resolve on static frames.

The four menu items and their ordering are fixed by the spec. Do not invent additions. In particular, there is no *new article* item — articles are elevations of notes, reached from inside the note composer.

## Step 5 — The note composer

The most specified surface in the document. Should wireframe quickly. Three states:

*Empty.* Fresh compose surface. A text field. Above it, a single To field. Nothing else visible at rest. The send button reads *Publish* because the To field is empty; a *Publishing publicly* banner sits at the top of the compose surface; a subtle secondary protocol selector is available but not intrusive.

*Mid-compose, private.* To field populated with one or more specific people or named groups. The *Publishing publicly* banner is gone. The send button reads *Send*. The protocol selector is gone — audience selection implicitly determines protocol.

*Mid-compose, public with nudge.* Body has exceeded 400 words, or contains markdown headings, or has more than one embedded image. The article-composer nudge banner appears at the top of the compose surface, same register as the *Publishing publicly* banner, typographically quiet. Copy: *this is getting long. Switch to the article composer for headings, images, and structure?* Two actions: *switch* and *keep as note*.

The nudge is non-blocking. It never steals focus, never intercepts keystrokes, never pauses auto-save. Wireframe this accurately — the nudge sits there while the user types; it does not interrupt.

## Step 6 — The article composer and the nudge migration

The article composer is an elevation of the note composer. Wireframe the nudge first (already covered in step 5) and then the post-migration surface.

The migration from note to article must feel like the writing surface getting more room, not like a modal transition. This is the hardest interaction to get right in the writer-side flow. Concretely: cursor position preserved, content preserved, no new window, no dismissal animation that implies leaving. The To field persists. The *Publishing publicly* banner persists if applicable.

The article composer's launch surface carries: full authoring (headings, structured lists, block quotes, images, tables), the To field (same semantics as note composer), protocol selection, subscription paywall placement (the *here is where the paywall falls* affordance), draft-saving, preview.

Deliberately not at launch and therefore not to be wireframed: per-piece pricing, payout estimation, article-level analytics. These appear when the micropayments rail goes live, not now.

## Step 7 — Content-scope long-press

Small surface, dedicated pass. On long-press of any item in any feed, three controls surface: *volume per source* (more / less / none), *save*, *reply*.

The volume control has exactly three states. No finer gradation. *More like this* increases the weight of the source that produced the item in the feed's ⊔ expression; *less* decreases it; *none* removes the source entirely.

The controls should feel attached to the item, not floating above it. Wireframe a single item in its feed context with the long-press surface active.

Volume and save are direct. Reply opens the note composer with reply context set and the protocol inherited from the item being replied to. Cross-protocol replies are out of scope for this pass.

## Step 8 — Feed-scope composer

The depth surface. Reached via long-press on the feed's name label.

The spec's strongest steer: *the ⊔ expression exposed as editable text*. This should look like the mathematical object made editable, not a settings panel. The surface carries the list of sources, add-source-by-URL, per-source weights, feed renaming, and deletion.

This is the surface most at risk of drifting into generic-settings-UI. If the wireframe comes back looking like a form with labelled inputs, it has failed the spec. The sources are operands of a ⊔ expression; the weights are coefficients; the editability should make that structure visible.

Wireframe this in two states: a fresh feed with one source, and a feed with four or five sources of different weights.

## Step 9 — The animations

Two sequences, storyboarded as key frames on paper before any motion work. The committed ⊔ proportions from step 1 and the workspace context from step 3 are prerequisites.

*First-login animation.* ∀ expands from centre of empty screen. Parts into H. H's crossbar drops, accumulates horizontal bars that resolve in their final third into legible content (title, byline, source name). The H completes its transformation; remaining vertical walls settle into the ⊔ shape; content comes to rest inside the vessel. Duration approximately two seconds. Resting state is the populated founder's feed. Plays once, on first login only.

*Feed-creation animation.* ∀ → H → ⊔, with H held for a fraction of a second, crossbar dissolving as the base forms. Duration under one second. Resting state is an empty ⊔. Plays on every new-feed creation.

Key frames to capture for each: the starting ∀, the H at its clearest moment, the transition from H to ⊔, the resting state. The animations rhyme; both pass through H; both deliver the user to a vessel. The only difference is whether the vessel arrives populated or empty.

## Open questions the spec flags

These should be noted but not resolved in this pass:

- *Brightness baseline.* Absolute per-feed brightness is what the spec commits to. An offset-from-workspace-global-baseline version is named as a possible future revision. Wireframe against absolute.
- *Vessel rendering details.* Resolved in step 1 of this plan.
- *∀ position.* Resolved in step 4 of this plan.
- *Brightness-and-focus coupling.* Deferred to its own design pass. Out of scope here.
- *Article nudge tuning.* The 400-word threshold is committed. Log dismissal rates post-launch and revisit; not a wireframing concern.
- *Cross-protocol reply semantics.* Not day-one.

## Working grouping

Steps 1–3 are one arc: the vessel, proven at the workspace level. These cannot be skipped or parallelised. They produce the committed proportions and the workspace context everything else sits in.

Step 4 is a prototyping detour. It should be done on hardware, not on static frames.

Steps 5–6 are the writer arc. Can be done consecutively by one person.

Steps 7–8 are the reader-control arcs. Can be done in either order.

Step 9 closes the loop and depends on outputs from 1 and 3.

If the session is time-boxed and only the essentials can be completed, steps 1, 2, and 3 are the ones that must ship. Everything else is recoverable in a later pass; a miscommitted vessel shape is not.

## Deliverable format

For each step, produce:

1. The wireframes themselves (the number of frames specified in each step).
2. A short written note on what was committed and what remains open.
3. Any deviations from the spec, explicitly flagged with reasoning.

Revisions to the spec itself should carry a note on what changed and why, as the spec document requires.

---

*This plan is a handoff. Check decisions against `WORKSPACE-DESIGN-SPEC.md` and `PRINCIPLES.md` at every step. Where this document and the spec diverge, the spec wins; flag the divergence and revise this plan.*
