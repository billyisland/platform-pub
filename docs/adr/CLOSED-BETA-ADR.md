# CLOSED-BETA-ADR: Closed Beta Gating & Waiting List

**all.haus Architectural Decision Record**
**Status:** Accepted — 2026-07-22. **Phase 1 built 2026-07-23**, **Phase 2 built
2026-07-24**, **Phase 3 built 2026-07-24** (local; not yet deployed). All three
phases complete. As-built notes: §VIII (Phase 1), §IX (Phase 2), §X (Phase 3).
**Author:** Ed Lake / Claude (design partner)
**Depends on:** existing magic-link + Google OAuth auth flow (`gateway/src/routes/auth.ts`, `gateway/src/routes/google-auth.ts`)
**Affects:** `gateway/src/routes/auth.ts`, `gateway/src/routes/google-auth.ts`, `gateway/src/routes/` (new `waitlist.ts`), `web/src/app/auth/page.tsx`, `web/src/app/page.tsx`, `web/src/app/` (new waitlist surface), `schema.sql`, `migrations/`

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_.
> Where it names a file, endpoint, column, or constant, treat that as the
> intended shape unless you find a concrete reason it cannot work — in which
> case stop and flag it rather than improvising a divergent design. Phasing is
> in §VI; Phase 1 (the server gate) is the only part that actually _closes_ the
> beta and must land first and independently.

---

## I. Problem statement

all.haus is going into **closed beta**. The intent:

1. **Existing members keep full access.** Anyone who already holds an account
   can still log in fresh — enter email, receive magic link, sign in — not
   merely ride an existing session.
2. **No new accounts.** Account creation is closed to the public.
3. **Prospective users can register interest** via a waiting list, so they can
   be admitted in cohorts as the beta opens up.
4. **The public face repositions readers-first** (see §IV) — a shift away from
   the current author-centric landing copy.

The naive implementation — a splash page, or hiding the "Sign up" button — does
not close the beta. With passwordless auth, "log in" and "sign up" are adjacent
actions, and OAuth auto-provisions. The gate must sit at **account creation, on
the server**, or anyone with the right URL walks in.

---

## II. Entry-path audit

There are three ways into the app. Each was traced before deciding.

1. **Email magic link** — `POST /auth/login` → `requestMagicLink(email)`.
   `requestMagicLink` issues a token only if an account already exists
   (`SELECT id FROM accounts WHERE email = $1 AND status IN ('active',
   'deactivated')`); an unknown email returns `null` silently, and no account is
   created. **This path is already closed to newcomers and already open to
   members.** It needs no change. Deactivated accounts still reactivate on login
   via `/auth/verify`, as promised by the deactivate flow — unaffected.

2. **Email signup** — `POST /auth/signup`. The one email path that creates an
   account (generates a keypair, inserts the row). **This must be blocked.**

3. **Google OAuth** — `GET /api/v1/auth/google` → callback. Finds-or-creates:
   an existing email returns its account; an unknown email calls
   `createGoogleAccount(...)`. **This is the leak** — "Continue with Google"
   silently provisions. New emails must be refused; existing ones pass through.

---

## III. Decisions

### D1 — Gate at account creation, server-side, authoritative

The server refuses to _create_ accounts; it does not merely hide the means to
ask. Frontend changes (§IV) are presentation only.

- **`/auth/signup`** returns `403 { error: "closed_beta" }`. No keypair, no
  insert. Rate-limit config unchanged.
- **Google OAuth**: in the callback, when the lookup finds no existing account
  (`existing.rows.length === 0`), do **not** call `createGoogleAccount`.
  Redirect to the waitlist surface with a closed-beta marker instead. When an
  account exists, proceed exactly as today.
- **Magic-link login**: unchanged — already members-only by construction.

This means the guarantee ("no new accounts") holds even if a stale frontend, a
bookmarked `/auth?mode=signup`, or a hand-crafted request reaches the gateway.

### D2 — Waiting list is capture, not a mailto

A stored list — not an inbox to trawl — because the README lists launch-cohort
recruitment (20–30 users) as launch-blocking, and a captured list _is_ that
pipeline: it lets prospects be admitted in cohorts and demand to be measured.

- New `waitlist` table. Minimal shape: email (unique, lower-cased), an optional
  publish-interest flag (see D3), `created_at`. No more PII than necessary.
- New enumeration-safe endpoint (e.g. `POST /waitlist`) returning a generic
  acknowledgement regardless of whether the email is new or already present —
  mirroring the existing "if an account exists…" posture on `/auth/login`.
  Rate-limited like the other unauthenticated auth routes.
- `mailto:info@all.haus` is retained as a human fallback / contact line, not as
  the primary mechanism.

### D3 — Reader is the default identity; publishing is a soft opt-in

Consistent with the readers-first repositioning (§IV), the waitlist does not
present a "writer / reader" fork. Everyone joining is a reader/user by default;
intent to publish is a single, unticked opt-in ("I'd also like to publish" or
similar). This preserves the cohort-recruitment signal — you can still pull the
would-be publishers out first — without contradicting the readers-first message
on the page.

> **Resolved (2026-07-24, Phase 2 build).** Keep the opt-in. The form carries a
> single unticked checkbox — "I'd also like to publish" — persisted to
> `waitlist.publish_interest` (default false). The email-only alternative was
> declined: the cohort-recruitment signal is worth the one boolean.

### D4 — Frontend presentation

- **Landing `/`** keeps its structure and SSR first-paint. Changes: hero and
  body copy reframed readers-first (§IV); primary CTA changes from "Get started
  — free £5 credit" (→ `/auth?mode=signup`, now a dead end) to **"Join the
  waiting list"**; a secondary **"Log in"** for members; a quiet "Closed beta"
  line. `HomeRedirect` (logged-in → `/reader`) is untouched.
- **`/auth`** defaults to `login` mode. The signup form and the
  signup/login toggle are removed. The Google button stays (it now works only
  for existing accounts, per D1). Two edge cases route to the waitlist surface
  with an explanatory line rather than a raw error: (a) a visitor arriving at
  `/auth?mode=signup` directly, and (b) a new email rejected by the Google
  branch.
- **Waitlist surface** — a page or section carrying the join form (D2) and the
  copy in §V.

### D5 — Privacy / legal posture

Storing prospective-user emails is new personal-data processing. Required
before or alongside Phase 2:

- A lawful-basis and purpose line for the waitlist (what is stored, why, for how
  long, how it's used to invite people), to sit beside the existing DPIA for
  Harper James to review.
- The enumeration-safe response (D2) also avoids leaking, via the waitlist, who
  is already a member.

---

## IV. Repositioning: readers-first

The current landing centres authors ("Free authors. Writing that's worth
something." — own your identity, find an audience that pays). The beta launch
repositions all.haus as **readers-first**. Landing copy refers to **"users"**
rather than "writers" / "authors"; the reader — one place to read everything,
paying only for what's worth it — is the protagonist. Publishing is present but
no longer the headline.

This is a copy-and-emphasis change, not a product change: the underlying
economic model (readers paying for what they read) is unchanged.

---

## V. Copy (drafts — to redline)

Not finished lines; the house voice (terse, literary, unhurried) wants the
author's own ear.

**Landing — closed-beta line**
> all.haus is in closed beta — invited users for now.

**Landing — hero (three propositions).** Superseded the earlier "Read everything
in one place." hero (2026-07-24): a serif head + a numbered manifesto naming the
thesis (ownership / farming / paying writers), then three mono body paragraphs
(omnivorous feeds · pay-a-few-pence · runs on Nostr). Still readers-first per §IV
— it just leads with *why* instead of *what*.
> **all.haus is a writing platform dedicated to three propositions.**
> 1. No one should own the public square.
> 2. Keeping up shouldn't mean being farmed.
> 3. Writing is work and deserves to be paid as such.
>
> Build omnivorous feeds that pull in the whole open social web — Bluesky,
> Mastodon, Substack, plain old RSS — in one place, sorted by rules you set
> rather than rules set on you. No engagement hacks, nothing optimised against
> you. A feed is a tool: you need the right one for each job. At all.haus you
> can create as many as you like.
>
> Read what's worth reading and pay a few pence for it. No subscription, no
> bundle, no commitment you'll forget to cancel. The money goes to whoever
> wrote the thing.
>
> It runs on Nostr: an open protocol with no company behind it, no servers to
> seize, and no owner to sell it to someone worse.

**Waitlist surface**
> **Not open yet.**
> all.haus is in closed beta. Join the list and we'll write when there's room.
> [ email · (opt-in: I'd also like to publish) · Join ]
> _Already have an account? Log in._

**Google-rejection / stray-signup landing**
> You're not in the beta yet. Join the waiting list and we'll be in touch.

---

## VI. Phasing

**Phase 1 — the gate (ships first, alone).** `/auth/signup` → 403; Google branch
refuses unknown emails. This is the only change that _closes_ the beta; it is
correct and shippable without any of the below. Frontend can still show the old
signup UI at this point without weakening the guarantee — the server refuses.

**Phase 2 — waiting list.** `waitlist` table + migration; enumeration-safe
`POST /waitlist`; the join form. Legal line (D5) in parallel.

**Phase 3 — presentation.** Landing readers-first copy + CTA swap; `/auth`
default-to-login and signup removal; edge-case routing to the waitlist surface.

Ordering rationale: Phase 1 delivers the actual guarantee immediately and
independently of any UI work. Phases 2–3 are the experience around it.

---

## VII. Consequences & non-goals

- **Not** invite-code gating — admission is manual/cohort-based off the stored
  list. Invite-code or self-serve cohort tooling is a possible later phase, out
  of scope here.
- **No automated cohort-invite tooling** is built by this ADR. The waitlist
  _stores_ the list; converting a waitlister to a member is a manual/next-phase
  action.
- Landing SEO and positioning are preserved (the page is edited, not replaced).
- Existing members — including those who previously deactivated — retain access
  through the untouched magic-link path.

---

## VIII. As-built — Phase 1 (2026-07-23)

The §II entry-path audit was checked against the code and holds exactly: the
only two production `INSERT INTO accounts` sites are `shared/src/auth/
accounts.ts::signup` (sole caller `POST /auth/signup`) and
`google-auth.ts::createGoogleAccount` (sole caller the unknown-email branch).

**The gate has one home.** `gateway/src/lib/closed-beta.ts` exports
`CLOSED_BETA`; both creation paths read it, so they cannot drift into a
half-open state. Deliberately a **code constant, not an env brake** — reopening
ships with copy and UI changes anyway, so it should be a reviewed deploy, and
the guarantee can never be lost to a missing environment variable. This is why
it carries no `DEPLOYMENT.md` row or compose default (contrast the dark-ship
brake convention, which governs env flags). Reopening = flip to `false`; both
original create paths are intact behind it.

**Two divergences from D1, both forced by the code:**

1. **The Google branch returns JSON, it does not redirect.**
   `/auth/google/exchange` is a POST whose response carries `Set-Cookie`,
   precisely because Next.js rewrite proxies drop `Set-Cookie` on redirects
   (the reason recorded at the top of `google-auth.ts`). So the gateway sends
   `403 {error:'closed_beta'}` and the **frontend callback page** owns the
   routing. D1's "redirect to the waitlist surface" is not available here.

2. **A sliver of frontend was pulled into Phase 1.** §VI says the old signup UI
   can stay, which is true of the *guarantee* but shipped a silent failure:
   `auth/page.tsx` mapped unknown errors to "Something went wrong", and the
   callback page collapsed every non-ok into `?error=google_failed` — a param
   `/auth` then ignored entirely. Both now switch on `closed_beta` and show a
   closed-beta explanation with the `mailto:` fallback (D2). Pointing at the
   real waitlist surface is Phase 2/3's job. This also fixed the pre-existing
   drop of `google_denied`/`google_failed`.

**Verified:** `/auth/signup` → 403 with no account created, including on a
malformed body (it refuses before parsing); magic-link login still mints a
token for an existing member and still creates nothing for an unknown email.
The Google branch cannot be exercised without a Google-signed `id_token`, so it
is covered by `gateway/tests/closed-beta-gate.test.ts` (5 cases: unknown email
creates *nothing* — no keypair, no insert, no session; active and deactivated
members pass through; suspended still refused; and provisioning resumes when
the constant is flipped). The test was mutation-checked — neutering the guard
fails it.

**Not verified:** the rendered appearance of the closed-beta notice (no browser
tooling in the build session). The branches are present in the shipped client
bundles; the copy itself wants the author's ear regardless (§V).

**Carried into Phase 3 — surfaces §IV does not name**, all of which advertise
signup to logged-out visitors: `Nav.tsx` ("Sign up", both desktop bar and
mobile sheet), `about/AboutContent.tsx` (CTA + "£5 credit" prose),
`PaywallGate.tsx` ("Sign up to read" on any shared paywalled article),
`invite/[token]` and `tribute/claim`. The landing **metadata** (title/OG/
Twitter, `app/page.tsx`) also still carries the author-centric line, which §VII
should reconcile. `subscribe/[code]` is already members-only and needs nothing.

**Open, and blocking nothing in Phase 1:** publication invites
(`/invite/[token]`) are a shipped path for recruiting *outside* writers onto a
masthead; Phase 1 dead-ends it. Either it gets a token-scoped exemption (a real
design decision — it is the one hole worth probing) or publications recruit
only existing members during the beta. Note `redirect=` is already inert:
`auth/page.tsx` reads only `mode` and always pushes `/reader`.

---

## IX. As-built — Phase 2 (2026-07-24)

The waiting list, per D2/D3. **Storage, endpoint, surface, and the D5 note; no
Phase-3 presentation** — the landing CTA swap, `/auth` default-to-login, and the
edge-case routing *to* the waitlist surface remain Phase 3.

**Storage.** Migration 162 adds `waitlist(id, email UNIQUE, publish_interest
bool default false, created_at)` — the D2 minimal shape, no more PII than
necessary. `schema.sql` regenerated and the seed re-appended in one step; drift
guard green.

**Endpoint.** `POST /waitlist` (`gateway/src/routes/waitlist.ts`, registered in
`index.ts`, rate-limited 5/min like the other unauthenticated auth routes).
**Enumeration-safe by construction:** email is lower-cased/trimmed and upserted
`ON CONFLICT (email) DO NOTHING`, and the route returns a **fixed
acknowledgement** whether the email is new or already present — it never
branches on the result, so the list cannot be probed for existing membership
(the D5 concern; mirrors `/auth/login`). `publish_interest` is **not** updated
on a repeat POST — the first expressed intent stands, and flipping it would leak
row-existence via a later export. Covered by `gateway/tests/waitlist.test.ts`
(6 cases: normalise + reader-default; opt-in threaded; enumeration-safe repeat
returns the identical body; malformed and missing email rejected pre-write;
storage failure → 500). Mutation-checked — dropping the lower-case or the
`ON CONFLICT` fails it.

**Surface.** `web/src/app/waitlist/page.tsx` — a standalone `/waitlist` page in
the logged-out register (matches the `/auth` page's chrome: serif head, mono
copy, the shared field/`.btn` grammar). Email field + the single unticked
"I'd also like to publish" opt-in (D3) + success state. Copy per §V, to the
author's ear. `web/src/lib/api/waitlist.ts` is the client method.

**D3 resolved:** keep the opt-in (see the D3 note). **D5:** the lawful-basis /
purpose note is drafted at `docs/adr/WAITLIST-PRIVACY-NOTE.md` — what is stored,
consent basis, single purpose, retention, subject rights, and why the endpoint
can't leak membership — with three points flagged for counsel (consent
sufficiency, a retention backstop, whether a privacy line must sit on the form
itself; the form currently carries none, faithful to §V).

**Deliberately deferred to Phase 3** (not oversights): nothing yet *links* to
`/waitlist`. The landing still shows the old signup CTA, `/auth` still defaults
to signup, and the Phase-1 closed-beta notices still point at the `mailto:`
fallback rather than the surface. Wiring those is Phase 3's stated job.

---

## X. As-built — Phase 3 (2026-07-24)

The presentation layer per §IV/D4, plus the §VIII "carried into Phase 3"
surfaces. **Every public signup CTA sitewide now routes to `/waitlist`;** the
only `mode=signup` string left in the code is a comment. Frontend-only — no
gateway, schema, or endpoint change. `next build` green; hairline tripwire clean
on all touched files.

**Landing (`app/page.tsx`).** Readers-first (§IV): originally hero "Read
everything / in one place." + one body line. CTA swap: primary **"Join the
waiting list"** → `/waitlist`, secondary **"Log in"** → `/auth?mode=login`,
"About all.haus" text link, and the quiet "all.haus is in closed beta — invited
users for now." line. Metadata (title/OG/Twitter) reconciled, killing the
author-centric copy §VII flagged. `HomeRedirect` untouched. **Restyled (same day)
into the logged-out register's idiom** — the giant Swiss-sans `hero-headline` and
the 6px `slab-rule` beam (used nowhere else in that register) dropped for the
centred crimson `∀` + serif head + mono copy grammar shared by `/auth`,
`/waitlist`, `/about`; the redundant body "Log in" / "About" links removed (both
in the topbar), leaving one CTA + the closed-beta line. **Copy reworked to the
three-propositions manifesto (2026-07-24, §V):** the single hero line became a
serif head + a numbered `<ol>` (crimson mono numerals, serif propositions) +
three mono body paragraphs; container widened `max-w-sm` → `max-w-xl` to hold the
prose; metadata TITLE/DESCRIPTION re-led with "No one should own the public
square." The idiom (centred ∀, serif head, mono copy, single `.btn-accent` CTA,
closed-beta line) is unchanged.

**`/auth` (`app/auth/page.tsx`).** Rewritten **login-only**: the signup form,
the display-name/username fields, `handleSignup`, and the login/signup toggle are
deleted. The Google button and dev-login stay. The two D4 edge cases —
`?mode=signup` arrived at directly, and `?error=closed_beta` (the shape the
Google callback used to send) — trigger `router.replace('/waitlist?from=beta')`
in an effect, and the component returns `null` while redirecting so the login
form never flashes. Bottom link is now "New here? Join the waiting list". The
inline closed-beta notice + `mailto` fallback (Phase 1's §VIII item 2) is
retired in favour of the real surface.

**Google callback (`app/auth/google/callback/page.tsx`).** The `closed_beta`
branch now routes **straight to `/waitlist?from=beta`** (D4's "route to the
waitlist surface") instead of `/auth?error=closed_beta` — one hop, no
intermediate. `/auth` still forwards a stray `error=closed_beta` as belt-and-
suspenders.

**Waitlist surface (`app/waitlist/page.tsx`).** Gains the §V edge-case line:
arriving with `?from=beta` shows "You're not in the beta yet. Join the waiting
list and we'll be in touch when there's room." in place of the default
subhead. Read from `window.location.search` in an effect, **not**
`useSearchParams`, to keep the page out of a Suspense boundary.

**§VIII carried surfaces, all swept to `/waitlist`:**
- `Nav.tsx` — desktop bar and mobile sheet "Sign up" → "Join the waiting list".
- `about/AboutContent.tsx` — CTA → "Join the waiting list"; the prose's "Sign
  up, log in with Google…" imperative softened to "Log in with Google…" (the
  £5-credit line is a product fact, kept).
- `article/PaywallGate.tsx` — the logged-out branch (shared paywalled article)
  drops "Create a free account / Sign up to read" for a closed-beta line and
  renders a `/waitlist` link in place of the `onUnlock` button (which assumes an
  account). `ArticleReader.handleUnlock`'s logged-out fallback likewise →
  `/waitlist`.

**Two §VIII open items, ruled conservatively (recruit only existing members
during the beta) rather than building new exemptions:**
- **Publication invites (`invite/[token]`)** — the logged-out branch is now
  "Log in to accept" → `/auth?mode=login`, not signup. The token-scoped signup
  exemption for outside writers (§VIII's "one hole worth probing") remains a
  deferred design decision, **not** built here. `redirect=` stays inert as noted.
- **Tribute claim (`tribute/claim`)** — the anonymous CTA → `/waitlist`
  ("Join the waiting list"), keeping the existing-member log-in path. The
  feature is itself dark (`tributesEnabled()` false in prod), so the anonymous
  branch is unreachable there; this is honesty cleanup, not a live path.

**Not verified:** rendered appearance / copy tone (no browser tooling in the
build session; the copy still wants the author's ear per §V). Behaviour is
covered by the build and by manual trace of each redirect.
