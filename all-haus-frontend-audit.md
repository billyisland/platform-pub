# all.haus — Front-End Audit

Ranked by priority: what matters most to converting writers and readers at launch.

---

## What works

**The design system is genuinely distinctive.** Three-voice typographic palette — Literata (writer's voice), Jost (platform voice), IBM Plex Mono (infrastructure voice) — applied consistently across every component. Self-hosted fonts with preload. Crimson as sole accent, black slab rules, square avatars, zero border-radius anywhere. The whole thing reads as a broadsheet newspaper reimagined for the web. This has real character, which is the hardest thing for a new platform to achieve.

**The reading experience is strong.** Hero image extraction, vault decryption via Web Crypto, session-cached unlocks, four paywall gate states handled cleanly, gradient fade above the gate, spend-threshold subscription conversion nudge. The article card in the feed (6px crimson/black left border, Literata italic headline, mono-caps byline) has the same broadsheet quality.

**The social layer is more complete than expected.** Notes, quote-commenting, vote controls, explore/following feed toggle, DM messaging, block/mute lists, DM fee settings.

**The publication system exists.** Three homepage layouts, `/pub/[slug]` routing with about/archive/masthead/subscribe pages, dashboard context switcher between personal and publication, publication-specific tabs for articles/members/settings/rate-card/payroll/earnings. Not a placeholder — it's wired up.

**Data portability is real.** Export modal with portable receipts (cryptographic proof of paid reads) and full account export (keys, receipts, articles).

---

## What needs fixing — ranked by priority

### 1. Open Graph / social sharing metadata

**Impact: critical — determines whether articles spread.**

The root layout metadata is `title: 'all.haus'` and `description: 'A publishing platform for writers and readers'`. No Open Graph tags, no Twitter cards, no per-article dynamic metadata. When a writer shares an article on social media, it unfurls as a generic link with no image, no title, no excerpt. For a publishing platform, shareability is the primary growth mechanism. This is the single highest-leverage fix.

### 2. Email / newsletter delivery

**Impact: critical — the feature Substack writers consider non-negotiable.**

There is no "send this to my subscribers" button, no mailing list management, no email delivery of articles. The email service exists for auth magic links only. Writers evaluating all.haus against Substack will ask "but how do I email my list?" within the first minute. Without an answer, they won't switch.

### 3. Landing page

**Impact: high — first impression for the launch cohort.**

Two headline lines, a slab rule, one paragraph, two buttons. No social proof, no screenshots, no example articles, no visual demonstration of the reading or writing experience. No explanation of the tab model, which is the platform's most distinctive feature. Someone evaluating all.haus has no way to judge the product without signing up. The about page copy is good but it's behind a click.

### 4. Writer analytics

**Impact: high — the thing that keeps writers engaged day-to-day.**

The dashboard has articles, drafts, drives, offers, and pricing tabs but no performance view. No read counts, no unique readers, no referral sources, no earnings charts, no trend lines. Ghost and Substack both surface this prominently. Writers are obsessed with their numbers; without them, the dashboard feels hollow.

### 5. Publication homepage templates

**Impact: high — the thing that sells the "publishing house" pitch.**

`HomepageMagazine` is a featured card plus a two-column grid, all `bg-grey-100`, no images, no hero, no visual customisation beyond layout choice. For the feature meant to differentiate all.haus as "a publishing house you can run," these feel like wireframes. A magazine homepage needs to look like a magazine.

### 6. Writer onboarding flow

**Impact: medium-high — determines whether new signups convert to active writers.**

After signup, no guided setup. No "create your profile, write your first article, set your pricing" sequence. New writers land on the feed with no orientation. The invite system exists (`/invite/[token]`) but there's no post-signup wizard.

### 7. CSP header blocking external images

**Impact: medium-high — will cause immediate problems.**

The nginx CSP sets `img-src 'self' data: blob:`, which blocks all external image URLs. Writers pasting images hosted elsewhere, embedding from CDNs, or using external avatars will hit a wall. The Blossom upload path handles platform-hosted images, but the CSP needs to permit at least the Blossom domain and common image CDNs.

### 8. Import tooling

**Impact: medium — matters for the launch cohort specifically.**

No way to import a Substack archive, Ghost export, or WordPress dump. The launch cohort of 20–30 writers likely have existing archives. A Substack CSV/ZIP importer that converts posts to NIP-23 events would remove a major switching-cost barrier.

### 9. Front-end test coverage

**Impact: medium — risk management.**

No tests in `web/`. The vault decryption pipeline, the paywall gate state machine, the TipTap editor with draggable gate — these are complex interactive flows being tested manually. A handful of integration tests on the critical paths (unlock flow, gate state transitions, publish flow) would catch regressions before users do.

### 10. Dashboard architecture

**Impact: medium — maintainability.**

The dashboard is a single ~530-line page component with pricing, articles, drafts, publication context switching, and publication creation all inlined. As the publication features grow, this will become unmanageable. Extract tab contents into proper route segments or at minimum separate files.

### 11. Dark mode

**Impact: low-medium — reader comfort.**

All-white reading experience with no theme toggle. A significant proportion of readers (and writers working at night) expect this. Not launch-blocking, but it'll generate complaints immediately.

### 12. Design system housekeeping

**Impact: low — code quality.**

"Legacy rule aliases" in `globals.css` suggest a mid-stream design system migration not fully cleaned up. Button styles defined in CSS rather than as Tailwind component classes or React components, splitting styling logic across two layers. The `platform-pub` / `platformpub` naming persists in Postgres credentials and the GitHub repo name while the product is `all.haus`. None of this is user-facing, but it accumulates as maintenance debt.

---

## Summary

The front-end has real character and the core reading/writing/paying experience works. The design system is the strongest asset — it's distinctive, confident, and consistent. The critical gaps are in distribution infrastructure (OG metadata, email delivery), sales surface (landing page), and writer retention tools (analytics). These are the things that determine whether the launch cohort sticks, and they're all addressable without rearchitecting anything.
