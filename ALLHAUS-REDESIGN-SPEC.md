# all.haus Redesign Spec — Chrome, Feed Surface, Compose, Cards

> **Implementation status as of 2026-04-17 (commit `0ed389b`):** Steps 1–3 from §6 are shipped — the nav swap, compose overlay (note + reply modes), and card chassis unification. Annotations throughout mark what's done vs. what remains. Search for `✅ SHIPPED` and `⏳ TODO` to scan status.

Companion to `REDESIGN-SCOPE.md`. Where the scope doc argues what the product is, this doc specifies how four surfaces should look and behave: the topbar, the feed, the compose overlay, and the three card types that live in the feed. These four are the chrome of the product — what a user sees in the first three seconds, and where the register of the whole thing is set. Phase A's remaining items (filter bar, for-you model, cliquey primitive, trust drill-down, comments-on-externals, readability extraction) are not specced here; they become additive work once these four surfaces are locked.

The spec inherits the design tokens already in the codebase — colours, type, slab rules, grid widths, TrustPip — and names them where relevant rather than re-deriving them. Where a token is missing or needs to change, the spec says so explicitly.

---

## Register, restated

The visual language is Bauhaus-adjacent: solid geometric forms, structural weight, the ∀ mark, Jost / Literata / IBM Plex Mono, crimson as a strictly functional accent. The product should feel chic and media-confident with a subliminal touch of cypherpunk edginess — a serious publishing surface that knows what it is. It should not feel like software from a productivity suite.

Three negative references are doing load-bearing work here. Not Gmail: no chips, no density-driven layouts, no inbox-count chrome. Not Notion: no pastel blocks, no floating controls, no drag-handles-appearing-on-hover. Not Substack: no pink-ish warmth, no rounded corners, no "we're just a cozy newsletter" tonality. The product is closer in feeling to the NYRB website, a well-made print weekly, and the typographic register of FT Weekend — filtered through a design grammar that has spent time with cryptographic-protocol documentation and isn't embarrassed by it.

Two positive references worth pinning. The topbar should feel like the masthead of a broadsheet — a black beam, not a navbar. The reply thread should read like the dramatis personae scene in a play script — speaker, colon, line — not like a support-ticket transcript.

These references shape decisions throughout. When a choice is ambiguous, the test is: does this land closer to the positive references or the negative ones? If the answer isn't obvious, the choice hasn't been made yet.

---

## 1. The topbar ✅ SHIPPED

### What it is

The topbar is the persistent black beam across every authenticated surface of the product. It holds the wordmark, the primary navigation, search, the compose action, and the avatar. It is the one piece of chrome the user sees on every page, and it is where the scope doc's "subscribe input becomes prime real estate, compose becomes a topbar button" principle takes physical form.

The current `Nav.tsx` is almost right. The slab-beam shape (60px, `bg-black`, fixed top) is correct. The wordmark treatment (crimson ∀ mark + Jost "all.haus") is correct. The mono-caps nav links with crimson underline for the active item are correct. Three specific changes make it fit the new thesis.

### Principles

The topbar is a beam, not a navbar. Its structural weight comes from being a solid 60px of `#111111` edge-to-edge, anchoring the product the way a masthead anchors a newspaper. It does not float, it does not have a shadow, it does not become translucent on scroll. When the user scrolls, the beam stays put and the content passes under it.

Typography in the topbar is exclusively mono. All text elements — nav links, search placeholder, keybind hints — use IBM Plex Mono at 11px with `tracking-[0.06em]` uppercase. The one exception is the wordmark itself, which uses Jost to establish the product's voice at the one place the user reads its name. No Literata appears in chrome, ever; it is reserved for content.

The beam carries one structural accent: a 4px crimson under-rule appears beneath the currently-active nav link, bleeding to the bottom edge of the beam. This is the existing treatment in `navLinkClass(true)` and should stay. It is the only crimson in the topbar under normal conditions; the avatar badge for unread counts is a small exception.

### Composition

From left to right across the beam at 24px horizontal padding: wordmark, primary nav, flexible gap, search, compose button, avatar. The content is constrained to `max-w-content` (960px) and centered, so on wide screens the beam is edge-to-edge black but its contents sit within the reading column. This treatment exists in the current code and is right.

The wordmark is the crimson ∀ mark (18px) followed by "all.haus" in Jost 18px medium, the two joined with an 8px gap. It links to `/feed` for authenticated users and to `/` for anyone else. On hover, the entire wordmark performs the 360° spin already wired into `.logo-spin` — a small, deliberate moment of playfulness that counterbalances the beam's severity. Keep it; it's earned.

The primary nav is reduced from four items to two. The current nav is `Feed | Write | Dashboard | Network`. In the new thesis, `/write` ceases to be a navigable destination (the compose action replaces it) and `Network` becomes a dashboard sub-tab (it was always an awkward top-level item; the network graph is a writer-analytics surface, not a reader surface). The new primary nav is `Feed | Dashboard`, full stop. Two mono-caps links, active one underlined in crimson, inactive in `grey-400` with white on hover. ✅ SHIPPED

The one exception to the two-item rule is for users whose focus preference is reader-only: they see `Feed` and nothing else, because dashboard is irrelevant to them. Writer-only users see `Feed | Dashboard` where the Feed still works but the default surface on login is `/dashboard` rather than `/feed`. The preference shapes the chrome, it doesn't hide it. ⏳ TODO — focus-preference-based nav filtering not yet implemented; both items always show.

The compose button is new and it is the structural change this section exists to specify. It sits immediately to the left of the avatar, styled as a mono-caps text button rather than an icon: the literal word `COMPOSE` in IBM Plex Mono 11px, `tracking-[0.06em]`, uppercase, `grey-400` at rest, white on hover, with a thin 1px crimson underline that appears on hover. No button chrome, no border, no background. The keybind `⌘K` appears to its right in the same mono-caps style but at `grey-600`, separated by a single non-breaking space. The whole cluster reads as one unit: `COMPOSE ⌘K`. On mobile (below 768px), the `⌘K` disappears and `COMPOSE` itself is replaced by the ∀ mark at 14px (white, no background) because horizontal real estate is limited and the word gets cramped. Tapping either opens the compose overlay (specified in §3). The keybind is a global hotkey that works from any page in the product including inside the full editor, where it's a no-op to avoid nesting compose surfaces. ✅ SHIPPED

Search stays where it is and how it is: a borderless input at `bg-white/10`, 144px wide, 11px mono-caps placeholder text `SEARCH…`, expanding to 208px on focus. Correct as built. The one small refinement: the placeholder's trailing ellipsis is currently a literal `…` character; it should be a proper Unicode ellipsis with 4px of trailing padding so it doesn't butt against the right edge when the field is narrow. ⏳ TODO — ellipsis padding refinement not yet done.

The avatar is the existing `NavAvatar` at 28px, square, no border-radius. The unread badge in the top-right corner stays — 16px crimson circle, white text, Jost 10px semibold. This is the one place rounded geometry appears in the product (a circle, not a pill), and it earns its exception because the alternative (a square) looks like a small glitch next to the square avatar.

### Canvas mode

The `LayoutShell` `canvas` mode is for the article reader route (`/article/[slug]`) and the full-screen compose surface. It is a reduced topbar: just the ∀ mark (white, centered on the left) and the avatar on the right. No wordmark, no nav, no search, no compose button. Its purpose is to get out of the way of the content; the full beam's typographic density would compete with the reading surface. Currently correct in code.

One subtle change: in canvas mode, the ∀ mark should be crimson, not white. The reasoning is that the mark is smaller and more visually isolated here, and it needs the accent colour to register as a recognisable product mark rather than reading as a generic glyph. This contradicts the current code (`text-white`) and is a deliberate departure. ✅ SHIPPED

### States

*Default:* 60px black beam, contents as described.
*Unread present:* avatar badge shows 1–99 or `99+`, crimson background.
*Compose open:* beam stays in place; the overlay sits in front of the rest of the product but the topbar remains visible and interactive (the user can dismiss compose by clicking elsewhere in the topbar, e.g. the wordmark).
*Mobile sheet open:* the hamburger animates to an X; the sheet itself is specified in the existing code and stays (with the updated nav items reflected). No changes to the sheet needed for this spec.
*Not authenticated:* the wordmark, `Feed | About` nav, search, and `Log in / Sign up` cluster. No compose, no avatar. Compose is a logged-in action.

---

## 2. The feed surface (partially shipped)

### What it is

The feed is the primary destination of the product. It is one vertical stream of content — notes, articles, external items — rendered in reverse chronological order by default, with the subscribe input at the top and filter controls directly beneath. The feed is where the scope doc's central architectural claim lives: that reading is the dominant motion, and everything else composes around it.

This spec covers the feed surface as a container: its width, its vertical rhythm, the position of the subscribe input, and the placeholder for the filter bar. The filter bar's own visual design (Q1 in the scope doc) is not specced here but its *position* and *structural role* are, so whatever ships fits without retrofit.

### Principles

The feed is a single column. It is 780px wide (`max-w-feed`, already in tokens), centered on the page, with 24px horizontal padding inside the column. On wide screens, the feed sits in a sea of white with a lot of negative space around it. This is not an oversight — it's the point. The reading surface is generous about the space it gives its content to breathe, and narrow enough that line length stays in editorial range (around 65 characters for the note body text, closer to 75 for the excerpt prose).

The feed flows past; it does not pile up. Items arrive in reverse chron and the user reads down through them. There is no unread count in the chrome, no "12 new posts" banner at the top, no bold treatment on unread items, no "mark all as read" action anywhere in the UI. *Read/unread state exists in the backend* — it drives the default filter ("unread from subscriptions") — but it is never surfaced as a visible per-item affordance. The user's sense of being current comes from the zero state, not from a counter ticking down.

Vertical rhythm is a single 40px gap between every feed item, regardless of type. ✅ SHIPPED — implemented via `space-y-[40px]` on the feed items container. An earlier version of this spec proposed a 36/48 split (shorter within-type, longer between-type), on the theory that the longer gap would help the eye group items. In wireframe it read as irregular rather than as structured — the feed looked like it couldn't commit to a beat. A consistent 40px gap does the work of visual grouping through rhythm alone, which is actually more disciplined. There are no horizontal rules between feed items. The white space is the rule. This is one of the things that makes the product not-feel-like-a-feed in the pejorative sense.

The one deliberate exception is the zone break before a run of brief-tier article cards (specified in §4a). Brief cards are a different reading mode — skimmable, contents-page-adjacent — and are preceded by a 72px gap rather than 40px. This is semantic whitespace, signalling a section shift, and is distinct from the rhythm gap. Only one such break is permitted per contiguous brief run; individual briefs within the run (whether two-up or full-width) use the standard 40px gap.

### Composition

From top to bottom: topbar (fixed, out-of-flow), subscribe input (fixed position directly under the topbar, 60px of vertical space including its own padding), filter bar (60px, directly under subscribe), feed items (flowing, 48px top padding above the first one), end-of-feed affordance (48px above, 48px below).

The subscribe input occupies the position the composer currently holds in `FeedView.tsx`. It is the `SubscribeInput` component, slightly re-skinned: the existing `bg-grey-100` tray is replaced with a transparent background, and the input itself uses a 4px solid black bottom-border instead of a focus ring. This matches the slab-rule grammar already established elsewhere in the product. The placeholder text is changed from `"Follow a feed — paste a URL, handle, or npub"` to the shorter, more declarative `"Follow a URL, handle, or npub"` — this is a small change but the scope doc's register (chic, media-confident) rewards removing the instructional "Follow a feed —" preamble. The user already knows they're on a feed page; the input's job is to take input, not to introduce itself. ✅ SHIPPED

The subscribe input is sticky. When the user scrolls the feed, the input stays pinned directly under the topbar (combined height 120px of fixed chrome), which means the first affordance for *getting more things to read* is always one click away. This is a deliberate change from the current behaviour where the composer is sticky; in the new model, the composer is a topbar action and this slot belongs to the feed's primary purpose. ✅ SHIPPED — The filter bar, when built, will sit between the subscribe input and the feed content, and will also be sticky, creating a 180px chrome-and-controls zone at the top of every feed view. ⏳ TODO — filter bar not yet built.

Below the filter bar, the feed content itself is the flowing stream. Items are rendered as their respective cards (§4) with the vertical rhythm described above. On load, a skeleton of three shape-matched placeholders appears (the existing `InlineSkeleton` treatment is correct and stays). Progressive loading pulls the next batch when the user's scroll position is within 1000px of the bottom; the existing infinite-scroll pattern in the codebase is fine.

The end-of-feed affordance is new and worth specifying. When the user reaches the bottom of the loaded feed and no more items are available, a short mono-caps line reads `END OF FEED` in `grey-400`, centered, with a 4px crimson underline underneath it that is 48px wide (not the full column). Below that, at 24px remove, a mono-caps action link reads `SUBSCRIBE TO MORE →`. Click scrolls the user back to the subscribe input at the top with smooth scroll behaviour. This is the product's way of saying "you are current" without using the words "you are current" — which would be sentimental and fail the register test. The mechanism is structural: the user has reached the end, and the affordance offered is to feed more things in. ⏳ TODO

### The zero state ⏳ TODO

Zero state is the most semantically loaded moment in the feed and the scope doc names it (Q5). A user who has just signed up and subscribed to nothing needs to see a surface that does not apologise for itself.

The composition: centred in the vertical middle of the viewport (not at the top), a short block of content 60% of the feed column width. From top to bottom: a single large Literata italic phrase, 32px, tracking-tight, leading snug, reading `"Nothing here yet — which is fine."` The em-dash matters; the full sentence matters. Below it, at 24px, a Jost 15px line in `grey-600`: `"The feed fills up as you follow people and publications. Start above."` The word "above" is underlined and on hover becomes a click-target that scrolls to and focuses the subscribe input. Below that, at 36px, a small mono-caps line in `grey-400`: `TRY: A BLUESKY HANDLE · AN RSS URL · AN NPUB · A PUBLICATION NAME` — four examples separated by middle dots, compressed typographically into a single line that reads as a ribbon of possibilities. This is not instructional copy; it's a demonstration of what the product accepts, which is also a small flex of the architectural claim (the universal feed aggregator is real).

No illustrations. No mascots. No "welcome to the community". The zero state is handsome, sparse, and a little dry, and it rewards the user for being in a zero state rather than making them feel it's a problem to solve.

The non-zero-but-filtered-to-empty state is a separate case: if the user has applied a filter that produces no items (e.g. "notes only" on a feed with no notes), the message is different. A single mono-caps line, centered, reads `NO ITEMS MATCH THIS FILTER`, with an underlined mono-caps action beneath reading `CLEAR FILTER` that dismisses the filter state. No italic phrase, no explanation. The difference between the two states matters: a true zero state is an invitation; a filtered-to-empty state is a dead end and should read as one.

### Error state ⏳ TODO

If the feed fails to load, the existing treatment (`"Failed to load feed."` + `Try again` link) is functionally correct but register-wrong. The replacement: a single Jost 15px line centered at 33% viewport height reading `"Couldn't load the feed."` (the contraction is deliberate — it's more conversational and less technical than the current copy), with a mono-caps `RETRY` link below it at 24px remove. Retry re-runs the fetch. If it fails three times in a row within 60 seconds, the message expands to include a second line in `grey-600`: `"The gateway may be down. This isn't a sync issue on your end."` — the register here is "we're being honest about what's happening" rather than "please contact support", which is another place the cypherpunk-adjacent voice asserts itself quietly.

### Mobile

The feed is already single-column, so the mobile treatment is largely the same as desktop: the 780px `max-w-feed` becomes 100% width below 768px, and horizontal padding reduces from 24px to 16px. The subscribe input's sticky behaviour stays (120px chrome is acceptable on mobile; the filter bar, when specced, will need to decide whether to stay sticky at mobile sizes or collapse into a dropdown — that's a Q1 decision). The compose button in the topbar replaces the `COMPOSE ⌘K` cluster with the crimson ∀ mark at 14px, as noted in §1.

---

## 3. The compose surface (note + reply modes shipped)

### What it is

Compose is a mode, not a page. It is the one place the user initiates new content — whether that content is a short note, a reply, a DM, a cliquey thread, or a long-form article. Triggered from the topbar (button or `⌘K`), it opens as an overlay over whatever the user was doing, and dismisses back to context. This is the scope doc's "composing is entered from anywhere, written, sent, and exited back to where the user was" principle made concrete.

The current codebase has a `NoteComposer` (short-form, currently lives in the feed) and a `/write/[draftId]` full-page editor. Neither is the compose overlay. The overlay is a new component that subsumes `NoteComposer` entirely for short-form composition and opens into the existing `/write` editor (with altered chrome) when the user chooses long-form. The NoteComposer component stays in the codebase but loses its sticky-feed deployment; it is used only inside the overlay from here forward. ✅ SHIPPED — `ComposeOverlay.tsx` built; NoteComposer removed from FeedView, QuoteSelector, and WriterActivity; compose store (`stores/compose.ts`) coordinates all open/close; overlay mounted globally in `layout.tsx`.

### Principles

The overlay has four presentational principles.

*It does not take over the surface.* The underlying page remains visible and partially interactive. Concretely: a 40% black scrim covers the page but the topbar stays fully visible and clickable (clicking the wordmark, for instance, closes compose and navigates home). The overlay itself is a rectangular slab that occupies about 60% of the viewport height and 640px of horizontal space, centered horizontally, positioned 80px below the top of the viewport. It is not a modal in the "locks you in" sense; it's a foregrounded working surface. ✅ SHIPPED

*It is one slab, with structure inside it.* The overlay is a single white rectangle with a 6px solid black top rule (a `slab-rule`), no shadow, no border-radius. Inside, it is divided into three zones by internal 4px grey-200 rules: the recipient/subject zone at the top, the editing zone in the middle, the controls zone at the bottom. This gives the overlay the same architectural solidity as the topbar — stacked horizontal elements with structural weight, no floating pieces. ✅ SHIPPED

*It knows what kind of thing is being composed.* The overlay has three modes — *note*, *reply*, *article* — and it switches between them without changing its visible shape. The difference is in the affordances shown in the recipient/subject zone and the controls zone. A note has no subject, no publication selector, no paywall controls. An article has all three, plus the scheduling and presentation-mode toggle. A reply has a pinned preview of what's being replied to at the top (pulling from the existing `activeQuote` pattern in `NoteComposer`) and no recipient field. The mode is selected implicitly from how compose was opened: topbar button defaults to *note*; "Reply" on any card opens *reply* with the target pinned; a dedicated *Write an article* button within the overlay (in the note mode's controls) switches to *article* mode. ✅ SHIPPED (note + reply modes); ⏳ TODO (article mode).

*Exit is always clean.* The user can dismiss with Escape, by clicking the scrim, or by clicking the small `×` in the overlay's top-right corner. If there is unsaved content, dismiss triggers a terse confirmation — a single Jost 14px line appears in the controls zone reading `"Discard this? Press Escape again to confirm."` No modal-within-modal. The second Escape (or second scrim-click) discards. If the user is composing an article, dismiss saves to drafts silently and closes — articles are never lost. ✅ SHIPPED (note/reply dismiss behaviour); ⏳ TODO (article draft auto-save on dismiss).

### Composition — note mode (default) ✅ SHIPPED

The overlay's top zone contains a single mono-caps label reading `NOTE` in `grey-400`, left-aligned, with no other controls. This is structurally equivalent to the reply mode's pinned preview and the article mode's subject field — the zone is always there; its contents vary.

The editing zone is a single auto-growing `textarea` styled in Jost 16px with 1.6 line height, taking the full width of the overlay with 24px horizontal padding. The placeholder text is `"What's on your mind?"` at `grey-400`. The character counter from the current `NoteComposer` (`0/1000`) appears at the bottom-right of this zone in mono-caps 11px, `grey-600` when under limit, crimson when over.

The controls zone at the bottom is a single horizontal row with 16px vertical padding. From left to right: image upload button (the existing 18px SVG icon from `NoteComposer`, `grey-600` at rest), cross-post toggle (a mono-caps text label `ALSO POST TO:` followed by small toggle pills for each linked account the user has — `BLUESKY`, `MASTODON` etc.), flexible gap, `WRITE AN ARTICLE →` text link (navigates to `/write/new` and closes overlay), the `POST` button (the existing `.btn` class, 32px height, mono-style text). The `Post` button is enabled only when the textarea is non-empty and the character count is under limit. Keyboard: Enter posts, Shift+Enter inserts a newline, matching current behaviour.

### Composition — reply mode ✅ SHIPPED

Opened via the `Reply` affordance on any card. The top zone replaces `NOTE` with a pinned preview of the target: the existing quote-preview pattern from `NoteComposer` (byline, title, excerpt, crimson left border) rendered at full overlay width. This pattern is already built and is right; it just moves from inline-within-composer to the dedicated top zone.

The recipient semantics of the overlay determine the reply's behaviour:
- If the target is a platform item (article or native note), the reply posts as a native reply (kind 1111 for article comments, kind 1 with quote for note replies).
- If the target is an external item, the reply behaviour depends on whether cross-post is toggled and whether the user has a linked account for that protocol. The cross-post toggle in the controls zone shows which protocols are available for outbound reply and which aren't (the latter greyed out). This preserves the current `ExternalReplyComposer` logic but consolidates its UI into the overlay's chrome rather than appearing as a separate component under each external card.

The editing zone is identical to note mode. The controls zone loses the `WRITE AN ARTICLE →` link (replies are never articles) and shows the cross-post controls more prominently.

### Composition — article mode ⏳ TODO

The top zone becomes a three-row stack at 80px combined height: subject field (the article's title, plain input, Literata 22px italic — a small but deliberate typographic cue that the user is writing something serious, carrying the editorial voice into the compose surface itself), publication selector (a mono-caps dropdown: `PUBLISH AS: PERSONAL ▾` or `PUBLISH AS: [PUBLICATION NAME] ▾`), and the presentation mode toggle (a single-line segmented control: `FLOWING · CUSTOM`).

The editing zone grows considerably. It is the existing `ArticleEditor` component (Tiptap-based, already built) rendered at full overlay width, with the same typographic treatment as the published article surface (Literata 17px, 1.8 line height, max-width 640px centered within the overlay). Paywall gate markers, embed nodes, image uploads — all the existing editor affordances work inside the overlay.

The controls zone contains: the draft autosave indicator (a small mono-caps line `SAVED · 11:42` at `grey-400`), flexible gap, `OPEN IN FULL EDITOR ↗` text link (switches to `/write/[draftId]` with the current draft preserved), `SCHEDULE` button (opens a date/time picker inline in the controls zone), `PUBLISH` button (the existing `.btn-accent` class — crimson, because publishing is the consequential act and crimson's job is to mark consequence).

The *full editor* at `/write/[draftId]` is the expanded-chrome destination the scope doc's Phase B item 9 describes. It is the same editor with more room to breathe: no overlay, full page, canvas-mode topbar (minimal), the article rendered at its true column width, paywall controls and metadata in a right-hand sidebar rather than a collapsed bottom zone. The compose overlay is for fluency; the full editor is for focus. The user moves between them without losing state.

### Opening and closing — the animation question ✅ SHIPPED

The overlay appears when triggered. It does not animate in from below, it does not fade in, it does not scale up. It appears. This is a deliberate choice against the Notion/Linear convention of spring-animated overlays; animation at the moment of compose would signal "ceremonial tool" where the product wants to signal "fluent working surface". The user triggers `⌘K` and begins typing — there is no transition to wait through.

On close, the overlay disappears in the same frame. The scrim's opacity transitions out over 150ms, giving a small softening, but the overlay itself is there then gone. This is structural and intentional, not a miss.

### States

*Default (note):* as composed above, textarea focused on open.
*Focused with content:* character count visible, Post button active.
*Over character limit:* counter crimson, Post button disabled with reduced opacity.
*Uploading media:* a mono-caps `UPLOADING…` label appears where the character count usually sits, disappears when done.
*Posting:* Post button reads `POSTING…`, disabled; on success, overlay closes and the new item appears at the top of the feed (existing `handleNotePublished` callback behaviour).
*Error on post:* a single Jost 13px line appears in the controls zone above the buttons, crimson, reading the actual error message. Dismissable with the `×` pattern already in use.
*Article mode, unsaved changes:* draft indicator shows `UNSAVED`, saves automatically every 30 seconds.

### Mobile ✅ SHIPPED (structure); ⏳ TODO (swipe-down gesture, keyboard behaviour, file-picker integration)

The overlay's 640px width is wider than most mobile viewports. On mobile (below 768px), the overlay becomes a full-screen sheet that slides up from the bottom, occupying 100% of width and 90% of height, with a small drag handle at top (4px black bar, centered, the one place a handle is visible in the product — it's earned because the gesture to dismiss is swipe-down). The topbar is replaced by a thin mobile-overlay chrome: `×` on the left, mode label (`NOTE` / `REPLY` / `ARTICLE`) in the center, `POST` button on the right. The internal layout is otherwise identical.

---

## 4. The card family (chassis shipped)

### What it is

Three card types render in the feed: `ArticleCard`, `NoteCard`, `ExternalCard`. They are the most-repeated surfaces in the product, and their visual coherence is what makes the feed read as one thing rather than three. The scope doc's "content from Nostr, Bluesky, Mastodon, and RSS, rendered as peers of native content" principle has to be visible at the card level — if the three types look like three different products, the feed is not the feed the thesis describes.

The current cards are close. They already share the byline pattern, the trust pip, the mono-caps byline typography, and a rough sense of shared layout. What they don't yet share is a clear *structural grammar* that distinguishes article-shaped-thing from note-shaped-thing from external-shaped-thing without making them feel alien to each other. The spec below establishes that grammar.

### The shared chassis ✅ SHIPPED

Every card in the feed, regardless of type, has the following structure:

A *bar* on the left edge, 4px wide, running the full height of the card. The bar's colour encodes the card's nature:
- Black (`#111111`) for platform-native items (all.haus articles and notes)
- Crimson (`#B5242A`) for paid articles
- `grey-300` (`#BBBBBB`) for external items

This is a generalisation of the current `ArticleCard` treatment (which uses the black/crimson distinction already) applied to all three card types. The bar is structural — it's how the eye parses the feed — and its colour is informational. The crimson-for-paid treatment aligns with the product's rule that crimson marks consequence: money is a consequence.

Directly to the right of the bar, at 24px left padding, comes the *byline row*. It is always mono-caps, 11px, `tracking-[0.06em]`, and it always contains, in order: the trust pip (5px circle, colour per TrustPip), the author name (mono-caps uppercase, Jost bold on hover underline), a middle-dot separator, the timestamp (formatted relative, `grey-600`), and — for paid articles — a second middle-dot and the price in crimson. This exact pattern is already in `ArticleCard` and needs to be backported to `NoteCard` (which currently uses the wrong typography for the byline — Jost semibold at 14px — because it was built for a different era of the design) and `ExternalCard` (which currently renders the author name with Jost bold at a mix of sizes). ✅ SHIPPED — all three card types now share the mono-caps 11px byline row with pip, author, middle-dot, timestamp. Avatars removed from NoteCard and ExternalCard.

The byline row is the *only* mono-caps content in the card body. Everything else (headline, excerpt, content, action labels) uses its appropriate voice — Literata for editorial content, Jost for UI. The byline's mono treatment is the card's tie back to the product's infrastructure voice, and it is how three very different content shapes read as members of one family.

Below the byline row comes the *content zone*, which is where the three cards diverge. This is specified per-type below.

At the bottom of the card comes the *action row*, which returns to mono-caps 11px, `tracking-[0.02em]` (slightly tighter than the byline — this is deliberate, it gives the action row a subtly more compressed feel that reads as "utility" rather than "signature"), `grey-600`. The action row contains type-appropriate actions plus the universal reply affordance (see below). Actions are text labels separated by 16px gaps, no buttons, no chrome. The right-hand end of the action row holds the persistent per-item utilities: vote controls and share button — these already exist and work, just need to be styled to match the mono-caps register. A previous version of this section also listed a bookmark button; that action has been removed product-wide in favour of the reading-history resumption mechanism described under ArticleCard specifics below.

### The unified reply affordance ✅ SHIPPED

Every card has a single `Reply` action in its action row. This is the scope doc's "one gesture: *I want to respond to this*" principle. Click behaviour: opens the compose overlay in *reply* mode with the card's item pinned as the target. The overlay handles the three underlying mechanics (platform reply, note quote, external cross-post) based on the target's type. The card does not need to know which mechanic will fire; it only knows that this item can be replied to.

This is a meaningful change from the current state, where `ArticleCard` has no reply button inline (you have to click into the article to comment), `NoteCard` has a `Reply` button that opens an inline `ReplySection` composer, and `ExternalCard` has a separate `Reply` and `Quote` pair that open the `ExternalReplyComposer` inline. All three collapse into one affordance with one destination. ✅ SHIPPED — ArticleCard now has Reply; NoteCard Reply routes to overlay; ExternalCard inline composer removed, Reply routes to overlay; Quote removed from ExternalCard (subsumed by overlay reply).

The `ReplySection` component does not go away — it still renders the reply *thread* below notes (and, in Phase A, below articles and external items once comments-on-externals lands). What changes is that the reply *composer* is no longer part of `ReplySection`. Replying always opens the overlay; the thread renders below the card purely to display replies, not to collect them. ✅ SHIPPED — ReplySection kept for thread display with `composerOpen={false}`.

### ArticleCard — specifics (chassis + tiers shipped)

An article card renders in one of three tiers — *lead*, *standard*, *brief* — which are specified in §4a below. The content-zone description here defines the *standard* tier, which is the default for most articles; §4a covers how leads and briefs diverge from it.

The content zone for an article has four elements, top to bottom:

*Headline.* Literata italic, medium weight, tight tracking (`-0.02em`), 1.18 line height. Wraps freely. Size is per-tier (see §4a): 30px lead, 22px standard, 19–20px brief. *Italic Literata is the signature of native all.haus articles* — it is the voice the product uses for its own long-form work, and it is reserved for that purpose. External content that happens to have a headline (RSS-shape externals, some Mastodon posts) uses **roman Literata** at the equivalent size, so that the native/external distinction is legible typographically and not merely through the `VIA PROTOCOL` byline tag. On hover, the headline colour shifts from `#111111` to `crimson-dark` (`#921D22`) — a small, refined hover state that's already in the code and is right.

*Excerpt.* Literata roman (not italic), 15.5px, `grey-600`, 1.65 line height, constrained to 540px max-width so it doesn't run the full card width (this creates a deliberate asymmetric shape where the excerpt is narrower than the headline). Uses `article.summary` if present, otherwise falls back to the first ~200 characters of the content with markdown stripped. Already implemented correctly.

*Tags.* Mono-caps, 11px, `tracking-[0.06em]`, `grey-300`. Separated by middle dots. Each tag links to `/tag/[name]`. Already implemented correctly; stays.

*Action row.* Mono-caps 11px, `tracking-[0.02em]`, `grey-600`. Contents: read-time (e.g. `5 MIN READ`), reply count if > 0 (e.g. `3 REPLIES`), flexible gap, `REPLY`, `QUOTE`, vote controls, share. The left-aligned items are *metadata about the item*; the right-aligned items are *actions you can take on the item*. This split is deliberate — it separates informational from operational affordances and helps the eye parse the row. Currently the card has `Quote` and no `Reply`; the new spec adds `Reply` as the primary affordance and keeps `Quote` as a secondary for now (quote may merge into reply in a later phase but that's not this spec's decision). The bookmark action is removed — its job is now done by the reading-history mechanism described below. ✅ SHIPPED — Reply added to ArticleCard action row, routed to compose overlay. Left bar narrowed from 6px to 4px, paddingLeft from 28px to 24px.

Click on the card body (outside of explicit action buttons) navigates to `/article/[dTag]`. This is existing behaviour and should stay; it preserves the card's affordance as "the thing you click to read the article".

### Reading history and resumption ⏳ TODO

Where a bookmark action previously existed in the card's action row, its work is now done by an ambient mechanism: the article reader page remembers scroll position per-article-per-user and opens at that position on return. There is no explicit "save this for later" gesture; the act of reading is itself the act of marking your place. This is closer in spirit to how a book works than to how a web app works, and it is the right register for this product.

Mechanically: the reader page (`/article/[dTag]`) snapshots the user's scroll position on scroll-idle (debounced at ~500ms) and on page-exit. The snapshot is an `(article_id, user_id, scroll_ratio, updated_at)` record. On return, the page mounts at `scrollTop = scroll_ratio * scrollHeight`. A small grace zone at the top (first 10% of the article) is treated as "start from the beginning" rather than resumed, so users returning to an article they barely opened aren't yanked into the middle of a paragraph that looks like no progress. The grace zone is invisible to the user — it just means "very small scroll positions resolve to zero".

A threshold matters: articles opened and scrolled less than ~20% into are considered *glanced at* rather than *read-into*. This distinction is not surfaced on the card itself — the feed never shows per-item reading state, per §2 — but it becomes meaningful in the reading-history surface described below, where glanced-at articles render in a separate, quieter tier from genuinely engaged ones.

The consequence: **reading history becomes a first-class surface in the product.** If every article you've opened is remembered and resumable, then "my reading" is a place — a dashboard sub-tab, accessed from the avatar menu, showing articles you've started with a visual indicator of how far through each one you are. Genuinely-engaged articles (>20% read) render in the primary list; glanced-at articles render as a muted secondary cluster beneath, collapsed by default. This surface is not specced in detail here — it wants its own pass — but its existence is a natural consequence of the scroll-position mechanic, and the mechanic should be built with this surface in mind.

One behavioural note worth pinning: resumption is a preference, not a mandate. A user who prefers to always start from the top can set a preference ("always open articles at the top") in their settings; this is the kind of setting that an actually-reading population will never touch and a certain kind of user will insist on, and providing it avoids a long argument in the weeds.

### §4a. Article tiers — lead, standard, brief ✅ SHIPPED

The weekend-supplement observation. A feed of uniform-size article cards is structurally honest but editorially flat: a 22-minute long read and a 4-minute dispatch ask for different kinds of attention from the reader, and the contents page of a well-made weekend supplement (FT Weekend, NYRB, the old LRB back matter) knows this and *sizes its items accordingly*. A six-thousand-word essay gets top billing in heavy italic; the short notices run in the side column at small size, half a dozen to a page, scanned in two seconds. The size difference is the editorial voice.

The feed should do this too. Article cards render in one of three tiers:

*Lead.* Long reads, typically 3,000+ words, usually one or two per batch. Headline Literata italic 30px, excerpt Literata roman 16px, full card width, standard action row. This is the card that says "sit down and read something". Leads always render full-width; they never participate in two-up layouts.

*Standard.* The default essay, typically 1,000–3,000 words. Headline Literata italic 22px, excerpt Literata roman 15px, full card width, standard action row. This is the baseline article card — the one the spec's §4 ArticleCard specifics describe. Most articles land here.

*Brief.* Short pieces, typically under 1,000 words — columns, dispatches, notices. Headline Literata italic 19–20px. **No excerpt.** The card's content zone is just the headline, full stop. The byline row and action row are unchanged (other than proportional adjustments in two-up — see below). The absence of the excerpt is the point: a brief asks the reader to commit from the headline alone, or to skip, which is how the "In Brief" column of a supplement works. A brief that wanted an excerpt is a standard.

The default tier mapping is by word count, but the tier is a field on the article record (not a pure function of word count) so that writers and publications can manually promote a piece to lead or demote to brief where editorial judgement calls for it. This hook doesn't need UI in this spec — it's a field that can be set editorially at first — but it should exist in the data model from the start. Length is the default signal; editorial weight is the underlying one.

#### Two-up brief pairing

Briefs may render in pairs, side by side, in a two-column grid within the feed column. This is the contents-page move — it makes the feed read, briefly, like the "Notes" column of a supplement. Rules:

- Two-up pairing is *opportunistic*. It applies only when two briefs are adjacent in the reverse-chronological feed stream. The feed is never reordered to create pairings; the scope doc's "never silently reordered" promise holds.
- Only briefs pair. Leads and standards always render full-width. Notes and externals never participate in two-up layouts (they have their own shape — short, conversational — and forcing them into a grid makes the feed read like a Pinterest board, which is the opposite register).
- Three adjacent briefs do not render as a 1+2 or 2+1 layout. The first two pair; the third renders full-width (as an unpaired brief) below them. Four adjacent briefs render as two pairs. The rule is simply: pair briefs in twos, top to bottom, leave remainders full-width.
- The two-up grid has a 40px horizontal gutter. Each card in the pair uses the same chassis (bar, byline row, content zone, action row) as a full-width brief, with proportional adjustments: byline and action row sit at 10.5px mono-caps rather than 11px; the action row is condensed to `REPLY` and vote controls only (the `SHARE` action moves off-card and is available only on full-width briefs and larger). This is a deliberate, narrow exception to the shared-chassis principle: a two-up card is space-constrained, and the condensed action row is what makes that legible.

#### Zone break

A run of briefs (whether a two-up pair or a sequence of full-width briefs) is preceded by a 72px vertical gap, rather than the standard 40px feed rhythm. This is semantic whitespace: it signals a shift into a different reading mode — scan-and-skip rather than read-and-follow — in the way a supplement's "In Brief" heading does. The break appears once, before the first brief in a contiguous run; briefs within the run are separated by the standard 40px gap. When the run ends and a standard or lead returns, the rhythm goes back to 40px (no matching 72px break on the way out — the shift *into* the brief zone is the editorial move, and a second break would read as bracketing).

#### What doesn't change

The shared chassis rules from §4 hold across all tiers. The left-hand colour bar (black/crimson/grey) works the same way regardless of tier. The byline row is the same mono-caps treatment. The trust pip, reply count, timestamp, paid marker — all identical. A brief is a smaller article, not a different object. And everything in §4 about the *other* two card types (NoteCard, ExternalCard) is unaffected by this section: tiers are an article-card concern.

### NoteCard — specifics ✅ SHIPPED

The note card is structurally simpler than the article card because a note has no headline, no excerpt, no tags — the note *is* its content. The shared chassis (bar, byline row, action row) stays; the content zone holds the note body and any quoted content.

The content zone has up to three elements:

*Body.* Jost 15px, 1.55 line height, `#111111`, whitespace-preserved. This is the current treatment and it's right. Media (images, embedded link previews) renders via the existing `MediaContent` component and stays as-is.

*Quoted content.* If the note quotes another item (note or article), the quote renders as a pennant: a 4px crimson or black left-border (depending on whether the quoted item is paid), 20px left padding, 8px vertical padding, Literata italic 14px excerpt at `grey-600`, mono-caps byline beneath at 10px. This is the `ExcerptPennant` pattern already in the code and it's correct; no changes.

*Action row.* Mono-caps 11px. Contents: `REPLY (n)` (showing reply count when > 0, otherwise just `REPLY`), `QUOTE`, vote controls. Simpler than article's action row because notes don't have read-time or share (notes aren't sharable in the same way; the whole conversation is the point).

One deviation from current behaviour: the `NoteCard` currently renders its `ReplySection` inline below the note, expanding in place when the user clicks `Reply`. In the new spec, the reply *composer* is gone (replaced by the overlay), but the reply *thread* below the note stays. This thread is where the playscript treatment (Q4) lands, and it's specified in its own section next. ✅ SHIPPED — Reply routes to compose overlay; ReplySection kept for thread display only.

### ExternalCard — specifics ✅ SHIPPED

The external card is the most visually-distinct of the three because it has to carry a `VIA [PROTOCOL]` badge without letting that badge dominate. The chassis stays shared (grey-300 left-bar, mono-caps byline row), but two specifics differ:

*Byline extension.* The byline row includes a protocol badge to the right of the timestamp. The badge is mono-caps 11px, `tracking-[0.06em]`, `grey-400`, reading `VIA BLUESKY` / `VIA MASTODON` / `VIA RSS` / `VIA NOSTR`. No chrome, no box around it — it's just another piece of byline text, the way a print publication would note "from the New York Times wire" in small caps. For Mastodon specifically, the existing `BETA` flag stays as a small amber tag immediately after the protocol — it's acceptable because Mastodon outbox polling genuinely is beta and the amber is useful as a trust signal.

*Content zone.* External items have variable shape — a Bluesky post is short like a note, a Mastodon post might be longer, an RSS item might have a title and summary like an article. The content zone handles this by branching visually:

- If the item has a title and summary (RSS-like): render a small **Literata roman** headline (20px) and a Literata roman summary (14.5px, `grey-600`). The roman-not-italic treatment is deliberate: italic Literata is reserved for native all.haus article headlines (see §4 ArticleCard specifics), so that the native/external distinction is legible at a glance without relying solely on the `VIA PROTOCOL` byline tag. No "read more" link; clicking the card body opens the external source in a new tab.
- If the item has only body text (Bluesky/Mastodon-like): render the text in Jost 15px (matching NoteCard's body treatment). Media renders via the same `MediaContent` component as native notes.

*Action row.* Mono-caps 11px. Contents: `REPLY` (opens compose overlay in reply mode, which handles the cross-post routing), flexible gap, `VIEW ORIGINAL ↗` (external link to source). No quote (quote is now subsumed by reply in the overlay's cross-post routing), no vote controls (voting on external items is not supported). Bookmarking doesn't apply to external items either way, since the product-wide bookmark mechanism has been replaced by reading-history resumption (see §4 above), which only operates on native articles with a dedicated reader surface. ✅ SHIPPED — inline ExternalReplyComposer removed; Reply routes to compose overlay; Quote removed from action row; provenance badge moved into byline row as grey-400 text.

The card body click behaviour is different from the article card: clicking anywhere in the card body *does not* navigate. External items are ingested into the feed for reading in-place, not for deep-linking into a dedicated reader surface. If the user wants to see the item on its original network, they click `VIEW ORIGINAL ↗`.

### Thread rendering — the playscript treatment ⏳ TODO

Q4 in the scope doc: how do reply threads render? The answer is a deliberate departure from the current nested-indented-reply pattern in `ReplyItem.tsx`. The current treatment (`ml-8 pl-3 border-l border-grey-200` at each nesting level) produces the Gmail/Reddit family of thread visuals, which is exactly the register the product is trying to move away from.

The replacement is the playscript treatment. It treats a reply thread as a transcript of a conversation — flat, speaker-led, minimally indented.

Structure: each reply renders as a single line block, 32px of vertical padding between replies, no nesting, no left borders, no indentation between replies, no hairline rules between turns. At rest, the reply has two visible elements stacked tightly — a speaker line and a dialogue line — plus a vote-count in the top-right corner as persistent furniture. A third element, the full action row, appears on hover or keyboard focus. These are specified in the three passages below.

The whole thread — the stack of replies beneath a card — is offset 32px to the right of the parent card's content column. This single step-in signals that the thread belongs to the card above without using nesting as the mechanism. It is the only indentation in the thread system; individual replies within the thread are not further indented, regardless of who is replying to whom. 32px is a deliberate choice: enough to register as an assertive belonging-to cue (at smaller values the thread reads as a quiet continuation of the parent rather than a response to it), but not so large that the step-in starts to read as hierarchy. It also aligns roughly with the rhythm multiple of the feed's 40px inter-card spacing, giving the system a dimensional coherence.

In place of the hairline rules an earlier version of this section proposed: nothing. The 32px vertical padding between entries, combined with the typographic split between the mono-caps speaker line and the Jost dialogue line, does the turn-boundary work on rhythm alone. The absence of rules is what gives the thread its transcript feel — rules would pull it back toward ticket-log territory.

*Speaker line.* Mono-caps 11px, `tracking-[0.06em]`, `grey-600` by default. Contains: trust pip, speaker name (displayName or username), a colon. That's it. No timestamp, no avatar (this is the big change — avatars go away in the thread; the pip-and-name combination carries the identity without the visual weight of avatars, which accumulate when threads get long and make them feel crowded). The colon is typographically deliberate: it's the playscript grammar, and it reads as "this person says:". The speaker name is in Jost bold weight within the mono-caps line (same size) to give it slightly more presence than the rest of the byline.

*Dialogue line.* Jost 14.5px, 1.55 line height, `#111111`, directly below the speaker line at 4px remove. No indentation from the speaker line. This is the reply's content. Media embeds render via `MediaContent` as usual. If the reply is long (over 3 lines), it renders in full — no truncation, no "show more". Long replies are fine; the playscript register accommodates them.

*Action affordances.* The spec's earlier version had the full action line (timestamp, `REPLY`, vote, delete/report) visible beneath every reply at rest. In practice, once there are five or six entries, each carrying its own three-row stack (speaker / dialogue / action), the thread starts reading busy — the *rhythm of action lines* becomes as visible as the rhythm of content, which pulls the register back toward chat-log. The revised treatment: at rest, each reply shows only the vote count — a single mono-caps `▲ N` in `grey-400`, positioned at the top-right of the dialogue block, aligned to the first line of text. This is the one piece of social-proof furniture the thread preserves always-on, because vote weight genuinely marks which lines landed and that is editorial information the playscript should carry.

On hover (or keyboard focus), the full action line appears beneath the dialogue: relative timestamp (`14m` / `3h` / `2 MAR`), `REPLY`, `DELETE` (for the user's own replies or content-author-moderation), `REPORT`, at mono-caps 11px, `tracking-[0.02em]`, `grey-400`. The vote count stays in place at the top-right; the appearing row is action-only. This mostly-hidden-until-needed treatment is what allows the thread to read as pure dialogue at rest — every affordance is still there, just not competing with the reading.

The hovered reply itself may get a subtle background tint (a very light off-white, approximately `#fafaf7`) to mark which reply's action line is showing. This is optional polish rather than load-bearing; a version without any background change is also acceptable.

No quote-of-parent treatment (the current `"On [date] [name] wrote"` pattern explicitly called out in Q4 as a thing to not do). If reply B is replying to reply A, the visual cue is that reply A appears immediately above reply B; the thread is read top-to-bottom and the context is the sequence itself, not a nested visual structure. If reply B is replying to a non-adjacent reply (e.g. the user replies to the third reply in a thread rather than the most recent), a very subtle treatment is used: the name of the replied-to user appears in the speaker line, prefixed with `→`, as in `→ CLARA SZALAI:   YOU:` — the `→` is a typographic arrow, the first name (in `grey-400`) is the person being replied to, "YOU" (in the speaker's default black) is the speaker. A 16px gap separates the prefix from the speaker's name; jammed together, the two read ambiguously as a single two-person line. With the gap, the parse is unambiguous on first reading: "replying to Ines — speaker: You". This is the one piece of nesting information the thread surfaces, and it surfaces it in the speaker line rather than with indentation.

Depth limit: the current code allows 2 levels of nesting. The playscript treatment erases nesting entirely, so this limit becomes irrelevant — replies are flat. A reply to a reply to a reply is just three sequential flat entries in the transcript, with the `→` arrow disambiguating where needed. This is a significant simplification and it is the point.

Rendering at scale: long threads (20+ replies) need a pagination pattern. The thread renders the first 10 replies in full, then a mono-caps action `SHOW 14 MORE REPLIES` in `grey-400`, underlined on hover. Click expands the rest. No algorithmic sorting, no "top reply" promotion — replies are always in chronological order (the scope doc's "reverse chronological by default, sortable and filterable but never silently reordered" applies here too, though threads are forward-chron since the reading direction of a conversation is forward in time).

One more detail. The user's own replies are visually distinguished by their speaker line reading `YOU:` instead of the user's own name. This is a small editorial move that mirrors playscript convention (where the reader of the script is never named) and reinforces the register. The TrustPip is omitted for `YOU:` lines — the user doesn't need trust information about themselves. A consequence: since every other speaker line begins with a pip and `YOU:` lines don't, there's a small left-edge jog where `YOU:` lines sit 16px further left than pip-bearing lines. This is deliberate — `YOU:` is semantically different from any named third-party speaker (it's the reader, not a character in the scene), and the typographic irregularity mirrors that semantic one. Giving `YOU:` an invisible pip-slot spacer for perfect alignment was considered and rejected; the honest version is the asymmetric one.

### Card states

*Default:* as composed.
*Hover:* on article cards, headline colour transition as noted. No hover state on note/external cards (the card is not itself a click target for those types).
*Loading:* the existing `InlineSkeleton` pattern applies to all three card types. The skeleton does not attempt to match per-type structure — three generic shape-matched blocks are sufficient and read as "content loading" without promising a specific card type.
*Focus (keyboard navigation):* a crimson 2px outline with 2px offset appears around the whole card. This is the `focus-ring` utility already defined. Keyboard users can tab through the feed, landing on each card's primary action (article: the card link; note: first action button; external: the `VIEW ORIGINAL` link).
*Muted:* currently, muted replies don't render (`if (reply.isMuted && !reply.isDeleted) return null`). This stays. Muted *notes and articles* in the feed should render as a single mono-caps line `MUTED` in `grey-300` where the card would be, with `SHOW` on the right — consistent with the feed's "flow past" principle rather than hiding things entirely.
*Deleted:* already handled — the content renders as `"[content deleted]"` in italic grey. Stays.

---

## 5. What this spec is missing and deliberately so

This is the chrome-and-surfaces spec. It does not cover:

*The filter bar (Q1).* Its position is specified (under the subscribe input, sticky, 60px high, fits the slab-grammar). Its visual design — how filters render, how they combine, how URL-param state surfaces in the UI — is a separate spec pending its own sketch. The feed surface section above leaves the space for it and commits to its height so whatever ships doesn't require retrofit.

*The for-you model (Q2).* The scope doc's answer is graph-adjacent-primary with transparent provenance, and the answer is good enough for the backend to build against. The visual design of how provenance renders per-item (the *"surfaced because 3 people you follow vouch for this author"* label format) is a small but real design question, specced alongside the filter bar.

*The trust profile drill-down.* Tap on the pip, slide-in profile panel — Phase A item 7. Already roughly scoped in the codebase (`TrustProfile` component exists). The drill-down's own visual design is not covered here and needs its own pass.

*The cliquey primitive.* Phase A item 9. Opens a new overlay-like surface (compose with recipients, pinned item as subject) but the *conversation* surface that results is the Messages view, not a new one. Messages needs its own spec pass to handle item-pinned threads; that spec builds on this one.

*Mobile compose surface in detail.* This spec sketches the mobile treatment at the end of §3 but doesn't fully resolve the gestures, the keyboard behaviour, the file-picker integration. That's a focused mobile pass.

*Dark mode (Q6).* The entire spec assumes light mode. Dark mode needs its own token derivation before the filter bar locks (as the scope doc notes). The spec's colour choices are all tokenised in a way that dark-mode mapping should be mechanical, not re-designed.

---

## 6. Implementation order

Not a phased roadmap — that's the scope doc's job. Just a practical sequencing note for building this spec's pieces.

*First: the swap.* ✅ SHIPPED (commit `0ed389b`, 2026-04-17) — `FeedView.tsx` replaced sticky `NoteComposer` with sticky `SubscribeInput`. `Nav.tsx` added the `COMPOSE ⌘K` cluster and reduced nav to `Feed | Dashboard`. Canvas ∀ mark changed to crimson. Global `⌘K` hotkey wired (no-op on `/write/*`). MobileSheet updated to match.

*Second: the compose overlay — note mode only.* ✅ SHIPPED (commit `0ed389b`, 2026-04-17) — `ComposeOverlay.tsx` built with note + reply modes, three-zone slab structure, cross-post toggle via linked accounts, image upload, character counter, double-escape dismiss. `stores/compose.ts` Zustand store coordinates overlay state across Nav, FeedView, QuoteSelector, WriterActivity. Overlay mounted globally in `layout.tsx`. NoteComposer removed from all mounting points (FeedView, QuoteSelector, WriterActivity).

*Third: the card chassis refactor.* ✅ SHIPPED (commit `0ed389b`, 2026-04-17) — All three card types unified: 4px left bar (black native, crimson paid, grey-300 external), mono-caps 11px byline with pip/author/middle-dot/timestamp, avatars removed from NoteCard and ExternalCard. ArticleCard bar narrowed 6→4px, Reply added. NoteCard byline changed from Jost 14px semibold to mono-caps 11px. ExternalCard provenance badge moved into byline row, inline composer removed, Quote removed. Feed vertical rhythm unified to `space-y-[40px]`.

*Third-and-a-half: article tiers.* ✅ SHIPPED (2026-04-18) — Migration 068 adds `size_tier` column to `articles` with a BEFORE INSERT trigger that derives the tier from `word_count` when not explicitly set (editorial overrides survive re-publish). Gateway feed route emits `sizeTier`. `ArticleCard` branches headline size (30/22/20px) and skips excerpt+tags for briefs; new `twoUp` prop shrinks byline/action to 10.5px and drops Quote/Bookmark/Share. `FeedView.layoutBlocks()` pairs adjacent briefs two-up (40px gutter) with a 72px zone-break before each contiguous run.

*Third-and-three-quarters: reading-history resumption.* ⏳ TODO — Build `(user_id, article_id, scroll_ratio, updated_at)` table and reader-page snapshot-and-restore. Note: bookmark button has not yet been removed, so the window-of-no-mechanism risk from the original sequencing doesn't apply yet.

*Fourth: the playscript thread treatment.* ⏳ TODO — Rewrite `ReplyItem.tsx` with flat speaker-line structure. Ship behind feature flag recommended.

*Fifth: compose overlay — article mode.* ⏳ TODO — Extend overlay to handle articles with title field, publication selector, Tiptap editor, and state-preservation across overlay ↔ full-editor transition. Currently the overlay's "Write an article" link navigates to `/write/new` as a workaround.

*Sixth: the end-of-feed affordance, the zero state, the error state.* ⏳ TODO — Small polish items, ship together once chassis is stable.

---

## Summary

Four surfaces, four principles.

*The topbar* is a beam, not a navbar, and it carries the compose action that the feed used to hold.

*The feed* is a single reverse-chron column with subscribe at the top, filter bar under that, content flowing past. Vertical rhythm does the work that separators usually do.

*The compose overlay* is one slab with three modes (note, reply, article). It opens from anywhere and dismisses back to context. It is where all composing happens, everywhere in the product.

*The card family* shares a chassis (bar, byline, content, actions), differs in content zone only, and routes replies through a single unified affordance. Article cards render in three tiers — lead, standard, brief — with briefs able to pair shoulder-to-shoulder in a weekend-supplement two-up. Italic Literata is reserved for native article headlines; external content uses roman. Threads render as playscripts, flat and speaker-led, not as indented forums.

Beneath these four surfaces sits one cross-cutting behaviour: *reading history and resumption*. Articles remember where you were when you left them, without asking you to bookmark them. This replaces an earlier explicit bookmark mechanism and changes the register of how the product treats reading — as something ongoing and remembered, not as something you file.

These four surfaces are about 80% of what a user sees in the first minute of using the product. Getting them right is what makes the thesis read as real rather than as aspirational.
