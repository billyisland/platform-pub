# all.haus — Founding Documents

**An omnibus of four related but separable specifications**

**Status:** Active
**Date:** April 2026
**Supersedes:** docs/adr/ALLHAUS-ADR-UNIFIED.md (April 2026)

---

## About this document

This is an omnibus. It contains four documents that were previously fused into a single "unified ADR" and have now been separated into their proper shapes while remaining bound together for ease of reference. Each book has a distinct audience, a distinct purpose, and can be read on its own.

| Book | Title | Audience | What it is |
|---|---|---|---|
| **I** | **Vision** | Everyone | Why all.haus exists, what it is, what it is not. The political and product framing. Short. |
| **II** | **Trust graph specification** | Architects, cryptographers, critics | How legibility-without-identification is built. The four layers, the dual-graph mechanism, the threat model, the scale caveats. |
| **IV** | **Implementation plan** | Backend engineers, the author | Services, schemas, endpoints, phasing. The build order and what ships when. |

**Book III (Workspace specification) was removed in April 2026.** The four-panel workspace it specified was retired in favour of the single-surface product model described in `docs/adr/REDESIGN-SCOPE.md`. The trust pip spec, visual separation model, and feed item structure from Book III survive as design language in the existing codebase; the workspace shell, panel system, mode tabs, and responsive panel behaviour do not. Build Phases 3 and 7 in Book IV have been updated accordingly.

Decisions made within these documents are recorded inline where they are load-bearing. As the project progresses, discrete decisions that modify or replace anything here will be written as separate ADRs under `/docs/adr/` and will link back to the book and section they amend. This document is the foundation; ADRs are the amendments.

A note on register. Book I argues. Book II specifies. Book IV instructs. Each has a different voice on purpose. Read them in the register they're written in.

---

## Contents

### Book I — Vision

- §I.1 What all.haus is
- §I.2 The problem it addresses
- §I.3 What all.haus is not
- §I.4 The READER and the WRITER as separable tools
- §I.5 Comparators and competitive context
- §I.6 The two-phase anonymity strategy (weak now, strong later)

### Book II — Trust graph specification

- §II.1 The layers: what the trust graph is made of
- §II.2 Layer 1: automatic signals
- §II.3 Layer 2: attestations (weak-anonymous now, strong-anonymous later)
- §II.4 Layer 3: graph analysis
- §II.5 Layer 4: relational presentation
- §II.6 The dual-graph architecture (the target state)
- §II.7 Attestation dimensions
- §II.8 Credibility brackets, epochs, and decay
- §II.9 Sybil and abuse resistance
- §II.10 Threat model and what the system cannot do
- §II.11 Scale honesty: what each layer produces at each size
- §II.12 The bootstrap: seeding attestation from a known cohort
- §II.13 Open questions

### Book IV — Implementation plan

- §IV.1 What exists already
- §IV.2 Services: what's new, what changes
- §IV.3 Database schema
- §IV.4 Gateway additions
- §IV.5 Client-side components
- §IV.6 Standards and prior art being adopted
- §IV.7 Phasing
- §IV.8 Testing strategy
- §IV.9 What this trades away in the short term
- §IV.10 What a real ADR looks like (and when to write one)

---
---

# Book I — Vision

## §I.1 What all.haus is

All.haus is two tools that are made for each other but can be used apart.

The **WRITER** is a tool that protects the interests of writers. It preserves their autonomy, their security, their reputation, and their livelihood. It gives them portable identity via Nostr keypairs, transparent monetisation via the reading tab, content provenance from the point of creation, a draggable paywall gate, and dual-key authorship for publishing within editorial structures. The WRITER is currently assembled into a full publishing platform, but its components are separable in principle: a writer could use the WRITER tools while publishing on their own domain, through a Publication hosted by someone else, or anywhere the Nostr layer reaches.

The **READER** is a tool that protects the interests of readers. It guides them toward good content, discreetly flags the dubious as dubious, and makes the information environment legible without requiring anyone to surrender their privacy. The READER aggregates content from across the web — Bluesky, Mastodon, RSS, external Nostr, native all.haus content — into a unified experience, and layers trust information on top of everything it shows.

The two halves work especially well together. Content produced through the WRITER is maximally legible in the READER — richer trust signals, transparent incentives, full provenance. But neither requires the other. The WRITER is useful on day one without any READER ecosystem. The READER is useful as a standalone feed reader and trust-annotation layer even if the user never publishes a word.

Together they create a flywheel: writers publish through the WRITER; the reading tab generates both revenue and trust signal; the READER surfaces that signal to other readers; those readers subscribe; the trust graph deepens. Both halves become progressively more attractive as the other grows — and both have compelling use value alone.

## §I.2 The problem it addresses

The missing layer of the internet is *legibility without identification*. The current web forces a bad trade: operate under your real name and accept surveillance, targeting, and the collapse of context; or operate anonymously and accept that nobody has any reason to trust you. The missing middle is the ability to know things about a person or a piece of content that matter — are they human, are they consistent, are their incentives transparent, do they have a track record — without knowing things that don't matter, or are dangerous to reveal.

In an increasingly authoritarian world of arbitrary powers, a system that requires real-name identification to function is not neutral infrastructure — it is a tool of control. It should be possible to lead a full life and a successful career on all.haus via a high-quality pseudonym: one that can be guaranteed in various ways but cannot be trivially traced to a real-world government identity. This is a political commitment, not just a privacy feature.

The information environment is degrading fast. AI-generated content is flooding every channel, trust in institutions and media is collapsing, and the platforms that mediate most people's reading experience are optimised for engagement rather than legibility. Almost nobody is building seriously against this. All.haus does not need to become a mass-market product to matter. The people who care about the quality of their information environment — journalists, researchers, writers, editors, serious readers, people in adversarial political contexts — are a small population in percentage terms but a large and influential one in absolute terms. The correct comparison is not Instagram. It is Wikipedia, or PGP, or RSS itself: infrastructure that a relatively small number of people use directly but that shapes how information moves for everyone.

## §I.3 What all.haus is not

All.haus does not require or collect government identity documents. It does not perform biometric verification. It does not operate a centralised identity registry. It does not compute a single trust score that determines access or visibility. It does not make automated judgements about anyone's character. It does not rank content by engagement or watch time. It does not perform behavioural inference or train models on user activity.

All.haus is a lens. It makes information legible. The reader decides what it means.

## §I.4 The READER and the WRITER as separable tools

The deliberate separation of READER and WRITER is a structural commitment with product and strategic consequences.

**It makes day-one utility real.** A writer who wants portable identity, a paywall, and transparent payment gets a working product on day one, with no trust graph, no readership, and no network effects. A reader who wants a better feed reader with trust annotations gets a working product on day one, with no writing, no account beyond the minimum, and no obligation to pay for anything.

**It makes the phasing plan honest.** The WRITER and the READER can ship the first useful version of themselves without the trust graph being dense. The trust graph *enriches* both tools as it fills in — it does not gate either of them. This is the correct dependency structure. A product that requires dense trust-graph participation on day one would be dead on arrival.

**It reframes the competitive landscape.** The READER does not compete on aggregation alone — it competes on trust annotation. The WRITER does not compete on publishing alone — it competes on the writer-interest protection stack (portable identity, pseudonymity, transparent payment, protocol ownership). Each tool is a distinctive proposition that does not depend on the other being fully built out.

## §I.5 Comparators and competitive context

The READER's closest comparator is Flipboard's Surf (launched April 2026), which combines Bluesky, Mastodon, RSS, podcasts, and YouTube into a single browsing experience. The RSS reader incumbents — Feedly, Inoreader, NewsBlur — are mature and well-established.

All of these solve the *aggregation* problem: getting everything into one place. None of them touch the *trust* problem. You can curate your sources perfectly and still not know whether the person behind a pseudonym is acting in good faith, whether an article was funded by an undisclosed interest, whether a seemingly independent voice is part of a coordinated network. Source selection does not solve the legibility problem. The trust layer does.

The WRITER's comparators are Substack, Ghost, Beehiiv, and Mirror — plus the native-Nostr writing clients (Habla, Yakihonne, Highlighter). The differentiation is the stack: portable identity via Nostr, transparent payment, no platform lock-in on the reader relationship, no demand for government identity, and editorial structures (Publications) that give writers the benefits of publisher infrastructure without ceding ownership of their audience.

## §I.6 The two-phase anonymity strategy

This is the single most important strategic clarification. The trust graph's attestation layer (Layer 2) will be built and shipped in two phases: **weakly anonymous first, strongly anonymous later.** The target architecture is the dual-graph system (Book II §II.6); the launch reality is something simpler that gets the product to readers faster.

**Why the two-phase approach.** The target architecture — where the platform cannot determine who attested to whom even under compulsion — is the right long-term design. But at launch, the kompromat value of "X endorsed Y's integrity" data is low. Attestation records are not medical records, not sexual content, not financial fraud, not plans to overthrow a government. They are roughly on the order of "Alice left Bob a positive review on Goodreads." A subpoena for attestation data is not the defining threat to the early-stage project. The defining threat is *shipping something people use.*

Building a trustable public web is the priority. Building unanswerable-to-subpoenas infrastructure is a second-order commitment that the project is serious about but that does not need to gate launch.

**Phase A — Weak anonymity (launch through first ~1k active attestors).**

Attestations in Phase A are submitted under the user's public identity and are **not displayed** attached to that identity. The platform knows who attested to whom. Readers see only aggregate scores ("14 attestors vouch for this person's integrity") and, in the Trust panel's relational layer, statements about the viewer's network ("3 writers you follow have publicly endorsed this person").

In Phase A, attestations and public endorsements converge into a single primitive: a user vouches for another user on a dimension, and chooses whether the vouch is *public* (attributable, visible on profiles) or *anonymous-to-readers* (feeds aggregate scores only, attributable in the platform's database). Both types feed Layer 4. The anonymous-to-readers variant is "anonymous" in the weak sense: anonymous from the reader's point of view, not anonymous from the platform's point of view.

This gets us a trust product with real relational signal, with no cryptography, no blind signatures, no separate keys, and no user friction beyond a single "Vouch for integrity?" button.

**Phase B — Strong anonymity (when warranted by scale and threat environment).**

Phase B introduces the dual-graph architecture as originally specified in Book II §II.6: a separate anonymous Nostr keypair, blind-signature registration so the platform cannot link voucher requests to anonymous-node registrations, NIP-44-encrypted submissions, batched publication. In Phase B, "anonymous-to-readers" attestations from Phase A are *not* migrated — Phase A data remains Phase A data (the platform already knows it). Phase B is a separate, opt-in channel for users who want the strong guarantee.

Phase B will ship when:

- There are enough active attestors (~several thousand) that the anonymity set is meaningful, *and*
- There is visible demand from users who need the stronger guarantee (journalists in adversarial contexts, users in jurisdictions with hostile subpoena regimes, users making negative attestations), *and*
- The engineering cost of the dual-graph infrastructure is no longer displacing more urgent work.

The expected timeline is not "year one." It is "once the product is loved and the trust graph is producing real signal." Committing to Phase B in the spec now ensures the architecture is designed with the transition in mind; it does not require the transition to happen on a fixed schedule.

**What this means for users.** At launch, users are asked to vouch for each other under their public identities, with the choice of whether the vouch is visible to other readers or aggregated silently. They are told, plainly, that the platform holds this data — and that the platform will, at a later date, offer a separate channel with stronger guarantees. This is more honest than shipping a weak version of the dual-graph system and calling it strong, and it is less friction-heavy than shipping the dual-graph system on day one to a user base that won't use it.

**What this means for the threat model.** Book II §II.10 describes the full threat model — subpoenas, seizure, coercion, traffic analysis. That threat model is the *target* threat model. At Phase A, the honest position is: the platform holds attestation data under normal operational security; it will resist improper requests; it will not build the infrastructure that a hostile operator could use to weaponise that data; and it will migrate to the stronger architecture on a stated schedule. Users in high-threat contexts should not rely on Phase A for adversarial resistance — and should be told so in the UI.

---
---

# Book II — Trust graph specification

## §II.1 The layers: what the trust graph is made of

The trust graph is built from four progressively richer layers. The design intent is that Layer 1 works for every user from day one, Layers 2 and 4 become populated as users vouch for each other, and Layer 3 produces meaningful output once the graph is dense enough to analyse.

| Layer | What it is | Active from |
|---|---|---|
| 1 | Automatic signals (account age, paying readers, publishing frequency, payment verification, NIP-05) | Day one, every account |
| 2 | Attestations — dimensional vouches from one user about another (humanity, encounter, identity, integrity) | Phase A launch |
| 3 | Graph analysis — weighting, diversity, Sybil detection | Activates as graph densifies (~1k+ attestors) |
| 4 | Relational presentation — "what your network says" | Phase A launch, improves with Layer 2 density |

The key property of this stack is **graceful degradation**. A reader looking at a feed item with a thin Layer 1 profile, no Layer 2 attestations, no Layer 3 signal, and no Layer 4 relational data still sees *something* informative: "this is an RSS item with no identity metadata" is itself a useful datum. The READER is honest about what it can and cannot say.

## §II.2 Layer 1: automatic signals

Layer 1 signals are computed from data the platform already holds, without any social action from users. They are present for every native account on day one and are inferable (partially) for content from federated sources.

**Signals computed:**

- Account age (days since registration)
- Paying reader count (distinct readers who have paid through the reading tab)
- Published article count
- Payment verification status (Stripe account connected, or cryptocurrency wallet linked)
- NIP-05 domain verification status
- Continuous activity (days since last publication or meaningful platform action)
- Subscriber count

**Per-source inference:**

- **Native all.haus content:** full Layer 1 signal available.
- **External Nostr content:** account age (from Nostr event history on federated relays), NIP-05 if set, follower count on Nostr. No payment signal.
- **Bluesky content:** account age, follower count, posting frequency (inferred via the AT Protocol). No payment signal.
- **Mastodon content:** account age, follower count, posting frequency. No payment signal.
- **RSS content:** domain age (via WHOIS, cached), HTTPS presence, last-build-date freshness. No identity signal.

Layer 1 is deliberately weak individually and collectively informative. A new account with no paying readers and no publication history has a thin Layer 1 profile; a three-year-old account with 400 paying readers, verified payment, a NIP-05 domain, and weekly publication has a thick one. The trust pip compresses Layer 1 into a three-state glyph (known/partial/unknown) visible on every feed item.

## §II.3 Layer 2: attestations

Layer 2 is where one user makes a specific dimensional claim about another user. Four dimensions (§II.7), three possible values (affirm / contest / revoke), submitted to a service that aggregates them into per-subject per-dimension scores.

The attestation primitive is the same in both phases of the anonymity strategy (Book I §I.6); what changes is who can see what.

**Phase A (launch):**

A user selects another user's profile and clicks "Vouch" on one or more dimensions. They are presented with two choices:

1. **Public endorsement** — visible on both parties' profiles, attributable, feeds Layer 4 directly.
2. **Aggregate-only vouch** — not visible on either profile, contributes to the subject's aggregate score only. Anonymous *from other readers' point of view.* The platform knows the identity of the attestor.

Both types contribute to the subject's Layer 2 dimension scores. Both are withdrawable at any time by the attestor. Public endorsements additionally feed Layer 4.

The **negative case** (contesting a previously-made attestation, or making a cold-contest attestation) is only available in the aggregate-only channel. This is deliberate: public contests are a mob-dynamics hazard, and the value of negative signal is best expressed in aggregate.

**Phase B (future):**

A separate, opt-in channel using the dual-graph architecture (§II.6). A user generates an anonymous attestor keypair on-device, registers it via blind signature, and submits NIP-44-encrypted attestations to the attestation service. The platform cannot link the anonymous node to the user's public identity. Phase B attestations contribute to the same aggregate dimension scores as Phase A aggregate-only vouches — readers see no difference between them.

Phase A users are not automatically migrated to Phase B. Users who want the stronger guarantee for future attestations opt in and generate an anonymous keypair; their Phase A aggregate-only vouches remain in Phase A.

## §II.4 Layer 3: graph analysis

Layer 3 analyses the structure of the attestation graph to compute weighted reputation scores. The principles:

- **Attestor weighting:** An attestation from a user who is themselves well-attested counts for more than one from a user with a thin profile. At Phase A, this is approximated by Layer 1 signals on the attestor (a thick-Layer-1 attestor's vouch counts for more). At Phase B, credibility brackets (§II.8) replace this approximation for aggregate-only / anonymous attestations.
- **Diversity weighting:** Attestations from users who are distant from each other in the graph are worth more than attestations from a tight clique.
- **Sybil discounting:** Clusters of identities that all vouch for each other but have thin connections to the broader network are discounted (§II.9).
- **Payment-backed Sybil resistance:** Fake identities can follow each other and vouch for each other, but they can't easily generate realistic payment patterns through the reading tab. The reading tab is a natural Sybil resistance mechanism.

**Scale honesty.** At Phase A launch, with a few hundred active attestors, Layer 3 produces rudimentary output at best. Diversity weighting has little purchase; Sybil detection cannot distinguish a tight-knit friend group from a cluster of fakes. This is fine. **Public endorsements and Layer 1 carry the system at small scale**; Layer 3 activates gradually as the graph densifies. The READER is honest about this — the Trust panel's language at small scale is thinner and less confident ("3 early users have endorsed this person" rather than "established humanity").

## §II.5 Layer 4: relational presentation

Trust is relational, not absolute. There is no objective answer to "how trustworthy is this person" — only answers relative to the person asking. Layer 4 is the system's mechanism for producing those relative answers.

Layer 4 intersects the viewer's **valued set** (people they follow, pay through the reading tab, pin as sources, or quote-post approvingly) with the **public endorsement set** for the subject, producing specific, attributable statements:

- "Of the 14 writers you follow and pay, 3 publicly endorse this person's integrity; 1 has recently withdrawn their endorsement."
- "5 writers you also follow also follow this author."
- "No one in your network has publicly endorsed this person."

Layer 4 draws only on *public endorsements* and *public-graph proximity*, never on aggregate-only or anonymous attestations. Using anonymous attestation data in Layer 4 would require the platform to correlate public and anonymous identities, which would collapse the firewall in Phase B — and is unnecessary, because public endorsements are the simpler, lower-friction mechanism for the relational layer.

This is why the attestation primitive splits into two forms. Public endorsements produce relational data (Layer 4); aggregate-only / anonymous attestations produce global signal (Layers 2–3). Most users will only make public endorsements; a committed minority will also or exclusively use the aggregate-only channel (in Phase A) or the anonymous channel (in Phase B).

**Encouraging public endorsement volume.** Since Layer 4 — the most useful part of the trust system from the reader's perspective — is powered exclusively by public endorsements, the product must make public endorsement the path of least resistance. Design choices that serve this:

- **Public is the default.** The visibility selector defaults to "Public endorsement." The aggregate-only option is available but requires a deliberate second step.
- **Endorsement is reciprocally visible.** When a writer sees "3 people publicly endorse you," they see who — and are prompted to consider endorsing back. This is not forced reciprocity; it is social visibility creating natural endorsement flow.
- **Endorsement appears on the endorser's profile.** "Writers I endorse" as a public signal of taste and judgement — the same social motivation that drives public following, public reading lists, and public recommendations.
- **The seed cohort sets the norm.** If the founding 20–50 writers all make public endorsements, public endorsement is established as the default social behaviour before any new user encounters the feature.
- **No shaming of non-endorsers.** The system never says "you haven't endorsed anyone" or gamifies endorsement counts. The incentive is social visibility, not obligation.

## §II.6 The dual-graph architecture (the target state)

This section describes the Phase B target architecture. It is not what ships at launch — see Book I §I.6 and §II.3 for the phasing — but it is the architectural endpoint the system is designed toward, and the launch design is constrained by the need to be able to reach it.

**The design problem.** The trust graph requires people to make honest, private judgements about other people. Those judgements must feed into public reputation scores. In the target state, the system must be designed so that the platform cannot be compelled to reveal who judged whom — not as a policy commitment, but as a structural impossibility.

**Two graphs, one system.**

- **The public graph** has named nodes. Every participating user has a public node — their visible pseudonym — carrying reputation scores and public endorsements.
- **The private graph** has anonymous nodes. Every participating user (in Phase B) also controls an anonymous node with its own Nostr keypair, unrelated to the user's public identity. The mapping between a person's public node and their anonymous node exists only on the person's own device. Anonymous nodes submit attestations; their judgements flow into the system, are aggregated, and produce scores on the public graph. The witnesses themselves are never identified to the platform.

The two graphs are connected only by encrypted inbound channels (anonymous nodes submit attestations about named public nodes), batched outbound updates (the platform publishes revised reputation scores on the public graph at fixed intervals), and credibility feedback (the platform sends credibility adjustments back to anonymous nodes via their encrypted channels). No other communication crosses the boundary.

**Why structural separation rather than cryptographic approaches.** Three genres of solution were considered. Trusted execution enclaves offer strong guarantees but introduce hardware-vendor dependencies. Cryptographic approaches (homomorphic encryption, secure multi-party computation) offer the theoretically strongest position but push against the limits of what these techniques can do efficiently for the required graph analysis, making them a research problem rather than an engineering task. Structural separation — two graphs that never cross-reference at the individual level — is the most *comprehensible* of the three, which matters for a system whose trustworthiness depends on users understanding why it works.

**Anonymous node key management (Phase B).** The anonymous attestation key must not be custodial. The existing Nostr setup is custodial — key-custody holds the private key, indexed by `user_id` — and that works because the platform is *supposed* to know which user owns which Nostr key. The anonymous attestation key has the opposite requirement: the platform must *not* know. The anonymous key lives on the user's device:

- **Generation is automatic.** When the user opts into Phase B attestation, the client generates the keypair silently. One button: "Enable private attestation."
- **Storage is local.** IndexedDB, encrypted at rest with a key derived from WebAuthn (if the device supports it) or a user-chosen passphrase.
- **The seed phrase is shown once.** A clear "write this down" moment, same UX pattern as a crypto wallet setup.
- **Loss is accepted.** Lose the key, start over at bracket 1. This is the same threat model as Nostr `nsec` keys and Bitcoin wallet seeds. A modest level of natural wastage is healthy for the graph.

**Anonymous node registration (Phase B).** Registration must prove "a payment-verified public identity stands behind this anonymous node" without revealing which one. This is a blind signature problem, solved with RSA blind signatures (RFC 9474). The flow:

1. The user's client generates an anonymous Nostr keypair locally and stores it in IndexedDB.
2. The user authenticates normally (public identity) and requests a registration voucher from the gateway. The gateway checks payment verification.
3. The client generates a random nonce, blinds it using the platform's public RSA key, and sends the blinded value to the gateway.
4. The gateway signs the blinded value and returns it.
5. The client unblinds the signature locally — now holds a valid platform signature on a nonce the platform has never seen in cleartext.
6. From a separate connection (no auth cookies, different session), the client presents to the attestation intake service: anonymous pubkey + unblinded nonce + platform signature.
7. The attestation service verifies the signature, hashes the nonce to prevent replay, registers the anonymous node, and discards the nonce.

**Timing correlation defences.** The registration voucher is held by the client and submitted during a batch window spanning the first week of each epoch, when many registrations happen simultaneously. The voucher rate-limit is generous (one per epoch-quarter per user, re-requestable if lost), not aggressive — missing a window should not lock a user out for a quarter.

**Attestation submission (Phase B).** The client composes an attestation (`subject: Bob's public key, dimension: "humanity", value: affirm, epoch: 2026-Q2`), encrypts it with NIP-44 to the attestation service's pubkey, and submits it through a connection that carries no authenticated session data. The platform receives an encrypted attestation from anonymous key X regarding public node Bob. It knows X's judgement; it does not know who X is.

**Prompting.** The attestation service sends encrypted prompts to each anonymous node at the start of each epoch, listing the public nodes this anonymous node has previously attested to and asking the user to reaffirm, revise, or remain silent. All prompts go out within a **week-long** batch window with per-node jitter distributed across the week (not a 24-hour window — a 24-hour window is tight enough to leak timing via online-activity correlation for users on surveilled networks). Responses are similarly released from a randomised delay buffer.

**Aggregation.** See §II.8.

## §II.7 Attestation dimensions

Four dimensions, stable across Phases A and B:

- **Humanity.** "I believe this identity corresponds to a real human being." The most fundamental attestation. Once well-established, it ratchets — see §II.8.
- **Encounter.** "I have interacted with this person in a way that goes beyond reading their public output." A stronger signal than pure graph proximity.
- **Identity.** "I believe this person is what they claim to be." This accommodates pseudonymous commitment: someone who presents as a doctor, a journalist, a fisherman, a fictional character with a consistent persona. The attestation is about consistency and sincerity, not about government identity.
- **Integrity.** "I believe this person acts in accordance with their own stated standards and with general good faith." The most subjective and most valuable dimension. Also the most vulnerable to mob dynamics.

The dimensions are intentionally few. Each added dimension increases prompt complexity, gaming surface, and cognitive load on the attestor. Four is enough to produce a differentiated profile without being a form to fill in.

## §II.8 Credibility brackets, epochs, and decay

Attestations decay; attestors are weighted; scores are published on an epoch cadence. This section covers all three.

**Epochs.** The attestation system runs on a quarterly epoch cadence. At the end of each epoch, a full aggregation runs: every public node's scores are recomputed across all four dimensions and published simultaneously. Between epochs, lighter partial aggregations run twice weekly (Monday and Thursday, offset from other cron jobs) to handle acute situations — if more than a threshold number of out-of-cycle submissions have accumulated for a subject, that subject's scores are recomputed and republished without waiting for the quarter boundary.

**Small-scale scoring timing.** The quarterly cadence is appropriate at scale but can produce scoring latency problems for new or sparsely-attested subjects at small scale. The mitigation is explicit: **a subject with fewer than 10 total attestations has their scores recomputed on every Monday/Thursday mopping-up round regardless of threshold.** This means a new writer with 3 attestations sees their score update twice a week, not once a quarter. The threshold gate (initially 5 out-of-cycle submissions) applies only to subjects who already have a mature attestation profile. This is a small-scale-specific rule that can be relaxed as the graph densifies.

**Decay and reaffirmation.** Attestations decay on a per-epoch basis:

| Epochs since last reaffirmation | Freshness |
|---|---|
| 0 (current epoch) | 1.0 |
| 1 | 0.85 |
| 2 | 0.70 |
| 3 | 0.50 |
| 4 | 0.30 |
| 5 | 0.15 |
| 6+ | 0.0 (expired) |

With quarterly epochs, an attestation that has not been reaffirmed for roughly eighteen months effectively vanishes. The trust graph is a living picture of current opinion, not an archaeological record.

**Small-scale decay protection.** For subjects with fewer than 10 attestations, freshness decay is slowed rather than paused outright, using a graduated ramp that avoids a cliff when the threshold is crossed.

| Active attestation count | Decay rate multiplier |
|---|---|
| 1–3 | 0.0 (fully paused) |
| 4–6 | 0.25 (quarter speed) |
| 7–9 | 0.5 (half speed) |
| 10+ | 1.0 (full decay) |

The multiplier scales the per-epoch freshness drop. At 5 attestations, an attestation that would normally drop from 1.0 to 0.85 after one epoch instead drops to `1.0 - (0.15 × 0.25) = 0.9625`. This prevents the degenerate case where a small writer's score decays faster than it accumulates, while avoiding the cliff where attestation #10 suddenly starts the full decay clock for all prior attestations simultaneously. A writer who slowly accumulates vouches sees decay phase in gradually rather than switch on at a threshold.

**The humanity ratchet.** Once a public node's humanity score has exceeded a high threshold for 8 consecutive epochs (~2 years), the status shifts to "established." Established humanity does not decay to zero through silence alone — it can only move to "contested" if a significant fraction of historical attestors actively submit negative signals.

The 8-epoch (~2 year) threshold means the ratchet has no effect during the first two years of the platform's life. This is accepted: the ratchet is a maturity-stage mechanism that protects long-standing identities from stale-attestation erosion. During the growth phase, public endorsements and Layer 1 signals carry the trust product. The ratchet threshold should be reviewed at the 18-month mark — if the attestation graph is dense enough that established identities are losing humanity scores purely from reaffirmation fatigue, the threshold may need shortening.

**Credibility brackets (Phase B).** Each anonymous node accumulates a credibility score on the private side, quantised into four brackets: new (1), developing (2), established (3), veteran (4). Bracket placement is computed from a rolling 8-epoch (~2 year) window using:

- **Consistency with consensus:** how the node's attestations compare with the eventual aggregate.
- **Responsiveness:** fraction of epoch prompts responded to within the prompt window.
- **Stability:** fraction of attestations unchanged between consecutive epochs. Frequent oscillation is a negative signal.
- **Duration:** epochs since registration, capped at the sliding window.

Bracket advancement is not purely performance-based: a newly registered anonymous node cannot reach bracket 4 in its first 6 epochs (~18 months) regardless of accuracy. This prevents a well-resourced adversary from rushing cultivated Sybil attestors into high-weight positions.

**Phase A attestor weighting (simpler).** Phase A does not have credibility brackets — the attestor's public Layer 1 profile serves as the weighting signal. An attestation from a three-year-old account with verified payment and 400 paying readers carries more weight than one from a three-day-old account with no payment method. The transition to Phase B replaces this with brackets for attestations made through the anonymous channel; Phase A attestations continue to be weighted by Layer 1.

**Phase A weighting formula.** Each attestor's weight is a product of four normalised sub-scores, each in `[0, 1]`:

| Sub-score | Computation | Rationale |
|---|---|---|
| **Age** | `min(account_age_days / 365, 1.0)` | Caps at 1 year. A week-old account gets 0.02; a six-month account gets 0.5. |
| **Payment** | `1.0` if Stripe account connected and verified; `0.3` otherwise | Binary, heavily gated. The strongest single Sybil signal. |
| **Readership** | `min(paying_reader_count / 50, 1.0)` | Caps at 50 paying readers. Scales linearly below that. |
| **Activity** | `min(article_count / 10, 1.0)` | Caps at 10 published articles. |

`attestor_weight = age × payment × readership × activity`

A three-day-old account with no payment, no readers, and no articles scores `~0.008 × 0.3 × 0 × 0 = 0`. A mature account (1yr+, verified, 50+ readers, 10+ articles) scores `1.0`. The product formulation means a zero in any dimension zeroes the weight — an account with verified payment but zero articles and zero readers still contributes nothing. This is intentional: the reading tab is the Sybil gate, but a payment-verified account that has never published or been read is not yet a meaningful attestor.

The cap values (365 days, 50 readers, 10 articles) are tuning parameters. They should be revisited once real attestation data exists — the goal is that roughly the top quartile of active accounts score above 0.5 and the bottom quartile score below 0.1.

**Periodic re-keying (Phase B).** Anonymous-node keypairs are designed to rotate. The credibility-bracket mechanism creates a persistent per-node record — a persistent identifier. Periodic rotation caps the fingerprinting window structurally. A user can, at any time (and is gently prompted every two years), generate a new attestor keypair on-device, sign a handoff message with the old key authorising the new key, and submit the handoff to the platform. The platform retires the old key, registers the new one, and credits the new key with partial bracket inheritance — a veteran retires to an established inheritor, an established retires to developing, and so on.

## §II.9 Sybil and abuse resistance

**Sybil networks** — a bad actor creating many fake accounts to inflate someone's reputation — face several obstacles:

- **Payment-backed registration.** Every fake attestor requires a fake public node with a real payment method. This is the strongest single defence.
- **Time-gated credibility growth** (Phase B). Brackets cannot be rushed.
- **Cluster detection** on the attestation graph. Clusters of accounts that all vouch for each other with near-identical attestation patterns are flagged. Detected clusters have their attestations weighted as a single signal rather than N independent signals.
- **Diversity weighting.** Attestations from graph-distant attestors are worth more than attestations from tight cliques.
- **Periodic re-keying** (Phase B). An adversary who invests years building credibility loses that investment at each rotation.

**Malicious denial** — coordinated reputation damage — is mitigated by:

- **Diversity weighting** (a bloc behaving identically is one signal).
- **Tempo control** (changes processed at epoch boundaries or mopping-up rounds, not in real time).
- **Longevity weighting** (a long-standing attestor's change of position is stronger than a recent one's).
- **The humanity ratchet** (see §II.8).

**Mob dynamics.** When many people are sincerely but wrongly aligned against someone, Layer 4's relational presentation is the primary defence. Each reader sees the attestation landscape filtered through their own trust network. A mob concentrated in one region of the public graph does not distort what a reader in a different region sees. The READER shows the shape of disagreement — "15 long-standing attestors vouch for integrity; 40 recent attestors have downgraded; the downgraders share similar attestation patterns" — and the reader interprets.

**Scale honesty on abuse resistance.** At Phase A scale (hundreds of attestors), Sybil detection cannot distinguish a real friend-group from a fake cluster. The dominant defence at small scale is **payment-backed registration** — creating a fake attestor costs real money via the reading tab, which most Sybil attacks cannot absorb at useful volume. The other defences become meaningful as the graph densifies.

## §II.10 Threat model and what the system cannot do

This section is the honest version. It is written in two parts: the target threat model (Phase B) and the launch threat model (Phase A).

**Phase B target threat model.**

What the platform holds: the public graph (visible, no secrets); the private graph structure (anonymous node IDs, credibility brackets, set of public nodes each has attested to, dimension and value of each attestation — revealing that anonymous node X vouched for public node Bob, but not who X is); encrypted message logs.

What the platform does not hold: the mapping between anonymous nodes and public identities (exists only on user devices); cleartext attestation content in transit (NIP-44 encrypted; decrypted in memory, plaintext discarded, only aggregated results retained).

What a seizure yields: the public graph (already public); public endorsements (already public); a set of anonymous node IDs with credibility scores and attestation records (revealing that anonymous node X vouched for Bob, but not who X is); encrypted message logs. An adversary who independently identifies an anonymous node's key (e.g., by seizing a specific user's device) can look up that node's full attestation history. But the platform cannot perform that identification, and bulk deanonymisation from the server alone is not possible.

**Phase A launch threat model.**

What the platform holds: all of Phase B, plus — crucially — the mapping between attestations and the user who made them. An aggregate-only vouch in Phase A is anonymous from other readers; it is not anonymous from the platform. A subpoena served on all.haus in Phase A *can* be answered with "user X vouched for user Y on dimension Z on date D."

Users who need stronger guarantees in Phase A should:

- Use the Phase B anonymous channel once it ships.
- In the meantime, limit themselves to public endorsements (where the attribution is already visible) or refrain from attesting.
- Be warned of this in the UI when making aggregate-only vouches. The text should be plain: "This vouch is hidden from other readers. The platform can see it. We are building a stronger-privacy channel — it is not yet available."

**What the system cannot do, in either phase:**

- It cannot tell a reader who any specific anonymous-channel attestor is (Phase B).
- It cannot distinguish, at small scale, between a real tight-knit community and a Sybil cluster.
- It cannot prevent an adversary who seizes a user's device from identifying that user's anonymous attestations.
- It cannot produce an objective "trustworthiness" score. It produces relational and aggregate signal; interpretation is the reader's.
- It cannot replace editorial judgement, journalistic verification, or any other real-world process for establishing fact.

## §II.11 Scale honesty: what each layer produces at each size

| Scale (active attestors) | Layer 1 | Layer 2 | Layer 3 | Layer 4 |
|---|---|---|---|---|
| 0–50 | Works | Very thin, most profiles have zero attestations | Produces no meaningful signal | "No one in your network has endorsed this person" on most profiles |
| 50–500 | Works | Produces per-subject aggregates; individual dimension scores are noisy | Weak; Sybil detection is guessing | Relational signal starts appearing for well-connected subjects |
| 500–5000 | Works | Per-subject aggregates are stable; dimensional differentiation meaningful | Diversity weighting starts working; Sybil detection weakly discriminates | Relational signal populated for most viewer/subject pairs |
| 5000+ | Works | Rich per-subject aggregates | Full graph analysis meaningful; Phase B dual-graph protections become materially valuable | Rich, differentiated relational signal |

The product should be honest about this in the UI. At small scale, the Trust panel says "3 early users have endorsed this person's humanity" — a thin but accurate statement — rather than generating the appearance of richer signal than exists.

## §II.12 The bootstrap: seeding attestation from a known cohort

At launch, the attestation graph is empty. The first reader who opens the Trust panel on the first article sees "no one has vouched for this person" across four dimensions — a bad first impression for a product whose selling point is trust annotation.

The bootstrap strategy is explicit: **seed the graph with a known cohort.**

A small group of writers and editors — people the project knows personally, people who have opted into the early version, ideally 20–50 people — are invited at launch to publicly endorse each other on the dimensions where they have genuine knowledge. A writer endorses their editor's integrity; an editor endorses a writer's identity; two writers who have worked together endorse each other's encounter dimension. The cohort is not secret — the fact that there is a seed cohort is part of the launch messaging — and the seed endorsements are ordinary public endorsements, indistinguishable from later ones.

This solves three problems at once:

1. The Trust panel is populated with real signal on day one for the writers most likely to be read.
2. Layer 4 relational data has something to intersect with. A new reader following one seed writer immediately sees "3 people you follow have endorsed this person" for other seed writers.
3. The product demonstrates what the trust graph is *for*. A user encountering a populated Trust panel understands the feature in seconds; a user encountering an empty Trust panel needs it explained.

The seed cohort is the answer to the attestation cold-start problem that every similar product either ignores or pretends to solve with algorithms. Letterboxd, Are.na, Substack Notes — every curated network of any quality was bootstrapped this way, by a founding cohort that knew each other.

## §II.13 Open questions

1. **Credibility bracket thresholds (Phase B).** How many brackets, and what track-record metrics determine placement? Needs empirical tuning once real attestation data exists.

2. **Phase A → Phase B transition timing.** No fixed schedule. Criteria are: attestor count, visible user demand, engineering headroom. Revisit at each quarterly review.

3. **Small-scale decay and scoring rules.** The graduated decay bands (1–3, 4–6, 7–9, 10+) and the attestor weighting cap values (365 days, 50 readers, 10 articles) are initial estimates. Tune with real data from the first year.

4. **Attestation dimensions beyond the initial four.** The architecture supports adding dimensions without structural changes, but each new dimension increases prompt complexity and gaming surface. Defer additions until the initial four are in heavy use.

5. **Trust pip thresholds.** The three-state Layer 1 logic (known/partial/unknown, implemented in `trust-layer1-refresh.ts`) is a starting point. Calibrate once there are enough diverse accounts to test against.

6. **Dark mode for the Trust panel.** The bar colours (green/amber/grey/crimson) need dark-mode equivalents that preserve contrast and the contested-state stripe visibility.

7. **Cross-graph structural analysis (Phase B).** How aggressively to monitor for cases where the private graph's structure could be correlated with the public graph to narrow anonymity sets. An ongoing analytical task.

8. **Noise injection in published scores.** Whether to add differential-privacy noise to published reputation scores to prevent back-calculation of individual attestation changes from score deltas. Trade-off: privacy vs. precision. Likely needed at Phase B scale.

### Resolved design decisions

- **Anonymity strategy:** Phase A (weak, platform knows) at launch; Phase B (strong, dual-graph) when warranted. Not year one.
- **Epoch length:** quarterly for full aggregation; twice-weekly mopping-up rounds; small-subject scoring runs on every mopping-up round.
- **Prompt batch window (Phase B):** week-long with per-node jitter (revised from the earlier 24-hour window — 24 hours is too tight against online-activity correlation).
- **Voucher rate limit (Phase B):** one per epoch-quarter per user, re-requestable if lost. Not aggressive.
- **Anonymous node recovery (Phase B):** user-held seed phrase on the Nostr nsec / Bitcoin wallet threat model. Loss is accepted, not engineered around.
- **Layer 4 mechanism:** public endorsements alongside aggregate-only / anonymous attestations. Public endorsements provide attributable relational data; aggregate-only and anonymous attestations provide privacy-preserving (in their respective senses) global scores.
- **Layer 4 computation:** uses the viewer's public-side signals intersected with public endorsement data. Never correlates the viewer's public and anonymous identities.
- **Small-subject scoring:** subjects with fewer than 10 attestations are scored every mopping-up round and have freshness decay graduated (fully paused at 1–3 attestations, ramping to full at 10+). Prevents degenerate small-scale cases without creating a decay cliff at the threshold.
- **Phase A architecture:** gateway routes + feed-ingest cron jobs, not a separate service. Attestation-service extracts at Phase B when isolation is required.
- **Phase A attestor weighting:** product formula over four normalised sub-scores (age, payment, readership, activity). Concrete cap values specified; tunable with real data.
- **Bootstrap cohort:** 20–50 known writers and editors seed the public endorsement graph at launch. Explicit and acknowledged in launch messaging.

---
---


# Book IV — Implementation plan

## §IV.1 What exists already

| Component | Status | Role |
|---|---|---|
| Nostr keypair infrastructure | Built | Public identities |
| NIP-44 encrypted DMs | Built | Phase B encrypted channel (not yet used) |
| Nostr relay infrastructure | Built | Transport |
| Reading-tab payment system | Built | Layer 1 signal; Sybil resistance for registration |
| User identity and profile system | Built | Public graph node identity |
| Feed-ingest service (Graphile Worker) | Built | Aggregation; cron infrastructure |
| Content-tier system | Built | Distinguishes native, federated, bridged content |
| Key-custody service | Built | Custodial Nostr keys (public only — NOT for anonymous keys in Phase B) |

## §IV.2 Services: what's new, what changes

### Phase A: gateway routes + feed-ingest cron jobs (no new service)

Phase A attestation is CRUD over a Postgres table with the same auth middleware as every other gateway route. It does not warrant a separate service. The vouch endpoints live in the gateway; the aggregation jobs live in feed-ingest alongside the existing cron infrastructure.

**Gateway additions:**

```
gateway/src/routes/vouches.ts     # POST /api/v1/vouches, DELETE /api/v1/vouches/:id
gateway/src/routes/trust.ts       # GET /api/v1/trust/:userId (Layer 1 + scores + Layer 4)
gateway/src/services/trust.ts     # aggregation logic, weighting, Layer 4 computation
```

**Feed-ingest additions:**

```
feed-ingest/src/tasks/
├── trust_layer1_refresh.ts       # daily: recompute trust_layer1 from existing tables
├── trust_epoch_aggregate.ts      # quarterly: full dimension score recomputation
├── trust_mop_up.ts               # Mon/Thu: partial aggregation for acute changes
└── trust_decay.ts                # quarterly: apply freshness decay
feed-ingest/src/lib/
├── trust-aggregation.ts          # score computation (shared by epoch + mop-up)
├── trust-weighting.ts            # Phase A attestor weighting formula (§II.8)
└── trust-sybil.ts                # cluster detection (weak at small scale)
```

This is consistent with how the rest of the stack works: gateway serves requests, feed-ingest runs background jobs. The aggregation logic lives in `feed-ingest/src/lib/` and is imported by the cron tasks, making it independently testable without standing up an HTTP server.

### Phase B: extract to attestation-service

Phase B's isolation requirements — separate DB user, separate Docker network, separate subdomain, no shared auth on the anonymous path — demand a standalone service. At that point, the aggregation logic extracts from feed-ingest into a new service:

```
attestation-service/        (port 3005)
├── Dockerfile
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # Fastify, NO shared auth on anonymous path
│   ├── routes/
│   │   ├── anonymous-submit.ts   # NIP-44 encrypted attestation intake
│   │   └── register.ts           # blind-signature voucher verification
│   ├── tasks/
│   │   ├── epoch-aggregate.ts    # reads both Phase A (main) + Phase B (private_graph)
│   │   ├── mop-up.ts
│   │   ├── decay.ts
│   │   └── prompt-batch.ts       # week-long prompt window with jitter
│   ├── lib/
│   │   ├── aggregation.ts
│   │   ├── sybil.ts
│   │   ├── weighting.ts          # credibility brackets replace Layer 1 weighting
│   │   └── blind-sig.ts          # RSA blind signature verification
│   └── db/
│       └── queries.ts
└── migrations/
    └── 001_private_graph.sql
```

Phase B infrastructure:

- Separate `private_graph` PostgreSQL schema.
- Own PostgreSQL user with `GRANT USAGE ON SCHEMA private_graph` only.
- Own Docker network isolation, own Nginx upstream (`attest.all.haus`), own log stream.
- Logging discipline: no IPs, no sub-hour timestamps, no request metadata that could correlate with gateway access logs.

Phase A attestations are not migrated to the private graph. Phase A data remains in the main database, attributable, under normal operational security. The Phase A gateway routes (`/api/v1/vouches`) continue to serve public and aggregate-only vouches; the attestation-service handles only the anonymous channel.

## §IV.3 Database schema

### Phase A (main database)

```sql
-- Attestations in Phase A — attributable to the attestor
CREATE TABLE vouches (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attestor_id   uuid NOT NULL REFERENCES users(id),
    subject_id    uuid NOT NULL REFERENCES users(id),
    dimension     text NOT NULL,     -- 'humanity', 'encounter', 'identity', 'integrity'
    value         text NOT NULL,     -- 'affirm', 'contest'
    visibility    text NOT NULL,     -- 'public' (endorsement) or 'aggregate' (hidden from readers)
    created_at    timestamptz NOT NULL DEFAULT now(),
    withdrawn_at  timestamptz,
    UNIQUE (attestor_id, subject_id, dimension)
);

CREATE INDEX idx_vouches_subject ON vouches(subject_id) WHERE withdrawn_at IS NULL;
CREATE INDEX idx_vouches_attestor ON vouches(attestor_id) WHERE withdrawn_at IS NULL;
CREATE INDEX idx_vouches_public ON vouches(subject_id, dimension) WHERE visibility = 'public' AND withdrawn_at IS NULL;

-- Published dimension scores
CREATE TABLE trust_profiles (
    user_id           uuid NOT NULL REFERENCES users(id),
    dimension         text NOT NULL,
    score             numeric NOT NULL,   -- 0.0 to 1.0
    attestation_count integer NOT NULL DEFAULT 0,
    epoch             text NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, dimension)
);

-- Layer 1 signals computed from existing tables
CREATE TABLE trust_layer1 (
    user_id              uuid PRIMARY KEY REFERENCES users(id),
    account_age_days     integer NOT NULL DEFAULT 0,
    paying_reader_count  integer NOT NULL DEFAULT 0,
    article_count        integer NOT NULL DEFAULT 0,
    payment_verified     boolean NOT NULL DEFAULT false,
    nip05_verified       boolean NOT NULL DEFAULT false,
    pip_status           text NOT NULL DEFAULT 'unknown',
    computed_at          timestamptz NOT NULL DEFAULT now()
);
```

### Phase B additions (private_graph schema)

```sql
CREATE SCHEMA private_graph;

CREATE TABLE private_graph.anonymous_nodes (
    pubkey            text PRIMARY KEY,
    bracket           smallint NOT NULL DEFAULT 1,
    registered_epoch  text NOT NULL,
    last_active_epoch text,
    epochs_active     smallint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private_graph.attestations (
    attestor_pubkey text NOT NULL REFERENCES private_graph.anonymous_nodes(pubkey),
    subject_pubkey  text NOT NULL,
    dimension       text NOT NULL,
    value           text NOT NULL,
    epoch           text NOT NULL,
    freshness       numeric NOT NULL DEFAULT 1.0,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (attestor_pubkey, subject_pubkey, dimension)
);

CREATE INDEX idx_priv_attestations_subject ON private_graph.attestations(subject_pubkey);
CREATE INDEX idx_priv_attestations_epoch ON private_graph.attestations(epoch);

CREATE TABLE private_graph.registration_tokens (
    token_hash text PRIMARY KEY,
    used_at    timestamptz
);

CREATE TABLE private_graph.submission_buffer (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attestor_pubkey text NOT NULL,
    subject_pubkey  text NOT NULL,
    dimension       text NOT NULL,
    value           text NOT NULL,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    release_at      timestamptz NOT NULL,
    released        boolean NOT NULL DEFAULT false
);

-- Gateway (Phase B): voucher issuance tracking
CREATE TABLE registration_vouchers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id),
    issued_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id)  -- one voucher per user; re-requesting replaces
);
```

The aggregation seam in Phase B: the epoch aggregation job reads the private graph and writes `trust_profiles` in the main database. The join key is `subject_pubkey` (public Nostr key of the person being attested), which is public information. The attestor's identity never crosses the boundary. Implementation: a second DB connection from attestation-service with a narrowly-scoped user that can `SELECT` from `private_graph.*` and `INSERT/UPDATE` on `public.trust_profiles` only.

## §IV.4 Gateway additions

### Phase A (gateway routes)

- `POST /api/v1/vouches` — create a vouch (attestor from auth; body: subject_id, dimension, value, visibility). Validates dimension and value enums. Enforces the unique constraint (one vouch per attestor/subject/dimension).
- `DELETE /api/v1/vouches/:id` — withdraw (sets `withdrawn_at`, does not hard-delete).
- `GET /api/v1/trust/:userId` — full trust profile: Layer 1 signals (from `trust_layer1`), dimension scores (from `trust_profiles`), public endorsements for the subject, Layer 4 relational data (public endorsements filtered by the authenticated viewer's valued set). Unauthenticated callers receive Layer 1 + aggregate scores only (no Layer 4).

### Phase B additions

- `POST /api/v1/trust/voucher` — authenticated. Checks payment verification, returns a blind signature on the provided blinded value. Rate-limited to one per epoch-quarter per user. This endpoint remains in the gateway (it requires authentication); the attestation-service handles the anonymous registration and submission paths.

**Layer 1 computation:** A Graphile Worker cron job (daily, `trust_layer1_refresh` in feed-ingest) recomputes `trust_layer1` from: `users` (account age), `subscriptions` / `reading_tab_payments` (paying reader count), `articles` (article count), `stripe_accounts` (payment verification), `nip05_verifications` (NIP-05). Computes `pip_status` (known/partial/unknown) from Layer 1 thresholds.

## §IV.5 Client-side components

### Phase A

**Vouching UI** (integrated into writer profiles and trust drill-down):
- "Vouch" button on writer profiles and trust profile drill-down.
- Dimension selector (humanity, encounter, identity, integrity).
- Visibility selector: "Public endorsement" (default) or "Aggregate only" (with plain-text disclaimer about platform visibility).
- One-click flow for public endorsements; one-modal flow for aggregate-only.
- Withdrawal: list of one's own vouches on /network?tab=vouches.

### Phase B additions

**Anonymous key management module** (`web/src/lib/attestation-keys.ts`):
- Generate keypair (secp256k1, Nostr-compatible)
- Store in IndexedDB, encrypted at rest
- BIP-39 mnemonic generation and display
- Restore from mnemonic
- Blind signature request flow (authenticate → get blinded sig → unblind → register anonymously)

**Anonymous attestation UI** (new section, accessible from settings or trust profile drill-down, only renders if anonymous key is present):
- Enable private attestation onboarding (seed phrase flow)
- Prompt display: list of people the user has previously attested to, with affirm/contest/revoke/silent per dimension
- New attestation: select a user, choose dimensions
- All submission goes through NIP-44 encryption to the attestation service

## §IV.6 Standards and prior art being adopted

**Nostr-native:**
- **NIP-58 Badges.** On-protocol format for attestations. All.haus can act as a badge issuer for each dimension and for Layer 1 automatic signals. Badges are Nostr events, portable, verifiable.
- **Nostr Web of Trust.** The follow graph as rudimentary trust layer.
- **NIP-44 encryption** (Phase B transport).

**W3C standards:**
- **Verifiable Credentials v2.0** (W3C Recommendation, May 2025). Standard format for privacy-respecting, machine-verifiable claims.
- **Decentralised Identifiers (DIDs) v1.1** (Candidate Recommendation, March 2026). A `did:nostr` method mapping Nostr pubkeys to DIDs.
- **eIDAS 2.0.** EU digital identity wallets required by end of 2026. VC interoperability.

**Proof of personhood:**
- **Gitcoin Passport / Human Passport.** Credential aggregation from multiple weak signals.
- **BrightID.** Social-graph Sybil detection.
- **Keyoxide / Ariadne Spec.** Decentralised identity proofs.

**From outside the identity space:**
- **Elo / PageRank.** Attestation value depends on attestor standing. Approximated by Layer 1 weighting in Phase A and credibility brackets in Phase B.
- **Collaborative filtering.** Trust is relational.
- **Score opacity.** The trust calculus is opaque in mechanics but transparent in inputs.
- **Decay functions.** Stale attestations lose weight.

## §IV.7 Phasing

Each phase ships independently and produces user-visible value. The numbered phases here are the build order; the Phase A / Phase B distinction in Book I and Book II refers specifically to the anonymity strategy (weak → strong), which is orthogonal to the build phasing. In practice, Build Phases 1–5 deliver Anonymity Phase A; Build Phase 6 introduces Anonymity Phase B.

### Build Phase 1: Layer 1 enrichment

Compute trust signals from existing tables. Surface via trust pips in the feed and Layer 1 stats in the trust profile. **Requires:** `trust_layer1` table, daily cron job, pip rendering in feed items, `GET /trust/:userId` endpoint. **Done.**

### Build Phase 2: Vouching (public and aggregate-only)

Simple CRUD — vouch/withdraw, with visibility selector. Public vouches visible on profiles and trust profile drill-down. Aggregate-only vouches feed the score computation but not the profile display. No cryptography, no anonymous nodes, no epochs yet (scores computed on the fly from active vouches). **Requires:** `vouches` table, gateway endpoints, vouching UI with disclaimer modal, "YOUR NETWORK SAYS" section (Layer 4 from public endorsements). **Done.**

### Build Phase 3: Reader-side product work

**Superseded.** The four-panel workspace originally specified here was retired in favour of the single-surface product model described in `docs/adr/REDESIGN-SCOPE.md`. The frontend work that occupies this phase is now `docs/adr/REDESIGN-SCOPE.md` Phase A — ten incremental changes to the existing codebase rather than a ground-up shell rewrite. See that document for the sequenced item list.

### Build Phase 4: Epoch aggregation and decay

The batch job that turns raw vouches into dimension scores. Layer 1-based attestor weighting (Phase A formula from §II.8). Freshness decay with graduated small-scale protection (§II.8). Mopping-up rounds including the small-subject rule (under-10-attestations scored every round). Publish to `trust_profiles`. Includes dry-run mode for pre-production verification (§IV.8). The trust profile drill-down now shows the full Phase A version: public endorsements + aggregate scores + Layer 4 relational. **Done.**

### Build Phase 5: Graph analysis hardening

Sybil detection, diversity weighting, cluster discounting. This is where Layer 3 starts producing meaningful output — which means it should be built but shouldn't be expected to produce strong signal until the graph densifies.

### Build Phase 6: Anonymity Phase B

Stand up the dual-graph infrastructure. Isolate attestation-service (separate Docker network, separate DB user, separate subdomain). Implement blind signature registration, NIP-44 submission, client-side anonymous key generation and storage. Introduce credibility brackets, periodic re-keying, week-long prompt batching. Phase A vouches remain where they are; Phase B is a separate channel.

### Build Phase 7: Mobile responsive

**Superseded.** The panel-based tablet/mobile workspace originally specified here was retired alongside Book III. The single-surface product model (`docs/adr/REDESIGN-SCOPE.md`) treats mobile as a single-column responsive view on narrow viewports — not a briefing product with panel-swipe navigation. The compose surface on mobile needs its own design pass (overlay vs full-screen-modal vs bottom-sheet). See `docs/adr/REDESIGN-SCOPE.md` Q7.

### Build Phase 8: External content rendering

Server-side readability extraction via the gateway. Exclusion list management. Per-user cache with short TTL. **Gated on legal review** — copyright, ToS, and DMCA considerations must be resolved before this phase ships to users. The link-out fallback card for external content works without readability extraction. See `docs/adr/REDESIGN-SCOPE.md` Phase A item 6.

## §IV.8 Testing strategy

Attestation scoring directly affects user-visible reputation. Incorrect aggregation, weighting bugs, or decay miscalculations corrupt trust scores silently — there is no user-facing error, just wrong numbers. The testing strategy is proportional to this risk.

**Aggregation and weighting (unit tests, high coverage).** The aggregation logic (`feed-ingest/src/lib/trust-aggregation.ts`) and weighting formula (`feed-ingest/src/lib/trust-weighting.ts`) are pure functions: attestation records in, scores out. These are tested exhaustively with Vitest:

- Known-answer tests: hand-computed expected scores for small attestation sets (3 attestors, 5 attestors, 10 attestors).
- Boundary tests: all sub-scores at 0, all at 1, one zeroed, edge of each graduated decay band.
- Decay tests: freshness values after 1, 3, 6 epochs; graduated small-scale decay at each attestation-count band.
- Weighting tests: attestor weight at each Layer 1 profile shape (new/no-payment, mature/verified, payment-only-no-articles).
- Sybil discounting: cluster of 5 mutual-attestors produces the same aggregate contribution as a single attestor.

**Cron jobs (integration tests with test database).** The epoch aggregation, mop-up, and decay tasks run against a test database with seeded attestation data. Assertions check that `trust_profiles` rows match expected values after a full aggregation cycle. These run in CI alongside existing Vitest suites.

**Dry-run mode for production cron jobs.** The epoch aggregation and decay tasks accept a `--dry-run` flag that computes new scores and logs the diff against current `trust_profiles` without writing. This allows manual verification before the first real aggregation run, and can be run ad hoc to check for scoring anomalies.

**Monitoring.** After each aggregation run, log: number of profiles recomputed, largest score change, number of scores that moved by more than 0.2 in a single epoch (an anomaly signal). No alerting infrastructure at Phase A — the logs are sufficient for a single-operator platform. Alerting is future work alongside Build Phase 5.

## §IV.9 What this trades away in the short term

**Bulletproof anonymity at launch.** Phase A attestations are attributable in the platform's database. A subpoena can produce them. The project accepts this in exchange for shipping something users will actually use. Phase B is planned and committed to, not hypothetical.

**Rich Layer 3 signal at small scale.** Sybil detection, diversity weighting, and credibility brackets need a dense graph. The system is built for the architecture; the signal gets richer as the user base grows. Public endorsements carry the relational product in the meantime.


**Full recursive trust weighting.** In a single-graph system with attributable attestations, full PageRank-style recursive weighting is possible. In Phase B's dual-graph system, this is approximated by credibility brackets, which capture track-record quality but not social standing. A highly respected public figure and an unknown newcomer who both happen to be accurate attestors end up in the same bracket. This is a real loss of information and the cost of not bridging the two graphs.

**Relational data from anonymous attestations.** Layer 4 draws on public endorsements only. It cannot say "3 people you trust have anonymously attested to this person's integrity" without breaking the Phase B firewall. Public endorsements are the pragmatic bridge.

**Public verifiability of Phase B weighting.** The private graph's structure is held by the platform and aggregation runs server-side. Users must trust that the published methodology matches the computation. Mitigated by publishing aggregation code and allowing audits; not fully eliminated without exposing the private graph.

**Attestation history on key loss.** Losing a Phase B anonymous device and seed phrase loses that attestor's history. The system does not engineer around this. Same threat model as Nostr nsec / Bitcoin wallet.

## §IV.10 What a real ADR looks like (and when to write one)

This document is a foundation. It is not the right format for recording specific decisions that arise during implementation. From this point forward, discrete decisions should be written as separate ADRs in `/docs/adr/`, numbered sequentially, each following the classical ADR format:

```
# ADR-NNNN: [Short decision title]

## Status
Proposed / Accepted / Superseded by ADR-MMMM

## Context
The circumstance prompting the decision. One or two paragraphs.

## Decision
The decision itself. Short.

## Consequences
What becomes easier, what becomes harder, what is foreclosed.

## References
Links to the relevant sections of the omnibus (Book.Section).
```

Examples of the kind of decision that warrants its own ADR:

- Switching the blind-signature library (Phase B) from one implementation to another.
- Changing the quarterly epoch to monthly or six-weekly.
- Adding a fifth attestation dimension.
- Choosing between two candidate Sybil-detection algorithms.
- Adding a content-warning dimension to attestations.

Examples of things that do *not* warrant an ADR — they are amendments to this document, made by editing the relevant book directly:

- Adjusting Tailwind class values in the design spec.
- Changing the exact wording of the disclaimer modal.
- Renaming a database column before it ships.
- Reordering the build phases (as long as the logic is unchanged).

The test: if a future engineer would want to know *why* a decision was made (not just what the decision was), write an ADR. The omnibus answers "what." ADRs answer "why that and not the alternative."
