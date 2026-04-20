# The Big Redesign — Scope, Sequencing, and Open Questions

A second revision, following a working session that pushed against the first revision's assumptions hard enough that most of them moved. The first revision retired the unified workspace in favour of three-and-a-fraction products (reader, writer, workspace, groups). This revision retires the workspace entirely. What replaces it is not a fourth product but a clearer account of what the product already is, once you stop trying to turn it into something else.

---

## What all.haus is for

all.haus is an attempt to rebuild democratic press infrastructure. The institution it is trying to repair is the fourth estate — the independent press that historically produced the shared, trustworthy-enough picture of public affairs that self-government depends on. That institution is in terminal crisis. Its business models have been eaten by platforms whose incentives run against serious journalism. Its distribution sits inside walled gardens tuned for engagement rather than understanding. Its readers have lost the ability to tell, at a glance, whether what they're reading is worth their attention. Three problems — trust, funding, distribution — are three faces of a single failure, and the informed electorate self-government requires is the casualty.

The response is a trust graph, micropayments, and Nostr foundations. Users who make a home here can leave at any time, taking everything with them to another Nostr client or to one they set up themselves. This creates a permanent incentive for the platform to keep its services good and its prices reasonable. It wards off the evil eye of venture capital — margins are meant to stay thin forever. And it uses the momentum of the AI race as a kind of judo throw in support of human creativity, spinning up infrastructure at dazzling speed and low cost to construct a space in which human values have the upper hand.

The project has more than one intellectual parent. From the public-sphere tradition — Habermas on the structural transformation of public discourse, Benkler on commons-based peer production as a democratic technology — it takes the claim that a functioning press is constitutive of, not merely useful to, democratic life, and that networked infrastructure can sustain one outside both platform capitalism and state broadcasting. From Erik Olin Wright it takes the political grammar: there are three basic sources of power in modern political life, not two, and a project that wants to build real weight in the third — in civil society, in associational and commons-based life — has to resist absorption by either of the other two. all.haus is not anti-market: micropayments are a market mechanism, deployed deliberately to sustain a democratic good the default market underfunds. It is not anti-state: a democratic commons depends on legal infrastructure only states provide. It is against market-as-totality and state-as-totality both.

Where the project departs from Wright, and where a different lineage takes over, is in the specificity of its threat model. The architecture is designed to resist both characteristic failure modes of 21st-century publishing: **platform capture** — the market-as-totality failure, expressed through walled-garden extractivism, ad-incentive corruption, engagement-optimised algorithmic feeds, and the valuation-driven compression of editorial independence — and **state coercion** — the state-as-totality failure, expressed through surveillance, compelled disclosure, content takedown, deplatforming pressure, and the extraterritorial reach of adverse jurisdictions on centralised operators. Those are post-Snowden, post-platform-weaponisation threats that the older political-theory lineages underdetermine. For the technical commitments that follow from taking them seriously — content-addressed media, encrypted key custody, portable identity, federation as a roadmap item rather than a flourish, the Nostr-as-source-of-truth architectural choice — the nearer ancestors are the civil-libertarian and cypherpunk traditions: the EFF, software-freedom thinking, the cryptographic protocol lineage that runs through Signal and the wider architectural-resistance movement in applied cryptography.

The synthesis is simple to state. The public-sphere tradition tells us what we are trying to rebuild and why it matters. Wright tells us where, politically, such a thing can live and survive. The civil-libertarian tradition tells us what it has to be technically resistant to if it's going to last. The fourth estate is the institutional target; Nostr, portability, thin margins, and trust annotations are the means; the bet is that a press so rebuilt can sustain the informed public that democracy requires.

---

## Product thesis

all.haus is a reader and a writer that share a single surface.

Stuff comes in. You read it or you don't; you reply or you don't; occasionally you send something of your own. The dominant motion is reading. Replying is part of reading — the thing you sometimes do at the end of reading, not a separate activity with its own page. Composing from scratch is the rarer motion and should be available everywhere without occupying the screen when not in use.

The **reader** is a universal feed aggregator with trust annotations and good (if standard) social features. Content arrives from Nostr, Bluesky, Mastodon, and RSS, rendered as peers of native content. Discovery exists as an opt-in second slice of the same surface — a *for you* view that surfaces trust-graph-adjacent content with visible provenance, never algorithmic amplification masquerading as default. It competes with Surf and modern RSS tools on reading and with nothing on trust.

The **writer** is Substack/Ghost with micropayments, Nostr foundations, author-controlled presentation, and Traffology analytics. It supports solo blogging and serious online magazine publishing alike; where an author wants bespoke page design, that renders faithfully. Publication-level design tokens cascade into articles. A writer can live here and never engage with the reader side of the product.

The two compose because they share a surface and a set of affordances — not because the product imposes a composition. A reader who never writes gets the reader. A writer who never reads gets the writer. A user who does both gets one coherent place.

---

## Consequences of the thesis

The thesis changes several things about the previous redesign plans.

**There is no workspace to build.** The previous revision treated the workspace as an emergent third product. This revision treats the workspace as a conceptual artefact of an earlier confusion. There is one feed with filters, one reader route for full articles, one compose action available globally, and a handful of account-scoped destinations reached from the avatar dropdown. That is the whole product. Mode tabs, panel toggles, multi-panel shells, and the twenty-one questions the original scope doc raised about composing them are not deferred; they are not happening.

**The feed is an inbox, architecturally.** *Architecturally* is doing load-bearing work in that sentence. The product internally treats the feed as a filterable stream of things arriving from subscriptions, with read/unread state, threaded replies, and a compose action for items the user initiates. That structure is what gives the product its coherence. It is not what the product *calls* itself and it is not the metaphor the UI leans into. Nothing in the user-facing surface should feel like email. Items flow past rather than piling up. Zero-state reads as being current, not as emptiness. Threads render like transcripts — playscripts of a conversation — rather than nested reply-wastelands with broken quote formatting. The architect's metaphor stays in the architect's head.

**Trust is ambient infrastructure, not a destination.** A pip next to the byline, a discreet drill-down available by tapping the byline, a full trust profile for deep inspection. No standing trust panel, no scores on feed items, no leaderboards. The pip ships as one composite mark with three states; the four-dimension view (humanity, encounter, identity, integrity) exists as drill-down, which is already what the codebase does.

**Replying is one affordance, not three.** The current product has comments (on articles), quote-replies (on notes), and reply-via-linked-account (on external items). From the user's side this is one gesture: *I want to respond to this*. The three-mechanic split is backend protocol leaking into the frontend. A unified reply affordance routes correctly underneath and appears as one button on every card.

**Composing is a mode, not a page.** The current `/write/[draftId]` page shape, with its own full-page layout, is an artefact of the writer-first-builder era. In the product the thesis describes, composing is something entered from anywhere, written, sent, and exited back to where the user was. Drafts, auto-save, publication selector, scheduling, presentation-mode choice all live inside the compose surface rather than on a dedicated page.

**The feed ingester takes the position the composer currently holds.** The subscribe-via-omnivorous-input page exists in the codebase as an unlinked standalone. This is a small but telling diagnosis of what the current UI is optimised for: the NoteComposer sits at the top of the feed, in prime real estate, while the affordance for *getting more things to read* is orphaned. Swapping their positions is the single most consequential change in this revision. The top of the feed becomes the subscribe input; the compose action becomes a topbar button (and a keybind). This aligns the feed's first affordance with the feed's primary purpose and gives the ingester a home it has always deserved.

**Author-controlled presentation is a first-class feature, not a polish item.** The writer side supports two presentation modes per article: *flowing* (expands inline in the feed, renders in the default reader surface) and *custom* (never expands inline, opens only in the full reader route where the author's design choices render faithfully). This is what distinguishes all.haus-the-publishing-platform from all.haus-the-blog-host, and it's the pitch that a serious online magazine can hear and take seriously.

---

## Design principles

The premises above generate operational constraints. Every design decision should be tested against whether it preserves or erodes the democratic character of the space, and against the two failure modes the architecture is meant to resist: platform capture and state coercion.

**Portability is a first-class UX commitment, not a technical footnote.** Users can leave at any time with everything they have — identity, follows, subscriptions, paid receipts, drafts, annotations, conversations. The export flow exists already. The design commitment is that leaving must remain a fluent, visible, unembarrassed path for the life of the product. No feature ships that only works if the user doesn't leave. Portability is the exit condition that keeps the platform honest against capture; it is also the redundancy that keeps users' work intact if the platform is compelled to change shape.

**The product does not optimise for engagement.** No streaks, no push-to-reopen notifications, no algorithmic amplification tuned for arousal, no time-on-site as a success metric. The reader is for reading when the user wants to read; the writer is for writing when the user wants to write. The for-you view is explicitly gestural — the user enters it to look for new things, it does not claim their default attention. Engagement is a byproduct of usefulness, not a target.

**Thin margins by design.** The financial shape of the product is meant to stay unattractive to the kind of capital that would want to collapse it back into market-as-totality. A small team can sustain it indefinitely, or the premise fails. The product cannot depend on a large design team to maintain, cannot require a growth team to justify, and cannot accrete features whose only purpose is to increase valuation-relevant metrics.

**Trust information is infrastructural, not performative.** Trust annotations exist to help users make judgements, not to gamify status or rank users against each other. Discreet ambient pips and drill-down detail on demand. Users should be able to ignore trust signals entirely and still get value from the product. In the for-you view, where pips do evaluative rather than confirmatory work, provenance is always legible — *surfaced because 3 people you follow vouch for this author* — so the recommendation is auditable and declinable.

**Architectural resistance, not promises.** Where the platform cannot read something, it cannot be compelled to disclose it; where the platform does not own the source of truth, it cannot be coerced into breaking it. Nostr-as-canonical-store, encrypted key custody, content-addressed media, and the federation roadmap are expressions of this principle. Design decisions that would re-centralise what has been decentralised must meet a higher bar than *it would be simpler*.

**The writer owns their audience, the reader owns their attention.** Nostr-native identity means writers have direct relationships with readers that the platform cannot mediate or break. The reader's feed is reverse chronological by default, sortable and filterable but never silently reordered. Algorithmic sorting is opt-in, transparent, and user-configurable; it is never the default mask for a different agenda.

---

## Aesthetic register

Short section, because it matters and keeps getting elided into other sections where it drifts.

The visual language is Bauhaus-adjacent: solid geometric forms, structural weight, the ∀ mark, Jost / Literata / IBM Plex Mono, crimson as a strictly functional accent. The existing design specification holds. What this revision adds is a register note. The product should feel chic and media-confident with a subliminal touch of cypherpunk edginess — a serious publishing surface that knows what it is. It should not feel like software from a productivity suite. Not Microsoft. Not Notion. Not Gmail. The threads-as-playscripts point is part of this: when a conversation renders, it should read like something you'd be pleased to see in print, not like a customer-support transcript.

---

## The shape of the product

One feed. One reader route for full articles. One compose surface. A small set of account-scoped destinations reached from the avatar.

**The feed** is the single stream. Default filter: unread from subscriptions, reverse chron. Other filters stack: by source, protocol, item type, tag, read/unread. For-you is a filter. Filter state lives in URL params (the canonical URL for a filtered view is shareable and bookmarkable). Items render progressively — notes and lightweight external items expand in place; custom-presentation articles open the reader route. Every item has one reply affordance. The composer does not live on the feed; the subscribe input does.

**The reader route** (`/article/[slug]`) is the full reading surface. It runs in the existing canvas layout mode. It supports author-designed presentation, with publication-level design tokens cascading into articles where applicable. Comments render below the piece as a threaded transcript. This is where serious publishing looks serious.

**The compose surface** is accessible from the topbar (button + keybind) from anywhere in the product. It opens as an overlay or drawer over whatever the user is doing, does not take over the surface, can be dismissed back to context. It contains the editor, draft autosave, recipient field (empty = public, people = private thread, pinned-item field for discussing a specific thing), publication selector, presentation mode choice, scheduling, tags. It is the one place composing happens, whether the user is sending a DM, starting a cliquey thread on an RSS post, or publishing a long-form article.

**The avatar dropdown** holds the account-scoped shortcuts: Messages (with live badge) as a direct jump to the conversations slice of the feed; Notifications (with live badge) as a direct jump to the mentions/replies slice; Profile, Ledger, Library, Settings, Log out. Messages and Notifications are not separate products; they are persistent shortcuts into filtered views the user wants fast access to.

**The focus preference.** One setting — reader / writer / both — shapes the chrome. Reader-only hides the compose button in the topbar and keeps the feed as the primary surface. Writer-only surfaces drafts and publications in the topbar position where the feed lives for readers. Both is the default. The preference is honest: the user tells the product what they want rather than having it inferred from behaviour.

**The cliquey primitive.** Dissolves into the compose surface. Starting a small-group conversation about an item is the gesture of composing a reply with recipients. The thread lives in the conversations system (already a multi-party primitive in the schema), with the item pinned as subject. The Messages view renders item-pinned threads with the pin visible at the top of the conversation. Groups (Phase D in the previous plan) emerge from repeated use: when the user threads with the same people repeatedly, the product can offer to save that membership as a persistent group. No "Create a Group" flow; groups are a reification of existing practice.

---

## Sequencing

Two phases. They can run in parallel if there are two pairs of hands; otherwise, in sequence, with reader-first on the argument that the reader is what tests the thesis. The writer generates revenue but the reader is what proves this is not just a better Substack.

### Phase A — Reader-first soft launch

The work that delivers the reader half of the product.

1. Move the subscribe input to the top of the feed. Move the NoteComposer off the feed and into a global topbar compose action.
2. Filter bar. Default filter = Inbox (unread from subscriptions, reverse chron). Filter state in URL params. Zero-state copy reads as current, not empty. Sortable alternatives available for people who want them.
3. For-you as a filter. Surfaces trust-graph-adjacent content with visible provenance. Cold-start falls back to editorially-curated trust-annotated picks, not algorithmic popular-on-the-platform.
4. Unify the reply affordance across item types. One button per card, routes correctly underneath based on item type.
5. Progressive expansion in the feed — notes and lightweight external items expand in place; items marked custom-presentation never expand inline.
6. Readability extraction for RSS items that only ship descriptions. The one genuine piece of external-rendering work remaining.
7. Trust profile drill-down accessible from byline tap as a slide-in or popover rather than a navigation.
8. Focus preference (reader / writer / both) in settings, with default both.
9. Cliquey primitive as composing with recipients. Requires: `target_event_id` and `target_kind` on conversations (or a side table), a "discuss with…" action on feed items that opens the compose surface with those fields prefilled, and the Messages conversation view rendering the pinned item at the top when present.
10. Comments extended to cover external items (synthesised stable target event ID from the external item's canonical URI).

That is the minimum. It is shippable by one person. It tests the thesis.

### Phase B — Writer-side polish

Largely the existing frontend audit, with one significant addition and one clarification.

1. Email-on-publish (audit item 2).
2. Landing page (audit item 3).
3. Writer analytics surfacing Traffology (audit item 4, integrated with the Traffology work).
4. Publication homepage templates (audit item 5).
5. Writer onboarding (audit item 6).
6. CSP header fix (audit item 7).
7. Import tooling (audit item 8).
8. **Author-controlled presentation** — editor support for flowing vs custom presentation modes, publication-level design token system, faithful render in the reader route. This is larger than it reads and is what makes the writer pitch real.
9. **Clarification on `/write/[draftId]`** — the standalone editor page is not ported into a workspace mode (there is no workspace). It becomes the surface the global compose action opens on for long-form composing; for short posts and replies the compose surface stays compact. Same editor, different chrome around it depending on what's being written.

OG metadata (audit item 1) is already done.

---

## Open questions

The original scope doc listed twenty-one. The first revision reduced that to roughly fifteen spread across four phases. This revision's list is short, because most of the previous questions either dissolve under the single-surface framing or move to implementation-detail territory.

**Q1. The filter bar's visual design.**

Sits directly under the topbar, persistent or sticky on scroll. Needs to read as a continuation of the topbar's structural weight — another horizontal element in the Bauhaus grammar, not a floating row of Gmail-style chips. Design pass before build.

**Q2. For-you adjacency model.**

Graph-adjacent (people your network vouches for) is the defensible primary signal — it's the one the trust graph uniquely affords, and it's the one that doesn't drift toward engagement optimisation. Topic-adjacent and reader-adjacent models are viable secondary signals if transparent and labelled, but should not be default. Provenance is always legible per-item.

**Q3. What happens to a cliquey thread when a new member is added later?**

Join-from-now-on (clean crypto, some UX friction: earlier messages not visible to the new member) vs. key-sharing on add (Signal-style, more complex). Probably join-from-now-on for v1, with a note in the UI about what the new member can and cannot see. Decide before build.

**Q4. Threads-as-playscripts: how, exactly?**

The rendering of conversation threads needs a concrete visual design. Speaker-line shape: byline + pip + line of dialogue, indented continuations, no nested-quote reply chains, no "On [date] [name] wrote". This is a small but load-bearing design piece and is where the aesthetic register lives most visibly. Sketch before build.

**Q5. Feed zero-state as accomplishment.**

Copy, pacing, and the visual of "you're current" rather than "nothing here yet". Not a big design task, but worth not leaving to a default string. The product's emotional register is most visible in moments the user expected content and didn't find it; mishandling this is how the inbox-architecture starts feeling like an inbox.

**Q6. Dark mode.**

Flagged in the frontend audit, still unresolved. Decide before the filter-bar design locks in token choices — retrofitting is painful.

**Q7. Mobile.**

The reader as a single-column responsive view on narrow viewports, not a briefing product. This is less ambitious than the original "morning edition" idea and ships much sooner. The compose surface on mobile needs its own pass — overlay vs full-screen-modal vs bottom-sheet. Worth sketching rather than defaulting.

**Q8. Where does the ledger surface live in the compose UI?**

For paid articles, the compose surface needs to expose price, access mode, paywall position. These currently live in the editor page. In the compose-as-surface model they need a home that doesn't clutter short-form composing. Progressive disclosure — an expander or a secondary row that appears only when publication mode is set.

---

## What's not in this plan but lives nearby

- **Onboarding.** Reader-first and writer-first onboarding are genuinely different. Neither is in Phase A or Phase B as scoped. Needs its own small design pass.
- **Linked accounts and cross-posting.** Already implemented in the note composer and settings. In the compose-as-surface model, this becomes a per-compose affordance — "also post to Bluesky / Mastodon" as an inline toggle.
- **Federation and self-hosting.** Post-launch. The design should not foreclose it; doesn't need to actively support it at v1.
- **Groups as persistent entities.** Emerges from the cliquey primitive rather than being built as a separate feature. The product can offer to save a frequently-used thread membership after repeated use. No creation flow needed until the primitive has been lived with and the shape of real usage has become clear.

---

## Summary

The first scope doc was one project answering twenty-one questions about a unified workspace. The first revision was three-and-a-fraction products with their own scopes. This revision is one product — a reader and a writer sharing a single surface — with a short list of things to build and a short list of genuine design questions.

The practical test: one person signs up, subscribes to some things, reads them, never composes, and feels they have a good reader. Another person signs up, writes articles, emails subscribers, sees their numbers, never uses the feed, and feels they have a serious publishing platform. A third signs up, does both, and feels the composition is seamless because there is nothing to compose — it's one surface already. If all three are happy, the product is working.

The deeper test is the one the preamble describes. A platform that passes the practical test but fails the deeper one has missed the point. Every design decision is downstream of that.
