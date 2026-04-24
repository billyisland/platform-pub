# CARDS AND PIP PANEL — HANDOFF

*Session notes. April 2026.*

This document captures what was decided in a wireframing session on the atomic content unit of all.haus — the content card and its associated pip panel. It sits beneath `PRINCIPLES.md`, `WORKSPACE-DESIGN-SPEC.md`, and `WIREFRAME-PLAN.md`; those documents remain authoritative, and this one feeds into the next revision of the workspace spec.

The session worked iteratively. Many things were tried and discarded; only committed decisions and the reasoning behind them are recorded here. Rejected approaches are noted briefly where they might be revisited.

## What was settled

### The content card

All content in feed vessels is carried by a single card type, parameterised by content shape (article, note, embedded quote) but sharing the same outer grammar.

**Material treatment.** Cards are opaque white blocks sitting on the vessel's grey-100 floor. The floor shows between cards as breathing space. This was a late-session move that changed how the feed reads — cards became objects with material presence rather than regions of content. The business-card metaphor is intentional: each card is an identity object, edges defined by the meeting of opaque surfaces rather than by drawn borders (no hairlines, consistent with the design system).

**Card dimensions.** Cards inset 20px from each vessel wall. Content inset a further 20–24px from the card edges. Floor visible above, below, and between cards.

**Header row.** Each card begins with a horizontal attribution strip:

- A trust pip (coloured circle, ~11px diameter) at left, flush with the card's inner margin.
- The author's name in Literata medium 16px, immediately after the pip. This is the primary identifying element.
- The source platform + date in IBM Plex Mono caps 10px with 0.14em letter spacing, following the author name.
- For articles with paywalls: a crimson `PAYWALL · £X.XX` indicator at the far right of the header, in the same plex-caps register.

The author is the salient attribution; the platform is subordinate metadata. Author-first was deliberately chosen over platform-first after trying both.

The author name is the tap target for the author's profile on their source platform. The pip is the tap target for the pip panel (trust + volume, see below). These are adjacent but distinct interactions.

**Body region.**

For *articles*: title in Literata medium 22px, then standfirst in Literata regular 15px over two or three lines. No byline (author already in the header).

For *notes*: body prose in Literata regular 16px. No title. No standfirst. The body is the content.

For *embedded quotes* (notes that contain another content object): the outer note's body runs as normal. The quoted inner object sits below as an inset block, rendered on a subtly lighter fill (grey-50 or equivalent — lighter than the floor, distinct from the card). The inner block carries a smaller pip, the quoted author's name in Literata medium 13px, their platform metadata in smaller plex caps, and the quoted content in Literata regular 14px with reduced weight (fill `#5F5E5A`). The inner block carries no action row of its own. The inner pip is tappable and opens the pip panel for that author. Acting on the quoted object itself (upvoting, replying) requires tapping through to its own card.

**Action strip.** Each card ends with a horizontal row of actions in IBM Plex Mono caps 11px:

- Upvote arrow (▲), netted vote score, downvote arrow (▼) — clustered together as a single vote unit. The netted score is the number between the arrows. Hover or press reveals raw up/down counts and current cost for both directions (votes are paid — see below).
- A thin separator (`·` in grey-300).
- `QUOTE` — combines what would conventionally be separate "quote" and "repost" actions. A repost is a quote with empty commentary; having one action handles both. Opens the note composer with the target as context.
- `REPLY` — opens the note composer in reply mode.
- `REPORT` — the quietest item in the strip. Lighter grey (`#B4B2A9`) than the other actions. Present on every card but typographically subordinate.

Rejected: putting report behind a `⋯` menu. One affordance hiding one action is worse than just showing the action, quietened.

**Votes are paid.** Both upvotes and downvotes cost money, at an escalating scale per-voter-per-target (already built in the existing repo schema). Upvote payment goes to the author as a tip. Downvote payment goes to the platform. The cost at rest is *not* displayed on the card; cost labels appear on approach (desktop hover) or press (mobile). The paid-downvote mechanic resolves an earlier tension with PRINCIPLES: aggregated vote scores exist, but users knowingly opt into them as filters via the volume control's `TOP` sampling mode, rather than the platform using them as unnamed ranking signals.

**"Your state" colouring.** When the current user has upvoted a card, the upvote arrow becomes crimson. Downvote the same. When they've quoted, replied, or reported, the respective word becomes crimson. Consistent with the existing repo's convention.

**Heights vary by content.** Articles are taller; notes are shorter; quote-notes are tallest. The shared header and action strip mean variation reads as "different content" rather than "inconsistent layout."

### The pip panel

A surface opened by tapping the trust pip. On desktop: a popover. On mobile: a bottom sheet. Same content in both. Not a tooltip — a substantial surface that does real work.

**Material and placement.** Same opaque-white, sharp-edged treatment as the cards. Roughly 420px wide by 390px tall. Sits on its own, visually at the same level as the cards it came from.

**Header row.** Mirrors the card's header:

- The pip, drawn slightly larger than on the card.
- Author name in Literata medium 18px.
- A chevron (`›`) after the name. The name+chevron is the tap-through to the author's profile page.
- Right-aligned: `FOLLOW ›` (or `FOLLOWING ›` when active, with hover revealing `UNFOLLOW` per the repo's existing pattern) in plex caps 11px. Text-only, no button chrome. Rejected: making FOLLOW an inverted block button — it competed visually with the volume bar below.

**Bio line.** One line of Literata regular 14px. The author's short self-description. Plain regular weight, not italic. Italic is reserved for editorial/connective prose elsewhere in the panel.

**Trust section.** A plex-caps header `TRUST` at left; a depth affordance `ALL POLLING ›` right-aligned on the same line.

Below: three polled questions, each with a YES/NO answer and a percentage confidence.

1. **Are they human?**
2. **Are they who they seem to be?**
3. **Do they engage in good faith?**

Each question is Literata regular 13px, left-aligned. Each answer is plex caps 11px, right-aligned, in the colour of the answer (green for positive, amber/crimson for negative or ambivalent) with a percentage showing poll confidence.

Polling is anonymous and secure, drawing on the user's trust graph and the wider network. The three questions were chosen to match what polling can reliably produce:

- *Human* is reliably answerable from surface signals.
- *Who they seem to be* deliberately weaker than "who they say they are" — respondents judge surface presentation, not verified claims. Catches category-level impersonation (fake doctor, fake identity) without requiring respondents to have verified specific credentials.
- *Good faith* is the behaviour-over-time honesty question, phrased as observable conduct rather than abstract character. Catches both Frankfurtian bullshit and outright fraud without asking respondents to diagnose which.

Rejected: "integrity" as a question (too abstract), and any attempt to distinguish big from small dishonesty on the panel itself. The big/small distinction is real but not reliably pollable; it's deferred to the detail view.

Below the three poll results: a single italic Literata line giving the in-person count, e.g. *3 people in your graph have met Craig in person.* This is a different kind of signal — a relational fact, not a character judgment — and is visually broken out. Italic marks its different register.

The pip's colour is a compression of these four signals. Mapping (provisional, for trust-system spec proper):

- **Green**: all three polled questions positive with high confidence.
- **Amber**: mixed or low-confidence signal; thin polling history; new account.
- **Grey / outline**: no signal — account not polled.
- **Crimson**: one or more questions answered negatively with confidence.

When the three signals disagree (e.g. human-yes but good-faith-low), the pip colour and the per-question cells can show mixed states. Detail TBD for the trust-system spec.

**Volume section.** A plex-caps header `VOLUME`.

Below: a horizontal bar showing the current volume setting.

- Bar spans from `−` at the far left to `+` at the far right, both in plex mono at 16px. TV-remote vocabulary: tap minus to step down, plus to step up; drag the bar for continuous adjustment within the discrete steps.
- Bar track in grey-100, filled region in black. Continuous fill (no gaps through it).
- Five discrete steps: 20%, 40%, 60%, 80%, 100%. Tick marks below the bar (1.5px wide, 5px tall, grey) mark the steps without cluttering the bar itself.
- Current value label (e.g. `60%`) positioned above the end of the fill region, plex caps, quiet but legible.
- Zero is achievable. 0% volume means muted — mute is the natural bottom of the scale, not a separate action. Rejected: a `MUTE` button sitting beside the bar as a separate affordance.

Below the bar: a binary mode toggle labelled `Sample` (in Literata regular) with two small plex-caps buttons `RANDOM` and `TOP`. This controls *how* the percentage is filled: a random sample of the author's output at the given throughput, or the top cut by engagement at that throughput. This is the user's opt-in to aggregated vote signals.

Volume setting is *private* — about this user's own feed, not a public statement about the author.

**Footer.** If the author offers subscriptions, a right-aligned `SUBSCRIBE · £5/MO` (or similar) in plex caps 11px. Otherwise empty. No other footer content — block, mute, manage, etc. have been moved elsewhere (see below).

### What the panel does NOT carry, and why

- **Block.** Blocking is a DM-layer action, not a feed-layer action. Block controls whether someone can message you; volume controls whether their content reaches you. Block lives on the author's profile page, or reachable from DM surfaces. A person you've muted (0% volume) can still DM you unless separately blocked.
- **Mute as a separate action.** Mute = 0% volume, handled by the bar.
- **Report.** Report is about a specific piece of content, not about the person. It lives on the card's action strip.
- **Subscription management.** Subscribing is the action; managing an existing subscription is on the author's profile or account page. The footer's `SUBSCRIBE` transitions to `SUBSCRIBED — MANAGE ›` when active.
- **Notify on publish, notification preferences, etc.** Lives on the author's profile page.

The panel is *judgment + commitment* surface: form a view about the person, set how much of them you want, and optionally escalate to paying them. Everything else is elsewhere.

## Other decisions made along the way

**The ⊔ vessel holds a grey-100 floor with white cards on it.** The vessel walls are heavy black. The floor is grey-100. The cards are opaque white. Between cards, the floor is visible as breathing space. The "room" the spec talks about is literal — a stone-coloured floor with white documents laid out.

**The author is the object of volume; the card is the object of voting.** This resolves a muddle from earlier in the session. Volume controls are properties of the *author* (persistent across their content). Votes are properties of the *card* (this specific piece of writing).

**"Source" in the ⊔ composition expression is still a (platform, handle) pair.** An author who posts on Bluesky and Nostr is two sources in the composer. Whether the same author's volume setting applies across their sources is an open question, deferred.

**Quote and repost are the same action.** Unified under `QUOTE` (with empty commentary = what other platforms call a repost). Protocol adapters handle producing the correct downstream event type (Bluesky repost, Nostr quote-comment, Mastodon boost-or-quote).

**Votes are paid, with the mechanics already wired in the existing repo** (schema.sql `votes`, `vote_tallies`, `vote_charges` tables). Upvote → author as tip. Downvote → platform as revenue. Per-voter-per-target escalating scale via `sequence_number`. Costs shown on approach/press, not at rest.

**The existing repo's UI spec uses Reddit/HN arrow glyphs (▲ ▼)** for voting. The new card grammar adopts them. Earlier exploration of word-based treatments (`UP 142`) was rejected for consistency with the repo.

**The design system's three-voice typography is unchanged and reinforced by this work:**
- *IBM Plex Mono caps* for infrastructure (attribution, labels, action strip, percentages).
- *Literata* for content (titles, bodies, bios, prose).
- *Jost* for interactive UI elements where applicable (not much of it appears on cards, because the card is mostly content).

**Pip states are not fully specified; placeholder mapping in the "Trust section" above.** The trust-system spec proper will need to resolve how the four signals compose into a pip colour, how confidence thresholds work, and how mixed signals are rendered.

## What was sketched but not committed

**Candidates for the feed-scope composer** — literal ⊔ expression, source list with weight bars, nested ⊔ composition stack, vessel-in-composer-mode, and a deliberate "settings panel" negative reference. The vessel-in-composer-mode (D) was the most promising but wasn't taken further in this session. Noted in the earlier handoff; still to be designed, now with the benefit of the committed card grammar (source rows in the composer can borrow the pip + name + platform attribution grammar from the card's header).

**A "left colour bar as volume slider" explored and rejected.** Clever but put volume on the wrong object (the card) rather than the author; also conflated the paywall-status bar with volume. Rejected once the author/card distinction became clear.

**Hover and active states for the vote arrows, quote/reply/report controls.** Consistent with the existing repo pattern (crimson for "your" action state, slight hover lift otherwise). Not drawn but specified.

## What wasn't addressed this session (carry-over for next)

**Pip panel in non-green states.** Amber, grey, crimson versions. Stress-test whether the architecture holds when the trust signals are negative.

**Pip panel on mobile.** Sheet treatment from the bottom. Same content, different geometry.

**Pip panel in context.** Shown open over a card, as a desktop popover or a tapped-into sheet. Tests placement, tether, dismissal.

**Cards with media.** Lead image on an article. Image in a note. Video embed in a standfirst. These weren't drawn and will stretch the grammar.

**Cards at dim brightness.** The per-feed brightness control dims the whole vessel including cards. Test: does crimson hold at the dim extreme (paywall indicators, "your action" states)?

**Long-note truncation.** Notes beyond ~6 lines. Truncation mark + tap-through? A small `READ MORE` in plex caps?

**Subscription state variations.** Panel when the current user already follows / is subscribed / is the author themselves / the author offers no subscription.

**The trust depth view (`ALL POLLING ›`).** What opens when the depth affordance is tapped. Bigger polling questions (verified credentials? known inauthentic networks?). Belongs to the trust-system spec proper more than to the panel design.

**Feed-scope composer, now with the author-as-volume-controllable-entity grammar clear.** Probably worth returning to with the card grammar settled.

## Open architectural questions worth flagging

**How does the pip colour compose from three poll results plus in-person count?** A weighted function? Threshold logic? The panel's design depends on this being coherent but doesn't solve it. Trust-system-proper territory.

**Can a user see their own past trust poll answers? Can they update them?** If yes, the polling system has identifiers tied to respondents. If no, bad-faith early answers become sticky. Affects the panel's potential "your answer" display.

**"ALL POLLING ›" — what is in the detail view?** With three panel-level questions, the detail view has room to carry the bigger-grained (less reliably polled, more dangerous-if-wrong) questions: verified credentials, network associations, specific claim verification. Design pending.

**Volume sampling mode — what does `TOP` mean specifically?** Top by upvote count? Net score? Engagement breadth (replies + quotes + votes)? Recent vs all-time? Committed to "top" as a binary opposite to "random" but the metric behind it is a real choice.

**How do author volume settings interact when the same author posts on multiple platforms?** Craig Mod on both Nostr and RSS. One volume setting for both, or independent? Deferred.

---

*Handoff doc, end of session. Next session picks up from the "What wasn't addressed" list, with my recommended starting point being pip-panel-in-other-states (stress-test the architecture) or the feed-scope composer (now unblocked by the card grammar). These priorities are negotiable depending on what the project needs most.*
