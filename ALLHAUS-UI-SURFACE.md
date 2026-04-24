**all.haus — UI Surface Description**  
A feature-by-feature inventory of the user interface as it now stands across the tracked planning documents. This revision reconciles the April 2026 documents — PRINCIPLES.md, WORKSPACE-DESIGN-SPEC.md, WIREFRAME-PLAN.md, and CARDS-AND-PIP-PANEL-HANDOFF.md — with the prior product corpus (CLAUDE.md, UI-DESIGN-SPEC.md, feature-debt.md, all-haus-frontend-audit.md, the README, and the ADRs under docs/adr/).  
Where the April 2026 documents speak, they win. The prior product corpus is treated as the carry-over surfaces appendix — real surfaces the new spec has not yet rebuilt and which therefore continue to govern, with the understanding that they will be re-decided as the workspace metaphor is propagated through the rest of the product.  
Last compiled: 2026-04-24. Conflicts resolved as follows:  
- **Left colour bar on article cards** — dropped (per CARDS-AND-PIP-PANEL-HANDOFF.md, which supersedes WIREFRAME-PLAN.md's prior reference to left bars; paywall status moves into the header row as a crimson PAYWALL · £X.XX chip).  
- **Trust dimensions** — three poll questions plus an in-person count (per the cards/panel handoff), not the prior four-dimension humanity / encounter / identity / integrity scheme. The vouch CRUD as currently implemented is treated as legacy pending reframing.  
- **Cross-feed bookmarks** — dropped. Save in the new model is a per-feed Saved state surfaced from content-scope long-press; /library as a cross-feed bookmark surface does not survive the workspace reframe.  
- **Top-level six-page IA** — superseded by the workspace. The /, /feed, /dashboard, /ledger, /library, /network, /profile, /settings URL space is treated as transitional; the workspace itself is the surface, with user-scope settings reached deliberately and writer/admin surfaces flagged as carry-over pending re-decision.  
- **Reading tab / micropayments** — deferred to phase two per WORKSPACE-DESIGN-SPEC.md. Subscription paywalls only at launch.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AUBBAsUfyNTCi9VwgEA3sWGAjJK2CbjNzVGcAAPzFtapV7V9PAAB47X4AEW4ELQDBN+AAAAAASUVORK5CYII=)  
**0. Design foundation**  
Not a feature, but the substrate every feature below inherits.  
- **Palette.** Near-black (#111), white, five greys (grey-100 is the workspace floor and the most-used neutral), single crimson accent (#B5242A). No border-radius anywhere. No hairlines, no keylines, no drawn frames anywhere in the system. The grammar leaves no place where a hairline would fit; space and wall-weight do the framing work that borders would otherwise do.  
- **Typography — three voices.** Literata (serif) for content, headlines, author names in card headers, and the body text of the pip panel; Jost (sans) for platform UI and any interactive control labels; IBM Plex Mono 11px caps for infrastructure labels and metadata. Tokens: text-ui-xs (13px sans), text-ui-sm (14px sans), text-mono-xs (11px mono), .label-ui (11px mono caps, 0.06em tracking). Plex caps copy is uppercase by token; never set uppercase by hand on Plex.  
- **Crimson is strictly functional.** Logo, paywall indicator, prices, primary CTAs, the user's "your action" state on votes/quotes/replies/reports, and the four crimson states inside the trust pip. Nowhere else.  
- **Square avatars where avatars appear at all.** Cards do not use avatars; the pip plus mono-caps platform line plus author name carry identity in the card grammar.  
- **No toasts.** Success = text-grey-600 text-ui-xs near the action. Error = text-red-600. Inline, auto-clearing.  
- **Confirmation.** Simple destructive actions use browser confirm(). Money, irreversibility beyond a single record, or multi-party consequences use a custom modal (fixed overlay, bg-black/40 backdrop-blur-sm, white card, cancel/confirm pair). Type-to-confirm modal reserved for publication and account deletion.  
- **Aesthetic register.** Solid, chunky, confident. Anything faint, recessive, or over-accumulated is wrong for this system.  
**Iconographic grammar**  
Two marks, related by geometric transformation.  
- **∀** — universal quantifier. The default-open state. The mark of *everything before narrowing.* Used as the logo, as the label on any default-open field (empty audience selector, unfiltered feed source), and as the workspace-level affordance for creating new objects.  
- **⊔** — disjoint union. The vessel. The mark of *a container assembled from sources.* The shape every feed takes at the workspace level — heavy black walls, open at one end, content held within. Carries a feed; not used as an icon outside the workspace itself.  
The transformation ∀ → H → ⊔ is the signature visual move. The H is a transitional form in the animation, evoking *haus* without making a fuss; it is a ceremonial transit point, not a category the product carries.  
**Unresolved or confused**  
- **Dark mode.** The three-voice palette, the crimson accent, the grey-100 floor, the heavy-walled vessel, and the opaque-white card are all authored against a white-only environment. Wall-weight is supposed to remain legible at the dark-mode limit per WORKSPACE-DESIGN-SPEC.md §"Brightness", but a dark-mode translation of the per-vessel brightness gradient (where dark-mode sits at the dim limit per-feed, vs. dark-mode as a global theme) has not been resolved.  
- **Crimson at dim brightness.** Engineering constraint, named explicitly in WORKSPACE-DESIGN-SPEC.md: paywall indicators, price markers, the four crimson trust states, and "your action" colouring must remain legible and distinctive across the brightness range. This is acknowledged but not yet stress-tested in any tracked artefact (WIREFRAME-PLAN.md §step-2 names this as the test that must be done).  
- **Legacy CSS aliases.**globals.css carries rule aliases from a mid-stream design migration (frontend audit §12). Which rules are current and which are aliases is not documented. Will need pruning as the workspace surfaces land.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJGkPcrHpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaJkELjbMzy0AAAAASUVORK5CYII=)  
**1. The workspace**  
The user's primary surface. A reading room.  
**1.1 Frame**  
- A single rectangle — the user's screen, at whatever size.  
- The workspace floor is grey-100. There is no other framing in the system above this.  
- Feeds are heavy black ⊔ vessels arranged on the floor, with space between them.  
- Layout persists. Closing and reopening the app restores the exact state of arrangement, orientation, brightness, density, and per-feed scroll position.  
**1.2 Physics**  
- Feeds have intuitive physics. They are manipulable objects with persistent position, orientation, size, and brightness.  
- Feeds do not overlap. They tile, stretch, and can collapse to peripheral strips, but they never stack on top of each other. Drag gives a capability; overlap gives a problem the physical metaphor refuses to import.  
- The workspace has a carrying capacity. A vertical ⊔ takes meaningful screen; a horizontal strip takes a slice. A user with more feeds than will fit at primary brightness and full density will feel productive pressure to rearrange — to dim some feeds, collapse others, reorient some to peripheral strips.  
**1.3 The ∀ workspace control**  
A small persistent ∀ mark on the workspace floor. Always visible, never intrusive.  
- Position is being decided in prototyping (WIREFRAME-PLAN.md step 4): bottom-right corner anchor versus floating along the workspace edge. Decision is a thumb-reach test on real hardware, not a static-frame call.  
- Tapping reveals exactly four actions, in this order:  
1. **New feed** — opens an empty ⊔ vessel with the feed-creation animation.  
2. **New note** — opens the note composer with empty To and empty body.  
3. **Fork feed by URL** — paste a URL of any feed (internal to all.haus, or RSS / Bluesky / Nostr / Mastodon source) and get a new ⊔ vessel pre-populated with the source.  
4. **Reset workspace layout** — return all feeds to default arrangement. Non-destructive (no feeds deleted, no content lost). Behind a confirmation.  
- Deliberately *not* in this menu: new feed templates, feed sharing, workspace sharing, advanced import, **new article**. Articles are elevations of notes, reached from inside the note composer.  
**1.4 Brightness, focus, and reading vs arranging mode**  
The coupling of per-vessel brightness to a "reading mode" that brightens a focused feed and dims its neighbours is *flagged but deferred* (WORKSPACE-DESIGN-SPEC.md §open questions). This is its own design pass.  
**Unresolved or confused**  
- **∀ position** — corner vs floating edge. To be resolved in prototyping.  
- **Brightness baseline.** Absolute per-feed brightness is what the spec commits to. An offset-from-workspace-global-baseline that tracks ambient light or time of day is a possible future revision.  
- **Reading mode vs arranging mode.** Out of scope for the current spec; needs its own design pass.  
- **Topbar / persistent chrome.** The workspace metaphor has no header bar. The doc previously described a sticky Nav with Feed | Dashboard plus COMPOSE ⌘K, NotificationBell, AvatarDropdown. Of those, COMPOSE ⌘K is replaced by the ∀ menu's *new note* (with ⌘K as a candidate hotkey to open the menu directly), and the avatar dropdown's contents collapse into the user-scope surface (§21). NotificationBell is one of the carry-over surfaces — see §14.  
- **Footer.** Not addressed in the workspace spec. The previous doc had no spec for a footer either.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSPBCj7fFRYQwYwEZiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AMTJBeJDClAyAAAAAElFTkSuQmCC)  
**2. Vessels — feeds**  
Every feed at the workspace level is a ⊔. Heavy black walls, open at one end, closed on the other three sides. The shape is the container; there is no per-feed icon, no separate frame, no card rectangle behind the content.  
**2.1 Vessel chassis**  
- **Walls.** Drawn heavy. Weight is what distinguishes structural from decorative. A thin-walled vessel reads as a border around a rectangle; heavy walls read as a container with material presence.  
- **Opening.** The open end is where new content arrives. Vertical (primary reading orientation) → opening at top, content stacks downward, newest at the opening, oldest at the base. Horizontal (peripheral awareness orientation) → ⊔ rotated 90°, opening at one end determined by the newest-end setting.  
- **Interior.** Cards (§3) sit inside the vessel at the current density, on the grey-100 floor visible inside the walls. Floor visible above, below, and between cards. No per-item dividers, no hairlines, no cards within cards.  
- **Scrolling.** When content exceeds the visible height, walls stay put, content scrolls within them. The vessel is a viewport onto an arbitrarily deep container.  
- **Name label.** Discreet, typographically quiet, positioned just above the opening (or alongside, in horizontal orientation). User-set. New feeds arrive untitled and prompt for a name on first edit; the founder's feed arrives with a default name.  
- **Brightness.** The whole vessel — walls, content, opening — dims and brightens as a unit. Heavy walls remain legible at every luminance.  
- **Shape invariance.** All feeds are ⊔-shaped. There is no visual distinction between inherited and user-made feeds at the workspace level. The founder's feed sits among the user's own as a peer, distinguished only by its name label and contents.  
The four rendering variables (wall thickness, opening width relative to base width, aspect ratio at rest, interior padding) are committed only as constraints — the ⊔ must read unmistakably as a vessel and not as a rectangle with three borders. Specific values are pending the step-1 prototyping pass.  
**2.2 Per-vessel controls (feed-scope)**  
Always carried by every vessel. Reached by gesture on the vessel, not by visible chrome.  
- **Composer** — long-press the name label (or an affordance adjacent to it) opens the configuration depth: list of sources, add-source-by-URL, per-source weights, feed renaming, deletion. Not visible at rest. The composer is *the ⊔ expression exposed as editable text*; see §2.3.  
- **Position** — drag to move. Other vessels reflow. No grid snapping. Position persists.  
- **Size** — pinch to resize, or drag a corner. Minimum size below which content becomes illegible; no maximum. Size persists.  
- **Orientation** — two-finger rotation switches between vertical (column) and horizontal (strip). Vertical is the primary reading orientation; horizontal is peripheral.  
- **Newest-end direction** — flick gesture reverses chronology. Default reverse-chronological (newest at the opening). Reversed reads oldest-first — for serialised reading, chronological queues, working through a feed.  
- **Density** — three states, gestural toggle: *compact* (title only),  *standard* (title + byline + brief preview, the default),  *full* (the full card including hero image and source attribution).  
- **Brightness** — two-finger vertical drag on the vessel. Up brightens, down dims. Continuous during the gesture. Default for new feeds is medium-bright. Persists per-feed.  
**2.3 The feed composer (depth surface)**  
Reached via long-press on the name label.  
- The strongest steer from WIREFRAME-PLAN.md: the ⊔ expression *as editable text*, not a settings panel. Sources are operands; weights are coefficients; the editability should make the ⊔ structure visible.  
- Carries: list of sources, add-source-by-URL (resolver-backed — accepts URL, handle, email, npub, DID, NIP-05, Bluesky handle, Mastodon user@instance, Nostr nprofile, RSS feed URL, etc.), per-source weights, feed renaming, deletion.  
- Two states to wireframe: a fresh feed with one source, a feed with four or five sources of different weights.  
**Unresolved or confused**  
- **Vessel rendering details.** Wall thickness, opening width, aspect ratio at rest, interior padding — to be resolved in prototyping (WIREFRAME-PLAN.md step 1).  
- **Vessel density visual differentiation.** The three densities must read as three distinct states, not three interpolations of the same state. Tested in step 2 of the wireframe plan.  
- **Same-author-on-multiple-platforms.** "Source" in the ⊔ expression is a (platform, handle) pair. An author on both Bluesky and Nostr is two sources. Whether the per-author volume setting in the pip panel applies across the author's sources is an open question.  
- **Feed sharing, workspace sharing, multiple workspaces, import/export beyond single-URL fork.** Deferred indefinitely.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJe0PYTKpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaIEEMYtKmi4AAAAASUVORK5CYII=)  
**3. Cards**  
A single card type, parameterised by content shape (article, note, embedded quote), shares an outer grammar across all three.  
**3.1 Material treatment**  
- **Opaque white blocks** sitting on the vessel's grey-100 floor. The floor shows between cards as breathing space.  
- **Edges defined by the meeting of opaque surfaces.** No drawn borders, no left colour bars, no hairlines.  
- **Inset 20px from each vessel wall.** Content inset a further 20–24px from the card edges.  
- **Heights vary by content.** Articles taller, notes shorter, embedded-quote notes tallest. The shared header and action strip mean variation reads as "different content" rather than "inconsistent layout."  
**3.2 Header row**  
A horizontal attribution strip, identical across the three card variants (sized down inside an embedded quote — see §3.5).  
- **Trust pip** at left, flush with the card's inner margin. ~11px diameter coloured circle.  
- **Author name** in Literata medium 16px, immediately after the pip. The primary identifying element. This is the tap target for the author's profile on their source platform.  
- **Source platform + date** in IBM Plex Mono caps 10px, 0.14em tracking, following the author name.  
- **Paywall indicator** (articles with a paywall only) — PAYWALL · £X.XX in crimson, plex-caps register, far right of the header.  
The pip is the tap target for the pip panel (§4). The pip and author name are adjacent but distinct interactions — the pip opens the panel, the name opens the author's profile.  
**3.3 Article body**  
For native long-form articles (NIP-23 kind 30023):  
- **Title** in Literata medium 22px.  
- **Standfirst** in Literata regular 15px over two or three lines.  
- **No byline** in the body (already in the header).  
- **Hero image** where the article body has one extracted server-side; positioned per density.  
Article *size tiers* (lead / standard / brief, derived from word count via migration 068 with editorial overrides) survive as a content-shape variable inside the article card variant: lead headlines render at 30px instead of 22px, brief cards drop the standfirst entirely and pair two-up with another brief on the same row. The feed_items denormalised table remains the backing store. The size tier is a property of the article rendering inside the card body, not of the card chassis — chassis (header, action strip, material treatment) is identical.  
**3.4 Note body**  
For native short posts (Nostr kind 1):  
- **Body prose** in Literata regular 16px. No title. No standfirst. The body is the content.  
**3.5 Embedded quote (note that contains another content object)**  
The outer note's body runs as normal. The quoted inner object sits below as an inset block:  
- Subtly lighter fill (grey-50 or equivalent — lighter than the floor, distinct from the card).  
- Smaller pip.  
- Quoted author's name in Literata medium 13px.  
- Their platform metadata in smaller plex caps.  
- Quoted content in Literata regular 14px with reduced weight (fill #5F5E5A).  
- **No action row of its own.**  
- **Inner pip is tappable** and opens the pip panel for the quoted author. Acting on the quoted object (upvoting, replying) requires tapping through to its own card.  
**3.6 Action strip**  
A horizontal row, IBM Plex Mono caps 11px, identical across all three variants.  
- **Vote unit.** Upvote arrow ▲ · netted vote score · downvote arrow ▼. Clustered as one unit. The netted score is the number between the arrows.  
- **Separator.** A thin · in grey-300.  
- **QUOTE** — combines what other platforms call quote and repost. A repost is a quote with empty commentary; a single action handles both. Opens the note composer with the target as context. Protocol adapters produce the correct downstream event type per source platform (Bluesky repost, Nostr quote-comment, Mastodon boost-or-quote).  
- **REPLY** — opens the note composer in reply mode.  
- **REPORT** — typographically quietest item. Lighter grey (#B4B2A9) than the others. Present on every card, never hidden behind a ⋯ menu.  
**3.7 Votes are paid**  
- Both upvotes and downvotes cost money, escalating per-voter-per-target via the existing votes / vote_tallies / vote_charges schema and sequence_number.  
- **Upvote payment** → author as tip.  
- **Downvote payment** → platform as revenue.  
- Cost at rest is *not* displayed. Cost labels appear on **approach** (desktop hover) or  **press** (mobile) and reveal the raw up/down counts plus the current cost for both directions.  
- This resolves the principle-level tension with aggregated vote scores: scores exist, but users opt into them as filters via the volume control's TOP sampling mode (§4), not as the platform's own opaque ranking signals.  
**3.8 "Your state" colouring**  
When the current user has upvoted a card, the upvote arrow becomes crimson. Same for downvote. When they've quoted, replied, or reported, the respective word becomes crimson.  
**3.9 Hover and active states**  
Vote arrows and quote/reply/report controls follow the existing repo pattern: crimson for "your" action state, slight hover lift otherwise. Specified, not yet drawn.  
**Unresolved or confused**  
- **Cards with media.** Lead image on an article. Image in a note. Video embed in a standfirst. Not yet drawn. The grammar will stretch.  
- **Cards at dim brightness.** Whether crimson holds at the dim extreme — paywall indicators, "your action" states, the four crimson trust pip states — is an engineering constraint not yet stress-tested.  
- **Long-note truncation.** Notes beyond ~6 lines. Truncation mark plus tap-through, or a small READ MORE in plex caps? Pending.  
- **Quote-of-quote chains.** The §3.5 embedded quote treatment handles one level. Behaviour at depth 2+ is not specified.  
- **External sources** — the via RSS / NOSTR / BLUESKY / MASTODON provenance line previously rendered in the byline row of an ExternalCard does not appear in the new card spec. The likely home is the platform metadata in the header (the source platform line is exactly the VIA RSS etc. line under another name), but this should be confirmed when the workspace + cards land.  
- **Per-protocol Reply / Quote eligibility on items from external sources.** Whether Reply on a card sourced from an external platform requires the viewer to have a linked account of the matching protocol, or whether it falls through to a native note with a link-back, is a behaviour the new card spec does not address. The prior convention (cross-post pills filtered to matching protocol) is a candidate.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OMQ0AIAwAwZIgBKn1gjJsdGLBABMhuZt+/JaZIyJmAADwi9VP1NMNAABu1AaU4gUeBSGW2wAAAABJRU5ErkJggg==)  
**4. The pip panel**  
Opened by tapping the trust pip on a card. The substantive surface that does the per-author work the prior product split between profile masthead, follow button, mute action, and (now defunct) cross-feed bookmark.  
**4.1 Material and placement**  
- Same opaque-white, sharp-edged treatment as cards. Roughly 420px wide × 390px tall.  
- Sits on its own, visually at the same level as the cards it came from.  
- **Desktop:** popover from the tapped pip.  **Mobile:** bottom sheet. Same content in both.  
- Not a tooltip — a substantial surface.  
**4.2 Header row**  
Mirrors the card's header at panel scale.  
- The pip, drawn slightly larger than on the card.  
- Author name in Literata medium 18px.  
- A chevron › after the name. Name+chevron is the tap-through to the author's profile page.  
- Right-aligned: FOLLOW › (or FOLLOWING › when active, with hover revealing UNFOLLOW) in plex caps 11px. Text-only, no button chrome.  
**4.3 Bio line**  
One line of Literata regular 14px. The author's short self-description. Plain regular weight, not italic. (Italic is reserved for editorial / connective prose elsewhere on the panel.)  
**4.4 Trust section**  
A plex-caps header TRUST at left; a depth affordance ALL POLLING › right-aligned on the same line.  
Below: three polled questions, each with a YES/NO answer and a percentage confidence.  
1. **Are they human?**  
2. **Are they who they seem to be?**  
3. **Do they engage in good faith?**  
Each question Literata regular 13px, left-aligned. Each answer plex caps 11px, right-aligned, in the colour of the answer (green for positive, amber/crimson for negative or ambivalent), with a percentage showing poll confidence.  
Polling is anonymous and secure, drawing on the user's trust graph and the wider network. The three questions match what polling can reliably produce:  
- *Human* is reliably answerable from surface signals.  
- *Who they seem to be* deliberately weaker than "who they say they are" — respondents judge surface presentation, not verified claims. Catches category-level impersonation without requiring respondents to have verified specific credentials.  
- *Good faith* is the behaviour-over-time honesty question, phrased as observable conduct rather than abstract character. Catches both Frankfurtian bullshit and outright fraud without asking respondents to diagnose which.  
Below the three poll results: a single italic Literata line giving the in-person count, e.g. *3 people in your graph have met Craig in person.* A different kind of signal — a relational fact, not a character judgment — visually broken out by italic.  
**4.5 The pip itself**  
A compression of the four signals. Provisional mapping pending the trust-system spec proper:  
- **Green.** All three polled questions positive with high confidence.  
- **Amber.** Mixed or low-confidence signal; thin polling history; new account.  
- **Grey / outline.** No signal — account not polled.  
- **Crimson.** One or more questions answered negatively with confidence.  
When the three signals disagree (e.g. human-yes but good-faith-low), the pip colour and the per-question cells can show mixed states.  
**4.6 Volume section**  
A plex-caps header VOLUME.  
Below: a horizontal bar showing the current setting.  
- Bar spans − at far left to + at far right, both plex mono 16px. TV-remote vocabulary: tap minus to step down, plus to step up; drag the bar for continuous adjustment within the discrete steps.  
- Bar track grey-100, filled region black. Continuous fill (no gaps).  
- Five discrete steps: 20%, 40%, 60%, 80%, 100%. Tick marks below the bar (1.5px wide, 5px tall, grey).  
- Current value label (e.g. 60%) above the end of the fill region, plex caps, quiet but legible.  
- **Zero is achievable.** 0% means muted — mute is the natural bottom of the scale, not a separate action.  
Below the bar: a binary mode toggle labelled Sample (Literata regular) with two small plex-caps buttons RANDOM and TOP. Controls *how* the percentage is filled — a random sample of the author's output at the given throughput, or the top cut by engagement at that throughput. This is the user's opt-in to aggregated vote signals.  
Volume setting is **private** — about this user's own feed, not a public statement about the author.  
**4.7 Footer**  
If the author offers subscriptions, a right-aligned SUBSCRIBE · £5/MO (or similar) in plex caps 11px. Otherwise empty. When active: SUBSCRIBED — MANAGE ›.  
**4.8 What the panel does NOT carry, and why**  
- **Block.** A DM-layer action, not a feed-layer action. Lives on the author's profile page or DM surface.  
- **Mute as a separate action.** Mute = 0% volume, handled by the bar.  
- **Report.** About a specific piece of content, not about the person. Lives on the card's action strip.  
- **Subscription management.** Subscribing is the action; managing is on profile or account.  
- **Notify on publish, notification preferences, etc.** Lives on the author's profile page.  
The panel is *judgment + commitment* surface: form a view about the person, set how much of them you want, optionally escalate to paying them. Everything else is elsewhere.  
**Unresolved or confused**  
- **Pip panel in non-green states.** Amber, grey, crimson versions. Stress-test whether the architecture holds when trust signals are negative.  
- **Pip panel detail view (** **ALL POLLING ›** **).** Bigger, less-reliably-polled questions: verified credentials, network associations, specific claim verification. Belongs to the trust-system spec proper.  
- **Volume ** **TOP** ** sampling metric.** Top by upvote count? Net score? Engagement breadth? Recent or all-time? Committed to *top* as the binary opposite of  *random* but the metric behind it is a real choice.  
- **Subscription state variants.** Panel when the current user already follows / is subscribed / is the author themselves / the author offers no subscription.  
- **Mobile sheet treatment.** Specified as bottom sheet, geometry not yet drawn.  
- **Pip-colour composition function.** How the four signals (three poll results + in-person count) compose into a single pip colour — a weighted function? Threshold logic? — is the architectural problem the panel design depends on but does not solve. Trust-system-proper territory.  
- **Whether a user can see their own past trust poll answers, or update them.** If yes, the polling system has identifiers tied to respondents. If no, bad-faith early answers become sticky.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSPBCj5fFgpQwYwEZiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AMTRBeEgNK9YAAAAAElFTkSuQmCC)  
**5. Trust model**  
**5.1 The trust pip**  
5px circle rendered inline in the byline row of every card and the speaker line of every reply (§10.3). Four states (per the panel spec, §4.5), composed from three polled questions and the in-person count.  
**5.2 The pip panel**  
The substantive trust surface. See §4.  
**5.3 The current vouch system — legacy pending reframe**  
The current implementation (POST /vouches, DELETE /vouches/:id, GET /trust/:userId, TrustPip three-state component, TrustProfile four-dimension bars, VouchModal with humanity/encounter/identity/integrity dimensions, VouchList on /network > Vouches) does not match the new model.  
**Reframing decisions to land:**  
- The four dimensions (humanity, encounter, identity, integrity) collapse to the three poll questions (human / who-they-seem-to-be / good-faith) plus the relational in-person count. **Integrity is explicitly rejected** as too abstract.  
- TrustPip moves from a three-state (known / partial / unknown, derived from account-age × paying-readers × KYC) to a four-state (green / amber / grey / crimson, derived from poll results) component.  
- Public per-attestor vouches under the current scheme are likely replaced by anonymous secure polling. Whether the existing public vouch corpus survives in any form (e.g. pre-poll seed signal, Layer 4 "writers you follow endorse this person" intersection) is an open question.  
- Layer 1 precomputed signals (trust_layer1) and Layer 2 epoch aggregation (trust_profiles, trust_epochs) survive as backend infrastructure — what the pip panel renders draws on those — but the surface-side concepts of "vouch", "withdraw", "Phase A weighting" cease to be reader-facing primitives.  
**Unresolved or confused**  
- **Migration story.** The vouch CRUD, the four-dimension TrustProfile block on writer profiles, and the /network > Vouches tab are all live in the codebase. None of them are accounted for in the new model. The data has utility (for backend trust signals) but the user-facing surfaces are inconsistent with the panel spec.  
- **Layer 4 "writers you follow endorse this person" line.** Currently rendered on the writer profile masthead. In the new model, the equivalent signal might live in the pip panel's italic in-person line (under a different framing) or on the profile page.  
- **Layer 3 graph signals** (sybil detection, diversity weighting, cluster discounting) — Phase 5 backend work per ALLHAUS-OMNIBUS.md. Not rendered anywhere currently and no reader-facing surface planned before the graph densifies.  
- **Phase B anonymous vouching** (blind signatures) — the new model arguably absorbs this since polling is anonymous by construction. Whether Phase B as currently specified remains a meaningful concept under the polling reframe is undecided.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCUrfD6LYGNDAgAU2QtIq6DIzW7UHAMBfHGt1V+fXEwAAXrseHDAF/orRG+cAAAAASUVORK5CYII=)  
**6. Composers**  
The writer-side primitives. The note composer is the simple form; the article composer is its elevation. **Both are reached from the same starting point** — New note from the ∀ menu, or Reply from any card's action strip.  
**6.1 Note composer**  
The default. Ships at launch.  
- **Surface.** A text field. Above it, a single To field. Nothing else visible at rest.  
- **To** ** field.** Empty by default. Autocomplete across: specific people, named groups, *everyone on Nostr*,  *everyone on Bluesky*,  *everyone on ActivityPub*,  *everyone everywhere*, or combinations. Typing a name resolves to a person via the universal resolver (§19.4); typing a group name resolves to a group; leaving it empty and hitting publish is the gesture for  *publish to everyone*.  
- **Friction on empty ** **To** **.** A persistent banner at the top of the compose surface: *Publishing publicly.* Not a dialog, not a confirm step — a visible fact about the current state. The send button reads **Publish** rather than  **Send**.  
- **Protocol selection for public notes.** When To is empty, a subtle secondary control surfaces letting the user choose which protocols the note goes out on. Default: all of them. Most users never touch this. Private notes don't need this control because audience selection implicitly determines protocol.  
- **Replies.** A reply affordance on any card opens the note composer with the reply context set. The reply inherits the protocol of the item replied to. Cross-protocol replies (adding an audience member on a different protocol than the original) are deferred.  
**6.2 What the note composer does not have**  
Headings. Structured lists beyond a few items. Block quotes. Tables. Multiple embedded images. Paywall controls. Scheduling. These live in the article composer — and the user gets there by *the writing surface getting more room*, not by switching modes.  
**6.3 Article composer (an elevation, not a separate surface)**  
Ships at launch. Full authoring surface — headings, structured lists, block quotes, images, tables. Subscription paywalls live here. **No per-piece pricing at launch** (deferred until the micropayments rail is live).  
**6.4 How the user reaches it**  
Two paths:  
- **User-initiated.** A small *this is an article* toggle adjacent to the formatting controls in the note composer. Tapping it migrates current content into the article composer with cursor position preserved. The switch should feel like the writing surface getting more room, not like a modal transition. Cursor position preserved, content preserved, no new window, no dismissal animation that implies leaving. The To field persists. The  *Publishing publicly* banner persists if applicable.  
- **Nudged.** The note composer monitors three signals and offers the switch when any one triggers:  
1. *Length* past 400 words.  
2. *Structured formatting* — markdown-style headings pasted or typed, numbered lists extending beyond a few items, block quotes, tables.  
3. *Multiple embedded media* — more than one inline image.  
Any one signal is sufficient; logic is OR, not AND.  
**6.5 The nudge banner**  
- Small, typographically quiet, top of the compose surface — same register as the *Publishing publicly* banner. No character, no icon, no decoration.  
- Copy: *this is getting long. Switch to the article composer for headings, images, and structure?*  
- Two actions: **switch** (migrates content, preserves cursor) and  **keep as note** (dismisses).  
- **Honest dismissal.***Keep as note* means: for the remainder of this composition, do not offer again. The trigger logic resets for the next note.  
- **Non-blocking.** Never steals focus, never intercepts keystrokes, never pauses auto-save.  
**6.6 What the article composer has at launch**  
- Full authoring surface (StarterKit + Markdown I/O + Image upload + Embeds + Placeholder + CharacterCount, in the existing TipTap implementation).  
- Publish-with-To (same semantics as note composer).  
- Protocol selection.  
- **Subscription paywall placement** — the *here is where the paywall falls* affordance, draggable gate node with a subscription gate (no per-piece price field at launch).  
- Draft-saving.  
- Preview.  
**6.7 What the article composer does not have at launch**  
- Per-piece pricing.  
- Payout estimation.  
- Article-level analytics.  
These surface inside the existing composer when the micropayments rail goes live. No new composer appears; existing controls grow.  
**Unresolved or confused**  
- **Existing ** **ComposeOverlay** ** (three-mode shell with separate ** **note** **/** **reply** **/** **article** ** modes, mounted globally in ** **app/layout.tsx** **).** Does not match the new model. The three modes collapse: there is no separate reply mode (reply is just the composer with reply context set), and there is no article-mode-as-overlay (article is the composer when the writing surface gets more room).  
- **Existing full editor at ** **/write** **.** The note-elevates-into-article model leaves no obvious role for a separate URL-routed editor. Whether /write survives as a deep-link form (for resuming a draft, e.g. /write?draft=<id>) or is folded into the composer entirely is undecided.  
- **Cross-post pills.** The current overlay shows one pill per linked account on /settings. Not addressed in the new model. They are likely an extension of the protocol-selector affordance for public notes (§6.1), but the geometry is unspecified.  
- **Mobile composer gestures.** Swipe-to-dismiss, keyboard handling, attachment picker parity. Not designed.  
- **Cross-protocol reply edge cases.** Replying to a Bluesky post and including a Mastodon user in the audience. Simple same-protocol case covers almost all replies; cross-protocol case is deferred.  
- **Scheduling.** Mentioned as not in the note composer. Whether scheduling appears in the article composer (the prior SCHEDULE control in overlay article mode wrote scheduled_at against migration 051) at launch is undecided.  
- **Email-on-publish toggle, comments toggle, dek, tags, show-on-writer-profile.** All previously V1 deferrals from overlay article mode to the full editor. Their final home in the new note→article elevation has not been resolved.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJOUPcjIpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaJEEL8XMiYMAAAAASUVORK5CYII=)  
**7. Content-scope long-press**  
Controls that live on individual items, reachable via long-press (mobile) or hover (desktop) on any card in any vessel. At rest, items are just content.  
**7.1 What surfaces**  
Three controls only.  
- **Volume per source** — three states: *more like this*,  *less like this*,  *none of this*. No finer gradation, because finer gradation would be false precision. These map directly to weights on the ⊔ operands of the feed:  *more* increases the weight,  *less* decreases,  *none* removes the source from the expression entirely. The fine-grained per-author volume bar lives on the pip panel (§4.6); the long-press control is the fast path for the common case.  
- **Save** — minimal. Marks an item so it persists in a dedicated Saved state accessible from the feed it lives in.  **Per-feed, not cross-feed.** Not a bookmark system. Not a read-later queue. Deliberately small.  
- **Reply** — opens the note composer with reply context set. Inherits protocol from the item replied to.  
**7.2 What is deliberately absent**  
- **Per-item provenance trace** ("why is this here"). Removed until algorithmic discovery features arrive — until then, the answer is always *because you put it there*, and the feed composer (§2.3) already answers the structural version. Reinstate when algorithmic discovery is introduced.  
- **Cross-feed bookmarks.** The prior /library > Bookmarks surface does not survive the workspace reframe. Bookmark icon and BookmarkButton on the prior card chassis are gone.  
**Unresolved or confused**  
- **Long-press affordance discovery.** Defaults are the product; configurability is the ceiling. The wireframe plan flags discoverability of long-press as a test (WIREFRAME-PLAN.md step 7). A user who never long-presses never finds these controls.  
- **Desktop equivalent of long-press** — hover surface, right-click menu, persistent on-card affordance? Not pinned.  
- **Save UX inside a feed.** Whether the feed shows a "Saved" sub-section, a filter pill, or a separate visual treatment for saved items is unspecified.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OQQmAABRAsad4EjtY9fewnUms4E2ELcGWmTmrKwAA/uLeqrU6vp4AAPDa/gDzWAM6QQXRdAAAAABJRU5ErkJggg==)  
**8. Article reading surface**  
When a user opens an article, the reading surface lives inside (or escalates from) the vessel that surfaced it. The interaction mode of "user is reading an article inside a vessel" is **explicitly deferred to its own design pass** (WIREFRAME-PLAN.md §"What is out of scope"). Until that pass lands, the existing article reading surface continues to govern, with the workspace as a context outside it.  
**8.1 Article page (carry-over)**  
- Server-rendered Next.js page with OG + Twitter Card metadata, RSS <link rel="alternate">.  
- max-w-article (640px).  
- Hero image where extracted.  
- **Byline block.** Pip · author name (Literata) · · DATE · READ TIME · PAID|FREE · VIA PUBLICATION NAME where publication-hosted, in mono-caps.  **No avatar in the byline** — the pip-and-author grammar from card headers extends to the article page.  
- Tags below byline.  
- Body: Literata 17px / 1.8, rendered via remark/rehype from the NIP-23 markdown, with inline images, embeds, Nostr URIs, and the paywall gate region.  
- Action bar: vote arrows · QUOTE · REPLY · REPORT (the same action strip as on cards). For the logged-in author: Edit, Unpublish, Delete.  
**8.2 Paywall reader states**  
Subscription paywalls only at launch. Four reader states, surfaced on the article page:  
1. **Preview.** Gradient fade above the gate boundary. Mono-caps PAID chip. Primary CTA — Subscribe to [writer] — £5/mo (the per-piece Unlock — £X.XX button is deferred until micropayments).  
2. **Subscribed.** Full body, SUBSCRIBED chip.  
3. **Owned (author).** Full body, no chip.  
4. **Tab-unlocked.** Full body, READ TAB chip — *deferred until the micropayments rail ships*. Not visible at launch.  
**8.3 Replies — playscript threads**  
The flat-chronological transcript model survives from the prior redesign Step 4, with the pip-and-name speaker line aligned to the new pip semantics.  
- **Step-in.** 32px left indent once from the article column (ml-8). No further indentation for nested replies.  
- **Inter-entry rhythm.** 32px. No hairlines.  
- **Speaker line.** Mono-caps 11px, grey-600. TrustPip · **Jost bold name**:  — colon terminator. Self-reply reads YOU: with no pip.  
- **Non-adjacent parent.**→ PARENT: in grey-400 + 16px gap, then NAME: on the same line.  
- **Dialogue.** Jost 14.5px / 1.55 black, mt-1 under the speaker.  
- **Vote count.** Vote arrows pinned top-right of each entry, aligned to the first line of dialogue.  
- **Action row.**time · REPLY · DELETE · REPORT mono-caps 11px grey-400, revealed on hover/focus with optional #fafaf7 tint.  
- **Pagination.** First 10 entries + SHOW N MORE REPLIES link.  
- **Component surface.**PlayscriptReply + PlayscriptThread in web/src/components/replies/. ReplySection.tsx flattens the nested API tree into PlayscriptEntry[].  
**8.4 Reading-history resumption (carry-over)**  
- Scroll position per article-and-user persisted to reading_positions (migration 069) with ~500ms debounce + pagehide / visibilitychange keepalive flush.  
- Restore on next open, skipping: top 10% grace zone, anchored URLs, "scrolled to foot" tail, and the always_open_articles_at_top per-user preference.  
- Preference exposed in user-scope settings (§21).  
**Unresolved or confused**  
- **Reading mode vs arranging mode** — the brightness-and-focus coupling that would let a vessel "open" into the reading surface is deferred. The current behaviour (URL navigation to /:username/:slug) is a stop-gap.  
- **Quote-commenting UX.** A reader selects a span and attaches a quote-comment. Specified as existing but no surface design captured.  
- **Spend-threshold subscription nudge.** A banner offering subscription conversion when a reader's tab exceeds a threshold. The visual treatment was never pinned. Effectively moot at launch (no tab) and reactivates with micropayments.  
- **Author's own-article action cluster** (Edit / Unpublish / Delete) duplicates dashboard controls. Whether both entry points stay or one delegates is unresolved.  
- **Reader-side Report modal** (categories, free-text reason, evidence attachments). Not designed.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSPBCj5fFgpQwYwEZiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AMTRBeEgNK9YAAAAAElFTkSuQmCC)  
**9. Writer profile**  
The writer's public surface remains a /:username page, carrying the masthead, articles, activity, and subscribe actions. The pip panel (§4) absorbs much of what the masthead previously did; the profile page is the *depth* surface.  
**9.1 Masthead**  
- Avatar (square, large), display name (serif 2xl, font-light, tracking-tight), @username.  
- Bio (Jost, grey-600).  
- Action buttons: Follow · Subscribe — £X/mo · Message (DM) · Gift a subscription (secondary text link) · RSS (text link).  
- **Trust block.** A TrustPip inline in the masthead (matching card-side semantics). The detailed trust surface — three poll results, in-person count, depth view — is the pip panel; the profile page can carry a fuller trust block as a depth view, but its design needs to be reconciled with the new pip panel rather than continuing the prior four-dimension TrustProfile bar layout.  
**9.2 Tabs**  
- **Articles** — list of native cards authored by the writer, including those written for publications (with VIA PUBLICATION NAME in the byline).  
- **Activity / Notes** — note-card stream + quote-posts (+ reposts-by, future).  
- **Drives** — author's active PledgeDrive cards, including pinned drives.  
- **About / standfirst** — long-form bio where present.  
**9.3 Subscribe flow**  
- The inline Subscribe button on the masthead (and the SUBSCRIBE · £5/MO footer in the pip panel) opens a Stripe Elements modal.  
- The custom /:username/subscribe landing page (UI-DESIGN-SPEC §2.5, outstanding) — dedicated page with avatar, Subscribe to [name], bio/description, plan toggle (monthly / annual with save-%), primary Subscribe button, "What you get" bullet block.  
**Unresolved or confused**  
- **Vouch** ** button on profile.** Lives on the current profile masthead; opens VouchModal. Pending the trust reframe (§5.3), this is presumed to disappear or change shape — possibly absorbed into the pip panel's ALL POLLING › depth view, possibly rebuilt as a polling-participation affordance.  
- **Activity** ** vs ** **Notes** ** tab naming** — inconsistent across prior docs. Final label not chosen.  
- **Pinned drives presentation** — pin/unpin lives on DriveCard in dashboard; profile-page presentation (dedicated section vs mixed with Drives tab) not specified.  
- **Reposts on profile.** The "Reposted by" prefix and how reposts surface on the reposter's Activity tab — not designed.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBCkLfFR7wwIgHRiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AOIEBeX8aGZPAAAAAElFTkSuQmCC)  
**10. Subscriptions and economics**  
Subscription paywalls ship at launch. **Micropayments deferred.**  
**10.1 Subscribing to a writer / publication**  
- From the pip panel's SUBSCRIBE footer, the masthead Subscribe button, the article paywall's Subscribe to [writer] CTA, or the dedicated /:username/subscribe / /pub/:slug/subscribe landing pages.  
- Plan toggle: Monthly (£X/mo) / Annual (£Y/yr, save Z%).  
- Stripe Elements modal (or inline on the landing page).  
- Gift flow: secondary text link → modal with recipient email, optional message, price summary, Gift — £X.  
**10.2 What launches without**  
- The **reading tab** (per-piece micropayments aggregating to a Stripe-batched balance) is deferred to phase two.  
- /ledger as a balance + tab-history surface in its prior shape is reduced to a subscription-management surface until the tab returns.  
- The READ TAB paywall reader state and the spend-threshold nudge are inactive.  
- The "writers without an audience yet" and "exceptional single piece travelling further than any subscription would" parts of the editorial argument operate at phase two, not phase one. Subscription-only economics serve the writer with a paying audience, not the writer without one.  
**10.3 Outstanding subscription UI surfaces**  
Carry-over from UI-DESIGN-SPEC.md §2.5, all targeted at the dashboard / subscribers / pricing surfaces (themselves carry-over — see §22):  
- Free trials (3-button group: Off / 7 / 30 days).  
- Welcome email (toggle + textarea).  
- Subscriber import / export (CSV).  
- Subscriber analytics (3 sparkline cards: Growth / Churn / MRR).  
- Custom subscribe landing page (/:username/subscribe, /pub/:slug/subscribe).  
**Unresolved or confused**  
- **Currency strategy.**platform-pub-currency-strategy.md names Option 2 (GBP launch with display-only conversion) as the recommended path. The reader-side UX for display-only conversion (auto-detect from browser? manual selector? persistent preference?) is not designed.  
- **Subscription management surface** under the workspace metaphor. The pip panel's SUBSCRIBED — MANAGE › footer points somewhere; what *somewhere* is — /ledger slimmed to a subscription manager, a user-scope screen, an in-panel sub-view — is unresolved.  
- **Settlement cadence and tab thresholds** are pre-decided at the schema level but become live design questions only when the tab returns.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSfYxKK/kJXEkyE8WcGbCFuCLTOzVXsAAPzFsVZ3dX4cAQDgvesB/vEF9H9odtUAAAAASUVORK5CYII=)  
**11. Animations**  
Two sequences specified in WORKSPACE-DESIGN-SPEC.md §iconographic-grammar.  
**11.1 First-login animation**  
- **Trigger.** First login only.  
- **Sequence.** ∀ expands from the centre of an empty screen. Parts into H. H's crossbar drops, accumulates horizontal bars that resolve in their final third into legible content (title, byline, source name). The H completes its transformation; remaining vertical walls settle into the ⊔ shape; content comes to rest inside the vessel.  
- **Duration.** Approximately two seconds. Parting of ∀ to H is the slowest moment; content-resolution is the last.  
- **Resting state.** Populated ⊔ — the founder's feed, available for immediate editing or deletion.  
**11.2 Feed-creation animation**  
- **Trigger.** Every new-feed creation (∀ menu → *new feed*).  
- **Sequence.** ∀ → H → ⊔, with H held for a fraction of a second, crossbar dissolving as the base forms.  
- **Duration.** Under one second. Plays as a consequential response, not a performance.  
- **Resting state.** Empty ⊔ vessel.  
The animations rhyme. Both pass through H. Both deliver the user to a vessel. The terminal state differs only in content: the first login's vessel arrives populated, the new-feed vessel arrives empty.  
**Unresolved or confused**  
- **Implementation.** Animation work has not begun. The committed proportions from the vessel rendering study (§2.1, WIREFRAME-PLAN.md step 1) and the workspace context from step 3 are prerequisites.  
- **Reduced-motion preference.** Both animations need a reduced-motion fallback. Not specified.  
- **Vessel deletion animation.** Not specified. (The feed composer's delete is the trigger.)  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OQQmAABRAsSfYxZo/khWsYQLPJrCCNxG2BFtmZquOAAD4i3Ot7mr/egIAwGvXA4qjBdKlX6OKAAAAAElFTkSuQmCC)  
**12. Onboarding**  
The principle: *the launch feed is the editorial position made operational.* A new user encounters a populated feed, clearly labelled as a copy of the founder's public feed. They can edit it, fork it, or bin it.  
**12.1 The founder's feed**  
- Copied to the new user, not subscribed. Future edits to the founder's feed do not propagate. The user inherits taste, once, and then it is theirs to shape.  
- Arrives as a single ⊔ vessel on the workspace, populated, at medium-bright default, after the first-login animation.  
- Default name: the founder's feed name. User can rename, delete, fork, or leave alone.  
**12.2 The onboarding test**  
The example feed has to do two things at once: be good enough that the user wants to keep it, and teach them it is theirs to edit. A feed that is already perfect gives no reason to touch the controls. Gentle nudging is likely needed — *try removing this source; turn down the volume on this person* — without making it feel like a tutorial.  
**Unresolved or confused**  
- **Discoverability of the per-vessel controls.** A user who long-presses an item discovers *less like this*. A user who drags a vessel discovers it moves. A user who two-finger-drags discovers brightness. Whether this discovery is sufficient or whether a one-time set of nudges is needed has not been resolved.  
- **Long-term fate of the founder's feed as the entry point.** Held open per PRINCIPLES.md. Not to be answered now.  
- **Marketing pages and unauthenticated entry surfaces.**/, /about, /auth are carry-over and have no spec under the workspace metaphor.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJmkPYLLpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfHEQAA3rseaHkEMn1wK7sAAAAASUVORK5CYII=)  
**CARRY-OVER SURFACES**  
The sections below document surfaces the new spec is *silent on*. They continue to govern under the prior product corpus until the workspace metaphor is propagated through them. Each carries an unresolved-points block flagging the reframing question.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBACPykMH4NpGACyywEZJWQZeZ2aszAAD+4l6rrTo+jgAA8N71AL/CBEiG5xPoAAAAAElFTkSuQmCC)  
**13. DMs / messaging**  
**13.1 Surfaces**  
- /messages (or /dm). Two-pane: conversation list (left), current conversation (right).  
- Conversation list row: display name, last-message preview, timestamp, mute icon (if muted), kebab menu on hover.  
- Conversation header: counterparty name, Commission button (opens CommissionForm modal, migration 036).  
- Message column: flat chronological, speaker-identified.  
- Composer: inline text input with Send.  
- DM pricing: per-global and per-user overrides.  
- NIP-17 encryption on the wire.  
**13.2 Kebab menu (per conversation)**  
Specified, unbuilt:  
Mute · Archive · ── · Delete  
   
Mute silences notifications, no confirmation. Archive moves to collapsed Archived section at bottom. Delete confirm() ("This only removes it from your view.").  
**Unresolved or confused**  
- **The fundamental reframe.** In the new model, the audience-selection cardinality of the note composer's To field collapses what other platforms call DMs and posts into one gesture. *Whether * */messages* * survives as a separate surface, becomes a vessel pinned to the workspace, or is reached via * *To* *-field history* is the central reframing question.  
- **DM rendering grammar.** Playscript-style flat chronological with pip-and-name speaker lines is the natural fit, but DMs were not in the playscript spec.  
- **DM pricing's send-side 402 enforcement** was pulled (FIX-PROGRAMME §12) pending a charge-and-unblock endpoint. The UX for "you owe £0.20 to message this person — pay now?" is not drafted.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJGkPcrHpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaJkELjbMzy0AAAAASUVORK5CYII=)  
**14. Notifications**  
**14.1 **NotificationBell ** + notification centre**  
- Bell in the prior topbar; under the workspace metaphor, the bell needs a new home (corner affordance, ∀ menu adjunct, vessel decoration?). Pending.  
- Permanent-log dropdown view. Each row: icon/avatar or system glyph, short text line, mono-caps timestamp.  
- Fallback renderer for unknown notification types.  
**14.2 Known notification types**  
- New followers, replies, mentions, quotes, commission requests (with inline Accept/Decline buttons), publication events, subscription activity.  
- report_resolved system notification — no avatar, no admin reference, copy: *"The content you reported has been [removed / found to not violate our guidelines]."*  
**Unresolved or confused**  
- **Home of the notification surface in the workspace.** Open question. Candidates: corner-anchored chrome on the workspace floor; a reserved peripheral vessel; a surface reached from user-scope (§21).  
- **Canonical list of notification types** has grown organically. No single source of truth.  
- **Push notifications** are deferred to mobile per memory.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCUrfD6LYGNDAgAU2QtIq6DIzW7UHAMBfHGt1V+fXEwAAXrseHDAF/orRG+cAAAAASUVORK5CYII=)  
**15. Publications**  
Federated editorial entities with shared subscription paywalls.  
**15.1 Public publication pages (carry-over)**  
- **/pub/:slug** — masthead (logo, name, tagline), Follow button, RSS, Subscribe primary action; homepage layout below in one of three variants (blog / magazine / minimal).  
- **/pub/:slug/about** — long-form about, members masthead.  
- **/pub/:slug/archive** — chronological article list.  
- **/pub/:slug/masthead** — roster with roles (Editor-in-Chief, Editor, Sub-editor, Contributor) and bylines.  
- **/pub/:slug/subscribe** — standalone subscribe page.  
- **/pub/:slug/:article-slug** — articles authored within a publication, with publication masthead in the byline (VIA DAILY DISPATCH).  
**15.2 Homepage layouts**  
- **Blog.** Single-column chronological list.  
- **Magazine.** Featured card + two-column grid. Currently wireframe-quality.  
- **Minimal.** Three-column stripped list.  
**15.3 Dashboard publication tabs**  
Personal-vs-publication context switcher in the dashboard header. Publication tabs: Articles, Members, Settings (logo, name, tagline, about, layout, danger zone with archive / transfer ownership / delete), Rate Card, Payroll, Earnings.  
**15.4 Phase 4 (outstanding)**  
Theming and custom domains per PUBLICATIONS-SPEC.md §10 — theme settings UI, custom CSS editor, per-publication favicon, wildcard subdomain routing, custom-domain DNS verification, TLS. Not built.  
**Unresolved or confused**  
- **Workspace fit.** Whether a publication appears as a vessel on a member's workspace, a separate "publication workspace", or remains a /pub/:slug URL space outside the workspace is the central reframing question.  
- **Magazine layout** is wireframe-quality (audit §5).  
- **Per-publication favicon, theme settings, custom CSS** deferred without a design spec.  
- **Owner-side notification of "X left this publication"** not in tracked docs.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSPBCUbfEm6YmFDBhAU2QtIq6DIzW7UHAMBfnGt1V8fXEwAAXrse/w8F7pbTa1oAAAAASUVORK5CYII=)  
**16. Traffology (writer analytics)**  
Phase 1 shipped per feature-debt.md. Writer-facing only.  
**16.1 Existing surface**  
- /traffology — baseline stats header, traffic narrative feed (observation-driven), source resolution.  
- Per-article view — IKB op-art provenance bars, read-completion distribution, time-of-read histogram.  
- Chronological feed of observations as mono-caps narrative cards.  
**16.2 Phases 2–4**  
- Phase 2 — Nostr monitor service (relay polling for reposts/reactions/quotes). No UI spec.  
- Phase 3 — Outbound URL search (Bluesky, Reddit, HN, Mastodon APIs). UI: more sources / observations.  
- Phase 4 — Publication editor view.  
**Unresolved or confused**  
- **Workspace fit.** A writer-facing analytics surface under a reader-first workspace metaphor needs reframing. Candidates: a vessel pinned to the writer's own workspace; user-scope (§21); a separate route (current).  
- **IKB bar scaling** (log vs linear), source-count distinguishability, mobile behaviour — not specified.  
- **Phase 4 publication editor view** — no mockup.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhZscaUpheJwqQgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseopcEQ2uoYnwAAAAASUVORK5CYII=)  
**17. Linked accounts and cross-posting**  
**17.1 **LinkedAccountsPanel  
On user-scope settings (§21). Lists linked external accounts (Mastodon, Bluesky):  
- Connect button per protocol.  
- Per-account cross_post_default toggle.  
- Disconnect action.  
- Mastodon connection via OAuth (dynamic client registration).  
- Bluesky connection via atproto OAuth (confidential client, PKCE + DPoP + PAR).  
**17.2 Cross-post pills in the composer**  
In the prior overlay, one pill per linked account, with state following cross_post_default. In the new composer model, the equivalent surface is the protocol-selector affordance for public notes (§6.1) — not yet pinned in geometry.  
**17.3 Outbound replies to external items**  
Reply on a card sourced from an external platform routes through the composer with cross-post filtered to the matching protocol. Underlying job: enqueueCrossPost (Mastodon/Bluesky) or enqueueNostrOutbound (external Nostr with user-signed event).  
**Unresolved or confused**  
- **OAuth round-trip landing.** No explicit spec for the loading/landing screen on return from PDS auth.  
- **Bluesky handle resolution failures** — no surfaced error UX.  
- **Mastodon instances with OAuth registration disabled** — backend falls through; no panel-side UX.  
- **"Cross-posted to Bluesky" status** on a sent note — not specified visibly to the author.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OQQmAUBBAwSd8bOHVnBvBkAaxgjcRZhLMNjNHdQUAwF/cq9qr8+sJAACvrQctgQNH4A++9QAAAABJRU5ErkJggg==)  
**18. Email and distribution**  
**18.1 Email-on-publish**  
- Writer-side toggle in dashboard pricing (or successor under workspace reframe). Default on for new writers per UI-DESIGN-SPEC §2.4.  
- Reader-side per-subscription Notify / Muted toggle on the subscription-management surface.  
**18.2 Newsletter / broadcast email**  
Unbuilt and flagged as launch-critical (frontend audit §2). No "send this to my subscribers" button, no mailing-list management, no email delivery of articles.  
**18.3 Welcome email on subscribe**  
Toggle in pricing; revealed textarea for the message when on. Saves on Save.  
**Unresolved or confused**  
- **Three email semantics in one surface** (on-publish / welcome-on-subscribe / one-off broadcast) — grouping not settled.  
- **Email template customisation** (header, footer, unsubscribe styling) — no UX.  
- **EMAIL-ON-PUBLISH-SPEC.md** referenced but not fetched this session.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSPBCUbfEm6YmFDBhAU2QtIq6DIzW7UHAMBfnGt1V8fXEwAAXrse/w8F7pbTa1oAAAAASUVORK5CYII=)  
**19. Search, RSS, tags, omnivorous resolver**  
**19.1 Search**  
- Sitewide search backend exists (gateway/src/routes/search.ts, trigram-backed).  
- No UI spec for the search entry point under the workspace metaphor — candidates: a reserved input on the workspace floor, an item in the ∀ menu, fold into the universal-input affordance.  
**19.2 Tags**  
- /tag/:tag browse page. Header: #TAG mono-caps + count. Stream of cards.  
- No "all tags" index page.  
**19.3 RSS**  
- Per-writer at /rss/:username. Per-publication at /api/v1/pub/:slug/rss. Platform-wide RSS.  
- RSS text links on writer and publication mastheads.  
- <link rel="alternate" type="application/rss+xml"> in HTML head for auto-discovery.  
**19.4 The universal resolver**  
Wherever all.haus asks a user to identify a person, feed, or resource, the receiving field is **omnivorous**: accepts URL, handle, email, npub, DID, NIP-05, Bluesky handle, Mastodon user@instance, Nostr nprofile, RSS feed URL, platform username, free-text search.  
- Backend: POST /api/v1/resolve, specced in UNIVERSAL-FEED-ADR.md §V.5.  
- Used by: feed composer's add-source-by-URL (§2.3), Fork feed by URL from the ∀ menu (§1.3), the note composer's To field autocomplete (§6.1), invite acceptance, vouch target lookup (legacy), publication invite, etc.  
- No narrow single-format inputs anywhere.  
**Unresolved or confused**  
- **Search UI** — no design under the workspace metaphor.  
- **Tag discovery** — no all-tags index. Whether intentional minimalism or omission not flagged.  
- **Boundary between native subscriptions and external feed sources** under the new model. Both flow through the feed composer as ⊔ operands; the prior /subscriptions management page and /network > Following tab are subsumed by the per-vessel composer plus the pip panel's FOLLOW toggle.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCkJfE1pYGfHAiAU2QtIq6DIzW7UHAMBfnGt1V8fXEwAAXrse4dwF6o2O55YAAAAASUVORK5CYII=)  
**20. Moderation and reporting**  
**20.1 Reader-side**  
- Report action on every card (action strip), every article-page action bar, every reply-entry action row.  
- Report modal — categories, free-text reason, submit. Not designed.  
- Post-submit: Your report has been submitted inline message.  
- report_resolved system notification when admin resolves.  
**20.2 Admin-side**  
- Admin reports queue with resolve/reject actions.  
- Direct account suspend surface (UI-DESIGN-SPEC §1.10, unbuilt).  
**Unresolved or confused**  
- **Reader-side report modal** — categories, free-text length, evidence attachments — not designed.  
- **Publication-level moderation** — not designed.  
- **Admin surface under workspace reframe** — admin and owner dashboards (OWNER-DASHBOARD-SPEC.md) are paper specs for sections (Overview, Users, Content, Config, Regulatory). Not in fetched docs at component level.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd4NIGhrOTvaQBrWMGbCFuCLTOzV2cAAPzFvVZbdXw9AQDgtesBhYQEO+64Y8AAAAAASUVORK5CYII=)  
**21. User-scope settings**  
Reached deliberately, off to the side. The threshold for getting here is a little higher than for any workspace-scope action — these are settings changed rarely and intentionally.  
**21.1 Implementation**  
A user avatar or name in a corner of the workspace; tapping reveals the user-scope surface. Exact position TBD with the ∀ control.  
**21.2 Sections (carry-over from **/settings ** and **/profile **)**  
- **Profile (public).** Avatar (square, drag-drop, Blossom-backed); display name; username (inline change with debounced availability, 30-day cooldown, 90-day redirect from old URL); bio; public URLs.  
- **Email.**EmailChange component.  
- **Password / sessions.** Active sessions list with Revoke per row and Revoke all other sessions. Currently shows account info display only.  
- **Linked accounts.**LinkedAccountsPanel (§17).  
- **Payment.** Stripe Connect onboarding / KYC status / payout card.  
- **Notifications.** Toggle grid for new followers, replies, mentions, quotes, commission requests, publication events, subscription activity. Saves immediately.  
- **Reading preferences.**always_open_articles_at_top toggle, other per-reader prefs.  
- **Export.** Modal with Set<ExportType> — portable receipts (cryptographic proof of paid reads) + full account export (keys, receipts, articles).  
- **Danger zone.** 4px black slab rule, CLOSE YOUR ACCOUNT in crimson.  
- **Deactivate.**btn-soft, confirm().  
- **Delete permanently.**btn-accent crimson, type-to-confirm modal with email address as the match string. Consequences bullet list (cancel subs, settle tab, remove articles, publish Nostr deletion events, payout remaining earnings).  
**Unresolved or confused**  
- **Workspace fit.** The user-scope spec says "a user avatar or name in a corner". Whether this conflicts with the ∀ control's candidate position is unresolved.  
- **Notification preferences home** — duplicated with the prior /network surface in older specs. The user-scope surface wins under the new model.  
- **Export modal partial-success UX** — no design.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd4EKxgBjP+Asa0hxW8ibAl2DIzR3UFAMBf3Gu1VefXEwAAXtsfSqwDVbgKngwAAAAASUVORK5CYII=)  
**22. Carry-over dashboard surfaces**  
The personal dashboard (/dashboard) and its tabs (Articles, Subscribers, Proposals, Pricing) are *writer-side* concerns the workspace spec does not address. They continue to govern in their prior shape until the workspace metaphor reaches the writer side. The writer-side reframe will likely turn these into vessels pinned to the writer's own workspace, or into a dedicated writer-mode surface, but neither shape is committed.  
**22.1 Existing dashboard tabs (carry-over)**  
- **Articles.** Unified list — published, drafts, scheduled. Per-row Edit · Unpublish · Delete. DRAFT and SCHEDULED FOR … chips. Inline gift-link generator.  
- **Subscribers** (writer-only). Stat row (Active subscribers / Est. monthly revenue / New this month). Table (Subscriber, Since, Plan, Status, Amount). Header Import / Export links.  
- **Proposals.** Filter bar ALL · COMMISSIONS · DRIVES · OFFERS. Pending commissions; active drives (DriveCard with Pin/Unpin, Edit, Cancel); subscription offers create/list/revoke.  
- **Pricing.** Subscription price (monthly/annual toggle); free-trial group (Off/7/30 days, unbuilt); welcome email (toggle + textarea, unbuilt); email-on-publish toggle; DM pricing.  
- **Publication tabs** when a writer is a member — see §15.  
**22.2 Admin / owner dashboard**  
- **Reports.** Existing.  
- **Suspend account.** Unbuilt.  
- **Owner dashboard.** Entirely paper spec — Overview, Users, Content, Config, Regulatory.  
**Unresolved or confused**  
- **Workspace reframe of writer-side surfaces.** The note composer ships at launch; the writer's reading-vs-writing balance under the workspace metaphor is not designed beyond *a feed is the same surface readers and writers share, the difference is what they put into it*.  
- **Email-on-publish home** — Pricing tab provisionally; might move to a Distribution section or to the article composer.  
- **Owner dashboard** — entirely unspecified at the component level.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAM0lEQVR4nO3OMQ0AIAwAwZIgBKm1gjSMNCwYYCIkd9OP3zJzRMQMAAB+sfqJeroBAMCN2pTWBSSZVtjzAAAAAElFTkSuQmCC)  
**23. Accessibility and performance**  
- **Accessibility.** Vote buttons carry aria-labels. Paywall indicator uses crimson + price text, not colour-only. Dropdowns keyboard-navigable with Escape to close, aria-expanded, role="menu".  
- **Performance.** Article and profile pages are Next.js Server Components. Fonts self-hosted with preload. NDK removed from client bundle. Shared Avatar component. Print stylesheet. Error boundaries.  
**Unresolved or confused**  
- **Comprehensive a11y pass** outstanding.  
- **Reduced-motion fallback** for the two animations (§11) not specified.  
- **CSP ** **img-src** currently blocks external images (frontend audit §7); UX for "image failed to load" not specified.  
- **Workspace gestures and screen-reader equivalents.** The pinch / two-finger-rotate / two-finger-vertical-drag / long-press vocabulary needs keyboard and SR analogues.  
- **Dark mode** unspecified beyond the per-vessel brightness gradient.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd49m4v6wg/pwmMYQVvImwJtszMXp0BAPAX91pt1fH1BACA164Hoq8EQMMPmF8AAAAASUVORK5CYII=)  
**24. Import / export**  
- **Export.** On user-scope (§21). Modal with two kinds: portable receipts (cryptographic proof of paid reads) and full account export (keys, receipts, articles).  
- **Import.** No tooling. Substack ZIP / Ghost / WordPress importer all flagged as launch-cohort blockers (frontend audit §8).  
- **Subscriber import** in SubscribersTab (UI-DESIGN-SPEC §2.5) specced for CSV; whether the same surface handles full-archive import is not addressed.  
**Unresolved or confused**  
- **Substack importer minimum UI** (upload ZIP, confirm author mapping, confirm paywall handling, preview N posts, commit) — no design.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBCkLfFR7wwIgHRiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AOIEBeX8aGZPAAAAAElFTkSuQmCC)  
**25. Transitional / deprecated / aliased surfaces**  
- The **six-page IA** (/, /feed, /dashboard, /ledger, /library, /network, /profile, /settings) is transitional. The workspace replaces /feed. /ledger, /library, /network partially survive as carry-over sections until the workspace metaphor reaches them. /dashboard survives as the writer-side carry-over (§22). /profile and /settings collapse to user-scope (§21).  
- **Old URL aliases:**/account → /ledger (or /settings by section); /bookmarks → previously /library, now to be re-decided since cross-feed bookmarks are dropped; /following, /followers, /history, /reading-history, /social → previously /network or /library tabs.  
- **NoteComposer** ** component** kept in the codebase but no longer imported anywhere.  
- **ComposeOverlay** ** component** (the three-mode global overlay) is on the deprecation path — replaced by the note→article composer model (§6).  
- **The pre-redesign sticky ** **NoteComposer** ** at top of feed** was previously replaced by sticky SubscribeInput; under the workspace metaphor, neither exists — the equivalent function is the feed composer (§2.3) and the ∀ menu's *new note* (§1.3).  
- **/write** ** page** — pending decision (§6).  
- **Network** ** top-level nav item** — gone; per-author functions absorbed into the pip panel (§4) and the per-vessel composer (§2.3).  
**Unresolved or confused**  
- **Deprecated-file deletion policy** — no consistent rule in tracked docs.  
- **Backwards-compatible URL aliases** — whether they survive the workspace reframe at all (since the workspace has no URL routing in the prior sense beyond user-scope and writer-side surfaces) is undecided.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd49m4v6wg/pwmMYQVvImwJtszMXp0BAPAX91pt1fH1BACA164Hoq8EQMMPmF8AAAAASUVORK5CYII=)  
**Global unresolved points**  
Cutting across several features:  
1. **Reading-mode vs arranging-mode coupling.** Brightness-and-focus needs its own design pass (WORKSPACE-DESIGN-SPEC.md). Until it lands, the workspace and the in-vessel reading surface (§8) interact through ordinary URL navigation, which is a stop-gap.  
2. **Writer-side surfaces under the workspace metaphor.** The dashboard, its tabs, the publication editor surfaces, the analytics views, the admin and owner dashboards — none have been reframed. Carry-over sections (§13–§24) document the existing surfaces; the reframe is pending.  
3. **Trust system reconciliation.** The new four-state pip and three-poll-question panel (§4–§5) coexist in the codebase with a four-dimension vouch CRUD (legacy). The migration story for vouches, TrustProfile, the Vouch button on profiles, and the /network > Vouches tab is not pinned.  
4. **DMs, notifications, search.** Three live surfaces with no home in the workspace metaphor. Each needs a placement decision.  
5. **Composer reconciliation.** The current ComposeOverlay (three modes, no To field, full editor at /write) does not match the new note→article elevation (§6). Migration story unresolved.  
6. **Cross-feed bookmarks dropped.** The prior /library > Bookmarks surface and the BookmarkButton on cards are deliberately removed by the workspace reframe (per-feed Save replaces them), but the existing data and existing user expectations need a transition story.  
7. **Reading tab deferred.** The /ledger page in its prior form (balance header + accrual + tab history) is reduced to subscription management until micropayments ship. The READ TAB paywall reader state and the spend-threshold nudge are inactive at launch.  
8. **Mobile design.** Mostly assumed to degrade gracefully from desktop. Explicit mobile specs exist for the pip panel (bottom sheet) and the article-composer compose surface (full-screen bottom sheet, prior). Systematic mobile surfaces for the workspace's gesture vocabulary, threads, dashboard tabs, and the pip panel's volume bar are pending.  
9. **Dark mode.** Unspecified beyond the per-vessel brightness gradient (which sits at the dim limit per-feed, not as a global theme).  
10. **Currency** UX (display-only conversion) not designed.  
11. **Landing and onboarding** beyond first-login animation (§11) and the founder's feed (§12) — unspecified.  
12. **Email distribution at the writer-broadcast level** — single largest unspecced feature surface relative to its launch-criticality.  
13. **Notifications** — no canonical list of types or their renderers.  
14. **Report/moderation** reader-side modal unspecced.  
15. **Owner dashboard and admin area** — paper specs at section level, no component-level design.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OQQmAABRAsaeILbwZ9Fewo0Gs4E2ELcGWmTmqKwAA/uLeqr06v54AAPDa+gAthwNEfGhnhAAAAABJRU5ErkJggg==)  
**Notes on this compilation**  
This document is the reconciled inventory after the April 2026 design rethink. The workspace, the vessel, the card grammar, the pip panel, the trust reframe, the composer model, the content-scope long-press, the workspace-scope ∀ control, the animations, and the onboarding founder-feed mechanic come from the four April 2026 documents (PRINCIPLES.md, WORKSPACE-DESIGN-SPEC.md, WIREFRAME-PLAN.md, CARDS-AND-PIP-PANEL-HANDOFF.md).  
The carry-over sections (§13–§24) come from the prior product corpus (CLAUDE.md, UI-DESIGN-SPEC.md, feature-debt.md, all-haus-frontend-audit.md, README.md, and the ADRs under docs/adr/). They describe surfaces the new spec is silent on, which therefore continue to govern under their prior specifications until the workspace metaphor is propagated through them.  
Where the April 2026 documents and the prior corpus disagree, the April 2026 documents win. Where they are silent, the prior corpus governs. Where the prior corpus is also silent, an unresolved-points entry flags the gap.  
Several earlier surfaces are explicitly **dropped** by this compilation rather than carried over:  
- The four-mode FeedDial and the "reach modes" framing.  
- The 4px solid left colour bar on cards.  
- Cross-feed bookmarks (/library > Bookmarks, BookmarkButton).  
- The reading-tab balance header and the per-piece pricing surfaces.  
- The four-dimension TrustProfile and VouchModal as user-facing primitives (the data and infrastructure remain; the surfaces are reframed under the pip panel).  
- The three-mode ComposeOverlay shell.  
- The Feed | Dashboard topbar and the persistent Nav.  
The next compilation should pick up the surfaces flagged as carry-over (§13 onwards) one by one, propagating the workspace metaphor into each. The most urgent carry-over surfaces to reframe — by launch-criticality and by how poorly the prior model fits the new metaphor — are: writer-side dashboard surfaces, DMs, notifications, search, and the in-vessel reading-mode coupling.  
