# PRINCIPLES

The commitments that define what all.haus is for. Every feature, design decision, and strategic choice is answerable to these. When a decision gets hard, come back here.

## What we are for

**We route attention and money toward writing that deserves it.**

Not neutral infrastructure for writers to monetise themselves. A deliberate attempt to route readers and revenue to work that merits both, on infrastructure neutral enough to do so without paternalism. Scale is downstream. Staying small and doing this well is success. Growing large while doing this is fine. Growing large by doing something else is failure.

The claim is not that we know universally what good writing is. The claim is that taste is better when owned than when laundered. Every curated surface carries a name.

This is the motivational core. Every other principle serves it.

## How the claim is structural

**The editorial judgement is the infrastructure.**

Two kinds of writer are badly served by the current web. The writer without an audience yet, for whom subscription economics are a closed door — subscriptions demand a recurring commitment readers ration to names they already know. And the writer whose exceptional single piece travels further than any ongoing relationship would — for whom subscription conversion captures a small fraction of the actual reach, months late. Between them, these are most of the writers the editorial claim is about.

Micropayments answer the first problem by changing the temporal structure of payment. A viral essay by an unknown is immediately lucrative, proportional to actual reach, without requiring a reader to enter an ongoing relationship or a writer to have built the audience that would justify asking for one. The tab is not a payment convenience. It is the argument that work deserves payment now, for what it is, not later, for the relationship it might seed.

Named curation and the trust graph answer the distribution problem. A viral essay under algorithmic amplification reaches readers through incentives orthogonal or hostile to editorial quality. The same essay under all.haus reaches readers through named curators whose reputations are on the line when they elevate it. Both are distribution mechanisms; only one carries editorial signal.

Open-protocol portability is what keeps the first two honest. If writers could not leave, the platform could degrade into extracting rent from the audiences it helped build. Because they can leave, the platform has to stay worth using on the merits of the editorial and economic arguments above.

The platform is not neutral infrastructure that happens to have editorial consequences. It is editorially-motivated infrastructure whose commercial shape is an argument.

## What we are

**We are a fiat payment facilitator for open-protocol publishing.**

Card payments, reconciliation, payouts, tax reporting, dispute resolution, regulatory posture — at sub-pound granularity, without tripping into e-money authorisation. That is what we sell. The rest is the condition under which selling it is trustworthy.

This disciplines engineering priority. Stripe, payouts, webhook reliability, FCA analysis — not overhead. Product. Bugs there are structural.

**Our moat is operational, not custodial.**

Anyone can fork the protocols. Anyone can arrange their own payments. Doing fiat legally and efficiently from a standing start is harder than it looks. That is the edge, and the only kind of edge this project is allowed to have. We do not widen it by degrading the open layer, adding payment extensions that break interoperability, or using regulatory posture to slow others' use of the open protocols. We compete by doing the hard thing well.

This is the commercial analogue of the ownership principle below, and the condition under which the ethical claim and the economic claim stay aligned. If the operational edge erodes, ethics and economics start pulling in different directions. Notice when that is happening. The named early-warning signal: a payment feature that only works on all.haus. If that is ever under serious consideration, the moat is eroding and the principles have started bending to accommodate it.

## What we build on

**Committed to open protocols, not to any specific one.**

The ideological bet is on openness. The implementation bets — Nostr, ATProto, ActivityPub, RSS — are protocol-literate, not protocol-committed. The platform survives the loss of any single substrate. Test for any feature: does it work if we swap the protocol underneath? If yes, well-designed. If it couples to one, flag it.

This protects against becoming a protocol advocate rather than a product — the failure mode that caught Mastodon and Element.

**We own nothing our users would miss if we disappeared.**

Identities, audiences, writing, social graphs — all on open protocols the user controls. If all.haus shut down tomorrow, users keep everything that matters. We cannot hold anything hostage, so we have to be worth using on the merits.

**We do not custody what we do not have to.**

The fiat rail is regulated and we run it properly. Stored value, pre-paid balances, long-held funds — off the balance sheet. Credit ledgers belong to the user (Cashu, NIP-60), not to us. Peer-to-peer payments (zaps, nutzaps) go peer-to-peer. The custody window is to be minimised, not monetised.

## The primitive

**The configurable feed is the thing we build everything else around.**

A universal in-tray that ingests content from any protocol and exposes a single control: volume, per source. More of this person, less of that one, none of this one. A feed is the primitive. A user can have as many as they like, configured however they like, public or private. Simple controls for simple use; depth available to those who want it.

A message and a post are the same object with different audience parameters. An inbox and a timeline are the same object with different source parameters. The engine does not distinguish them. The platform does not prescribe a fixed taxonomy of either.

**The writer tool and the reader tool are mirror images.**

The writer's gesture narrows from everyone to someone. The reader's gesture narrows from everything to something. Same gesture, opposite directions. The ∀ in the name and logo is the shorthand for the default both sides narrow from.

The symmetry is a claim about primitives, not about onboarding. The tools around the primitives are legitimately asymmetric — writers need payout tooling and analytics; readers need discovery and trust signals. The engine underneath them is not.

**The audience selector and the feed composer are the two most important UI elements we ship.**

They are where the structural symmetry becomes operational. If "write to my sister" and "publish to everyone" feel like the same gesture at different settings, the writer side works. If building a feed feels like the reading-side equivalent, the reader side works. If they do not feel like mirrors, the product has not cohered.

Each uses the same vocabulary at every scale, defaults sensibly in context, stays visible without demanding attention, and exposes its consequences — confidentiality on the writer side, inclusion on the reader side — as emergent from the primitive choice, not as separate controls.

## How it launches

**The reader tool ships first. The writer tool follows.**

The writer tool has an economic floor it cannot meet alone. Payouts need collective volume before anything clears. So the reader tool carries the platform through phase one, and earns the right to introduce the writer tool.

This means the fiat rail — what the platform *is*, at maturity — is not running at launch. That is fine, provided the reader tool is complete as a reader tool, not a placeholder.

The writer tool's launch is not a secondary milestone. It is the moment the editorial claim becomes operationally real — unknown writers earning immediately from reach, exceptional single pieces paid for in the week they travel. The conditions that trigger writer-tool launch should be named deliberately and revisited honestly, not allowed to drift because the reader tool happens to be working. The failure mode to watch: reader tool succeeds well enough that the internal narrative starts describing it as the point, and writer launch slips indefinitely.

**The product is good for its first user before anyone else shows up.**

No network-effect excuses. The reader tool, on day one, with no writers on the platform, aggregating content from Bluesky, Mastodon, RSS, and Nostr into a configurable feed, is a real product on its own terms. If it is not, we have not shipped.

**The launch feed is the editorial position made operational.**

A new user encounters a populated feed, clearly labelled as a copy of the founder's public feed. They can edit it, fork it, or bin it. That feed is the only editorial claim the platform makes on day one, and it carries the weight of every other claim about taste, curation, and aesthetic seriousness.

Copied, not subscribed. The user's divergence is theirs. Future edits to the founder's feed do not propagate. The user inherits taste, once, and then it is theirs to shape.

**Defaults are the product; configurability is the ceiling.**

Most users will never create a third feed or set a custom rule. The defaults are what 80% of users experience as the entire product. Configurability makes power users evangelists; defaults make normal users stay. Design labour on defaults is at least as important as design labour on the rule engine.

## How curation works

**Every curated surface carries a name.**

No anonymous trending pages, no opaque recommendations, no unnamed editorial team as the platform grows. When we elevate content, a person decides, and their name is on it. The default feed is explicitly someone's feed. Curation is inspectable, accountable, and honest about the taste every feed inevitably expresses.

The discipline: as we grow, curation must never get laundered into an unnamed editorial team. Named humans, even rotating or guest-invited.

**Featuring is editorial, not commercial.**

When curation and commercial interest diverge, editorial wins. Easier to establish small than to retrofit at scale. Write down the featuring criteria. Defend them against the platform's own growth pressures when those pressures arrive.

**We are a curated venue, not a neutral carrier.**

The curation discipline applies to what we amplify and to what we tolerate alike. We do not host everything the open protocols will carry; we host what this venue will carry. The named-human principle governs both surfaces.

**Aesthetic seriousness is load-bearing.**

The typographic system, the no-hairlines discipline, the functional crimson, the zero border-radius, the solid beams — not decoration. A low-cost, high-fidelity signal of editorial standards, and signals of editorial standards are what filter both the writing and the readership. Generic SaaS aesthetics would attract generic SaaS content. The visual identity is the first and most persistent statement of editorial position.

**We do not promise what we cannot deliver.**

We do not bridge closed platforms. We do not claim universal messaging coverage. We do not pitch ourselves as the last app anyone needs. The honest scope: a reading and writing environment for the open web, where the distinction between journal, letter, essay, newsletter, and book is a continuous gradient rather than five separate tools. That is a genuinely new thing and it is enough.

## How the economics work

**Micropayments are the primary mechanism; subscriptions are secondary.**

Most economic activity is expected to be per-piece micropayments. This matches the platform's promiscuous reading spirit — discover, pay a small amount, move on — and it is the structural edge for two writers the subscription economy serves badly: the writer without an audience yet, and the writer whose exceptional single piece travels further than any ongoing relationship would.

The mechanism is the tab. Reading stays frictionless; payment batches at a threshold; the reader experiences settlement rather than transaction. The thing to watch is the median tab. Write down the target before launch, so the interpretation is not retrofitted to whatever happens. This document will be updated with the target once set.

The principle beneath the mechanism: writers-without-subscribers and exceptional-single-pieces must have an answer. Micropayments via the tab are our current answer. If they fail, the principle still holds, and we owe it a different answer.

**Writers keep their audiences; the platform earns its place.**

Syndication via open protocols means audiences are not trapped. The platform's job is to be good enough to stay, not to make leaving costly.

**Features earn their place by serving the motivational core.**

A good feature serving a different purpose is still a no. Adjacencies will be suggested; some will be good ideas for a different product. The test: does it route attention and money toward writing that deserves it, or does it extend the platform into new territory because the territory is available?

## The tests not yet passed

The mirror-primitives principle sets the target. These are the problems of hitting it. All three are harder than they look.

**Feed construction.** How does building and maintaining a feed feel native rather than like filter configuration? Users do not want to administer a rule engine. The primitive is powerful; the interface hides the power behind gestures that feel like natural acts of reading — following, muting, turning volume up or down, forking someone else's feed. The Gmail-filters failure mode (immensely powerful, used well by nobody) is the cautionary case. Every feed must be inspectable: "why is this here / why isn't this here" must return a legible answer that traces to a user-set rule.

**Audience selection.** How does choosing who a message is for feel seamless at every cardinality from one to everyone? The selector defaults sensibly in context, stays visible without demanding attention, and scales from intimate to public without changing vocabulary or affordance.

**The onboarding feed.** The example feed has to do two things at once: be good enough the user wants to keep it, and teach them it is theirs to edit. A feed that is already perfect gives no reason to touch the controls. Gentle nudging is likely needed — *try removing this source; turn down the volume on this person* — without making it feel like a tutorial.

**And a fourth, further out.** As the platform grows, what happens to the founder's feed as the entry point? Does every new user inherit it indefinitely? Does it rotate? Does it get replaced, and by what? The named-human principle says curation stays attached to a named human at scale. The onboarding question is narrower: whether one specific person's taste is the permanent front door, or a launch-era convenience. Not to be answered now. To be held open, and answered deliberately.

**The test that ties them together.** Does the narrowing gesture feel like the same gesture in both directions — shaping what reaches you, shaping who you reach? If it does, the product's internal symmetry is legible through a single interaction pattern, and the ∀ is doing real work. If not, one side has not landed, and the principle is aspirational rather than operational. Prototype both together. Judge them together.

---

*Last revised: April 2026. These principles are load-bearing but not frozen. Revise deliberately, with a note on what changed and why.*
