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
square." The idiom (centred ∀, serif head, mono copy, single `.btn-accent` CTA)
is unchanged. **Chrome pared back (2026-07-24):** the closed-beta line was dropped
from the landing (it still lives in the topbar CTA cluster + `/waitlist`), the
container widened again `max-w-xl` → `max-w-2xl` and head/propositions/body sizes
bumped (30 / 22 / 17px). The **About link was removed from the topbar** (desktop
nav + mobile sheet, `Nav.tsx`) and the **sitewide `Footer` was unmounted entirely**
(`LayoutShell.tsx` no longer renders `<Footer />`; `Footer.tsx` retained, unused).
Consequence: About / Guidelines / Privacy / Terms are no longer linked from the
logged-out register — reachable by direct URL only.

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

---

## XI. Phase 4 — admission, and the two emails (SPEC, not built)

Written 2026-07-27, from evidence rather than from plan. The operator left three
test entries on the live site and none of them produced an email, which read as
a broken flow; it is not one. **The waitlist sends no email at all, by design
(D2), and nothing in the product reads the table.** What follows specifies the
missing half. Nothing here is built.

### XI.1 What was actually established

Queried on prod, 2026-07-27:

- **Capture works.** Three rows, correctly normalised, spanning one day —
  including one genuine prospect (a journalist's work address) alongside the
  operator's own and one from a disposable-mail domain. `POST /api/v1/waitlist`
  validates and rejects a malformed body, so the endpoint is live and behaving.
- **The mailer works too.** `EMAIL_PROVIDER=postmark` with a key present, so
  magic links send. This is *not* a mail-configuration fault — it is the
  waitlist route never calling `sendEmail`, which is D2 working as written.
- **Nothing reads the table.** No admin surface, no export, no admit path. The
  list is write-only, and the success page tells every joiner "We'll write to
  you when there's room" — a promise with no mechanism behind it and no way to
  see who is owed it short of `psql` on the box.

The third point is the one that matters. A real prospect has been waiting since
the morning of the day the beta's own operator discovered, by accident, that
there was no way to know she was there.

### D6 — The join acknowledgement is sent unconditionally, or not at all

If a joiner gets an email, it goes on **every** accepted submission — new row or
`ON CONFLICT DO NOTHING` no-op — with byte-identical copy. Sending only on a new
insert reintroduces exactly what D2/D5 designed out: an attacker who submits a
third party's address learns nothing from the HTTP response (which is fixed),
but the *presence or absence of a message in that person's inbox* becomes the
side channel instead, and the victim is the one who pays for the probe. The
route must therefore not learn what it does not need: no `RETURNING`, no
branching on rowcount.

The alternative — send nothing, which is today's behaviour — stays legitimate.
What is not legitimate is a confirmation that fires only for new rows.

### D7 — A mail failure must never fail the join

The row is the product; the email is a courtesy. `sendEmail` is awaited outside
the insert's success path and its rejection is caught and logged, never
surfaced. A 500 from the join route means the *storage* failed and the prospect
should retry — it must not come to mean Postmark had a bad minute, or the list
loses people at exactly the moments it is busiest.

The operator notification (D8) is subject to the same rule, and additionally
must not be a per-row send at scale: it is specified as a daily digest, not an
alert, for the same reason the launch cohort is 20–30 people and not 20–30
thousand. At three rows a day the digest is a formality; the point is that the
shape does not have to change when it isn't.

### D8 — Two emails, and they are not the same decision

1. **Join acknowledgement** (to the joiner) — transactional, Postmark's
   transactional stream. Subject to D6 and D7. Its copy has a job the HTTP ack
   does not: the joiner keeps it, so it is the only durable record they hold of
   what they signed up for and how to get off the list. It carries the D5
   purpose line and an unsubscribe that actually deletes the row.
2. **Operator digest** — one message a day, only when the count moved, listing
   what the panel (XI.2) would show. This is the cheapest possible fix for the
   failure that produced this section, and it is worth building *first*, before
   any panel: it turns "nobody knew she was there" into a solved problem in an
   afternoon. **BUILT 2026-07-27 — see XI.4.**

The **admission** email — "there's room now" — is a third thing and belongs with
the admit flow, not here. Note it is arguably bulk rather than transactional;
DEPLOYMENT.md records that new Postmark broadcast streams are rate-limited and
want warming over 2–4 weeks, which is a lead time the first cohort has to plan
around rather than discover.

### D9 — Emailing the list sharpens the legal question, it does not create it

`WAITLIST-PRIVACY-NOTE.md` already carries three points for counsel (consent
sufficiency, a retention backstop, whether a privacy line must sit on the form).
Adding email moves the first from theoretical to live: a single "join the list"
action currently produces no contact, so consent has had nothing to cover.
Before D8.1 ships, the form needs the line the note flags as open, and the
acknowledgement needs the unsubscribe that makes deletion a user action rather
than an operator favour.

### XI.2 The panel — `/admin/waitlist`, a seventh tab  · READ HALF BUILT, see XI.5

Written in the OWNER-DASHBOARD-SPEC §4 idiom so it can be lifted straight into
a build. The dashboard itself shipped 2026-07-22 with six tabs; this is an
addition to it, not part of it.

**Route.** `/admin/waitlist`, tab label "Waitlist", behind `requireAdmin` from
`gateway/src/middleware/admin.ts` (never a re-implementation — the one home).
Backed by a new route group in `admin-dashboard.ts`.

**Reads.** `GET /admin/waitlist` returns the rows plus three counts: total,
joined in the last 7 days, and `publish_interest` true. The counts are the
demand signal D2 promised and nobody has yet seen.

**Columns.** Email · publish-interest · joined (absolute date, not "3d ago" —
an operator deciding a cohort wants the real date) · admitted state. Default
sort newest first. No pagination until it needs it; the beta is 20–30 people.

**Triage, not policy.** The list will attract throwaway addresses — one of the
first three is from a disposable-mail domain. The panel should make that
*visible* (the domain is right there in the column) and must not act on it:
auto-rejecting a domain list is a policy decision with false positives, taken by
an operator looking at a screen, not by a heuristic. Sort and see; don't filter.

**Actions.** One, initially: **Admit**, which is the §3.7 manual admit —
an admin-privileged account create for that email bypassing the `CLOSED_BETA`
constant, followed by the magic link / welcome. It needs state on the row to be
safe (`admitted_at`, and the invite's own `notified_at` if the two can fail
apart), because an admit button with nothing to record it is a double-admit
waiting to happen. **Export CSV** second, for the cohort planning the list
exists to serve.

**Not in scope.** Invite codes, self-serve cohorts, and any automated admission
— all explicitly out of scope of this ADR (§VII) and unchanged by this section.

### XI.3 Order to build

1. **The operator digest (D8.2).** Smallest, and it closes the actual incident.
2. **The panel's read half (XI.2, no actions).** Turns `psql` into a screen.
3. **The admit action + its row state**, which is §3.7's minimum for running a
   beta at all.
4. **The join acknowledgement (D8.1)**, gated on D9's privacy line landing.

Emphatically *not* first: the join acknowledgement. It is the most visible and
the least urgent — it tells people something the success page already told them,
while the operator still cannot see who is waiting.

### XI.4 As built — the operator digest (2026-07-27)

`gateway/src/workers/waitlist-digest.ts`, on the hourly worker tick under
`ADVISORY_LOCKS.WAITLIST_DIGEST` (100008), recipients resolved from
`getAdminIds()` → those accounts' `email`. Cadence dial
`waitlist_digest_interval_hours` (24) in `config-defaults.sql`; the state it
keeps is two `platform_config` keys, both deliberately absent from that file
because absence is the meaningful cold start.

**Two keys, because they are two facts** — and the first cut had one doing
both. `waitlist_digest_watermark` holds a ROW's `created_at` and answers *what
have I already reported*; `waitlist_digest_last_sent_at` holds a CLOCK reading
and answers *am I due*. Conflated, the cadence drifts: a digest sent at 10:00
whose newest row was from 02:00 leaves a watermark eight hours in the past, so
the "24 hours since" test passes at 02:00 the next day and the digest fires
fourteen hours early. Harmless on a quiet list (nothing new, nothing sends),
wrong the moment the list moves.

**The watermark is carried as Postgres's own text, never through a JS Date.**
`created_at::text AS created_at_exact` out, `$1::timestamptz` back in. Postgres
keeps microseconds and a `Date` keeps milliseconds, so a watermark that has been
through `toISOString()` lands up to 999µs *before* the row it was taken from —
and that row satisfies `created_at > watermark` again on the next run. Every
digest would re-report its own newest joiner, for ever.

**Both bugs were found by running it against a real database, and neither was
visible to the unit tests.** The first because the tests set both keys in
lockstep; the second because a mocked JS Date has no microseconds to lose. The
suite (14 cases, `gateway/tests/waitlist-digest.test.ts`) is mutation-checked —
watermark-from-`now()`, bare `UPDATE`, advancing on an empty digest, no due
check, advancing before the send, dropping the publish-interest flag, the
truncated Date, and window/cadence swapped each fail at least one case. The
`::timestamptz` cast is pinned structurally only, and the test says so: a mock
compares strings and cannot see a cast, which is precisely the gap that let the
microsecond bug in.

**Neither key moves unless a send succeeded**, so a Postmark failure retries the
same rows rather than dropping a day of joins (D7); an unconfigured
`admin_account_ids`, or admin accounts with no email, log a warning and move
nothing — otherwise configuring an admin later would start the digest from a
window that skipped everyone who joined while it was unconfigured.

Driven on dev, five runs: cold start reports the window's rows and sets both
keys · an immediate re-run reports nothing · a new joiner with the cadence
rewound reports exactly one, not the whole window again · nothing new moves
nothing · a three-day-old watermark with a digest an hour ago stays quiet.
**Not yet driven on prod**, where the three real rows will produce one digest on
the next deploy — the first thing that happens should be an email naming them.

### XI.5 As built — the panel's read half (2026-07-27)

`GET /admin/dashboard/waitlist` (`admin-dashboard.ts`, `requireAdmin`) +
`web/src/app/admin/waitlist/page.tsx`, and `AdminShell`'s tab list goes from
six to seven. **Path note:** §XI.2 wrote the route as `/admin/waitlist`; the
shipped convention for every dashboard read is `/admin/dashboard/*`, so it
follows the code rather than the spec. The page is at `/admin/waitlist` as
written.

**What it shows.** Four counts — total waiting, joined in the last 7 days, how
many ticked publish-interest, and **when the operator was last told** (the
digest's own `waitlist_digest_last_sent_at`, "Never" in crimson while the list
is non-empty and nothing has gone out). Then every entry, newest first:
address, publish-interest, absolute joined stamp. The last-digest tile is not
in §XI.2's spec; it earns its place because this whole section exists from an
incident about not being told, and the panel is where you would look to find
out whether you had been.

**No actions, and the page says so** rather than showing a control that
half-works: Admit needs `admitted_at` on the row to be safe, so it waits for
its own item. There is no `admitted` column yet for the same reason.

**No filtering, per §XI.2** — the disposable-domain row is returned like any
other, and a mutation that filtered it fails two tests. The domain is on screen
for a person to read; a route that quietly dropped rows would hide someone who
IS waiting and give the operator no way to know.

**The cap is 500 with an explicit `truncated` flag**, not pagination and not a
silent LIMIT. The beta is 20–30 people, but a bare cap reads as "that's
everyone" exactly when it isn't, and the panel prints "showing the 500 most
recent of N" when it bites.

Six route tests, mutation-checked: dropping `requireAdmin`, flipping the sort
to ASC, hard-coding `truncated: false`, filtering a domain in the route, and
nulling the last-digest read each fail at least one. The ASC mutation initially
passed — the mock sorted in JS regardless of the SQL — so the mock now reads
the `ORDER BY` out of the query it is handed. That is the same blind spot that
let the digest's microsecond bug through (XI.4), caught this time by mutating
rather than by production.

**Driven against the dev database through the real middleware**: no session →
401, a genuinely signed admin cookie → 200 with the rows newest-first, and the
7-day count correctly excluding a 9-day-old row. **Not seen in a browser** —
the page compiles and prerenders (1.5 kB), but its rendered appearance in
either mode is unverified.
