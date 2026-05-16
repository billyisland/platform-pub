# all.haus — Vision, Trust Graph, Workspace, and Implementation Architecture

## Architectural Design Record

**Status:** Active
**Date:** April 2026
**Scope:** Product vision, trust graph design, attestation mechanism, payment layer, workspace UI, and implementation architecture
**Incorporates:** Workspace Design Spec (formerly WORKSPACE-DESIGN-SPEC.md), trust graph implementation decisions, Layer 2-4 implementation design


## I. What all.haus is

All.haus is two tools that are made for each other but can be used apart.

The **WRITER** is a tool that protects the interests of writers. It preserves their autonomy, their security, their reputation, and their livelihood. It gives them portable identity via Nostr keypairs, transparent monetisation via the reading tab, content provenance from the point of creation, a draggable paywall gate, and dual-key authorship for publishing within editorial structures. The WRITER is currently assembled into a full publishing platform, but its components are separable in principle: a writer could use the WRITER tools while publishing on their own domain, through a Publication hosted by someone else, or anywhere the Nostr layer reaches.

The **READER** is a tool that protects the interests of readers. It guides them toward good content, discreetly flags the dubious as dubious, and makes the information environment legible without requiring anyone to surrender their privacy. The READER aggregates content from across the web — Bluesky, Mastodon, RSS, external Nostr, native all.haus content — into a unified experience, and layers trust information on top of everything it shows.

The READER and the WRITER work especially well together. Content produced through the WRITER is maximally legible in the READER — richer trust signals, transparent incentives, full provenance. But there is no requirement to use both. The WRITER is useful on day one without any READER ecosystem. The READER is useful as a standalone feed reader and trust-annotation layer even if the user never publishes a word.

The two halves create a flywheel: writers publish through the WRITER, the reading tab generates both revenue and trust signal, the READER surfaces that signal to other readers, those readers subscribe, which deepens the trust graph further. Both halves become progressively more attractive as the other grows — but both have compelling use value alone.


## II. The problem all.haus addresses

The missing layer of the internet is *legibility without identification*. The current web forces a bad trade: operate under your real name (and accept surveillance, targeting, and the collapse of context) or operate anonymously (and accept that nobody has any reason to trust you). The missing middle is the ability to know things about a person or a piece of content that matter — are they human, are they consistent, are their incentives transparent, do they have a track record — without knowing things that don't matter or that are dangerous to reveal: their legal name, their location, their government ID number.

In an increasingly authoritarian world of arbitrary powers, a system that requires real-name identification to function is not neutral infrastructure — it is a tool of control. It should be possible to lead a full life and a successful career on all.haus via a high-quality pseudonym: one that can be guaranteed in various ways but cannot be traced to a real-world government identity. This is a political commitment, not just a privacy feature.

The information environment is degrading fast. AI-generated content is flooding every channel, trust in institutions and media is collapsing, and the platforms that mediate most people's reading experience are optimised for engagement rather than legibility. Almost nobody is building seriously against this problem. All.haus does not need to become a mass-market product to matter. The people who care about the quality of their information environment — journalists, researchers, writers, editors, serious readers, people in adversarial political contexts who need pseudonymous identity with real trust signals — are a small population in percentage terms but a large and influential one in absolute terms. The comparison is not Instagram. It is something more like Wikipedia, or PGP, or RSS itself: infrastructure that a relatively small number of people use directly but that shapes how information moves for everyone.


## III. The READER

### What the READER is for

The READER is a trust-annotated feed reader. It aggregates content from multiple sources into a unified experience, and it tells you something about what you're looking at. Every item in the feed carries whatever the trust layer can say about it. Native all.haus content is richest — full provenance, transparent payment, attestation depth. Nostr content has portable identity signals. Bluesky and Mastodon content has whatever Layer 1 can infer. RSS content from an unknown blog has almost nothing — but "almost nothing" is itself a visible datum, and it is more honest than treating all sources as equivalent.

The READER's first pitch to users is that it is a good, elegant way of organising and sifting everything they might want to look at. The aggregation is table stakes — the thing that gets someone in the door. The trust layer is what keeps them, and what distinguishes the READER from every other feed reader on the market.

### Competitive context

Flipboard's Surf, launched in April 2026, is the closest comparator. Surf combines Bluesky, Mastodon, RSS, podcasts, and YouTube into a single browsing experience and positions itself as a response to siloed networks. The RSS reader incumbents — Feedly, Inoreader, NewsBlur — are mature and well-established.

All of these solve the *aggregation* problem: getting everything into one place. None of them touch the *trust* problem. You can curate your sources perfectly and still not know whether the person behind a pseudonym is acting in good faith, whether an article was funded by an undisclosed interest, whether a seemingly independent voice is part of a coordinated network. Source selection does not solve the legibility problem. The trust layer does.

The READER should not compete on aggregation alone. It should lead with "the feed reader that annotates what it shows you" — where every feed item carries a trust profile, however thin. Even minimal trust signals ("this identity is three years old and has 400 paying readers" versus "this is an RSS item with no identity metadata") change the reading experience in a way that makes the product distinctive immediately.

### The READER's relationship to content

The READER should teach its users to notice what's missing by consistently showing them what's present. Content that came through the WRITER is visibly richer — more dimensions of trust, transparent payment, full provenance. Content from outside is thinner. The reader does not need to be told this is worse; they experience it as less complete. The READER creates demand for the WRITER by making legibility feel normal and its absence feel like a gap.

The READER must not treat non-WRITER content as second-class in a way that feels punitive or partisan. The READER is honest: "here's what I can tell you about this, here's what I can't." The asymmetry should feel like a limitation of the source, not a judgement by the tool. "No trust data available" is neutral. "Unverified" is already a judgement. The READER stays on the neutral side of that line.

### UI principles

The READER should make the reader feel discerning and intentional rather than listless and captured by a bad dopamine loop. The pleasure of using it should not feel pathological.

**Assume the shape the user wants.** The READER is a workspace, not a feed. It is composed of panels — sources, feed, reading pane, trust instruments — that the reader opens, closes, and arranges. The arrangement persists between sessions. There is no behavioural inference, no algorithmic personalisation, no machine learning. The system does not watch what you do and guess what you want. It remembers what you arranged and holds that arrangement faithfully until you change it. The "intelligence" is persistence of state: the tool remembers what you did, not what it thinks you are.

If someone wants to use all.haus as a social client, they filter the feed to social posts and close the trust instruments. If they just want Google Reader back, they close the trust instruments and use the feed and reading pane alone. The configuration is explicit and manual — closer to arranging furniture in a room than to training a recommendation engine. But every arrangement must be a valid composition: when a panel closes, the remaining panels reflow to fill the space, and the result looks intentional, not broken. The workspace is a set of designed rooms, not a generative space. This is a design problem, not a machine learning problem, and it should be solved with layout engineering and good defaults rather than with models and training data.

**Content diversity by default; narrowing by intent.** At the functional level, the site assumes the shape the user wants. At the content level, the path of least resistance should entail increasing exposure to diverse high-quality content. Readers have the sovereign right to configure the site so it only shows them the same three things they like — but that should take a deliberate decision. The default feed is not "things you already like" or "things that are popular" — it is "things that are well-attested by diverse sources, weighted toward your region of the trust graph." That is a genuinely different ranking principle from anything else on the market. The trust graph is not just serving the reader; it is serving the writer ecosystem. A new writer with a thin trust profile but genuine attestations from a few well-connected people gets surfaced to readers who would never have found them otherwise. The READER becomes a discovery mechanism that rewards trust capital rather than popularity or volume.

**Desktop and mobile are different modes of attention, not responsive breakpoints.**

*Desktop* is where you sit down to read. A broad surface, many items visible at once, the ability to have something open in a reading pane while surveying what else is waiting. Dense, structural, closer to a broadsheet front page or a well-set table of contents than to a social feed. Trust annotations can be richer here — the Trust panel that expands alongside the reading pane, showing attestation landscape, payment history, publishing frequency. The desktop READER is a proper instrument.

*Mobile* is where you check in. The attention is narrower, more sequential, more interruptible. A morning-edition model: you open the app, here are the items most worth your time since you last looked, ranked by some combination of your preferences and the trust graph. You read one or two, you're done. The interaction is vertical and focused — one item at a time, swipe to move on, minimal chrome. Trust information is compressed to a glyph or a colour — a tiny dense signal you learn to read at a glance rather than a panel you expand. The mobile READER is a briefing, not a workspace.

These are not two separate products. They are the same river, the same graph, the same preferences, expressed through two different interaction grammars that reflect how you are actually using the device. What you dismissed on mobile is dismissed on desktop. What you saved on desktop is waiting on mobile. The state is unified; the experience is adapted. (V1 is honestly per-device via localStorage; cross-device sync requires a server-side state store and is future work — see §VIII.6.)

**Respect the reader's attention.** The default view should be the content itself, with the trust layer available on demand rather than always overlaid. A cockpit has instruments, but you look through the windscreen most of the time. The instruments are there when you glance down at them. Density communicates seriousness: a denser layout lets the reader survey before they commit, seeing many items at a glance with headline, source, and trust annotation visible. They choose what to enter. The design language should present information rather than sell it — solid, structural, not trying to be seductive.

**Intentional, not effortful.** The line between "respecting the reader's attention" and "making them work for it" is real. Triage gestures need to be frictionless. Trust annotations need to be glanceable. Tempo features need to feel like a courtesy, not a restriction. The design has to make discernment feel natural, not like homework.

### Where the READER already exists

The feed-ingest service pulls in Bluesky, Mastodon, RSS, and external Nostr into a unified timeline. The outbound adapters can cross-post back out. The content-tier system distinguishes native content from federated and bridged content. The Nostr layer gives portable identity. The paywall system is in principle generalisable.

### Where it falls short

The feed is currently structured as a social feed (Following + For You), curated *for* you rather than *by* you. The article reading experience is built around all.haus's own rendering pipeline with no middle ground for reading external content inside all.haus with its tools layered on top. The annotation and commenting system is scoped to native content. The paywall is tightly coupled to the publishing flow. Identity and the social graph are platform-centric in practice even though they are built on a portable protocol.


## IV. The WRITER

### What the WRITER is for

The WRITER protects the interests of writers. It preserves their autonomy (portable Nostr identity that they own), their security (pseudonymous operation with no requirement for government-traceable identification), their reputation (trust graph accumulating attestations over time), and their livelihood (reading-tab monetisation with transparent incentive structure).

### Transparent motivation as the first trust layer

Most of the functionality on the present iteration of all.haus is about creating transparent motivations for content production. People write what they do because they are being paid in the obvious way. If they weren't being paid in the obvious way, that would be suspicious. If they were being paid in additional, concealed ways, that would be dishonourable, or at least raise old-fashioned questions about integrity.

The reading-tab model is not just a monetisation feature. It is the first layer of trust infrastructure. It answers one of the core questions — *why was this made?* — with a verifiable answer: because readers paid to read it. The payment system makes incentives legible. Deviation from it is itself informative.


## V. The payment layer

### Design principles

The payment system is a protocol with multiple backends. The reading tab sits above all of them and does not care which one is active. A reader's tab accumulates in the abstract; settlement happens through whichever channel the reader and writer have in common. If the reader pays in sats and the writer wants pounds, the conversion layer resolves the mismatch. If both are wallet-connected, it can be direct.

The payment layer must support full pseudonymous participation. A person should be able to be a fully fledged member of the all.haus community without linking a bank account — because linking a bank account is an identity-revealing act that contradicts the political commitment to high-quality pseudonymity.

### Three tiers

**Tier 1: Crypto-native.** Users connect their own wallets. A reader pays sats from their wallet; a writer receives sats in their wallet. All.haus facilitates the connection but the cryptocurrency passes through rather than being held. This is the lightest tier for all.haus legally, because there is no custody and no conversion. It is also the tier that fulfils the full pseudonymous vision: neither party has linked a bank account to anything. Their identities are pseudonymous, their payment method is pseudonymous, the trust graph attests to their standing without revealing who they are.

**Tier 2: Conversion via third party.** A reader pays in Lightning (or another cryptocurrency); the payment hits a third-party processor (Strike, OpenNode, or similar) that converts it to fiat instantly. What arrives in the writer's Stripe-connected account is just pounds. The writer does not see where the payment came from. All.haus does not touch the cryptocurrency at any point — the processor sits between the reader's wallet and the writer's fiat account. This matters because it means all.haus itself is not performing a regulated financial activity; the processor carries the authorisation burden.

**Tier 3: Fiat only.** Readers and writers who want nothing to do with cryptocurrency use Stripe throughout. This is the current default and remains fully supported.

The system must handle mismatches gracefully. If a reader pays in crypto and the writer has opted out of receiving crypto in any form, the conversion layer resolves this silently. Writers who are cryptocurrency-hostile should never have to know that cryptocurrency was involved — even if it was converted to fiat before it reached their account.

### Legal and regulatory context

Accepting cryptocurrency as payment for goods or services in the UK does not currently require FCA registration or authorisation, provided the platform is not facilitating trades, holding crypto on users' behalf, or operating an exchange.

The UK is introducing a comprehensive cryptoasset regulatory regime. The FCA authorisation gateway opens in September 2026, with the new regime expected to come into force in October 2027. This regime creates new regulated activities including dealing, arranging transactions, operating trading platforms, and providing custodial services.

The three-tier architecture is designed to keep all.haus on the light side of this regulatory boundary. In Tier 1, all.haus facilitates wallet-to-wallet payments but does not hold or convert funds — it is closer to a messaging layer than a financial intermediary. In Tier 2, the regulated conversion activity is performed by the third-party processor, not by all.haus. In Tier 3, Stripe handles everything.

Key obligations that apply regardless of tier: cryptocurrency received as payment is business income and must be valued in GBP at the time of receipt. From 2026, UK firms must report all customer cryptocurrency transactions to HMRC under the Cryptoasset Reporting Framework (CARF). Tax reporting is non-negotiable across all tiers.

The wallet-to-wallet tier (Tier 1), while legally lightest for all.haus at current scale, is the one most likely to attract regulatory attention as the UK regime matures. The direction of travel is toward platforms being responsible for knowing who transacts through them, even when they are not holding funds. At small scale this is manageable. At the scale where all.haus is a meaningful payments network, the facilitation itself may constitute a regulated activity under the 2027 regime. This is a bridge that does not need to be crossed now, but it should be anticipated in the architecture.


## VI. The trust graph

### What the trust graph is for

The trust graph is the shared infrastructure that makes both the READER and the WRITER work. The READER consults it to contextualise what you are reading. The WRITER builds trust capital through it by accumulating attestations and payment history. The graph is connective tissue, not the property of either tool.

The trust graph serves two purposes. First, it helps decide what to show the reader, to the extent that they want to let the algorithm drive — surfacing content from well-attested sources, deprioritising content from thin or contested identities, weighting editorial signals from people the reader has reason to trust. Second, it is present as a resource for the reader to consult as they like when making their own explorations — visible, interrogable, a tool for the reader's own judgement rather than a hidden hand shaping what they see.

### The layers

The trust graph is built from four layers, each progressively richer.

**Layer 1: Automatic signals.** Things the platform can compute without any social action from the user. Age of account. Whether a payment method is connected (fiat or crypto wallet). How long the identity has been continuously active. How many distinct readers have paid to read this person's work. Writing history and publishing frequency. Subscriber count. NIP-05 domain verification. These are weak individually but collectively they build a baseline picture of whether an identity is substantial or hollow. This layer is always present for every account and requires no opt-in. Crucially, Layer 1 signals can be inferred even for non-native content — the READER can assess account age, publishing frequency, and domain verification for content from any source.

**Layer 2: Personal attestations.** One person making a specific claim about another. "I believe this person is a real human." "I have met this person." "I believe this person is what they claim to be." "I believe this person acts with integrity." These are individual, directed, multidimensional claims. They exist in two forms:

- **Anonymous attestations** are made via a separate, unlinkable keypair (see §VII) and processed through the dual-graph system. The platform sees that anonymous node X attested to public node Bob, but cannot determine who X is. Anonymous attestations feed the global trust scores via epoch-based aggregation.
- **Public endorsements** are attached to the endorser's public identity. They are visible, attributable, and immediately queryable. Public endorsements feed the relational presentation layer (Layer 4) directly — they are the mechanism by which the Trust panel can say "3 writers you follow endorse this person's integrity."

The two forms serve different needs. Public endorsements are low-friction (one click, no key management) and provide the relational data that makes the Trust panel feel alive. Anonymous attestations are higher-friction (require a separate keypair with seed phrase backup) but provide the stronger privacy guarantee needed by people in adversarial contexts or people making negative attestations. The system produces useful output even if anonymous participation is thin, because public endorsements carry the Layer 4 relational data independently.

**Layer 3: Graph analysis.** The system analyses the structure of the attestation graph to compute trust scores. An attestation from someone who is themselves well-attested is worth more than one from someone with a thin profile (the Elo/PageRank principle). In the dual-graph system, this is approximated by credibility brackets on the private side (see §VII.5). Attestations from people who are distant from each other in the graph are worth more than attestations from a tight clique (diversity weighting). Clusters of identities that all vouch for each other but have thin connections to the broader network are suspicious and their attestations are discounted (Sybil detection). The financial layer is a Sybil-resistance mechanism in its own right: fake identities can follow each other and vouch for each other, but they can't easily generate realistic payment patterns through the reading tab.

**Layer 4: Relational presentation.** Trust is relational, not absolute. There is no objective answer to "how trustworthy is this person" — only answers relative to the person asking. Layer 4 blends two data sources:

- **Public endorsements:** The viewer's "valued set" — people they follow, pay through the reading tab, pin as sources, or quote-post approvingly — is intersected with the set of public endorsers for the subject. This produces specific, attributable statements: "Of the 14 writers you follow and pay, 3 publicly endorse this person's integrity; 1 has recently withdrawn their endorsement."
- **Public-graph proximity:** Co-follows, shared readership, co-payment patterns on the public graph provide additional relational context: "This author is followed by 5 writers you also follow."

The anonymous attestation scores from Layers 2-3 are shown as global aggregates — the four dimension bars in the Trust panel. The relational layer adds the personalised context on top. The system is a lens, not a judge.

This formulation deliberately uses the viewer's *public* signals to compute relational views. Using the anonymous side would require the platform to correlate public and anonymous identities, which would collapse the dual-graph firewall. Public endorsements are the mechanism that bridges this gap: people who are willing to vouch publicly provide the relational data; people who need privacy vouch anonymously and their signal feeds the global scores.

### The trust graph as feed signal

To the extent that the reader wants algorithmic curation, the trust graph informs what the feed surfaces. Content from well-attested authors with strong trust profiles in the reader's region of the graph is naturally prioritised. Content from thin or contested identities is deprioritised but not hidden — the reader can always override and explore. The weight given to the trust graph in feed ranking is a user-controllable parameter: some readers will want heavy trust filtering, others will want to see everything and consult the trust profile manually when something catches their attention.

The trust graph does not replace editorial judgement or reader autonomy. It is a tool that makes the information environment more legible, and the reader decides how much to lean on it.

### Cold start and bootstrapping

New pseudonyms with no attestations, no payment history, and no writing history start with a blank trust profile.

The WRITER is useful on day one even with zero attestations — portable identity, paywall, payment all work without the trust graph. The READER is useful as soon as it can pull in feeds and show basic Layer 1 signals. The trust graph *improves* both tools as it fills in, but neither is gated on it. This is the correct dependency structure: neither half of the product waits for the graph to be dense.

The reading-tab model provides a natural cold-start signal: connecting a real payment method (whether fiat or crypto wallet) is itself a soft signal of humanity and commitment. Beyond that, the automatic signals (Layer 1) gradually build a baseline trust profile without requiring any social action. The attestation layer is additive — it enriches a profile that already has a foundation from platform activity.

At small scale, graph analysis (Layer 3) has limited power. The credibility-bracket dynamics require density to produce meaningful outputs; diversity weighting has nothing to work with in a small community; Sybil detection cannot distinguish a real cluster from a tight-knit group. The system should be transparent about this: trust annotations at small scale are thinner and less confident, and the READER should present them accordingly. As the user base grows past a threshold — likely in the range of several hundred to a few thousand active attestors — Layer 3 begins to produce genuinely informative outputs. This is accepted — public endorsements carry the relational data in the meantime.


## VII. The attestation mechanism: dual-graph anonymous vouching

### VII.1 The design problem

The trust graph requires people to make honest, private judgements about other people. Those judgements must feed into public reputation scores that the READER can display. The system must be designed so that the platform cannot be compelled to reveal who judged whom — not as a policy commitment, but as a structural impossibility.

The naive approach — a single graph where Alice attests to Bob, stored in a database — fails because any record linking Alice to Bob is seizable. Encrypting that record helps, but the platform holds the keys or can be compelled to produce them. The goal is an architecture where the information simply does not exist in recoverable form.

Several genres of solution were considered. Trusted execution enclaves (running the full graph computation inside hardware that excludes the platform operator) offer strong guarantees but introduce dependency on hardware manufacturers. Cryptographic approaches (homomorphic encryption, secure multi-party computation) offer the theoretically strongest position — the full picture is never assembled anywhere — but the graph analysis required (recursive weighting, Sybil detection, diversity scoring) pushes against the limits of what these techniques can currently do efficiently, making them a research problem rather than an engineering task. Ephemeral polling (assembling trust signals on demand and discarding them) eliminates stored state but sacrifices the persistent graph properties that make the system genuinely useful.

The chosen approach is structural separation: two graphs that never cross-reference at the individual level, connected only by encrypted channels and batched updates. Privacy comes not from hiding the graph or computing on encrypted data, but from severing the link between those who gossip and those who are gossiped about.

### VII.2 Two graphs, one system

The solution separates the trust graph into two structurally independent graphs.

**The public graph** has named nodes. Every all.haus user who participates in the trust system has a public node — their visible pseudonym, the identity they publish under, the identity the READER annotates. Public nodes carry reputation scores across the attestation dimensions. These scores are visible to everyone. The public graph is the product surface of the trust system. Public nodes are named because they must be: reputation is useless if it can't be attached to the person it describes. Public nodes also carry public endorsements — attributable, visible vouches that feed the relational layer (Layer 4).

**The private graph** has anonymous nodes. Every participating user also controls an anonymous node with its own Nostr keypair, unrelated to the user's public identity. The mapping between a person's public node and their anonymous node exists only on the person's own device. The platform does not hold it, has never held it, and cannot reconstruct it. Anonymous nodes submit attestations about public nodes. They are the witnesses. Their judgements flow into the system, are aggregated, and produce the reputation scores that appear on the public graph. But the witnesses themselves are never identified.

The two graphs are connected only by encrypted inbound channels (anonymous nodes submit attestations about named public nodes), batched outbound updates (the platform publishes revised reputation scores on the public graph at fixed intervals), and credibility feedback (the platform sends credibility adjustments back to anonymous nodes via their encrypted channels). No other communication crosses the boundary. The two graphs share no keys, no identifiers, no metadata that could bridge them.

### VII.3 Anonymous node key management

The anonymous attestation keypair **cannot be custodial.** The existing Nostr setup is custodial — key-custody holds the private key, indexed by `user_id`. That works because the platform is *supposed* to know which user owns which Nostr key; the whole publishing flow depends on it. The anonymous attestation key has the opposite requirement: the platform must *not* know which user owns it. If key-custody held both keys for the same `user_id`, a court order or server seizure would link them and the dual-graph firewall would collapse.

The anonymous key lives on the user's device:

- **Generation is automatic.** When the user opts into attestation, the client generates the keypair silently. One button: "Enable private attestation."
- **Storage is invisible until it isn't.** IndexedDB, encrypted at rest with a key derived from WebAuthn (if the device supports it) or a user-chosen passphrase.
- **The seed phrase is shown once.** A clear "write this down" moment, same UX pattern as a crypto wallet setup. If the user skips it, the key still works from that browser until they clear storage or lose the device.
- **Loss is handled gracefully.** Lose the key, start over as a new anonymous node at bracket 1. "Your previous attestation history is gone. Your new attestor identity starts fresh." No drama, no support ticket — this is accepted loss.

This is the same threat model as Nostr `nsec` keys and Bitcoin wallet seeds. The upside of genuine pseudonymity is that nobody, including the platform, can recover what you lose. A modest level of natural wastage is healthy for the graph, adding churn that further obscures long-horizon structural inference.

**The adoption reality:** Most users will never manage a separate seed phrase. Public endorsements (one click, no key management, attached to their public identity) are the escape valve. Anonymous attestation is for the committed minority who want the stronger privacy guarantee — journalists, people in adversarial contexts, people making negative attestations they don't want to be identified with. The system produces useful trust output even if anonymous participation is thin.

### VII.4 Anonymous node registration

Registration must prove "a payment-verified public identity stands behind this anonymous node" without revealing which one. This is a blind signature problem, solved with RSA blind signatures (RFC 9474).

**The flow:**

1. The user's client generates an anonymous Nostr keypair locally and stores it in IndexedDB.
2. The user authenticates normally (public identity) and requests a "registration voucher" from the gateway. The gateway checks they have a verified payment method.
3. The client generates a random nonce, blinds it using the platform's public RSA key, and sends the blinded value to the gateway.
4. The gateway signs the blinded value and returns it. It has now committed to "someone with a verified payment method requested a voucher" but cannot later link the unblinded result to this request.
5. The client unblinds the signature locally — now holds a valid platform signature on a nonce the platform has never seen in cleartext.
6. From a **separate connection** (no auth cookies, different session), the client presents to the **attestation intake service**: anonymous pubkey + unblinded nonce + platform signature.
7. The attestation service verifies the signature, hashes the nonce to prevent replay, registers the anonymous node, and discards the nonce.

**Timing correlation mitigation:** If Alice requests a voucher at 14:00 and an anonymous node registers at 14:01, that's a metadata leak. The client holds the voucher and registers during a batch window — the first week of each epoch, when many registrations happen simultaneously. The UX prompt for generating the attestor identity should coincide with an epoch boundary.

**Library support:** RSA blind signatures are standardized. The `blind-rsa-signatures` npm package handles the primitives. The Web Crypto API handles the RSA operations client-side. This is plumbing, not research.

### VII.5 How attestations flow

**Submission.** When the user wants to attest to someone, their client composes an attestation message (`subject: Bob's public key, dimension: "humanity", value: affirm, epoch: 2026-Q2`), encrypts it end-to-end (NIP-44) using the attestation service's Nostr pubkey, and submits it to the attestation intake service. The platform receives an encrypted attestation from anonymous key X, regarding public node Bob, on dimension humanity, for the current epoch. It knows what X thinks about Bob. It does not know who X is.

**Prompting.** The system does not rely solely on spontaneous attestation. At the beginning of each epoch (quarterly), the attestation service sends encrypted prompts to each anonymous node via NIP-44 DM, listing the public nodes this anonymous node has previously attested to and asking the user to reaffirm, revise, or remain silent. The user's client presents this as a simple check-in — a quick, reflective task, not a chore. The framing is confirmation rather than continual vigilance: *is Joe Bloggs still Joe Bloggs?* All prompts go out within a single 24-hour batch window with randomised per-message jitter, so the timing of any individual prompt is not informative.

**Spontaneous updates.** A user can submit a revised attestation at any time outside the regular prompt cycle — for instance, if they learn something that changes their view of someone's integrity. These submissions are held in a delay buffer and released into the intake queue on a randomised schedule within a 24–72 hour window, so that submission timing cannot be correlated with external events. The platform sees the buffered release time, not the original submission time.

**Aggregation.** At the end of each epoch, the platform runs the full aggregation job (see §VII.7). Between epochs, twice-weekly mopping-up rounds apply partial score updates when a threshold of out-of-cycle submissions has accumulated (see §VII.8).

**Publication.** Updated reputation scores are published to the public graph atomically — every public node's scores change at the same moment. There is no temporal correlation between an individual attestation submission and an individual score change.

### VII.6 Attestation dimensions

Attestations are multidimensional. The four dimensions:

- **Humanity.** "I believe this identity corresponds to a real human being." The most fundamental attestation. Once well-established, it should be hard to revoke — a ratchet property. If twenty people have vouched for someone's humanity over three years and five suddenly retract, the status should shift to "contested," not "revoked."
- **Encounter.** "I have interacted with this person in a way that goes beyond reading their public output." A stronger signal than pure graph proximity.
- **Identity.** "I believe this person is what they claim to be." This accommodates pseudonymous commitment: someone who presents as a doctor, a journalist, a fisherman, a fictional character with a consistent persona. The attestation is about consistency and sincerity, not about government identity.
- **Integrity.** "I believe this person acts in accordance with their own stated standards and with general good faith." The most subjective and the most valuable dimension. Also the most vulnerable to mob dynamics, and therefore the one that most needs the protective design features described below.

### VII.7 Credibility brackets and epoch aggregation

**Credibility brackets.** Each anonymous node accumulates a credibility score on the private side, quantised into four brackets: new (1), developing (2), established (3), veteran (4). Bracket placement is computed from a rolling 8-epoch (~2 year) sliding window using four inputs:

- **Consistency with consensus:** For each attestation this node has made, how does it compare with the eventual aggregate? Measured as fraction of attestations within 1 standard deviation of the consensus, over the rolling window.
- **Responsiveness:** Fraction of epoch prompts responded to within the prompt window.
- **Stability:** Fraction of attestations unchanged between consecutive epochs. Frequent oscillation is a negative signal.
- **Duration:** Epochs since registration, capped at the sliding window.

**Time-gated growth.** Bracket advancement is not purely performance-based. A newly registered anonymous node cannot reach bracket 4 (veteran) in its first 6 epochs (~18 months) regardless of accuracy. This prevents a well-resourced adversary from rushing cultivated Sybil attestors into high-weight positions.

**Privacy of bracket data.** Bracket-only retention: the platform retains the bracket placement and the small number of inputs needed to compute it, not the full attestation history. Metrics are computed at aggregation time and discarded; only the resulting bracket persists between epochs. The sliding window means data older than ~2 years is dropped. The bracket is shared by many anonymous nodes, not a unique fingerprint.

**Epoch aggregation.** The full aggregation runs quarterly. For each public node, for each dimension:

1. Collect all non-expired attestations.
2. For each attestation: weight = `bracket_weight[attestor.bracket]` (e.g., 1x / 1.5x / 2x / 3x) × `freshness` (decay factor) × `diversity_factor` (discounted if attestor is in a detected Sybil cluster).
3. Affirm attestations add to the score; contest attestations subtract at 0.5x weight.
4. Normalise to 0.0–1.0.
5. Apply the humanity ratchet: if dimension is humanity and previously established (12+ consecutive epochs above threshold), floor at 0.3 — status can move to "contested" but not to zero through silence alone.
6. Recompute credibility brackets for all anonymous nodes.
7. Publish updated scores to the public graph in a single atomic batch.

### VII.8 Mopping-up rounds

The full epoch aggregation is quarterly. Between epochs, a lighter partial aggregation runs **twice weekly** (Monday and Thursday, offset from feed scoring) to handle acute situations:

1. Count out-of-cycle submissions since the last aggregation (full or partial).
2. If the count is below a threshold (initially 5), skip — nothing to mop up.
3. If the threshold is met:
   a. Identify affected subjects (public nodes with new submissions).
   b. Recompute dimension scores for those subjects only.
   c. Use existing credibility brackets (do not recompute).
   d. Apply freshness decay only for affected attestations.
   e. Publish updated scores for affected subjects.

This means an acute integrity challenge surfaces within 3-4 days rather than 3 months, but only if enough independent attestors have submitted signals to cross the threshold. The threshold is a damper against coordinated rapid-fire attacks — a mob of new anonymous nodes submitting contest signals in the same week won't cross it if the Sybil discount reduces their effective count.

The ADR's 24-72h random delay buffer for out-of-cycle submissions means the mopping-up round sees submissions made 1-4 days before the round runs. Fast enough to be responsive, slow enough that submission timing can't be correlated with external events.

### VII.9 Decay and reaffirmation

Attestations are not permanent. Each attestation has a freshness value that starts at 1.0 when submitted or reaffirmed and decays by a fixed factor per epoch:

| Epochs since last reaffirmation | Freshness |
|---|---|
| 0 (current epoch) | 1.0 |
| 1 | 0.85 |
| 2 | 0.70 |
| 3 | 0.50 |
| 4 | 0.30 |
| 5 | 0.15 |
| 6+ | 0.0 (expired) |

With quarterly epochs, an attestation that has not been reaffirmed for roughly eighteen months effectively vanishes from the graph. The trust graph is a living picture of current opinion, not an archaeological record. Silence is a signal: non-response to a prompt is not neutral but mild negative information — "this person did not feel strongly enough to reaffirm" — which is meaningfully different from active reaffirmation.

**The humanity ratchet.** Once a public node's humanity score has exceeded a high threshold for 12 consecutive epochs (~3 years), the status shifts to "established." Established humanity does not decay to zero through silence alone — it can only move to "contested" if a significant fraction of historical attestors actively submit negative signals.

### VII.10 Periodic re-keying

Anonymous-node keypairs are designed to rotate. The credibility-bracket mechanism creates a persistent per-node record — a persistent identifier. Periodic rotation caps the window structurally.

The mechanism is opt-in with handoff: a user can, at any time (and is gently prompted roughly every two years), generate a new attestor keypair on-device, sign a handoff message with the old key authorising the new key, and submit the handoff to the platform. The platform retires the old key, registers the new one, and credits the new key with partial bracket inheritance — a veteran retires to an established inheritor, an established retires to developing, and so on. Full trajectory is not preserved; this is the point.

Rotation serves three purposes: it caps the fingerprinting horizon, it defeats long-horizon Sybil cultivation (an adversary who invests years building credibility loses that investment at each rotation), and it adds graph churn that obscures structural inference at small scale.

Rotation is not forced. A user who never rotates is never locked out. The UX nudge, not a hard requirement, is the right balance.

### VII.11 Sybil detection

Cluster analysis on the private graph, run at each full epoch aggregation:

**Temporal clustering.** Nodes registered in the same epoch window that attest to near-identical sets of subjects. Metric: Jaccard similarity of attestation target sets, flagged if >0.8 within a registration cohort.

**Behavioural correlation.** Nodes that submit attestations on correlated schedules (within the randomised buffer) or that systematically change positions in the same direction at the same time.

**Structural anomaly.** Small, dense subgraphs — a clique of nodes that all attest to the same subjects with the same values, with few connections outside the clique.

Detected clusters have their attestations weighted as a single signal rather than N independent signals. This is applied during aggregation, not as a permanent label — a cluster that disperses over time loses its penalty naturally.

At all.haus's likely scale for the next 1-2 years (hundreds to low thousands of users, maybe dozens of active attestors), the graph analysis has limited power. Sybil detection cannot distinguish a real cluster from a tight-knit friend group. This is accepted — the system is built for the architecture, and public endorsements carry the relational data in the meantime.

### VII.12 Protecting against abuse

**Sybil networks.** A bad actor who creates many anonymous nodes to inflate someone's reputation faces several obstacles: payment-backed registration (every fake attestor requires a fake public node with a real payment method — see §VII.4), time-gated credibility growth (cannot rush to high brackets), cluster detection on the private graph, and periodic re-keying that defeats long-horizon cultivation.

**Malicious denial.** Coordinated reputation damage is mitigated by diversity weighting (a bloc of nodes behaving identically is one signal, not twenty), tempo control (changes processed at epoch boundaries or mopping-up rounds, not in real time), longevity weighting (a long-standing attestor's change of position is much stronger than a recent one's), and the humanity ratchet.

**Mob dynamics.** When many people are sincerely but wrongly aligned against someone, the relational presentation layer (Layer 4) provides the primary defence. Each reader sees the attestation landscape filtered through their own trust network. A mob concentrated in one region of the public graph doesn't distort what a reader in a different region sees. The READER shows the shape of disagreement — "15 long-standing attestors vouch for integrity; 40 recent attestors have downgraded; the downgraders share similar attestation patterns" — and the reader interprets.

### VII.13 Protecting against the state

The architecture is designed so that the platform cannot comply with a demand to reveal who attested to whom, even under compulsion.

**What the platform holds.** The public graph: named nodes, reputation scores, public endorsements — all visible, no secrets. The private graph structure: anonymous node IDs, their credibility brackets, the set of public nodes each has attested to, the dimension and value of each attestation — this reveals that anonymous node X vouched for public node Bob, but not who X is. Encrypted channel keys: the platform can address messages to anonymous nodes via their Nostr keys, but does not know which person controls which key.

**What the platform does not hold.** The mapping between anonymous nodes and public identities — this exists only on individual users' devices. Cleartext attestation content in transit — submissions arrive NIP-44 encrypted; the platform decrypts them for processing but processes in memory and discards plaintext, retaining only aggregated results and anonymous-node-keyed records.

**What a seizure yields.** The public graph (already public); public endorsements (already public); a set of anonymous node IDs with credibility scores and attestation records (revealing that anonymous node X vouched for Bob, but not who X is); and encrypted message logs. An adversary who independently identifies an anonymous node's key (e.g., by seizing a user's device) can look up that node's full attestation history. But the platform itself cannot perform that identification, and bulk deanonymisation from the server alone is not possible.

**Batching as metadata defence.** All attestation prompts are sent within the same batch window. All reputation updates are published simultaneously. There is no temporal correlation between any individual's actions and any observable system output.

### VII.14 Public endorsements

Public endorsements are the simpler, lower-friction complement to anonymous attestations. They are attached to the endorser's public identity and are immediately visible.

**Mechanics:** A user clicks "Endorse" on another user's profile (or in the Trust panel) and selects one or more dimensions. The endorsement is stored as a simple record linking endorser, subject, and dimension. Withdrawing an endorsement is equally simple.

**Visibility:** Public endorsements are visible on the subject's trust profile. They are queryable by anyone. They feed directly into Layer 4's relational presentation.

**Relationship to anonymous attestations:** A user can make both a public endorsement and an anonymous attestation for the same person. The two are completely independent — the platform cannot correlate them. The public endorsement provides relational data for Layer 4; the anonymous attestation contributes to the global trust scores from Layers 2-3. Some users will do both; many will only do public endorsements; a few will only do anonymous attestations.


## VIII. The workspace

The workspace is the READER's primary interface: a configurable, panel-based reading environment whose state persists between sessions.

### VIII.1 Design philosophy

The workspace is a reading room, not a feed. The reader arranges it once and it stays arranged. The "intelligence" is persistence of state — the system remembers what you did, not what it thinks you are. There is no algorithmic personalisation, no behavioural inference, no model. You open a panel and it stays open. You close it and it stays closed. The workspace assumes the shape you give it and holds that shape faithfully between sessions.

Every configuration is a valid composition. When a panel closes, the remaining panels reflow to fill the space. The result never looks broken, partial, or like a grid with holes in it. Each arrangement — two panels, three, five — is a legitimate mode that the layout system was designed to produce.

The workspace is closer to VS Code than to Twitter: a tool you unpack and arrange, not a feed you scroll. The pleasure of using it should come from the quality of the space, not from the content's ability to capture your attention.

### VIII.2 Visual separation model

The workspace follows the established all.haus design principle: **no hairlines, no keylines, no 1px borders used as dividers.** Separation is achieved structurally, using white card rectangles on the `bg-grey-100` page background, with space between them. Where the existing design system uses `space-y-10` between sections and `bg-white px-6 py-5` for cards, the workspace applies the same logic at the panel level:

- **Panels** are `bg-white` card rectangles sitting on a `bg-grey-100` workspace floor. The gap between panels is the floor showing through — not a drawn line.
- **Items within panels** (feed items, source items, social posts) are separated by `space-y` gaps with the panel's white background visible, or by alternating card blocks. No `border-b` between items.
- **Sections within panels** (pinned sources vs. all sources, trust dimensions vs. Layer 1 stats) are separated by `space-y-6` or `space-y-8` gaps, with section headers providing structural rhythm. No horizontal rules.
- **The topbar** is a solid `bg-white` card with a `2px solid #111` bottom edge — this is the one thick slab rule in the design system, carried over from the existing site. It is a structural black rule, not a hairline.
- **The panel toggles bar** is a separate `bg-white` card below the topbar, separated from it by a `4px` gap of `bg-grey-100`. No border between them.
- **The status bar** is a `bg-grey-100` strip at the bottom — it is the floor itself, not a bordered element.

The visual rhythm comes from solid blocks of white on a quiet ground, not from drawn lines between things. This is the broadsheet principle: columns of type separated by gutters of white space, not by ruled lines.

### VIII.3 Structural overview

The workspace comprises a fixed shell (topbar, panel toggles, status bar) and a flexible interior (the panels). The shell is constant across all states. The interior reflows.

```
┌─────────────────────────────────────────────────────────────┐
│  TOPBAR  (bg-white, 2px black bottom rule)                  │
│  ∀ all.haus    [READ]  [WRITE]  [DASHBOARD]     🔍  [EK]   │
└─────────────────────────────────────────────────────────────┘
  4px gap (bg-grey-100 showing through)
┌─────────────────────────────────────────────────────────────┐
│  PANEL TOGGLES  (bg-white card)                             │
│  Panels: ○ Sources  ● Feed  ● Reading  ○ Trust             │
└─────────────────────────────────────────────────────────────┘
  4px gap (bg-grey-100 showing through)
┌──────┐ ┌───────────┐ ┌────────────────────┐ ┌──────────────┐
│      │ │           │ │                    │ │              │
│  S   │ │   FEED    │ │     READING        │ │    TRUST     │
│  O   │ │           │ │                    │ │              │
│  U   │ │  Item     │ │  Byline            │ │  Humanity    │
│  R   │ │           │ │  Headline          │ │  Encounter   │
│  C   │ │  Item     │ │  Body text...      │ │  Identity    │
│  E   │ │           │ │                    │ │  Integrity   │
│  S   │ │  Item ◄── │ │  ── gate ──        │ │              │
│      │ │           │ │                    │ │  Stats...    │
└──────┘ └───────────┘ └────────────────────┘ └──────────────┘
  ↑ 4px gaps between panel cards (bg-grey-100 gutters)

┌─────────────────────────────────────────────────────────────┐
│  STATUS BAR  (bg-grey-100 — the floor itself, not a card)   │
│  Your workspace. Toggle panels on and off. It stays how ... │
└─────────────────────────────────────────────────────────────┘
```

### VIII.4 The shell

#### Topbar

`bg-white` card, full-width. Bottom edge: `2px solid #111` (the single thick structural rule, consistent with the existing site header). Height: 48px. Padding: `0 20px`. Flexbox, `align-items: center`, `justify-content: space-between`.

**Left cluster:**

- Logo: `∀ all.haus`. The `∀` is `text-crimson font-bold`, the rest is `font-mono text-[13px] uppercase tracking-widest text-black font-semibold`. Gap between mark and wordmark: 2px (they read as one unit).
- Mode tabs: `font-mono text-[10px] uppercase tracking-widest`. Three tabs: READ, WRITE, DASHBOARD. Inactive: `text-grey-400 bg-transparent`. Hover: `text-black`. Active: `bg-black text-white px-[10px] py-[5px]`. Gap between tabs: 2px. Gap between logo and tabs: 16px.

**Right cluster:**

- Search input: `font-mono text-[10px] bg-grey-100 text-grey-400 px-[10px] py-[4px] w-[120px]`. No border, no border-radius. The grey-100 background is the only visual boundary.
- Avatar: 24×24px square, `bg-grey-200`, initials in `font-mono text-[9px] text-grey-400`, centred. No border-radius. Clicking opens the existing avatar dropdown menu.

#### Panel toggles bar

`bg-white` card, full-width. Separated from the topbar by a `4px` gap of `bg-grey-100`. No border on any edge. Height: 36px. Padding: `6px 20px`. Flexbox, `align-items: center`, `gap: 12px`.

**Label:** "Panels:" in `font-mono text-[9px] uppercase tracking-wide text-grey-300`.

**Each toggle button:** `font-mono text-[9px] uppercase tracking-wide`. Flexbox with `gap: 4px`, `align-items: center`. Contains:

- A state indicator: 6×6px square (no border-radius). When off: `bg-grey-200`. When on: `bg-black`.
- The panel name: When off: `text-grey-300`. When on: `text-black`. Hover (either state): `text-black`.

The four toggles, in order: **Sources**, **Feed**, **Reading**, **Trust**.

Default state on first visit: Feed ON, Reading ON, Sources OFF, Trust OFF. This default is overridden by any persisted state from a previous session. The instrument panels (Sources, Trust) are available but not imposed. A first-time reader sees the feed and the reading pane — the content itself — and can summon the instruments when they want them.

#### Status bar

The status bar is not a card — it is the `bg-grey-100` floor itself, with text laid on it. Full-width. Height: 36px. Padding: `10px 20px`. `font-mono text-[10px] text-grey-400 tracking-wide text-center`.

Content changes by mode:
- READ: "Your workspace. Toggle panels on and off. Close what you don't use. It stays how you left it."
- WRITE: "Writing mode. The workspace clears to the editor. Your panels return when you're done."
- DASHBOARD: "Dashboard. Articles, subscribers, earnings, analytics. The workspace remembers your reading layout."

The word "Your workspace" / "Writing mode" / "Dashboard" is `text-black`.

### VIII.5 The panels

#### General panel behaviour

The panel area sits between the panel toggles bar and the status bar. The container is `bg-grey-100` (the workspace floor). Panels are `bg-white` card rectangles sitting on this floor, separated by `4px` gutters where the floor shows through. The container uses flexbox (`display: flex`, `gap: 4px`).

Each panel has `overflow: hidden` and a transition: `all 0.35s ease`. Panels have a **panel header** at the top — `font-mono text-[10px] uppercase tracking-widest text-grey-400 px-4 pt-3.5 pb-2.5` — followed by scrollable content.

**Collapsing:** When toggled off, a panel transitions to `flex: 0 0 0px`, `padding: 0`, `opacity: 0`, `pointer-events: none`. The remaining panels absorb the freed space via their flex properties. The gutter disappears naturally (flex gap only renders between visible items). The transition (0.35s ease) ensures the reflow is smooth.

**Minimum panel area height:** 520px. On taller viewports, the panel area fills the available space below the shell (`calc(100vh - topbar - toggles - status)`).

#### Panel sizing

| Panel    | Flex declaration     | Behaviour                                 |
|----------|---------------------|-------------------------------------------|
| Sources  | `flex: 0 0 200px`   | Fixed width. Collapses to 0 when off.     |
| Feed     | `flex: 1 1 280px; min-width: 220px` | Grows to fill.          |
| Reading  | `flex: 1 1 360px; min-width: 300px` | Grows to fill.          |
| Trust    | `flex: 0 0 200px`   | Fixed width. Collapses to 0 when off.     |

When only Feed and Reading are open (the default), they split roughly 40/60. When all four are open, the fixed panels occupy 400px and the remaining space splits between Feed and Reading.

### VIII.6 Panel specifications

#### Sources panel

The reader's subscription list, organised by protocol origin. Replaces the current Following/For You toggle.

**Panel header:** "SOURCES"

**Section headers:** `font-mono text-[9px] uppercase tracking-wide text-grey-300 px-[16px] pt-[14px] pb-[4px]`. No rule above or below.

**Source items:** `px-[16px] py-[8px]`, flexbox, `align-items: center`, `gap: 8px`. Hover: `bg-grey-100`. Contains:

- Protocol indicator: 8×8px square (no border-radius). Colour by protocol:
  - Nostr: `bg-crimson` (#c41230)
  - Bluesky: `bg-[#0085ff]`
  - Mastodon: `bg-[#6364ff]`
  - RSS: `bg-[#ee802f]`
- Source name: `font-sans text-[12px] text-black`. Truncated with ellipsis.
- Unread count: `font-mono text-[9px] text-grey-300`, pushed right via `margin-left: auto`.

**Sections:** (1) **Pinned** — explicitly pinned, manually ordered (drag-to-reorder, persisted). (2) **All sources** — alphabetical, unread items sort above read.

**Interaction:** Clicking a source filters the Feed panel to that source. Active source gets `bg-grey-100`. Click again to clear. Right-click (desktop) or long-press (mobile) opens context menu: Pin/Unpin, Mute, Unsubscribe.

**Adding sources:** A `+` in `font-mono text-[11px] text-grey-300 hover:text-black` in the panel header, right-aligned. Opens a minimal modal: single text input (placeholder: "Paste a feed URL, Nostr npub, or @handle..."), cancel link, confirm button. Auto-detects protocol from input format (omnivorous input via the universal resolver).

**Empty state:** "No sources yet." in `text-ui-sm text-grey-400 text-center py-[20px]`, with "Add a source" action link.

#### Feed panel

The headline scan. A dense, vertical list of items ordered reverse-chronologically.

**Panel header:** "FEED"

**Feed items:** Each item is a rectangular block: `px-[16px] py-[10px]`, stacked with `space-y-[2px]` between them. Hover: `bg-grey-100`. Transition: `background 0.1s`.

**Active item** (currently in Reading panel): `bg-grey-100` with a `4px` solid crimson left edge. Implementation: `border-left: 4px solid crimson` with `pl-[12px]` to keep text alignment consistent.

**Item structure:**

```
┌─────────────────────────────────────────┐
│ ● ANDREW HOLGATE · 14 APR        mono  │
│ The Dictator's Library              ser │
│ On the shelves of the powerful...  sans │
└─────────────────────────────────────────┘
```

- **Meta line:** Flexbox, `align-items: center`, `gap: 6px`.
  - Trust pip: 5px diameter circle (`border-radius: 50%`). See §VIII.8 for full specification.
  - Source name: `font-mono text-[9px] uppercase tracking-wide text-grey-400`
  - Separator: `·` in `text-grey-400`
  - Date: `font-mono text-[9px] uppercase text-grey-400`. Format: "14 APR". Today: "TODAY". Yesterday: "YESTERDAY".

- **Headline:** `font-serif text-[14px] text-black italic leading-[1.3]`.

- **Standfirst** (optional — longform articles only): `font-sans text-[11px] text-grey-400 leading-[1.35] mt-[3px]`. Truncated to 120 characters.

**Content type differentiation:**

- **Native all.haus articles:** Full treatment (headline + standfirst + trust pip). Crimson left edge when active.
- **External articles (RSS, linked from Bluesky/Mastodon):** Same treatment. Trust pip is grey unless source has identity metadata.
- **Social posts (Bluesky, Mastodon, Nostr notes):** No headline/standfirst distinction. Post text replaces headline in `font-sans text-[12px] text-black` (platform voice, not writer's voice). Truncated to 200 characters.

**Feed ordering:** Reverse chronological. No algorithmic ranking at launch. Trust-graph-informed ordering is a future opt-in feature.

**Feed filtering:** A filter row below the panel header with three pills — ALL, ARTICLES, SOCIAL. Uses `.label-ui` + `.toggle-chip-active` / `.toggle-chip-inactive`. Selection persists with workspace state. This replaces what earlier drafts described as a separate Social panel.

**Scroll behaviour:** Intersection observer for infinite scroll. New items arriving while scrolled down show a "3 new items" indicator at the top.

**Empty state:** "Your feed is empty." with "Add some sources" link focusing the Sources panel's add-source input.

#### Reading panel

The article itself. The existing reading experience transplanted into a panel.

**Panel header:** "READING"

**Content area:** `padding: 24px 20px`. Overflow-y: auto.

**Byline:** `font-mono text-[10px] uppercase tracking-wide text-grey-400 mb-[8px]`. Format: "ANDREW HOLGATE · 14 APR 2026 · 12 MIN".

**Headline:** `font-serif text-[22px] font-normal text-black leading-[1.25] mb-[12px]`.

**Body text:** `font-serif text-[14px] text-grey-600 leading-[1.7] mb-[12px]`. All existing TipTap/remark/rehype rendering applies.

**Paywall gate:** Existing draggable gate. `2px dashed crimson` horizontal rule with gradient fade above. Gate label: `font-mono text-[9px] uppercase tracking-widest text-crimson text-center`.

**Reading external content:** Server-side readability extraction. The gateway fetches the article URL, runs a readability library (Mozilla Readability or `postlight/mercury-parser`), sanitises the HTML, caches with a short TTL, and serves through the same rendering pipeline as native articles.

Safeguards: prominent link-out to the original, respect for `noindex` and robots meta hints, short cache TTL, clear attribution, no substitution in search. For paywalled sites (NYT, FT, Atlantic, WSJ), JS-rendered-only sites, and sites on an exclusion list, no extraction is attempted. Instead:

```
┌──────────────────────────────────────────┐
│  BYLINE · DATE                           │
│  Headline                                │
│  First paragraph (from RSS description)  │
│                                          │
│  This article is hosted externally.      │
│  Open on [source domain] →               │
│                                          │
│  Trust annotations still apply. ──►      │
└──────────────────────────────────────────┘
```

**Social post rendering:** Full post with thread context. Centred at `max-w-article` (640px) with reply thread below.

**Empty state:** Centred vertically and horizontally. `font-serif text-[16px] text-grey-300 italic`. "Select something to read."

#### Trust panel

The instrument panel. Shows the attestation landscape for the author of whatever is in the Reading panel.

**Panel header:** "TRUST"

**Trust dimensions:** The four dimensions stacked with `space-y-[4px]`. Each dimension: `px-[14px] py-[10px]`.

```
┌──────────────────────────┐
│  HUMANITY           mono │
│  ████████████░░  4px bar │
│  18 attestors, est. 3 yr │
└──────────────────────────┘
  4px gap
┌──────────────────────────┐
│  ENCOUNTER          mono │
│  ████████████░  4px bar  │
│  12 have interacted      │
└──────────────────────────┘
```

- Dimension label: `font-mono text-[9px] uppercase tracking-wide text-grey-400 mb-[6px]`.
- Bar track: `h-[4px] bg-grey-200`. No border-radius.
- Bar fill: `h-[4px]`. No border-radius. Colour by strength:
  - Strong (>70%): `bg-[#1d9e75]` (green)
  - Moderate (30–70%): `bg-[#ef9f27]` (amber)
  - Thin (<30%): `bg-grey-300`
  - Contested (active downgrades): `bg-[#ef9f27]` with `2px` stripe of `bg-[#c41230]` at right end.
- Gloss: `font-sans text-[11px] text-grey-400 leading-[1.4]`. Natural language. Examples: "18 attestors, est. 3 yr", "Mixed — 2 recent downgrades".

Dimensions in order: **Humanity**, **Encounter**, **Identity**, **Integrity**.

**Layer 1 automatic signals:** Below dimensions, separated by `space-y-[8px]`. A `bg-grey-100` recessed card: `px-[12px] py-[10px] mx-[14px]`. Each stat is a row: flexbox, `justify-content: space-between`, `py-[4px]`.

- Label: `font-mono text-[11px] text-black`.
- Value: `font-mono text-[11px] text-grey-600`.

Stats: Active since, Paying readers, Published (article count), Payment verification status, NIP-05 (if verified).

**Relational layer (Layer 4):** Below stats, `px-[14px] py-[10px]`.

- Section label: "YOUR NETWORK SAYS" in `font-mono text-[9px] uppercase tracking-wide text-grey-400 mb-[6px]`.
- Content: `font-sans text-[11px] text-grey-400 leading-[1.4] italic`. Generated from public endorsement data intersected with the viewer's valued set. Examples:
  - "Strong vouches from 3 people whose work you follow and pay. No flags."
  - "No one in your network has publicly endorsed this person."
  - "1 person you follow has recently withdrawn their integrity endorsement."

**Trust for external content:** For RSS with no identity metadata: "NO TRUST DATA AVAILABLE" followed by "This is an RSS item with no identity metadata." For Bluesky/Mastodon: Layer 1 only (account age, posting frequency, follower count). Attestation dimensions blank. Display: "Layer 1 only — no attestation data."

**Empty state:** "Select an article to see trust data."

### VIII.7 State persistence

#### What is persisted

Workspace state is stored in `localStorage` under `allhaus:workspace`. **This is device-local persistence.** V1 is honestly per-device; cross-device sync is future work requiring a server-side state store.

```typescript
interface WorkspaceState {
  panels: {
    sources: boolean;
    feed: boolean;
    reading: boolean;
    trust: boolean;
  };
  mode: 'read' | 'write' | 'dashboard';
  feedFilter: 'all' | 'articles' | 'social';
  feedSourceId: string | null;
  sourcesPinned: string[];
  feedScrollPosition: number;
  lastReadItemId: string | null;
}
```

#### When state is saved

On every panel toggle, mode switch, source pin/unpin, and article selection. Debounced write (200ms).

#### When state is restored

On page load (after authentication):
1. Panel open/closed states (before first paint — apply during SSR or blocking `<script>` to avoid flash).
2. Mode tab.
3. Source pin order.
4. Last-read item (if it still exists in feed data).
5. Feed scroll position (approximate, after feed data loads).

#### First visit

Feed ON, Reading ON, Sources OFF, Trust OFF. Mode: READ.

#### Clearing state

Account settings → Preferences → "Reset workspace layout" (text-link action). Confirm dialog → `localStorage.removeItem('allhaus:workspace')` and reload.

### VIII.8 Trust pip specification

The trust pip is the compressed legibility indicator on every feed item.

**What the pip is (and is not).** The pip is **not a trust score.** It is a **legibility indicator**: it tells you *how much the system knows about this author.* Green means well-known to the platform. Grey means no identity metadata. This is an honest signal: "unknown" is neutral, not a judgement.

**Visual:** 5px diameter circle, `border-radius: 50%`. Solid fill, no border, no shadow. The trust pip is the only circular element in the design system — everything else is square. The circle reads as a datum, not as a UI element.

**Colour logic (Layer 1 only):**

1. **Known (green, `#1d9e75`):** Account active >1 year, >50 paying readers, payment verified, NIP-05 verified.
2. **Partial (amber, `#ef9f27`):** Account active 3–12 months, some payment/subscription history, or Bluesky/Mastodon account with inferred activity signals.
3. **Unknown (grey, `#b0b0ab`):** No or minimal Layer 1 signals. Default for RSS with no identity metadata, new accounts.

Thresholds are deliberately coarse — three states. The fine-grained landscape lives in the Trust panel.

### VIII.9 Mode behaviour

**READ mode:** The full workspace. All four panels available.

**WRITE mode:** The workspace clears to the TipTap editor, filling the panel area as a single `bg-white` card. Panel toggles hidden (toggle bar shows "WRITING" in `font-mono text-[9px] text-grey-400`). Editor uses existing `max-w-article` (640px) centred layout. Clicking READ returns to persisted panel state. WRITE mode does not persist between sessions.

**DASHBOARD mode:** The workspace clears to the existing dashboard layout at `max-w-content` (960px), centred, as a single `bg-white` card. Panel toggles hidden. Clicking READ returns to persisted state.

### VIII.10 Responsive behaviour

**Desktop (≥1024px).** Full workspace. Below 1200px with all four panels open, the flex system compresses Feed and Reading. Below 1024px, if minimum widths exceed viewport, Trust auto-collapses.

**Tablet (768px–1023px).** Sources and Trust become overlays that slide from edges when toggled (240px and 220px respectively, `shadow-lg`). Feed and Reading share full width. `bg-black/20` scrim covers obscured content.

**Mobile (<768px).** Panels become full-screen views. Panel toggle bar replaced by bottom tab bar (four icons). Active panel fills screen. Swipe left/right between adjacent panels. Bottom tab bar: `bg-white` card with `4px` gap above, 24×24px icons (`stroke-grey-400` inactive, `stroke-black` active, `2px` black top edge on active tab). Mobile defaults to Feed as landing panel.

### VIII.11 Navigation and routing

**URL structure:** Single-page at `/` (authenticated). Panel state in `localStorage`, not URL. Reading content reflected in URL:

- `/` — workspace, Reading empty or last-read item.
- `/read/[article-slug]` — workspace with article in Reading panel.
- `/read/[article-slug]` unauthenticated — standalone article page (not workspace).

**Internal navigation:** Feed item clicks update Reading panel client-side, `pushState` to `/read/[slug]`. Back button returns to previous article.

Mode switches: `/` (READ), `/write` (optionally `/write/[draft-id]`), `/dashboard` (optionally `?tab=articles`).

### VIII.12 Interaction patterns

**Feed → Reading handoff:**
1. Feed item receives active state (crimson left edge, `bg-grey-100`).
2. Reading panel crossfades (current content fades to `opacity: 0` over 150ms, new content fades in over 150ms).
3. Trust panel updates with same crossfade timing.
4. URL updates via `pushState`.
5. Workspace state saves (debounced).

**Panel reflow:**
1. Toggle indicator updates immediately.
2. Panel transitions over 350ms: `flex-basis` animates, `opacity` animates.
3. Neighbours grow/shrink via flex. Gutters adjust naturally.
4. State saves.

Content within remaining panels does not visibly reflow during transition.

**Keyboard shortcuts (desktop only):**

| Shortcut | Action |
|----------|--------|
| `1`–`4` | Toggle panels (Sources, Feed, Reading, Trust) |
| `j` / `k` | Next / previous feed item |
| `Enter` | Open selected item in Reading |
| `Escape` | Clear Reading panel |
| `r` | READ mode |
| `w` | WRITE mode |
| `d` | DASHBOARD mode |
| `?` | Show/hide shortcut overlay |

Shortcut overlay: `bg-white` card, 280px, `fixed` bottom-right, `shadow-lg`. Dismiss with `?` or `Escape`.

### VIII.13 Design system additions

**New Tailwind tokens:**

```javascript
{
  extend: {
    maxWidth: { 'workspace': '100%' },
    transitionDuration: { '350': '350ms' },
    gap: { 'gutter': '4px' },
  }
}
```

**New component classes:**

```css
.workspace-floor { @apply bg-grey-100 min-h-screen; }

.panel { @apply bg-white overflow-hidden flex flex-col transition-all duration-350 ease-out; }
.panel.collapsed { flex: 0 0 0px !important; padding: 0 !important; opacity: 0; pointer-events: none; }
.panel-header { @apply font-mono text-[10px] uppercase tracking-widest text-grey-400 px-4 pt-3.5 pb-2.5 flex-shrink-0; }

.trust-pip { @apply inline-block w-[5px] h-[5px] rounded-full flex-shrink-0; }
.trust-pip-strong { background: #1d9e75; }
.trust-pip-moderate { background: #ef9f27; }
.trust-pip-thin { @apply bg-grey-300; }

.panel-toggle { @apply font-mono text-[9px] uppercase tracking-wide cursor-pointer bg-transparent border-none flex items-center gap-1; }
.panel-toggle .indicator { @apply w-[6px] h-[6px] bg-grey-200 transition-all duration-150; }
.panel-toggle.on .indicator { @apply bg-black; }
.panel-toggle.on { @apply text-black; }
.panel-toggle:not(.on) { @apply text-grey-300; }

.feed-item { @apply px-4 py-2.5 cursor-pointer transition-colors duration-100; }
.feed-item:hover { @apply bg-grey-100; }
.feed-item.active { @apply bg-grey-100 border-l-4 border-l-crimson pl-3; }

.source-item { @apply px-4 py-2 flex items-center gap-2 cursor-pointer transition-colors duration-100; }
.source-item:hover { @apply bg-grey-100; }

.trust-layer1 { @apply bg-grey-100 px-3 py-2.5 mx-3.5; }
```

**What the workspace does NOT use:** No `border-b` between list items. No `border-t` as separators. No `1px solid grey-200` rules. No `<hr>` (except the paywall gate). No hairlines of any weight as dividers. Separation is always structural.


## IX. Implementation architecture

### IX.1 What already exists

| Component | Status | Role in this system |
|---|---|---|
| Nostr keypair infrastructure | Built | Basis for public identities |
| NIP-44 encrypted DMs | Built | Encrypted channel between platform and anonymous nodes |
| Nostr relay infrastructure | Built | Transport for attestation prompts and submissions |
| Reading-tab payment system | Built | Layer 1 trust signal; Sybil resistance for registration |
| User identity and profile system | Built | Public graph node identity |
| Feed-ingest service (Graphile Worker) | Built | Aggregation layer; cron job infrastructure |
| Content-tier system | Built | Distinguishes native, federated, bridged content |
| Key-custody service | Built | Custodial Nostr keys (public identity only — NOT for anonymous keys) |

### IX.2 New service: attestation-service

A new backend service in the monorepo, following the same pattern as key-custody and feed-ingest.

```
attestation-service/        (port 3005)
├── Dockerfile
├── package.json
├── tsconfig.json           (extends tsconfig.base.json)
├── src/
│   ├── index.ts            # Fastify, NO auth middleware from shared/
│   ├── routes/
│   │   ├── register.ts     # anonymous node registration (verify blind sig)
│   │   └── submit.ts       # attestation submission (NIP-44 decrypt + store)
│   ├── tasks/
│   │   ├── epoch-prompt.ts       # quarterly: send prompts to all anonymous nodes
│   │   ├── epoch-aggregate.ts    # quarterly: full aggregation + bracket recompute
│   │   ├── mop-up.ts             # twice weekly: partial aggregation if threshold met
│   │   └── decay.ts              # apply freshness decay
│   ├── lib/
│   │   ├── nip44.ts        # decrypt incoming attestations
│   │   ├── blind-sig.ts    # verify blind signatures (RFC 9474)
│   │   ├── aggregation.ts  # score computation logic
│   │   ├── sybil.ts        # cluster detection on private graph
│   │   └── brackets.ts     # credibility bracket computation
│   └── db/
│       └── private-graph.ts  # queries against private_graph schema
└── migrations/
    ├── 001_anonymous_nodes.sql
    ├── 002_attestations.sql
    └── 003_registration_tokens.sql
```

**Isolation:**
- Own Docker container on a separate Docker network that can reach Postgres but not the gateway or other services.
- Own PostgreSQL user with `GRANT USAGE ON SCHEMA private_graph` only; no access to `public` schema.
- No imports from `shared/src/middleware/auth.ts` — the service has no concept of authenticated sessions.
- Own Nostr keypair for NIP-44 message handling.
- In production: `attest.all.haus` subdomain, own Nginx upstream, own TLS termination, own log stream.
- **Logging discipline:** No IP addresses, no timestamps at sub-hour granularity, no request metadata that could correlate with gateway access logs.

**The aggregation seam:** The epoch aggregation job needs to read the private graph (attestations, brackets) and write to the public graph (`trust_profiles` in the main database). This is the one place where the two worlds touch. The join key is `subject_pubkey` (the public Nostr key of the person being attested), which is public information. The attestor's identity never crosses the boundary. Implementation: a second DB connection from the attestation service with a narrowly-scoped user that can `SELECT` from `private_graph.*` and `INSERT/UPDATE` on `public.trust_profiles` only.

### IX.3 Database schema

#### Private graph (isolated schema: `private_graph`)

```sql
CREATE SCHEMA private_graph;

CREATE TABLE private_graph.anonymous_nodes (
    pubkey            text PRIMARY KEY,
    bracket           smallint NOT NULL DEFAULT 1,  -- 1=new, 2=developing, 3=established, 4=veteran
    registered_epoch  text NOT NULL,                -- e.g. '2026-Q2'
    last_active_epoch text,
    epochs_active     smallint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private_graph.attestations (
    attestor_pubkey text NOT NULL REFERENCES private_graph.anonymous_nodes(pubkey),
    subject_pubkey  text NOT NULL,     -- public Nostr key of the person being attested
    dimension       text NOT NULL,     -- 'humanity', 'encounter', 'identity', 'integrity'
    value           text NOT NULL,     -- 'affirm', 'contest', 'revoke'
    epoch           text NOT NULL,     -- epoch of last submission/reaffirmation
    freshness       numeric NOT NULL DEFAULT 1.0,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (attestor_pubkey, subject_pubkey, dimension)
);

CREATE INDEX idx_attestations_subject ON private_graph.attestations(subject_pubkey);
CREATE INDEX idx_attestations_epoch ON private_graph.attestations(epoch);

CREATE TABLE private_graph.registration_tokens (
    token_hash text PRIMARY KEY,
    used_at    timestamptz
);

-- Out-of-cycle submissions held in delay buffer
CREATE TABLE private_graph.submission_buffer (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attestor_pubkey text NOT NULL,
    subject_pubkey  text NOT NULL,
    dimension       text NOT NULL,
    value           text NOT NULL,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    release_at      timestamptz NOT NULL,  -- randomised 24-72h after submitted_at
    released        boolean NOT NULL DEFAULT false
);
```

#### Public graph (main database)

```sql
-- Trust scores published by epoch aggregation
CREATE TABLE trust_profiles (
    user_id           uuid NOT NULL REFERENCES users(id),
    dimension         text NOT NULL,      -- 'humanity', 'encounter', 'identity', 'integrity'
    score             numeric NOT NULL,   -- 0.0 to 1.0
    attestation_count integer NOT NULL DEFAULT 0,
    epoch             text NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, dimension)
);

-- Layer 1 signals computed from existing data
CREATE TABLE trust_layer1 (
    user_id              uuid PRIMARY KEY REFERENCES users(id),
    account_age_days     integer NOT NULL DEFAULT 0,
    paying_reader_count  integer NOT NULL DEFAULT 0,
    article_count        integer NOT NULL DEFAULT 0,
    payment_verified     boolean NOT NULL DEFAULT false,
    nip05_verified       boolean NOT NULL DEFAULT false,
    pip_status           text NOT NULL DEFAULT 'unknown',  -- 'known', 'partial', 'unknown'
    computed_at          timestamptz NOT NULL DEFAULT now()
);

-- Public endorsements (Layer 4 relational data)
CREATE TABLE public_endorsements (
    endorser_id uuid NOT NULL REFERENCES users(id),
    subject_id  uuid NOT NULL REFERENCES users(id),
    dimension   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (endorser_id, subject_id, dimension)
);

CREATE INDEX idx_endorsements_subject ON public_endorsements(subject_id);
```

#### Gateway additions for blind signature vouchers

```sql
-- Tracks voucher issuance (NOT linked to anonymous nodes)
CREATE TABLE registration_vouchers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id),
    issued_at  timestamptz NOT NULL DEFAULT now(),
    -- No link to which anonymous node used this voucher.
    -- One voucher per user. Re-requesting replaces the existing one.
    UNIQUE (user_id)
);
```

### IX.4 Gateway additions

**Blind signature endpoint:** `POST /api/v1/trust/voucher` — authenticated. Checks payment verification, issues blind signature. Returns the signed blinded value. Rate-limited to one per epoch per user.

**Public endorsement endpoints:**
- `POST /api/v1/endorsements` — endorse a user (endorser from auth, subject + dimension in body).
- `DELETE /api/v1/endorsements/:subjectId/:dimension` — withdraw endorsement.
- `GET /api/v1/endorsements/:userId` — list endorsements for a user (both given and received).
- `GET /api/v1/trust/:userId` — full trust profile: Layer 1 signals, trust_profiles scores, public endorsements, and Layer 4 relational data (endorsements filtered by viewer's valued set).

**Layer 1 computation:** A Graphile Worker cron job (daily, in feed-ingest alongside existing cron jobs) recomputes `trust_layer1` for all users from existing tables: `users` (account age), `subscriptions`/`reading_tab_payments` (paying reader count), `articles` (article count), `stripe_accounts` or equivalent (payment verification), `nip05_verifications` (NIP-05 status). Computes `pip_status` from the thresholds defined in §VIII.8.

### IX.5 Client-side components

**Anonymous key management module** (`web/src/lib/attestation-keys.ts`):
- Generate keypair (secp256k1, Nostr-compatible)
- Store in IndexedDB, encrypted at rest
- BIP-39 mnemonic generation and display
- Restore from mnemonic
- Blind signature request flow (authenticate → get blinded sig → unblind → register anonymously)

**Attestation UI** (new section, accessible from settings or Trust panel):
- Prompt display: list of people the user has previously attested to, with affirm/contest/revoke/silent per dimension
- New attestation: select a user, choose dimensions
- All submission goes through NIP-44 encryption to the attestation service
- Only renders if anonymous key is present in IndexedDB

**Public endorsement UI** (integrated into Trust panel and user profiles):
- "Endorse" button on Trust panel when viewing another user
- Dimension selector (humanity, encounter, identity, integrity)
- One-click, no key management required

### IX.6 Existing systems and standards

**Nostr-native:**
- **NIP-58 Badges.** On-protocol format for attestations. All.haus becomes a badge issuer for each dimension and for automatic signals. Badges are Nostr events, stored on relays, portable, verifiable.
- **Nostr Web of Trust.** The follow graph as rudimentary trust layer. WoT extension with graph-distance scoring. All.haus integrates rather than building in parallel.
- **NIP-44 encryption.** Transport layer for all communication between platform and anonymous nodes.

**W3C standards:**
- **Verifiable Credentials v2.0** (W3C Recommendation, May 2025). Standard format for privacy-respecting, machine-verifiable claims. Supports selective disclosure.
- **Decentralised Identifiers (DIDs) v1.1** (Candidate Recommendation, March 2026). A `did:nostr` method mapping Nostr pubkeys to DIDs lets all.haus identities interoperate with the broader VC ecosystem.
- **eIDAS 2.0.** EU digital identity wallets required by end of 2026. Designing with VCs in mind ensures interoperability.

**Proof of personhood:**
- **Gitcoin Passport / Human Passport.** Credential aggregation from multiple weak signals.
- **BrightID.** Social-graph Sybil detection via connection patterns.
- **Keyoxide / Ariadne Spec.** Decentralised identity proofs with cryptographic key as root.

**From outside the identity space:**
- **Elo / PageRank.** Attestation value depends on attestor standing. Approximated by credibility brackets.
- **Collaborative filtering.** Trust is relational. Attestations from people whose judgement the viewer shares are more salient.
- **Score opacity.** The trust calculus is opaque in mechanics but transparent in inputs.
- **Decay functions.** Stale attestations lose weight. Active, reaffirmed attestations carry full weight.


## X. Implementation phasing

Each phase ships independently and produces user-visible value.

### Phase 1: Layer 1 enrichment

Compute trust signals from existing tables. Surface via trust pips in the feed and Layer 1 stats in the Trust panel. This is the foundation everything else builds on. **Requires:** `trust_layer1` table, daily cron job, pip rendering in feed items, Trust panel Layer 1 section.

### Phase 2: Public endorsements

Simple CRUD — endorse/withdraw, visible on profiles and in the Trust panel. No cryptography, no anonymous nodes, no epochs. Immediately gives Layer 4 relational data. **Requires:** `public_endorsements` table, gateway endpoints, endorsement UI in Trust panel, "YOUR NETWORK SAYS" section.

### Phase 3: Workspace shell and panels

Build the topbar, toggle bar, status bar, and four-panel flex layout with open/close transitions. Port existing feed rendering into Feed panel. Port existing article page into Reading panel. Build Sources panel from existing subscription data. Build Trust panel structure (Layer 1 + public endorsements from Phases 1-2). Implement state persistence. **Requires:** Major frontend work — this is the largest single phase.

### Phase 4: Anonymous node infrastructure

Stand up the attestation service (isolated). Implement blind signature registration, NIP-44 submission flow, client-side key generation and storage. Ship the intake pipeline without the aggregation engine — attestations accumulate but don't produce scores yet. **Validates:** UX of the attestation check-in, adoption rate of anonymous key generation, operational burden of the isolated service.

### Phase 5: Epoch aggregation

The batch job that turns raw attestations into dimension scores. Credibility brackets (starting with two or three brackets, expanding to four once there's data). Freshness decay. Mopping-up rounds. Publish to `trust_profiles`. Trust panel now shows both public endorsement data (Layer 4) and anonymous attestation aggregates (Layers 2-3).

### Phase 6: Graph analysis hardening

Sybil detection, diversity weighting, cluster discounting. Full four-bracket credibility system. Humanity ratchet. This is where scoring gets sophisticated. By this point there is real data to tune against.

### Phase 7: Responsive workspace

Tablet overlay mode. Mobile full-screen-with-tabs mode. Bottom tab bar. Swipe navigation. Touch interactions. Mobile trust compression (pip as primary signal, Trust panel one swipe away).

### Phase 8: External content rendering

Server-side readability extraction via the gateway. Exclusion list management. Cache strategy. This is a parallel track that can begin alongside any phase after Phase 3.


## XI. What this design trades away

**Full recursive trust weighting.** In a single-graph system, PageRank runs directly: an attestation is worth more if the attestor is well-attested, recursively. The dual-graph system approximates this with credibility brackets, which capture track-record quality but not social standing. A highly respected public figure and an unknown newcomer who both happen to be accurate gossippers will end up in the same bracket. This is a real loss of information, but it is the cost of not bridging the two graphs.

**Relational anonymous attestation data.** Layer 4's relational presentation uses public endorsements and public-graph proximity, not anonymous attestation data. The system cannot tell a reader "3 people you trust have anonymously attested to this person's integrity" without breaking the dual-graph firewall. Public endorsements are the pragmatic bridge — people willing to vouch publicly provide the relational signal; people who need privacy contribute to global scores only. This means Layer 4 is only as rich as the public endorsement data allows.

**Public verifiability of weighting.** The private graph's structure is held by the platform, and aggregation runs server-side. Users must trust the published methodology matches the computation. This can be mitigated by publishing the aggregation code and allowing audits, but it cannot be fully eliminated without exposing the private graph.

**Structural inference risk at small scale.** When the network is small, the private graph's structure may be partially inferable. If only three anonymous nodes have attested to both Bob and Carol, and an adversary knows Alice is the only person who knows both, the anonymity set shrinks. This risk diminishes with density.

**Continuous credibility trajectory.** Periodic re-keying discards continuous behavioural history in exchange for fingerprint hygiene. The bracket handoff softens the loss but does not eliminate it.

**Attestation history as accepted loss.** Losing a device and the seed phrase means losing anonymous attestation history. The system does not engineer around this. Recoverability would require server-side custody, breaking the threat model.

**Cross-device workspace state in v1.** The workspace stores state in `localStorage`, which is device-local. The READER vision of unified cross-device state is future work requiring a server-side state store.


## XII. Open questions

1. **Credibility bracket thresholds.** How many brackets (starting with fewer and expanding), and what track-record metrics determine placement? Needs empirical tuning once real attestation data exists.

2. **Noise injection.** Whether to add differential-privacy noise to published reputation scores to prevent back-calculation of individual attestation changes from score deltas. Trade-off: privacy vs. precision. At small scale, even modest noise significantly blurs scores.

3. **Cross-graph structural analysis.** How aggressively to monitor for cases where the private graph's structure could be correlated with the public graph to narrow anonymity sets. An ongoing analytical task.

4. **Attestation dimensions beyond the initial four.** The architecture supports adding dimensions without structural changes, but each new dimension increases prompt complexity and gaming surface.

5. **Trust pip thresholds.** The three-state Layer 1 logic is a starting point. Actual thresholds should be calibrated once the platform has enough diverse accounts. The visual design (three colours, one pip) is stable regardless.

6. **Panel width persistence.** Future enhancement: draggable panel edges with custom widths persisted. Not in v1.

7. **Feed item separation at scale.** The `space-y-[2px]` gap is subtle by design. At scale, may need to increase or use faint `bg-grey-50` banding. Test with real content density.

8. **Dark mode.** The workspace spec uses light-background colour values. Dark mode requires inverting the grey scale, adjusting trust pip colours for contrast, and ensuring panel gutters remain visible. Tracked separately.

9. **Mopping-up threshold calibration.** The initial threshold of 5 out-of-cycle submissions is a guess. Too low means frequent partial aggregations (operational cost, possible timing leaks). Too high means the responsiveness benefit is lost. Tune with real data.

### Resolved design decisions

- **Epoch length:** quarterly for full aggregation. Twice-weekly mopping-up rounds with threshold for acute situations.
- **Anonymous node recovery:** user-held seed phrase on the Nostr nsec / Bitcoin wallet threat model. Loss is accepted, not engineered around.
- **Anonymous node key custody:** client-side only. Cannot be custodial because that would break the dual-graph firewall.
- **Layer 4 mechanism:** public endorsements (Option B) alongside anonymous attestations. Public endorsements provide attributable relational data; anonymous attestations provide privacy-preserving global scores.
- **Layer 4 computation:** uses the viewer's public-side signals (follows, reading-tab payments, pinned sources, quote-posts) intersected with public endorsement data. Never correlates the viewer's public and anonymous identities.
- **Attestation service isolation:** separate service in the monorepo, own Docker container, own Docker network, own PostgreSQL schema (`private_graph`) accessed by a dedicated DB user. Same operational pattern as key-custody and feed-ingest.
- **Workspace state persistence:** `localStorage` (device-local) in v1. Cross-device sync is future work.


## XIII. What all.haus is not

All.haus does not require or collect government identity documents. It does not perform biometric verification. It does not operate a centralised identity registry. It does not compute a single trust score that determines access or visibility. It does not make automated judgements about anyone's character.

All.haus is a lens. It makes information legible. The reader decides what it means.
