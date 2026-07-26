# Logged-out register sweep — 2026-07-25

Retiring the last of the marketing/auth design language and putting every
logged-out surface on the member grammar.

---

## I. The finding

`/` was restyled onto the member grammar (bone floor, ⊔ walls at the 8px
lattice, cards, lockup docked in a bottom nav row). `/about` and `/admin/*` had
already been added to `LayoutShell`'s `chromelessRoute` allow-list. Everything
else logged-out still ran the **retired register**: a 60px black topbar over a
white page with a narrow centred column.

That meant the site shipped two houses at once. A visitor landing on `/` met
one; a visitor following a shared article link — the commonest way anyone
arrives at a platform like this — met the other. An allow-list that grows every
time a page is redesigned is a migration in progress, not a design.

**The inventory, as found:**

### A. The chrome
| Thing | State |
|---|---|
| `components/layout/Nav.tsx` | Black beam, bare 21px crimson ∀ + white wordmark, `MobileSheet` of auth links. Self-described in-file as "the logged-out marketing/auth register". |
| `LayoutShell` `chromelessRoute` | Allow-list of three: `/`, `/about`, `/admin*`. |
| `components/layout/Footer.tsx` | **Orphan** — no importers. Black bar linking `/community-guidelines`, `/privacy`, `/terms`, **none of which exist as routes**. |

### B. Auth register — one shared retired chassis
`max-w-sm` (384) · `py-28` · white page · `1.5px solid var(--ah-grey-200)`
inputs · full-width `.btn` · ∀ used as a decorative dingbat.

- **`/auth`** — login form, Google button, `.rule` "or" divider with a
  white-backed word knocked out of it, dashed-border dev block, magic-link-sent
  state.
- **`/waitlist`** — same chassis; checkbox; joined state.
- **`/auth/verify`** — the worst drift in the app: `font-sans text-xl font-bold`
  headings (a type role that exists nowhere else — the house is serif for claims,
  mono for prose), a `border-2` spinning ring, and a `bg-green-100 /
  text-green-600` tick straight out of Tailwind's defaults.
- **`/auth/google/callback`** — a bare grey mono line centred on nothing.

### C. `/about`
Chromeless already, but pre-restyle throughout: `max-w-article` column on white,
`font-sans` body where `/` uses mono prose, a 4xl serif "all.haus" standing in
for the lockup, `slab-rule-4` dividers, a centred ∀ dingbat, a `btn-accent` CTA.

**Copy also stale.** Writer-first ("A place to write, publish and get paid";
"Writers post Articles… Readers follow for free") against the readers-first
repositioning. `/`'s metadata moved; About's did not.

### D. Transactional pages a logged-out visitor can reach
| Page | Offence |
|---|---|
| `/invite/[token]` | `animate-pulse rounded` skeleton (l. 50) · off-palette · bare crimson text links |
| `/subscribe/[code]` | `animate-pulse` skeletons (ll. 66–68) · off-palette colour |
| `/tribute/claim` | retired chassis |
| `/pub/[slug]/subscribe` | `border border-grey-200 rounded p-6` cards (ll. 31, 37) |
| `/pub/[slug]/masthead` | retired chassis (the `rounded-full` avatars are fine — avatars are circles) |

### E. Public share/SEO pages
`/article/[dTag]` · `/read/[postId]` · `/[username]` · `/tag/[tag]` ·
`/source/[id]` · `/pub/[slug]*`

A logged-in visitor bounces into the workspace overlay
(`WorkspacePaneRedirect`); a logged-out one gets the full page **under the black
topbar**. By traffic this is the largest logged-out surface and was the most
inconsistent. `/read/[postId]` also carries a `shadow-sm` (l. 75).

### F. Boundaries
- `error.tsx` — retired register.
- **No `not-found.tsx`.** Every 404 fell through to the Next.js default —
  centred sans-serif "404 | This page could not be found" on white with a
  hairline divider. The single most off-brand screen on the site, and the
  easiest to reach: several routes call `notFound()` deliberately.
- No `loading.tsx`.

---

## II. Decisions

1. **The topbar is deleted, not restyled.** Every route is chromeless. The sole
   chrome a logged-out visitor sees is one nav row, in one place, on every
   route.
2. **The row is mounted once, in `LayoutShell`**, for any *resolved*
   logged-out visitor on any non-workspace route — which is what makes tranche E
   nearly free: the share/SEO pages keep their bodies and inherit the row and
   the reserved band rather than each opting in.
3. **Single-wall ⊔ for every public page except `/`.** The doubled wall is an
   argument about the lattice, worth a frame's weight on the one page whose job
   is to state the house's terms, and not worth it around a login form.

---

## III. What ships in this tranche (A, B, C, F)

**New — `web/src/components/public/`**

| File | Role |
|---|---|
| `palette.ts` | `usePublicPalette()` (`basic` × resolved dark) + the register's constants: `WALL 8`, `GRID 8`, `PAD 16`, `GAP 12`, `SLAB 4` |
| `PublicVessel.tsx` | Single-wall ⊔ + `PublicCard` / `PublicTitle` / `PublicBody` |
| `PublicNavRow.tsx` | Supersedes `LandingNavRow`. Route-aware left end — each page shows the destination it is *not* |
| `PublicShell.tsx` | Bone floor + two measures only: `prose` 720, `form` 480 |
| `Field.tsx` | `TextField`, `CheckboxField`, `PublicButton`, `PublicLink`, `FormError`, `OrDivider` |

**Rewritten** — `LayoutShell.tsx`, `/`, `/auth`, `/waitlist`, `/auth/verify`,
`/auth/google/callback`, `/about` (+ its metadata), `error.tsx`.
**New** — `not-found.tsx`.
**Deleted** — `components/layout/Nav.tsx`, `components/landing/LandingNavRow.tsx`.
**Appended** — `globals.additions.css` → `globals.css` (indeterminate slab).

### Design rules the primitives encode

- **Fields are cards with a 4px slab under them.** The house has three line
  weights — the 8px wall, the 6px slab, the 4px slab. `1.5px solid grey-200` was
  the only survivor under 4px anywhere in the app. Nothing is boxed; the slab
  says "write here" the way a ruled line on paper does.
- **Focus is the slab going crimson.** The element already has a line, so the
  line is what changes.
- **No spinner.** A spinning ring is a radius, an animation and a borrowed idiom
  at once. `/auth/verify` gets a crimson slab sweeping the 4px field it already
  occupies; `prefers-reduced-motion` pins it full-width and lets the heading
  carry the state.
- **No tick glyph.** Success is the word, in the serif, and the redirect.
- **One accent per screen.** `.btn-accent` survives in exactly one place — the
  waiting-list CTA in the nav row, which sits on the un-islanded bone floor
  where the neutral slugs it hard-codes are the right ones. Everything else
  derives from the palette so it inverts with the vessel.
- **One ∀ per screen**, in the lockup, where it is also a link home. The dingbat
  drops from `/auth`, `/waitlist` and `/about`.
- **16px minimum on every input** — below that iOS Safari zooms on focus, which
  on a fixed-nav-row layout strands the row mid-screen.
- **Google's four brand colours are the one licensed off-palette exception**: the
  button is a third-party affordance and must be recognisable as one.

### Two things to check when you wire this up

1. **`ComposeOverlay`'s gate.** It was `{!chromeless && <ComposeOverlay />}`,
   where `!chromeless` was doing double duty: "there is a topbar" happened to
   coincide with "logged-in platform page, no overlay open". With the topbar
   gone that predicate is always false. The new shell spells it out —
   `mode === 'platform' && !overlayOpen`. Worth a manual pass on the note
   composer from `/feed` and `/dashboard`.
2. **The row waits for auth to resolve.** While `useAuth.loading` is true
   nothing mounts, so a member reloading a share link never flashes "Log in" at
   themselves before `WorkspacePaneRedirect` bounces them. This replaces the
   `paneRedirectActive` suppression the old shell needed.

### `/about` copy — please read before merging

Every **fact** is carried over unchanged: the 8% cut, the £5 of starting credit,
the Tab, the Stripe settlement, the key pair in the locker, the Articles/Notes
distinction. Nothing new is claimed. What changed is the **order of address** —
the reader is the subject of the first three paragraphs and the writer arrives
as someone the reader is paying, which is also the direction the money runs. The
feed paragraph reuses `/`'s approved wording verbatim rather than paraphrasing
it, so a visitor who reads both doesn't meet two accounts of the same feature.

New headline: *"all.haus is a reading platform that pays the people you read."*

---

## IV. Remaining tranches

### Tranche 2 — D (transactional)
Each page keeps its logic and moves onto `PublicShell` + `PublicVessel`. The
specific removals: the `rounded` skeletons in `/invite/[token]` and
`/subscribe/[code]` (they become a `PublicCard` with the indeterminate slab, or
nothing — a sub-second skeleton is usually worse than a blank vessel), the
`border … rounded p-6` cards in `/pub/[slug]/subscribe`, and the off-palette
colours in `/invite` and `/subscribe`.

Note that these pages are **mixed-register**: a logged-in member can also hit
them. They should use the public chassis regardless, on the same reasoning as
`error.tsx` — an invite acceptance is a leaf, not a workspace surface.

### Tranche 3 — E (share/SEO)
Mostly free: they inherit the row from `LayoutShell`. What still needs doing is
a pass on each body for retired language — `/read/[postId]`'s `shadow-sm` is the
one confirmed offender — and a decision about whether these pages get the vessel
or stay full-bleed reading surfaces. **My recommendation: full-bleed.** They are
the reading experience, not chrome around a form; wrapping an article in a ⊔
would put a frame around the one thing the site exists to deliver.

### Tranche 4 — the gap this surfaced
`Footer.tsx` is orphaned and links to `/community-guidelines`, `/privacy` and
`/terms`, **none of which exist as routes** — despite the regulatory push having
produced the Terms of Service and moderation policies. Publishing them is a
logged-out-surface requirement, not a design task, but the sweep is the moment
to notice it. Either delete the Footer or give it somewhere to point.

---

## V. Amendment, same day — vessels are fitted, not documents

Found while building the landing page: letting the vessel grow to its content
and letting the page scroll to find the bottom wall doesn't work. **The
container must be wholly on screen; what's inside it scrolls.**

The reason is worth writing down, because it will come up again: a ⊔ whose
closing wall is below the fold isn't a vessel, it's a left-and-right pair of
rules, and the visitor has to scroll to discover the shape they were meant to
meet on arrival. It also contradicted the workspace, where a feed is always
wholly on screen and its cards move inside it. The public register was
borrowing the workspace's grammar and then breaking its central behaviour.

**Mechanics, copied from `Vessel.tsx` rather than invented:** every frame in the
stack is a shrinkable flex column (`flex: 1 1 0; min-height: 0`), and the
innermost element is the scroll body — `overflow-y: auto`, with `PAD` **on the
scroll body itself**. That last part matters: padding on the scrolling element
travels with the cards, so the first card starts at the mouth and the last ends
at the wall. Padding on the frame would leave a dead band that content slides
under, which looks like a bug.

On `/` the outer frame's `padding: GRID` does *not* move — that padding **is**
the doubled wall's buffer, not content padding.

**Changed:** `PublicShell` (fitted column), `PublicVessel` (scroll body),
`LandingVessel` (same, through two frames), `LayoutShell` (the band becomes a
CSS variable), `globals.additions.css` (`.ah-public-fit`, `.ah-vessel-scroll`).

### Why the band is a variable now, not padding on `main`

The two kinds of public page need the number in opposite directions. A **fitted**
page subtracts it from its height. A **scrolling** page — the full-bleed
share/SEO surfaces, which have no vessel — adds it as bottom padding so the last
line clears the row. Padding on `main` is right for the second and pushes the
first into overflow. So `LayoutShell` publishes `--ah-row-band` and each page
does its own arithmetic. **Tranche 3 must apply `padding-bottom:
var(--ah-row-band)`** to the share/SEO pages; they are the scrolling case.

### Three things this decides that weren't decided before

1. **`dvh`, not `vh`.** On mobile Safari `100vh` is the tallest the viewport
   ever gets, so a `vh`-fitted vessel hides its bottom wall behind the browser
   chrome — the exact bug the fix exists to cure.
2. **Below 480px of viewport height the fit is abandoned** and the page scrolls
   normally. On a landscape phone the remainder is too little to hold a card,
   and a 100px scroll region inside a frame is worse than an honest page scroll.
3. **The scrollbar is styled**, thin and in the walls colour via `currentColor`.
   A default Windows scrollbar inside a ⊔ is a 17px light-grey trough a few
   pixels from an 8px ink wall — it reads as a third wall of the wrong weight.

### Open: what the mouth does

Scrolled content is clipped at a line where there is no wall. Under `basic` the
interior and the floor are the same colour, so a card passing the mouth doesn't
cut against an edge — it slides out of the vessel onto the page, which is
arguably what a mouth should look like. **This needs eyes on it in the
browser.** If it reads as broken rather than as open, the fix is a top wall on
the fitted variant — which makes it a box and loses the ⊔. It is *not* a fade:
that's a gradient, and the house doesn't have one.

### Consequence for `/about`

Fitted vessels make length expensive: everything past the first screenful is
behind a scroll inside a frame. The rewritten About is four cards; it will
scroll on a laptop. Worth deciding whether About should be cut to fit one
screen — see the copy note in §III.
