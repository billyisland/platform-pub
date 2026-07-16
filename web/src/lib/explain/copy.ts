// =============================================================================
// Explain copy — EVERY caption the Explain engine renders, in one file.
//
// This file is prose only: no engine logic, no ordering, no DOM. Edit any
// string here at will; nothing else needs to change. The engine machinery
// (the ExplainKind union, sequence ordering, program builders) lives in
// ./registry.ts, which imports this file. The type annotations are the safety
// net: deleting or misnaming a caption fails the build instead of silently
// rendering nothing.
//
// Editorial rules (EXPLAIN-ADR Appendix A): no em-dashes; declarative "This
// is…" openings; harmonised grammar for repeated gestures (A.4 notes inline).
// EXPLAIN-ADR Appendix A remains the editorial record; this file is the
// implementation home the engine actually reads.
// =============================================================================

import type { CardFlavour, ExplainKind } from "./registry";

// ---------------------------------------------------------------------------
// Explain-program labels — Appendix A.2 / A.3, verbatim.
//
// `vessel` forks on starter provenance (D7), so it is NOT in this record; its
// two variants are VESSEL_COPY below. `card` here is the FALLBACK card label —
// cards with a recognised flavour render CARD_FLAVOUR_COPY instead.
// ---------------------------------------------------------------------------

export const EXPLAIN_LABELS: Record<Exclude<ExplainKind, "vessel">, string> = {
  floor:
    "This space is yours to fill with feeds. You can have as many as you want, configured as you like and positioned however suits you. They stay where they are put.",
  // disc annotates the REAL ∀ disc (D3, 2026-07-15 form: only the wordmark
  // gives way to the About button, so the disc stays on screen and is
  // described as itself).
  disc:
    "This is the ∀ menu, where everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn. While Explain is on, clicking it simply takes you back to your workspace.",
  about:
    "This opens About: a fuller account of what all.haus is and how it works, worth reading once.",
  pane: "This is a pane, floating over your workspace. Drag it by any empty part of itself to move it, and it will remember where you leave it. Close it by clicking outside, pressing Escape, or with the ✕ in the corner.",
  // First sentence deliberately echoes vessel.resize: same grammar for the
  // same gesture (Appendix A.4 harmonisation note).
  "pane.resize":
    "Drag this corner to make the pane bigger or smaller. It will remember the size you choose.",
  "pane.frame":
    "This frame takes its colour from the feed you opened this from, so you can tell at a glance where a pane came from. Panes opened any other way go without.",
  "pane.ear.prev":
    "This steps back to the previous article in the feed you came from. The ← key does the same.",
  // The ↑/↓ hint lives on this ear only, so the pair never repeats it verbatim.
  "pane.ear.next":
    "This steps forward to the next article in the feed you came from. The → key does the same, and ↑ and ↓ scroll the page as you read.",
  reader:
    "This is the reader. Anything you open from a feed is read here: pieces by all.haus writers and pieces from elsewhere, all in the same place.",
  "reader.gate":
    "This is where the free part of the article ends. Continue and the price is added to your reading tab: you pay only for what you read, and settle the tab later. The tab lives under Ledger in the ∀ menu.",
  composer:
    "This is the note composer. A note is a short post, published under your name to anyone who follows you, here and on the open network beyond. Replies and quotes are written in this same box.",
  "composer.crosspost":
    "One switch per network you have linked: dark means this note will also post there. The default for each network is set in Settings, under Reach other networks.",
  "composer.article":
    "This carries what you have written into the article editor. Articles have no length limit and can take a title, a standfirst, images, tags and a paywall.",
  editor:
    "This is the article editor. Write on the page below; the toolbar handles formatting, images, embeds and the paywall. Your work saves itself as a draft while you write.",
  "editor.dek":
    "This is the standfirst: one line under the title saying what the piece is about. It travels with the title on the article's card in feeds, and it is optional.",
  "editor.paywall":
    "This places a paywall in the article. Everything above the line stays free to read; everything below it is paid. Click again to take it out.",
  // First sentence deliberately identical to reader.gate: the same object,
  // seen from the writer's side (Appendix A.4 harmonisation note).
  "editor.gate":
    "This is where the free part of the article ends. Readers continue past it by paying the price set below, which goes on their reading tab.",
  "editor.price":
    "This is what a reader pays to read past the paywall. A suggested price appears based on length, but it is yours to set.",
  "editor.tags":
    "Tags say what the piece is about. Each tag has its own page collecting everything published under it, and readers can add a tag to their feeds as a source.",
  "editor.schedule":
    "This publishes the article later, at a time you choose. A scheduled piece waits in your dashboard and goes out on its own.",
  "editor.draft":
    "Saving happens by itself as you write; this button saves on demand. Drafts live in the dashboard, under the ∀ menu.",
  "editor.publication":
    "This chooses who the article goes out as: yourself, or a publication you belong to. Depending on your role there, a publication piece may need an editor's approval before it goes live.",
  feedComposer:
    "This is the feed composer: everything about one feed is decided here. Its name, its sources and their volumes, how it looks, and where it sits in the order.",
  // First sentence deliberately identical to vessel.addSource: one grammar for
  // one gesture (Appendix A.4).
  "feedComposer.addSource":
    "Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Paste whatever you have, a username, a URL, an npub or a #tag, and it will be worked out.",
  "feedComposer.source":
    "This is one of the feed's sources. Click its name to have a look at it; the × at the end of the row removes it from this feed.",
  "feedComposer.volume":
    "This is the source's volume in this feed: quieter to the left, louder to the right, and the × in front mutes it without removing it. RANDOM and TOP choose which of its posts get through when it is turned down, and NO REPLIES keeps only its freestanding posts.",
  "feedComposer.reach":
    "These add the site's shared streams to the feed: Following is everyone you follow, Explore is the wider platform. Either can sit alongside individual sources.",
  "feedComposer.colour":
    "This cycles the feed's colour scheme. The swatch is its only name: three bars for the feed's frame, its ground and its cards. Light or dark follows your sitewide appearance setting; the character is the feed's own.",
  "feedComposer.view":
    "This cycles how much of each post the feed shows: condensed, standard, or full.",
  "feedComposer.orientation":
    "This turns the feed between tall and wide. The symbol is the feed's own container, open on the side it grows from.",
  "feedComposer.textSize":
    "This steps the feed's text size, one to five. It belongs to this feed alone; the sitewide type size lives in Settings.",
  "feedComposer.order":
    "Drag the rows to put your feeds in order. The numbers here are the numbers the feeds wear on the floor, and on a phone this is the order you swipe through. Hidden feeds keep their place but wear no number.",
  // Verbatim reuse of vessel.hide: one grammar for one gesture (Appendix A.4).
  "feedComposer.hide":
    "This hides the feed without destroying it. Restore a hidden one from the menu at any time.",
  "feedComposer.delete":
    "This deletes the feed for good. If you only want it out of the way, hide it instead.",
  // --- C3: destination surfaces (Appendix A.3d) ---
  messages:
    "This is your inbox, in three parts: notifications on the left, your conversations in the middle, and the open conversation on the right. Everything addressed to you lands somewhere here.",
  "messages.notifications":
    "This is the activity log: follows, replies, quotes, mentions, and news from any publication you belong to. Click a row to open the thing it is about; a message notification opens the conversation here in place.",
  // Echoes the omnivorous grammar of feedComposer.addSource ("whatever you
  // have"): one grammar for one gesture (A.4).
  "messages.new":
    "This starts a conversation. Address it with whatever you have: a username, an email address, an npub.",
  "messages.thread":
    "This is the open conversation. Write at the bottom; hover any message to like it or answer it directly. Older messages load from the top.",
  dashboard:
    "This is your dashboard: what you have written, who subscribes to you, what your work earns and what it costs to read. Money itself moves in the Ledger; this is where you run the writing.",
  "dashboard.context":
    "Dashboards come one per identity: your own, and one for each publication you belong to. Switch here, or start a new publication.",
  "dashboard.articles":
    "Drafts and published pieces share this table, drafts first. Schedule a draft and it publishes itself at the time you set; publish it and the draft is cleared away, leaving the piece with its reads and earnings. Replies turns a piece's thread on or off.",
  "dashboard.gifts":
    "This makes gift links for a paywalled piece: anyone opening one reads it free. Each link carries a set number of uses and can be revoked.",
  "dashboard.pricing":
    "Your prices live here: what a monthly subscription to you costs, and the default price of a paywalled article, either scaling with length or fixed. Getting paid out needs the Stripe connection at the bottom, made once.",
  library:
    "This is your library: pieces you have bookmarked and pieces you have read. Anything here opens straight back into the reader.",
  "library.bookmarks":
    "Pieces you have saved with the Bookmark action on a card. They stay here until you unbookmark them.",
  "library.history":
    "Every piece you have opened, newest first, marked paid or free. What the paid ones actually cost you is in the Ledger.",
  network:
    "This is your network: who you follow, who follows you, and the accounts you have blocked or muted.",
  "network.dmFee":
    "This puts a price on messages from people you don't follow: set one and a stranger pays it to reach you. Blank means anyone can write free. Overrides give particular people a different price, or none.",
  // Teaches the feed-derived external-follow invariant from the reader's side.
  "network.following":
    "Writers you follow on all.haus. Following someone from another network works differently: add them to one of your feeds, and the following is done there.",
  "network.blocked":
    "Accounts you have blocked: they disappear from your feeds and can no longer reply to your work. Unblock here.",
  "network.muted":
    "Accounts you have muted: you no longer see them, and they are not told. To also stop someone replying to you, block instead.",
  // Carries the Ed-approved "this is your reading tab" sentence (C3 scope).
  ledger:
    "This is your ledger: everything your account earns and spends, listed to the penny. Most of it is your reading tab: paid pieces add their price as you read, and the tab settles in one small charge later, not one card form per article.",
  "ledger.balance":
    "One figure for the whole account: what you have earned minus what you have read. In credit, the balance is yours; outstanding, it settles from your card when the tab reaches its threshold.",
  "ledger.allowance":
    "This is your free allowance, spent before the tab is touched: paid reading draws it down first, and only when it is gone do prices start landing on your tab.",
  "ledger.transactions":
    "Every movement, one row each: reads, settlements, subscriptions, earnings. Filter by direction, or hide the free reads.",
  "ledger.subscriptions":
    "Subscriptions you hold. Each row manages its own: whether new pieces reach your email, whether the subscription shows on your profile, and cancelling, which keeps your access to the end of the period.",
  settings:
    "These are the account's settings: who you are, how you pay and get paid, how far your words travel, and this device's preferences. Anything about a particular feed lives in that feed's composer instead.",
  "settings.payment":
    "The card on file settles your reading tab, at the threshold or monthly, and pays for subscriptions. Stripe Connect is the other direction: it is how your earnings reach your bank.",
  "settings.discovery":
    "This is your visibility on the open Nostr network. Public publishes your profile beyond all.haus, so people anywhere can find and follow you; Private withdraws it.",
  // Reciprocates composer.crosspost ("The default for each network is set in
  // Settings, under Reach other networks").
  "settings.reach":
    "Networks you have linked, and what each may do: whether your notes crosspost there by default, and whether the people you follow there can be brought into your feeds. The composer's per-note switches start from these defaults.",
  "settings.theme":
    "Light or dark for the whole site, on this device; System follows the machine's setting. Feeds keep their own colours in both.",
  // Reciprocates feedComposer.textSize ("the sitewide type size lives in
  // Settings").
  "settings.typeSize":
    "This steps the site's type size on this device. A single feed can be stepped on its own too, from its feed composer.",
  "settings.export":
    "This downloads everything that is yours: your keys, your writing, your receipts. The keys are the point: with them, your identity and your audience work anywhere on the open network, not just here.",
  // --- C4: profile + surface overlays (Appendix A.3e) ---
  profile:
    "This is a profile. Writers on all.haus and people from other networks both open here, the same way: who they are, what they have posted, and the ways to follow them.",
  "profile.follow":
    "This follows the writer: their posts reach any of your feeds carrying the Following stream. Everyone you follow is listed under Network in the ∀ menu.",
  // Teaches the feed-derived external-follow invariant from the doer's side,
  // reciprocating network.following (A.4).
  "profile.followFeeds":
    "This follows someone from another network, and that works by feed: pick which of your feeds should carry their posts, or start a new one for them. Sitting in at least one feed is what following means.",
  "profile.handle":
    "This opens their profile on their home network, in a new tab. The @handle is the one link that leads off all.haus.",
  // Money site (Ed-approved 2026-07-16). One kind for both states: the copy
  // reads for Subscribe and for Subscribed/cancel alike.
  "profile.subscribe":
    "This is a subscription to the writer, monthly or yearly: while it runs, their paywalled pieces cost nothing more to read. The charge goes on your reading tab, the subscription is managed from the Ledger, and cancelling keeps your access to the end of the period.",
  "profile.identityLinks":
    "If the same person posts from more than one place, link their accounts here. Your feeds then treat those accounts as one person, and a piece posted to several networks shows only once.",
  source:
    "This is a source's own page: what it publishes, newest first, as far back as all.haus has seen. To keep it in your workspace, add it to one of your feeds.",
  // Second sentence deliberately reciprocates editor.tags (A.4).
  tag: "This is a tag's page, collecting every article published under it. A tag can be added to a feed as a source, like anything else that publishes.",
  pub: "This is a publication: writers publishing together under one name, with a masthead, an archive and followers of its own.",
  "pub.nav":
    "These are the publication's pages: its latest pieces, what it is, who makes it, and everything it has published. Each opens here in place.",
  "pub.follow":
    "This follows the publication: its new pieces reach any of your feeds carrying the Following stream, and arrive by email until you say otherwise.",
  "vessel.name":
    "This is the feed's name. Click to rename it and manage its sources, or click and drag to move the feed container around this workspace.",
  "vessel.gear":
    "Each feed's individual settings live behind this button: renaming, appearance, the full list of sources, and deletion.",
  "vessel.hide":
    "This hides the feed without destroying it. Restore a hidden one from the menu at any time.",
  "vessel.addSource":
    "Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. It all arrives in the same place.",
  "vessel.resize": "Drag this corner to make the feed bigger or smaller.",
  // Fallback card label: renders only when a card carries no recognised
  // flavour (see CARD_FLAVOUR_COPY below).
  card: "This is one item from one of the feed's sources, shown in the order it arrived.",
  "card.byline":
    "Hover over the name to follow this person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.",
  "card.reply":
    "This posts a reply, which appears in the thread underneath the original.",
  "card.quote":
    "This quotes the item into a post of your own, so you can add your thoughts on top. The original stays attached and attributed.",
};

// ---------------------------------------------------------------------------
// Card flavours — the per-kind-of-card variants of the `card` label
// (2026-07-16, third-session amendment). The flavour is derived from the
// post's origin (registry.ts::explainCardFlavour) and carried on the card as
// `data-explain-param`; a card with no recognised flavour falls back to
// EXPLAIN_LABELS.card above.
// ---------------------------------------------------------------------------

export const CARD_FLAVOUR_COPY: Record<CardFlavour, string> = {
  "native-article":
    "This is an article by an all.haus writer, arriving in the feed like everything else. Click the card and the whole piece opens in the reader.",
  "native-note":
    "This is a note by an all.haus writer: a short post, shown in the order it arrived. Click it to open the conversation around it.",
  nostr:
    "This is a post from the open Nostr network beyond all.haus, arriving in the feed like everything else its sources publish.",
  atproto:
    "This is a Bluesky post, arriving in the feed like everything else its sources publish.",
  activitypub:
    "This is a post from the Fediverse, Mastodon and its relatives, arriving in the feed like everything else its sources publish.",
  rss: "This is an item from an RSS feed: a blog post, an article, whatever the site publishes. It arrives here like everything else.",
  email:
    "This is an email newsletter, caught by the feed and read here instead of in your inbox.",
};

// ---------------------------------------------------------------------------
// The vessel label — forks on starter provenance (D7): the Billy Island copy
// renders only on the actual starter clone.
// ---------------------------------------------------------------------------

export const VESSEL_COPY = {
  starter:
    "A feed is a list of sources plus the weights you have given them. To get you started, this one is copied from a feed belonging to Billy Island, founder of all.haus. For better or worse, it reflects his interests. Change what's in it, or delete it if you want to start fresh.",
  neutral:
    "A feed is a list of sources plus the weights you have given them. Change what's in it, or delete it if you want to start fresh.",
} as const;

// ---------------------------------------------------------------------------
// First-run program copy — Appendix A.1, six beats, verbatim. The beat
// STRUCTURE (anchors, floats, the done affordance) lives in
// registry.ts::firstRunBeats; only the prose is here.
// ---------------------------------------------------------------------------

export const FIRST_RUN_COPY = {
  vesselStarter:
    "This is a feed: a list of sources plus the weights you have given them. This one is copied from a feed belonging to Billy Island, founder of all.haus, and for better or worse it reflects his interests. It's yours now. Change it or delete it as you see fit.",
  vesselNeutral:
    "This is a feed: a list of sources plus the weights you have given them. It's yours to change or delete as you see fit.",
  addSource:
    "You can add a source here: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Everything arrives in one place and reads the same way, so you don't need a separate app for each.",
  byline:
    "Hover over a name to follow that person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute. The mixing is done by you, not for you.",
  disc: "This is the ∀ menu, the one place everything runs from: writing, searching, your messages, your money, your settings. Next to it, About has the fuller account of what all.haus is and how it works, worth reading once. There is no other interface to learn.",
  floor:
    "Make as many feeds as you like and arrange them however suits you. They stay where they are put.",
  finale:
    "There is no algorithm here. Your feeds run in order of time, weighted by you and answerable to nobody else. Whatever you publish lives on an open protocol and remains yours wherever you take it. The public square should not have a landlord.\n\nYou can press Explain at any time to be shown how anything works.",
} as const;
