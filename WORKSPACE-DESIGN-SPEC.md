# WORKSPACE DESIGN SPEC

*Preliminary. April 2026. Revised.*

This document captures the workspace design worked out in conversation, following the PRINCIPLES revision. It is preliminary — decisions are explicit, defaults are named, open questions are flagged. The goal is to have one place where the control architecture, iconographic grammar, and interaction model are stated together, so that subsequent product decisions can be checked against them rather than re-derived.

This revision incorporates four changes from the first draft: paid subscriptions ship at launch (micropayments deferred); the per-item provenance trace is removed (deferred until algorithmic discovery features make it meaningful); a note composer ships at launch with an article-composer nudge on length and formatting signals; and feeds are not rectangular cards but ⊔-shaped vessels at the workspace level, with no ownership-status distinction between inherited and user-made feeds.

## Governing frame

The workspace is a reading room. Feeds are furniture. The user arranges the room; the platform remembers the arrangement. The user reads; the room responds to where attention is falling.

Every design decision below is answerable to the principles in PRINCIPLES.md. Two in particular are load-bearing throughout:

*Defaults are the product; configurability is the ceiling.* The controls described below are discoverable through use, not presented through tutorials. A user who touches nothing on day one still gets a functioning reading surface. The depth is reachable when reached for.

*Every feed is a disjoint union.* The ⊔ operator is the honest name for what a feed is — sources combined into a single stream, with user-weighted operands. The UI is a direct manipulation surface for this expression; the rule engine underneath is never the surface.

## Iconographic grammar

Two marks, related by geometric transformation.

**∀** — the universal quantifier. The default-open state. The mark of *everything before narrowing.* Used as the logo, as the label on any default-open field (empty audience selector, unfiltered feed source), and as the workspace-level affordance for creating new objects.

**⊔** — the disjoint union. The vessel. The mark of *a container assembled from sources.* Used as the shape every feed takes at the workspace level — heavy black walls, open at one end, content held within.

The transformation ∀ → H → ⊔ is the signature visual move of the platform. The H is a traditional form in the animation, evoking *haus* without making a fuss — the name of the building briefly visible in the act of the building giving you a container. It is not a category the product carries. It is a ceremonial transit point. What remains after the animation is a ⊔.

*First login animation.* ∀ expands from the centre of an empty screen, parts into H, H's crossbar drops and accumulates horizontal bars that resolve in their final third into legible content — title, byline, source name. The H then completes its transformation, the remaining vertical walls settling into the ⊔ shape, the content coming to rest inside the vessel. The resting state is a populated ⊔: the founder's feed, available for immediate editing or deletion. Duration: approximately two seconds, with the ∀-to-H parting the slowest moment and content-resolution the last. Plays once, on first login only.

*Feed-creation animation.* ∀ → H → ⊔, with the H held for a fraction of a second, the crossbar dissolving as the base forms. The resting state is an empty ⊔ vessel. Duration: under one second — it plays as a consequential response to the user's tap on "new feed," not as a performance. The meaning accrues through repetition; no single viewing should feel elaborate.

The animations rhyme. Both pass through H on the way to ⊔; both deliver the user to a vessel. The terminal state differs only in content: the first login's vessel arrives populated, the new-feed vessel arrives empty.

## The workspace

A single rectangle — the user's screen, at whatever size. The workspace floor is grey-100. Feeds are heavy black ⊔ shapes arranged on the floor, with space between them. No hairlines, no keylines, no drawn frames: the walls of the vessels are the only visual framing in the system, and space does the rest. The grammar leaves no place where a hairline would fit.

Feeds have intuitive physics. They are manipulable objects with persistent position, orientation, size, and brightness. The arrangement the user produces is the arrangement the workspace remembers. Closing and reopening the app restores the exact state.

Feeds do not overlap. Overlap is the digital-workspace problem the physical metaphor shouldn't import — it produces occlusion without affording retrieval. Feeds tile, stretch, and can be collapsed to shorter strips, but they do not stack on top of each other. Drag gives a capability; overlap gives a problem.

The workspace has a carrying capacity. A vertical ⊔ takes meaningful screen; a horizontal strip takes a slice. A user with more feeds than will fit at primary brightness and full density will feel pressure to rearrange — to dim some feeds, collapse others, reorient some to peripheral strips. This pressure is productive. It is the workspace's attention economics made physical.

## Feeds as vessels

Every feed at the workspace level is a ⊔ — heavy black walls, open at one end, closed on the other three sides. The shape is the container. There is no per-feed icon, no separate frame, no card rectangle behind the content: the ⊔ is all three at once.

**Walls.** The walls are drawn heavy — substantial, not thin. Weight is what distinguishes structural from decorative. A thin-walled vessel would read as a border around a rectangle; heavy walls read as a container with material presence. The walls look like they could hold something, because that is what they are doing.

**Opening.** The open end of the ⊔ is where new content arrives. In a vertical feed (the primary reading orientation) the opening is at the top; the base is at the bottom; content stacks downward, newest at the opening, oldest at the base. In a horizontal strip (the peripheral awareness orientation) the ⊔ is rotated 90°, with the opening at one end — left or right, determined by the newest-end setting.

**Interior.** Content sits inside the vessel at the current density (compact, standard, full). Items have internal padding from the walls. Space between items is the only separator — no per-item dividers, no hairlines, no cards within cards. The walls of the vessel are the visual frame; nothing else needs one.

**Scrolling.** When content exceeds the visible height of the vessel, the walls stay put and content scrolls within them. The vessel is a viewport the user sees onto an arbitrarily deep container; the walls are always at the edges of the visible feed, no matter how much content is behind the user.

**Name label.** Each feed has a discreet name label, typographically quiet, positioned just above the opening of the vessel (or alongside the opening, in horizontal orientation). The name is user-set. New feeds arrive untitled and prompt for a name on first edit; the founder's feed arrives with a default name.

**Brightness.** Feeds dim and brighten as a whole — walls, content, opening, everything. The heavy walls remain legible at every luminance: at dim settings they're medium grey on grey-100; at dark-mode limit they're light strokes on dark interior. The shape stays readable because the strokes are heavy.

**Shape invariance.** All feeds are ⊔-shaped. There is no visual distinction between inherited and user-made feeds at the workspace level. The founder's feed sits among the user's own as a peer, distinguished only by its name label and its contents. The gradient from inheritance to ownership happens in the contents, not in the container.

## Control scopes

Controls live at exactly one of four scopes. The scope determines where the control surfaces.

### Content scope

Controls that live on individual items, reachable via long-press or hover on any item in any feed.

*Volume per source* — three states: *more like this*, *less like this*, *none of this*. No finer gradation, because finer gradation would be false precision. These map directly to weights on the ⊔ operands: *more* increases the weight of the source that produced this item, *less* decreases it, *none* removes the source from the expression entirely.

*Save* — minimal implementation: mark an item so it persists in a dedicated Saved state accessible from the feed it lives in. Not a cross-feed bookmark system, not a read-later queue. Deliberately small.

*Reply* — opens the note composer with the reply context set. Inherits the protocol of the item replied to by default; the user can change the audience if they need to.

Content-scope controls do not surface until the user long-presses an item. At rest, items are just content. The configuration affordances appear only when reached for.

Deferred: a per-item provenance trace ("why is this here"). Until the platform introduces algorithmic discovery paths by which content arrives without explicit user authorisation, the answer is always *because you put it there*. The composer (reached at feed scope) already answers the structural version of this question by showing the source list. When algorithmic discovery is introduced, reinstate the per-item trace; not before.

### Feed scope

Controls that live on the feed container — the ⊔ vessel itself. Every feed carries these, always.

*Name label.* Discreet, user-set, above the opening of the vessel. The primary means of distinguishing feeds at a glance.

*Composer.* The configuration depth of the feed — the list of sources, add-source-by-URL, per-source weights, feed renaming, deletion. Reached via a gesture on the vessel (long-press on the name label, or an affordance adjacent to it). Not visible at rest. The composer is the ⊔ expression exposed as editable text; the ambient controls on content are the fast path.

*Position.* Drag to move. The vessel goes where you put it. Other vessels reflow to accommodate the new position. No auto-arranging, no grid snapping. Position persists.

*Size.* Pinch to resize, or drag a corner. Vessels have a minimum size (below which content becomes illegible) and no maximum. Size persists.

*Orientation.* A gesture — probably a two-finger rotation — switches a vessel between vertical (a column) and horizontal (a strip). Vertical is the primary reading orientation; horizontal is the peripheral awareness orientation. The orientation is a declaration of attentional priority.

*Newest-end direction.* Reversible per-feed via a flick gesture on the vessel. Default is reverse-chronological (newest at the opening). Reversing makes the vessel read oldest-first — useful for serialised reading, for working through a chronological queue, for bookmarks being read from the top.

*Density.* Three states: *compact* (title-only), *standard* (title, byline, brief preview), *full* (full card with preview, thumbnail, source attribution). Per-feed. Settable via a gesture; default is standard.

*Brightness.* A continuous dimension from bright to dim, with dark-mode at the limit. Per-feed. The salience control: brighter feeds claim more attention, dimmer feeds recede into ambient background. Brightness compounds with size and position to give the user a three-axis attentional layout, each axis doing different work.

Brightness is set via a two-finger vertical drag on the vessel: up to brighten, down to dim. The effect is immediate and continuous during the gesture — the light changes while the fingers are moving. The control reads as *turning down the light on this* rather than *adjusting a slider*. Brightness persists per-feed.

Default brightness for new feeds is medium-bright: slightly brighter than peripheral, not as bright as primary. This is the state that most invites a salience decision and is how the user discovers brightness is a control they have.

Crimson and other functional colours maintain their meaning at every brightness level. Paywall indicators, price markers, subscription CTAs must remain legible and distinctive when a feed is dim. This is an engineering constraint, not a design choice; test at the extremes.

### Workspace scope

Controls for operations about feeds in general rather than any specific feed. Home: a small persistent ∀ mark on the workspace floor (exact position TBD; the constraint is always visible, never intrusive). Tapping the ∀ reveals a minimal set of workspace-level actions:

*New feed* — opens a new untitled, empty ⊔ vessel with the feed-creation animation. Arrives at default size, default position (centre or next-free-slot), default brightness, empty of sources. The user immediately sees the composer invitation on a freshly-made empty feed.

*New note* — opens the note composer with an empty To field and an empty body. The user writes; the cardinality of the To field determines publication behaviour at send time.

*Fork feed by URL* — paste a URL of any feed (internal to all.haus, or an external RSS/Bluesky/Nostr/Mastodon source) and get a new feed built from it. The forked feed arrives as a ⊔ vessel with the source pre-populated.

*Reset workspace layout* — return all feeds to default arrangement. Non-destructive: no feeds deleted, no content lost. Behind a confirmation.

Deliberately not in this menu: new feed templates, feed sharing, workspace sharing, advanced import, *new article*. The first four are not day-one. The last is deliberately not a peer of *new note*: articles are elevations of notes, reached from inside the note composer rather than as a separate object type. The asymmetry is the point. A note is casual; an article is a deliberate act.

The ∀ is the generator of new objects. It is consistent that the default-open mark is also the mark that produces new containers — you tap *everything*, you get the option to narrow it into a new ⊔ or a new note.

### User scope

Profile, account, pricing, global preferences. Reached deliberately, off to the side, not surfaced in the workspace during normal reading. The threshold for getting here is a little higher than for any workspace-scope action — these are settings changed rarely and intentionally.

Implementation: a user avatar or name in a corner, tapping reveals the user-scope surface. User-scope changes who you are; workspace-scope changes what you have.

## The note composer

The writer-side primitive at its simplest. Ships at launch. The note composer is how the symmetric narrowing gesture is live from day one — readers narrow from everything to something; writers narrow from everyone to someone — without waiting on the micropayments rail.

**Surface.** A text field. Above it, a single To field. Nothing else visible at rest.

**To field.** Empty by default. Autocomplete across: specific people, named groups, "everyone on Nostr," "everyone on Bluesky," "everyone on ActivityPub," "everyone everywhere," or combinations. Typing a name resolves to a person. Typing a group name resolves to a group. Leaving it empty and hitting publish is the gesture for *publish to everyone*.

**Friction on empty To.** When the To field is empty, a persistent banner sits at the top of the compose surface: *Publishing publicly*. Not a dialog, not a confirm step — a visible fact about the current state. The send button's label changes to *Publish* rather than *Send*. The user can still misfire; the cost of misfiring is no longer *I didn't notice the field was empty*.

**Protocol selection for public notes.** When the To field is empty, a subtle secondary control surfaces letting the user choose which protocols the note goes out on. Default: all of them. Most users never touch this. A user who specifically wants a Nostr-only note or a Bluesky-only note can set it. Private notes don't need this control because audience selection implicitly determines protocol.

**Replies.** A reply affordance on any item in any feed opens the note composer with the reply context set. The reply inherits the protocol of the item replied to. Cross-protocol replies (adding an audience member on a different protocol than the original post) are a harder case worth flagging but not day-one material; simple same-protocol reply covers almost all cases.

**What the note composer does not have.** Headings. Structured lists beyond a few items. Block quotes. Tables. Multiple embedded images. Paywall controls. Scheduling. These live in the article composer.

## The article composer

Ships at launch as an elevation of the note composer. Full authoring surface — headings, structured lists, block quotes, images, tables. No per-piece pricing at launch (deferred until the micropayments rail is live). Paywall controls for subscription-gated articles ship at launch, because paid subscriptions do not have the volume floor that micropayments do: a writer with one paying subscriber at £5/month has £5/month. Subscription paywalls are live from day one.

**Reached from the note composer.** The user who starts typing in the note composer and realises they want more structure finds a small *this is an article* toggle adjacent to the formatting controls. Tapping it migrates current content into the article composer with cursor position preserved. The switch feels like the writing surface getting more room, not like a modal transition.

**Reached via the nudge.** The note composer monitors three signals and offers the switch when any one triggers:

1. *Length* past 400 words.
2. *Structured formatting* — markdown-style headings pasted or typed, numbered lists extending beyond a few items, block quotes, tables.
3. *Multiple embedded media* — more than one inline image.

Any one signal is sufficient; they compound but the logic is OR, not AND.

**The nudge's form.** A small typographically quiet banner at the top of the compose surface, same register as the *Publishing publicly* banner. No character, no icon, no decoration. Copy: *this is getting long. Switch to the article composer for headings, images, and structure?* Two actions: *switch* (migrates content, preserves cursor) or *keep as note* (dismisses).

**Honest dismissal.** *Keep as note* means: for the remainder of this composition, do not offer again. The trigger logic resets for the next note. The nudge never re-fires on trivially similar material within a dismissed session. The user's choice about the unit of work they are on is respected.

**Non-blocking.** The nudge never steals focus, never intercepts keystrokes, never pauses auto-save. The user continues typing; the nudge is there when they look up. If they never look up, no harm done.

**What the article composer has at launch.** Full authoring surface. Publish-with-To-field (same semantics as note composer). Protocol selection. Subscription paywall placement — the *here is where the paywall falls* affordance. Draft-saving. Preview.

**What the article composer does not yet have at launch.** Per-piece pricing. Payout estimation. Article-level analytics. These surface inside the existing composer when the micropayments rail goes live. No new composer appears; existing controls grow.

## Feed behaviours: consolidated

For reference, here is what a single feed carries.

**Static, always visible:** the ⊔ vessel itself, a name label above the opening, the content at current density.

**Ambient, on gesture:** volume per source (long-press item), save (long-press item), reply (long-press item), density toggle, newest-end flick, drag to move, pinch to resize, two-finger rotation for orientation, two-finger vertical drag for brightness.

**Depth, on request:** the composer — list of sources, add source, per-source weights, feed renaming, deletion.

The principle: controls a user needs most often are gestural and direct; controls a user needs rarely are reached for but findable.

## The three tests, against this spec

The PRINCIPLES document names three tests not yet passed. This spec takes a position on each.

**Feed construction feels native** if the ambient controls (long-press for volume, drag to arrange, gestures for orientation and brightness) are the primary surface, and the composer is reached for rather than presented. The test passes if a user who has used the platform for a week and never opened the composer still has a feed that has drifted meaningfully from the founder's original.

**Audience selection feels seamless** is addressed through the single To field whose cardinality configures everything downstream. The reader-side analogue — feed composition feels seamless — is addressed through the gesture-first, composer-on-request architecture. The structural symmetry is operational from day one: readers narrow via long-press-and-gesture on the ⊔ vessel; writers narrow via the To field in the note composer. Same gesture, opposite directions.

**The onboarding feed teaches itself** if the ambient controls are discoverable through use. A user who long-presses an item they dislike discovers *less like this*. A user who drags a feed discovers it moves. A user who two-finger-drags discovers brightness. Gentle nudging — *you've turned down three items from this source this week, want to mute them?* — is the exception, not the tutorial.

## Phase one scope summary

What ships at launch:

- The reader workspace: feeds as ⊔ vessels, all control scopes, the full manipulation model.
- Aggregation from Bluesky, Mastodon, Nostr, and RSS.
- The founder's feed as the onboarding feed.
- The note composer with full To-field semantics, including private messaging.
- The article composer with full authoring surface.
- Subscription paywalls for articles.
- Stripe rail, payouts, tax handling — everything the fiat payment facilitator framing requires for subscriptions.

What is deferred to phase two:

- Micropayments: per-piece pricing, the tab, settlement at threshold.
- The David-vs-Goliath piece of the structural editorial argument (an unknown writer earning immediately from a viral essay) operates at phase two, not phase one.
- Per-item provenance trace in feeds (reinstated when algorithmic discovery features arrive).
- Cross-protocol reply edge cases.

What is deferred indefinitely, held open:

- Multiple workspaces.
- The long-term fate of the founder's feed as the onboarding entry point.
- Workspace sharing, feed sharing, import/export beyond single-URL fork.

The phase one platform is not a placeholder. It is a complete reading-and-writing environment for the open web, with subscription payments live. The feature that completes the editorial argument is the one deferred — micropayments — and the deferral is specific and namable rather than general and indefinite.

## Open questions

**Brightness baseline.** Should per-feed brightness be absolute, or an offset from a workspace-global baseline that tracks ambient light or time of day? Absolute is simpler and is what this spec commits to. The offset version is nicer and more complicated; worth revisiting once absolute has been lived with.

**Workspace-level ∀ position.** Corner (bottom-left? bottom-right?) or floating along the workspace edge — to be resolved in prototyping. The constraint: always visible, never in the way, reachable with a thumb on mobile.

**Brightness-and-focus coupling.** The idea that tapping a feed to focus it causes it to brighten (and others to dim) is gestured at but not fully specified. This is an interaction mode — *reading mode* versus *arranging mode* — that needs its own design pass. Out of scope for this spec; to be picked up next.

**Vessel rendering details.** Wall thickness, opening width relative to base width, aspect ratio of the vessel at rest, interior padding — to be resolved in prototyping. The constraint: the ⊔ must read unmistakably as a vessel, not as a rectangle with three borders.

**Article nudge tuning.** The 400-word threshold is committed but may want adjustment after lived experience. The markdown-heading trigger may serve a narrower writer population than the length trigger. Log dismissal rates and revisit.

**Cross-protocol reply semantics.** What happens when a user replies to a Bluesky post and includes a Mastodon user in the audience? The simple same-protocol case covers almost all replies; the cross-protocol case needs design work before it ships. Not day-one.

---

*This spec is preliminary. It describes the workspace the conversation has arrived at, with defaults named where defaults need naming. Decisions below this point should be checked against both this document and PRINCIPLES.md. Revisions to either should carry a note on what changed and why.*
