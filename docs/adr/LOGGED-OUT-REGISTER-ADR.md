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

*(Amended by §IX 7quinquies, 2026-07-27: the bound stated here — never taller
than the viewport — stands, and a second one joins it: never taller than the
content either. `flex: 1 1 0` below is now `flex: 0 1 auto`, i.e. the same
shrink, no grow. Read the two together before changing either.)*

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

---

## VI. Tranche 2 — the transactional leaves

**Shipped:** `/invite/[token]`, `/subscribe/[code]`, `/tribute/claim`.
**Not shipped, needs a decision:** `/pub/[slug]/*` — see below.

### A correction to tranche 1 first

Deleting the topbar deleted something it was doing that I didn't account for.
The retired `Nav` rendered a **bare wordmark beam for logged-in members** on
standalone routes, and its own comment said why: those routes sit outside the
workspace, so a member who lands on one has no ∀ and no navigation. Tranche 1
gated `PublicNavRow` on `!authedUser`, which left members on exactly these
pages — an invite link in their email, a subscription offer, a shared article —
with no chrome at all.

Fixed by making the row's **left end** the thing that varies by auth, not its
mounting:

- **logged out** — log in / join the waiting list, each page showing the one it
  is *not*
- **logged in** — nothing but the lockup, and the lockup points at `/reader`
  rather than `/`, because sending a member to the landing page means a round
  trip through `HomeRedirect` and a page arguing them into signing up for
  something they have

`LayoutShell`'s gate is now `!authLoading && mode !== 'workspace' &&
!overlayOpen`. It still waits for auth to resolve so a member never flashes
"Log in" at themselves.

### New primitive

`IndeterminateSlab` (in `Field.tsx`), extracted from `/auth/verify` because
three pages now need it. **Use it for waiting on the network, not for
skeletons.** The retired pages drew `animate-pulse rounded` bars roughly the
shape of the content that was coming — a guess about a layout, rendered at the
one moment you can't know it, carrying a border-radius the house doesn't have.

### Per-page notes

**`/invite/[token]`** — no longer centred. Centring is what a page does when it
has one thing to say; this one has four (who, what, which role, and their
message), and ranged left they read as a sequence rather than a poster. The
inviter's message moves from grey italics to the **quoted-post treatment**
(`quoteBg` / `quoteText`), which is the house's existing answer to "someone else
said this". Declining gets a link, not a second button — two buttons of equal
weight would make this a decision the page is pressing for. The publication logo
keeps its circle; `border-radius: 50%` on an avatar isn't a violation, the ∀ disc
is a circle too.

**`/subscribe/[code]`** — the price gets its own card and the largest type on the
page. The serif **italic** display heading is gone: it appears nowhere else in
the app, and the house's serif carries claims upright. `bg-red-50 /
text-red-700` was the last Tailwind-default red in the register.

**`/tribute/claim`** — its local `Card` helper set the title in **Jost, not the
serif**, which made the page read as a system notice rather than as the house
speaking. The states are a routing table, so each is one serif line and one mono
paragraph.

### `/pub/[slug]/*` — a third register, not a page to restyle

This subtree has its own `layout.tsx` mounting `PublicationNav` and
`PublicationFooter`. It is a **publication's own branded space**, not an
all.haus surface, and wrapping its children in our ⊔ would put three sets of
chrome on one screen: the publication's nav, our nav row, and a vessel that
belongs to neither.

Three ways to go, and it's your call:

1. **Leave it a separate register.** A publication is a tenant; its pages look
   like the publication. Then `PublicationNav`/`Footer` need a design pass of
   their own, and our row should probably be suppressed on `/pub/*`.
2. **Fold it in.** Publications become surfaces of all.haus wearing a name and a
   logo, not a house style. Delete the publication chrome, use the row.
3. **Split the difference** — publication chrome on the reading surfaces
   (`/pub/:slug`, the article pages), our chassis on the transactional ones
   (`subscribe`, `masthead`), on the grounds that taking someone's money is
   all.haus's business and should look like it.

Two things to fix in that subtree whichever way it goes, both real bugs rather
than styling:

- **`/pub/[slug]/subscribe` has no subscribe button.** It renders the monthly
  and annual prices and a line saying "Cancel any time", and then stops. There
  is no CTA and no handler in the file.
- **`/pub/[slug]/masthead` sets its `h1` in `font-sans text-3xl`** — the same
  face error `/auth/verify` and `/tribute/claim` had.

### Still open from §V

Nobody has looked at the mouth in a browser yet — whether content clipping at a
wall-less line reads as open or as broken. That gates nothing in this tranche,
but it gates the whole register.

---

## VII. Tranche 3 — the share/SEO surfaces

**Resolved from §V:** the mouth reads as open, not broken. Content clipping at a
wall-less line where interior and floor share a colour is the right behaviour.
No top wall. The fitted vessel stands.

### The finding that shapes this tranche

Every one of these routes delegates to a component that is **also mounted inside
a workspace overlay**:

| Route | Body | Also mounted by |
|---|---|---|
| `/article/[dTag]` | `ArticleReader` | `ReaderOverlay` |
| `/read/[postId]` | `ExternalArticleReader` | `ReaderOverlay` |
| `/tag/[tag]` | `TagBrowser` | `SurfaceOverlay` |
| `/source/[id]` | `SourceSurface` | `SurfaceOverlay` |
| `/[username]` | `WriterActivity` (+ an inline header) | `ProfileOverlay` |
| `/author/[authorId]` | `AuthorProfileView` | `ProfileOverlay` |

That is the right architecture — the share view and the overlay view should not
drift — and it means **any retired styling inside those components is a
workspace question, not a logged-out one.** Restyling them from here would
silently redesign the member surface. So tranche 3 is wrapper-only, and the
audit below is a list for a future workspace pass, not work I've done.

### New primitive

`PublicPage` — the scrolling counterpart of `PublicShell`. No vessel, on
purpose: these pages *are* the reading experience, and a frame around an article
puts a box around the thing the site exists to deliver, then has to scroll
internally, which is the wrong behaviour for a long read.

The band works the opposite way round here. A fitted page **subtracts**
`--ah-row-band` from its height; a scrolling page **adds** it as bottom padding.
`minHeight` is `calc(100dvh - band)` so short content plus the padding comes to
exactly one viewport rather than inventing a scrollbar. `ground` is optional
because `ArticleReader` brings its own (`min-h-screen bg-white`).

### Shipped

Full rewrites: `/source/[id]`, `/author/[authorId]`.
Patches (I only read these files' render bodies, not their metadata halves, so
rewriting them whole would mean reconstructing code I haven't seen):
`TRANCHE-3-PATCHES.md` covers `/read/[postId]`, `/article/[dTag]`, `/tag/[tag]`,
`/[username]`.

### One more real bug

**`bg-grey-50` on `/read/[postId]` does not exist.** The Tailwind theme defines
`grey` at 100/200/300/400/600 only, so the class has always resolved to nothing:
the page has had no background, and the white reading column has been floating
on the browser default. The `shadow-sm` was compensating for the ground that
never rendered. Both go; the column sits on bone.

### In scope on `/[username]` because it's written inline

Two corrections, detailed in the patch file. `font-light` on the serif h1 is a
fourth display weight the type scale doesn't have (everything else is
`font-medium`). And `text-grey-300` — the disabled/placeholder wash — is
carrying the `@username`, the counts and the RSS link, which are facts rather
than hints, at `text-ui-xs` on white, close to the AA floor.

### Audit for a future workspace pass — NOT done here

These are inside shared components and would change the member surface:

- `app/author/[authorId]/AuthorProfileView.tsx:263` — `rounded-full` avatar.
  **Not a violation**; circles aren't softened rectangles. Listed so nobody
  "fixes" it.
- `app/write/page.tsx` — three `animate-pulse rounded` skeletons and an
  off-palette colour. A logged-in surface, so out of this sweep's scope
  entirely, but it is the last home of the skeleton pattern `IndeterminateSlab`
  replaced.

### What's left of the original inventory

Tranches 1–3 close A, B, C, E and F. Outstanding:

1. **`/pub/[slug]/*`** — needs the register decision in §VI, plus the missing
   subscribe button and the `font-sans` masthead h1.
2. **`Footer.tsx`** — orphaned, pointing at `/community-guidelines`, `/privacy`
   and `/terms`, none of which exist as routes despite the documents existing.
3. **`ComposeOverlay`'s gate** — still wants a manual pass from `/feed` and
   `/dashboard` (§III).
4. **Dark mode across the register** — every page resolves `basic` against the
   global toggle, so each has a `BASIC_DARK` twin nobody has looked at. The
   derived `PublicButton` primary inverts to a bone slab on an ink card.

---

## VIII. Dark-mode audit

It did invalidate something. Four real defects, one of them a design decision
rather than a bug, plus two mistakes of my own in the first cut.

### The values, so the arithmetic is checkable

| Token | Light | Dark |
|---|---|---|
| `--ah-bone` (floor, outside the island) | 240 239 235 | **20 19 17** |
| `interior` | `--ah-bone` → 240 239 235 | `--ah-ink-925` → **26 26 24** |
| `walls` | `--ah-ink` → 17 17 17 | `--ah-true-black` → **0 0 0** |
| `cardBg` | `--ah-white` → 255 | `--ah-ink-900` → 35 35 32 |
| `cardTitle` | `--ah-ink` → 17 17 17 | islanded `--ah-bone` → 240 239 235 |
| `crimson` | 181 36 42 | `crimson-soft` → 217 85 90 |

### 1. Every control line vanished in dark — the worst of it

Field underlines, the outline button's border, the "or" divider, the
indeterminate slab's track: all drawn in `palette.walls`. In light that is ink
on a white card and it looked right. In dark it is **0 0 0 on a 35 35 32 card**.
Invisible. That includes the Google button on `/auth`, whose entire visible form
*is* its border — in dark it was a floating label with nothing round it.

The mistake was using a **structural** token for a line that belongs to the
**card**. `walls` is the vessel's frame; it is supposed to recede in dark, and in
the workspace it should.

Fixed with a derived `controlLine(palette)` = `cardTitle`, which is
byte-identical to `walls` in light — **so this is a no-op in light mode** — and
islanded bone in dark, where 4px of bone on ink-900 is the same gesture as 4px of
ink on white. If bone at 4px reads hot once you see it, change it in `palette.ts`
rather than at the six call sites; the fallback is `cardStandfirst`, but that
lightens light mode too, so look at both.

`palette.walls` now survives in exactly one place: the vessel's actual walls.

### 2. Floor stopped matching interior in dark — the design decision

The register rests on floor and interior being the **same colour**. That is what
makes the walls read as ink rules on a continuous ground rather than a box, and
it is why content scrolling out of the mouth vanishes instead of cutting against
a seam — the thing you looked at and approved.

`var(--ah-bone)` delivers it in light. In dark it does not: bone goes to 20 19
17 while the interior stays at ink-925's 26 26 24. Six points apart on a
near-black ground reads as a panel edge, with true-black walls barely visible
around it. **In dark the vessel became exactly the box the design exists to
avoid.**

`PublicShell`'s floor is now `palette.interior`, which is correct in both modes
without an island because the variant selection has already done the work.

**This diverges from the workspace on purpose, and you should know it does.**
There the floor *is* `--ah-bone` and vessel interiors *are* ink-925, so feeds
read as islands on a floor. Right for a workspace holding many feeds; wrong for
a page holding one vessel that is pretending not to be a feed.

**Consequence I have not resolved:** `PublicNavRow` is still `--ah-bone`, so in
dark the row (20 19 17) is now a faintly darker band under a 26 26 24 floor. In
light all three are identical. That may be correct — chrome distinguishing
itself from the page — or it may want to track the floor. It needs your eye.
`PublicPage` keeps `--ah-bone`: no vessel, so nothing to be continuous with.

### 3. `.btn-accent` renders crimson-on-near-black in dark — sitewide

`background: var(--ah-crimson); color: var(--ah-white)`. Crimson isn't a
DARK_SLUG so it holds at 181 36 42, but `--ah-white` **is** one, and html.dark
takes it to 30 29 26. So under dark mode every `.btn-accent` in the app is
crimson with almost-black text.

This is not my register's bug — it is everywhere `.btn-accent` is used. Repairing
`globals.css` is the real fix. I've pinned `color` inline on the row's CTA as a
stopgap and flagged it in the file.

### 4. Two mistakes of mine in the scrollbar rule

- It was `scrollbar-color: currentColor`, on the claim that the scroll body
  inherits the walls colour from the frame. **It doesn't** — nothing sets
  `color` on the frame, so the thumb took whatever text colour was ambient.
- `overflow-y: overlay` was never standardised and Chrome has removed it. It did
  nothing except let the comment claim a floating thumb no browser was giving us.

Both vessels now pass `--ah-scroll-thumb` explicitly, set to `cardMeta` — outside
DARK_SLUGS, so the same quiet grey against either interior.

### What survived unchanged

- `PublicButton` primary: bone slab, ink-900 text in dark. Correct.
- `FormError`: `palette.crimson` auto-flips to crimson-soft (217 85 90) on
  ink-900. Correct, and the reason to use the palette token rather than the slug.
- `PublicBody`: `cardStandfirst` → stone-300 (180 178 169) on ink-900. Fine.
- `PublicNavRow`'s `text-grey-600 hover:text-black` — `black` maps to
  `--ah-ink-rgb`, which inverts to 236 234 230. Works.
- The share/SEO pages: `ArticleReader`'s `bg-white` inverts to 30 29 26 on its
  own, so the reading surface follows the toggle without help.

### Still not verified

None of this has been in a browser in dark mode. The arithmetic says these are
right; the two judgement calls — bone at 4px under a field, and the row's band
against the new floor — are the ones to look at first.

---

## IX. As built — 2026-07-26

Shipped over five commits (`34eb21b`, `c54ad3b`, `84cd85c`, `4fe7266`,
`c58f56f`). Tranches 1–3 are in; §VIII's dark arithmetic is in; nothing has
been in a browser yet.

**Read this section before touching the register.** Everything above is the
plan as drafted; these are the places the plan and the code diverge, and why.

### Departures from the plan

1. **`/` keeps its own chassis.** The draft moved it onto `PublicShell`. Its
   `page.tsx`/`LandingVessel.tsx` had been cut against an earlier `/`, so
   applying them would have reverted the screengrab showcase (`22bac3d`), the
   `'FOR ALL'` coda and the tightened propositions copy (`d5fc4ca`). `/` is the
   register's exception in any case — the only doubled wall, and the only page
   whose vessel IS the page. It gives up only the row: `LandingNavRow` was an
   in-flow 56px band at the end of its flex column, and the space is now
   reserved as `--ah-row-band` of bottom padding, which comes to exactly what
   the in-flow row plus the vessel area's old 8px bottom padding did.

2. **The band is padding INSIDE a full-viewport box, never subtracted from the
   height.** The draft's `calc(100dvh - band)` left the band's GRID of
   clearance — `NAV_ROW_H + GRID` reserved against a `NAV_ROW_H` row — painted
   by nobody, so `body` showed through it as an 8px stripe of the wrong colour
   between the floor and the row. `.ah-public-fit` and `PublicPage` both put
   the band inside now.

3. **The band is reserved from the first paint; only the row waits for auth.**
   Deriving both from `!authLoading` meant every public page laid out at band 0
   and reflowed 64px when `fetchMe` returned. `LayoutShell` now carries two
   flags: `rowSurface` (about the surface) publishes the variable, `showPublicRow`
   (`rowSurface && !authLoading`) renders the row.

4. **`.btn-accent` was repaired at source**, not pinned inline. §VIII.3 was
   right that it is a sitewide bug; the fix is a registry slug for the ROLE —
   `on-crimson`, outside `DARK_SLUGS`, because the ground it sits on never
   inverts either. `::selection` had the same bug and is fixed with it. The
   draft's inline `rgb(255 255 255)` on the row's CTA is gone.

5. **`ground={false}` drops `PublicPage`'s `minHeight` as well as its floor.**
   `/article`'s `ArticleReader` is `min-h-screen bg-white`; a full viewport
   inside a full viewport left the band's worth of dead scroll under every
   short article. A child that owns its ground owns its height.

6. **The lockup on `/` points at `/waitlist`.** `/` is home, so a link home is
   a dead no-op; `LandingNavRow` had made it the get-started target and the
   decision would otherwise have been lost with the file.

7bis. **`/`'s doubled wall is desktop-only** (2026-07-26). Departure 1 calls `/`
   "the only doubled wall", and that now holds at >767px only. On a phone the
   desktop chassis spends 16 (floor) + 8 (wall) + 8 (buffer) + 8 (wall) + 16
   (pad) = 56px **a side**: 112px of a 390px screen, 29%, to argue about an 8px
   square, leaving the prose 278px. So at ≤767px the vessel goes full-bleed —
   floor margin, outer wall and buffer all drop, interior pad halves 16 → 8 —
   for 16px a side and a 358px column. The ⊔ still reads, at mobile weight; what
   goes is the doubled-wall *statement*, which needs room to be one. This is
   MOBILE-LAYOUT-ADR's own grammar (the mobile workspace drops the vessel
   chassis outright for a full-bleed feed) applied one notch softer, not a
   responsive reflow of the desktop reading.

   The geometry moved to `globals.css` §1c (`.ah-landing-area`,
   `.ah-landing-frame`/`-outer`/`-inner`) **because `/` is SSR'd**: `useIsMobile`
   returns false on the server, so a JS breakpoint would paint the 56px desktop
   chassis on a phone and snap to the mobile one after hydration. Only the
   palette-derived wall colour crosses into the component, as `--ah-landing-wall`.
   The outer frame stays in the tree on mobile as a plain flex pass-through
   (`padding: 0; border: 0`) so the component keeps one shape in both modes.
   Measured after the change: phone 390 → card x=16 w=358; desktop 1440 → card
   x=400 w=640, i.e. desktop is unchanged to the pixel. *(The surviving single
   wall went too — **7quinquies**. Everything else here stands.)*

7ter. **`/`'s showcase is live markup, not screengrabs** (2026-07-27). 7bis's
   companion, and it retires the three `.webp` captures that shipped the day
   before along with `LandingShot`, `SHOT_RATIO`, the `failed`/disc-placeholder
   fallback and `next/image` on `/`. The captures were each a full 1848×1056
   viewport shown ~640px wide inside a card at the prose measure — a 2.9×
   reduction, which put the app's 15px body type at about 5px. The four `via …`
   provenance lines ARE the omnivore argument, and they were the first thing to
   dissolve; the captions were left carrying the whole claim, which is the
   definition of a decorative image, and these were meant to be evidence. 7bis's
   own reasoning ("the frame was cut to the shots") reads well and was in fact
   the trap: it locked all three figures to 16:9 landscape, the worst shape for
   interface detail in a narrow column. And screenshots rot — every colour
   retune and card-grammar change dated them silently, with nothing in CI to
   notice.

   Rebuilt as inert components (`components/landing/demos/`, plus
   `LandingFigure` for the figure/caption pairing), each demo reads the same
   palette tokens as the live site, so it inverts with the global toggle for
   free and cannot drift from a retune. They are a deliberate COPY of the card
   grammar rather than a reuse of `PostCard`, which takes a `Post`, resolves a
   level spec and threads eight callbacks — none of it meaningful to a
   logged-out visitor, all of it weight on the one page a stranger loads cold.
   The accepted cost is that the copy drifts if the real byline or origin-tag
   idiom changes; the mitigation is that the pieces are small enough to re-read
   against `Byline.tsx`/`PostOriginTag.tsx`/`QuotedEmbed.tsx` in a minute.

   **Sized as a set, and deliberately unequally** — the substantive difference
   from three captures that were all the same shape because they were all the
   same capture. Each demo's root sets one `fontSize` and everything inside is
   `em`, so a demo has a single register knob: omnivore 14.5px (largest — it
   carries content meant to be read), gate 13px (a specimen, and the only demo
   that could be mistaken for the page's own 17px prose, so it also gets a 52px
   inset), workspace 12px (schematic — it only has to read as "several feeds,
   each in its own colours, side by side"). Those knobs live in `globals.css`
   §1d, not the components, for 7bis's SSR reason exactly: on mobile they step
   to 13.5/12/11px, the gate's inset goes entirely (104px of a 318px card spent
   on a signal the size already sends) and the workspace drops to two columns
   (three at ~100px stop reading as cards) — the third hidden rather than
   reflowed, since stacked it would say "feeds go underneath each other", the
   opposite of what the desktop workspace does. *(The specific registers and the
   mobile step-down here are **superseded by 7quater**, which replaces two of the
   three demos; the one-knob-in-§1d principle stands, and 7quater keeps it.)*

   **The demo content is invented, and must stay so.** The captures showed real
   posts by real people, which is defensible in a screenshot and is not
   defensible retyped as markup: a named person's post becomes indistinguishable
   from words we put in their mouth, on a page whose job is to sell something.
   Bylines, publications, handles and bodies are all fictional (*The Meridian*,
   *Fenwick Wire*, *Third Rail* — shared across the three demos so they read as
   one world; the masthead was recast by 7septies). The protocol labels are the
   exception and must stay literally true: they are the argument.

7quater. **The canvas and the reading pane** (2026-07-27, same day as 7ter and
   revising it). Two of the three demos are replaced; the omnivore column, which
   was always the one carrying content meant to be read, is untouched.

   **`CanvasDemo` supersedes `WorkspaceDemo`.** Three feeds of equal width,
   height and spacing was the weakest available reading of the claim — three
   identical columns say "this app has columns", which every app has had since
   2004. The workspace's actual argument is that a feed can be any SIZE, in any
   POSITION, at either ORIENTATION, and no figure in the old set ever showed it.
   So the arrangement is irregular on purpose: one wide and tall down the left
   (the feed you read), two narrow stacked in the right-hand column (two feeds
   sharing one column of canvas), one horizontal along the bottom with its cards
   running off its own right edge under a gradient to the vessel interior. The
   clipping is load-bearing: a horizontal feed shown statically has to be clipped
   to read as scrollable, because a row that ends tidily reads as a row that has
   ended. Four colourways (basic/spring/winter/autumn), so the per-feed wall
   colour reads as a system rather than as decoration.

   **It scales, it never reflows — and this is the one place `/` uses a container
   query.** The predecessor dropped to two columns under a viewport media query,
   which failed twice over: it was sized against a *guess* at the viewport rather
   than the width it was actually handed (so an upstream padding change threw it
   out), and rearranging was wrong in principle, since the arrangement IS the
   argument and a mobile version that tidies the feeds into a regular stack
   demonstrates the opposite of the claim. The wrapper is now
   `container-type: inline-size`, the base `clamp(8.5px, 1.95cqw, 12px)`, and
   every measurement inside — type, padding, gaps, wall thickness, the bar — is
   `em`. Below 430px of *container* width the card bodies and provenance tags
   hide, leaving bylines and titles: **shed detail, don't shrink**, because
   scaling everything down to fit reproduces exactly the grey texture 7ter
   deleted the screengrabs for. **This departs from 7bis/§1c's media-query rule
   and is safe for §1c's own reason** — a container query is still CSS, resolving
   at paint on server-rendered markup with no JS and no hydration snap, so it
   keeps the SSR safety while measuring the right box. It is also the only new
   platform feature on the page, and the first thing to check if `/` ever has to
   reach an older browserslist (the fallback is a fixed 11px base).

   **`ReaderDemo` supersedes `GateDemo`.** On plain card ground the bare gate read
   as text that had gone wrong: a paragraph trailing into a fade, a price, two
   buttons, floating on nothing. A paywall is legible as a paywall because of the
   SITUATION it appears in, and the situation was the missing part — a reader
   recognises the shape of a pane held over an interrupted background. So the
   demo is now the whole Glasshouse figure: a blurred, desaturated four-feed
   floor, a scrim at `.gh-scrim`'s wash (bone-bright 0.72 / ink-925 0.74), and
   the lifted pane with grip and ✕, per §III.2's shadow-alone lift. The floor does
   double duty, quietly restating the canvas argument so the reader reads as
   something that opens OVER your feeds rather than a place you navigate to.
   **The blur is a `filter` on the floor, not `backdrop-filter` on the scrim** —
   the real scrim needs backdrop-filter because it sits over a live workspace
   whose contents it cannot know; this floor is inert markup that exists only to
   be blurred, so blurring it directly renders identically, costs less, and
   sidesteps the backdrop-filter containment bugs that bite inside clipped
   ancestors. Do not "correct" it for consistency. The 52px inset is gone: a
   lifted pane over a blurred field cannot be mistaken for the page's own prose,
   so the inset had stopped doing separate work and is now just the pane's margin
   (which shrinks on mobile but never goes — a pane flush to the edges is a box).

   **Registers, superseding 7ter's**: omnivore 14.5/13.5px fixed, reader 12px,
   canvas fluid. The one-knob-per-demo rule and its home in §1d are unchanged.

   **`DemoVessel` has two geometry modes**, and the distinction is not cosmetic:
   inline styles beat `@layer components`, so a demo whose walls must scale in
   `em` cannot have them set inline — an inline zeroed border would silently win
   and flatten the ⊔ to nothing. Pass `wall` and the vessel draws its own ⊔ (the
   fixed-size omnivore figure); omit it and it publishes only `--ah-demo-wall`
   and leaves border/padding/gap to §1d. **The trap is that omitting `wall` with
   no matching CSS rule renders a wall-less vessel and nothing errors** — which
   is exactly what the bundle did in two places (the omnivore call site, and the
   reader's floor rule), caught in review. A vessel is its walls; if a demo's
   feeds ever go colourless, this is why.

   **The invented-content rule of 7ter stands unchanged**, and had to be
   re-applied: the bundle reverted it wholesale, real names and all, and deleted
   the notes recording it. The note now lives in `CanvasDemo`. Anything arriving
   as a patch bundle for this page gets checked against 7ter's paragraph and
   against `check-hairlines.sh` before it is read for design — both regressions
   came back in the same delivery.

7quinquies. **No vessel on a phone, and no vessel taller than what it holds**
   (2026-07-27). Two changes to the chassis, from the same instinct: a container
   should be doing a container's job or not be there.

   **Mobile: the ⊔ goes entirely, on every logged-out page.** 7bis took `/` from
   56px a side to 16 and kept one wall, reasoning that "the ⊔ still reads, at
   mobile weight". It does read — the question that dodged is what the ⊔ is FOR.
   It says *this is one object among several*, which is true of a feed on a
   workspace floor and false of the only column on a phone screen, where it is
   ink spent framing the one thing already occupying the whole viewport.
   MOBILE-LAYOUT-ADR reached that conclusion first and dropped the mobile
   workspace's vessel chassis outright; the public register now matches it rather
   than sitting one notch softer. At ≤767px: `/`'s inner frame keeps its 8px pad
   and draws no wall (8px a side, a 374px column on a 390px phone), and
   `PublicVessel` — `/auth`, `/waitlist`, `/about`, `/invite`, `/subscribe`,
   `/tribute/claim`, `/auth/verify`, the Google callback, 404 and the error page
   — loses all three walls. Both frames stay in the tree as plain flex columns so
   the components keep one shape across form factors. The share/SEO surfaces
   (`PublicPage`) never had a vessel and are untouched.

   The wall widths had to MOVE OUT OF THE COMPONENT for this, exactly as 7bis
   moved `/`'s: `.ah-public-vessel` in `globals.css` §1a-bis, with only the
   palette-derived colour crossing in as `--ah-public-wall`. These pages are
   SSR'd, so a `useIsMobile` branch would paint the walled chassis on a phone and
   snap after hydration — and an inline border shorthand would beat the media
   query outright.

   **Desktop: the vessel hugs its content and is centred on both axes.** §V's
   amendment made the vessel take the shell's whole fitted height, so `/auth`'s
   four fields sat in a ⊔ as tall as the screen — a frame drawn around a great
   deal of nothing, and worse the taller the monitor. Now every link of the chain
   (shell measure column → vessel frame → scroll body) is `flex: 0 1 auto`, so
   the ⊔ is exactly as tall as what it holds, and `.ah-public-fit` gained
   `justify-content: center` beside the `align-items: center` it always had. A
   roughly square card sits in a roughly square vessel, in the middle of the
   screen. The two paddings happen to make that centring true to the viewport
   rather than merely to the box: top is `min(64px, 8vh)` and the bottom band is
   `NAV_ROW_H + GRID` = 64.

   **This does NOT revert §V, and the distinction is the whole design.** §V says
   the vessel may never be TALLER than the viewport — its bottom wall has to be
   on screen, or it is a left-and-right pair of rules rather than a vessel. This
   says it may never be taller than its CONTENT either. Both bounds are live at
   once, which is why `flex-shrink: 1` and `min-height: 0` survive on every link:
   a page with more content than room still shrinks to the remainder and scrolls
   inside its walls, bottom wall on screen, exactly as before. What went is only
   the stretching of a short one. `/` is unaffected on desktop — its content is
   always longer than the viewport, so hugging would be a no-op — and keeps its
   own chassis per departure 1.

7sexies. **The canvas becomes a floor, and it holds a photograph**
   (2026-07-28). 7quater built `CanvasDemo` right in every respect except the one
   that governs the rest: it was not a shape the workspace can hold, and it was
   sized by its contents rather than sizing them. Five changes, and the first two
   are corrections of fact.

   **The bar IS the bottom of a vessel.** Every demo vessel drew a bottom wall
   AND a bar, so each feed ended in two bands of two different colours. Per
   `Vessel.tsx` the bottom wall is *replaced* by `VesselBar`; the wall is gone
   and `DemoBar` now reaches out through the interior padding to the walls' inner
   faces, with `margin-top: auto` pinning it to the floor of a stretched vessel.
   This one thing was most of what made the vessels read wrong.

   **A horizontal feed is a ⊐, not a ⊔** — closed TOP and RIGHT, open on the
   LEFT where new items arrive, again per `Vessel.tsx`'s `wallStyle`. Feed 4 had
   been drawing the vertical arrangement while running its cards sideways.

   **The proportions are the real vessel's, as ratios.** Interior padding was
   *thinner* than the wall, which is why the cards looked crushed against them.
   Wall / padding / card-gap now hold the floor's 8 / 16 / 12, and the gutter
   between vessels equals the wall — so a gutter reads as wall / buffer / wall,
   the floor's own rule (`GRID = WALL`).

   **The arrangement is now a legal floor, built the way the floor is built.**
   Feed 4 ran as a band across the full width UNDER both columns — a shape no
   stored column order can express, and the only thing such a band can read as is
   a footer. It is two flex COLUMNS of slots now, `[1, 4]` and `[2, 3]`, with
   `flex: 1 1 0` standing in for the floor's `h: null` (take the column's
   remaining share) and the sideways feed the one slot with a fixed height,
   because it is the one with a real minimum. An intermediate version used
   interlocking grid row-spans; it was expressible but steered through `fr`
   arithmetic, which put the only slot with a hard constraint three divisions
   away from anything you could set. Columns divide themselves; that is both the
   ADR's model and the tractable one.

   **The vessels CLIP, and the canvas has a fixed height in `em`.** This is the
   substantive change and it supersedes 7quater's detail-shed. A vessel on the
   floor is a fixed rectangle whose cards scroll inside it, so content-sized
   vessels were never the right picture — and because two columns are always
   exactly as tall as each other, whichever held less content opened a VOID
   inside its own feed. Tuning card counts to close it is a losing game: the sum
   has to come out right at every container width. So every feed is over-filled
   and clips, which is at once the honest picture and the only stable one.
   The height is `em` and not an aspect ratio, because card heights are `em`:
   once the base floors at 8.5px the cards stop shrinking, but a ratio-derived
   box would keep going with the container and the feeds would quietly close over
   their own content. **63em ≈ 756px at the cap is also a ceiling**, not just a
   proportion — an intermediate 86em figure came to 1006px, taller than the
   landing vessel's scroll area on an ordinary laptop, so the arrangement could
   never be seen whole; the arrangement is the entire argument, and a feed
   showing one card fewer is much the cheaper loss.

   **And so 7quater's shed rule GOES.** Hiding card bodies and provenance tags
   below 430px of container was right for a canvas that sized itself; a clipping
   canvas has no such failure mode, and the shed halved every card height at one
   width only — which is precisely the width-dependence a fixed box exists to
   remove — while leaving the vertical feeds showing bare bylines. Every card is
   the same card at every size now; only the scale moves. The container query
   survives with one proportion in it (the sideways cards' flex-basis), so
   7quater's departure-from-§1c reasoning stands unchanged.

   **Feed 2 runs at HEADLINE density and feed 1 carries a photograph** — the two
   things the demo claimed and did not show. Feed 2's cards are source + title on
   the condensed family's tighter padding, and they carry no bodies, so nothing
   is written that the density silently drops. `DemoPhoto` is a new primitive at
   `PostMedia`'s "sized" treatment (cropped 16:9, on the vessel interior, square
   corners). **It is drawn, not photographed, and every tone is a canonical
   neutral** — `grey-200 → grey-300 → stone-400 → wall-grey → ink-925`, a warm
   grey ramp already in the registry, so the picture needs no raw hex and no new
   slug and does not invert under the dark toggle (a feed's surface follows the
   mode; a photograph in it never does). A stock landscape is a real place owned
   by someone, dropped onto a page that is selling something, which is 7ter's
   objection exactly. At ~160×90 CSS px a photograph is read as tone, mass and
   light rather than detail, so the demo needs only that. **The first draft read
   as a bar chart**, and the four things that fixed it are worth keeping: a
   gradient inside every mass rather than a flat fill, blur and lost contrast on
   the far planes (atmospheric perspective is the strongest single cue that a
   picture has depth and was not drawn), a glow BEHIND the skyline so the masses
   are backlit rather than laid on a background, and grain over the frame — which
   is most of what a small photograph is once its detail has gone.

   **Verified in a browser** — see the retraction under *Still open* 7.

7septies. **The invented world is a front page, not a parish magazine**
   (2026-07-29). 7ter and 7quater settled that the demo content must be invented
   and that the four omnivore bodies are the only copy on `/` a visitor reads at
   true size. What neither settled is what those sentences should be ABOUT, and
   the world that filled the gap was harbour leases, pilot whales, hand-set type,
   an ageing footballer and a repainted gate: charming, literary, and inert. That
   is a demonstration failure, not a taste one. The page's claim is that
   everything worth reading fits in one place; a canvas of things nobody would
   click argues the opposite while appearing to agree, and a paywall closing over
   a gentle reminiscence proves only that the gate works — never that anyone
   would pay forty pence to get past it.

   So the subjects are recast to what a front page actually leads on, in the same
   grammar and the same cast. **One story now crosses all three demos**: a
   sovereign fund (*Halcyon*) taking control of the grid through four shells, the
   minister who signed it taking a seat on the board ninety days later. It is
   broken by *The Meridian* in feed 1, traded on in feed 1's quote card (the
   market moved nine hours early), mocked in feed 3's chatter, turned from a
   reported fact into an accusation by a Bluesky reply in the omnivore column,
   and **paywalled as Ellis Marchetti's "The men who bought the lights"** in the
   reader demo — which is the 7quater pairing, retitled at both ends. A visitor
   who scrolls has met the story four times before being asked to pay for it,
   which is the strongest form of the payment argument the page can make.

   The rest of the spread is beats, not filler: science with a shortened
   timeline, a critic with an enemy, a doping lab that shut on the Friday, an
   infrastructure number. The masthead was recast with it — *The Common Room*,
   *The Slow Hour*, *The Tidewatch* and *The Whip Room* out; *Third Rail*
   (politics, and the £5/mo subscription target), *Deep Field*, *Nightshift*,
   *Touchline* and *Fenwick Wire* in — because a publication name is a claim
   about what kind of thing this is, and four sleepy ones made the whole world
   read small. **The invented-content rule is untouched and so is the
   no-repeats rule**; only the register moved. Register to hold: specific,
   consequential, short of the verb — no wistfulness, no throat-clearing.

7octies. **A front page is not all front-page, and the crossing story is a
   spine, not the world** (2026-07-29, the same day). 7septies was right and
   overshot. Having established that the world had to be consequential, it made
   every card consequential in the same way: a leak, a burial, a collapse, a
   betrayal, in all four canvas feeds, in three of the four omnivore bodies and
   across the reader's floor. That is the identical demonstration failure with
   the sign flipped. The page's claim is that ONE surface holds everything a
   person reads — and a canvas on which everything is the same grim column,
   four times, argues that a reader wanting that column would need only the
   column. The gate suffers most: a paywall over the fifth Halcyon card on a
   floor of further Halcyon cards reads as a single-subject wire putting up a
   toll, not as a person's whole reading surface with one piece behind glass.

   Two corrections, both content-only:

   **Mood is spread as deliberately as beat.** Roughly a third of the cards are
   now light — a swimmer's record and the third turn watched two hundred times,
   eleven days of telescope pointed at nothing, a soup made every morning since
   1998 and never written down, six people on a roof with a borrowed flask, a
   lecture on moss that drew two hundred and forty and now has a waiting list,
   a piano left on a seafront and still in tune. They are held to 7septies'
   standard exactly: specific, consequential, short of the verb, and something a
   stranger would click. **Delight is a beat; whimsy is the parish magazine
   coming back in**, and the difference is whether the card has a fact and a
   stake in it. The omnivore column is where this is load-bearing, since its
   four bodies are the only copy read at true size: verdict, accusation, comic
   scene, paid stake — four moods, not four gravities.

   **Halcyon appears only at its five spine points** (feed 1 lead, feed 1 quote
   card, one feed 2 headline, feed 3's mock, the omnivore accusation) **and then
   at the gate.** Everything else that had drifted into its orbit — a second
   feed-2 headline, a substation mural, a share price on the reader floor, a
   drainage lease, a grid coming back on at four in the morning — is now other
   subjects. The reader demo's floor carries **none** of it by design, so the
   figure states the argument once and cleanly: one story behind glass, on a
   floor visibly holding everything else.

   Cast additions for the lighter beats, kept minimal: **Sable Kwon** (sport,
   for *Touchline*), **Deniz Aksoy** (food) and the publication **Saltbox**.
   `Third Rail` keeps its subscription role; nothing was retired.

7. **Three logged-in tool surfaces clear the band** — `/write`, `/admin/*`,
   `/traffology/*` — because the row mounts on every non-workspace route and
   they are the only real pages left there (every other platform route is a
   redirect shim into the workspace). NOT via `PageShell`: it is also the body
   of five Glasshouse overlay panels, where there is no row to clear. `/write`
   also loses the `top-[53px]` sticky offset that existed to clear the topbar's
   mobile height.

### Also done, because deleting the topbar orphaned them

`usePaneRedirect`; the whole `ah:session` no-FOUC apparatus (localStorage
breadcrumb, `html.ah-session` class, the blocking `<head>` script, the CSS that
hid `.site-topbar`/`.site-footer` and zeroed `pt-[60px]`); and the orphaned
`Footer.tsx`. CLAUDE.md's escape invariant described all of it as standing rule
and is rewritten; a "public register" section documents the new chassis.

### Still open

1. **Almost nothing has been in a browser, in either mode.** The one exception
   is `/`, rendered 2026-07-26 at 390×844 and 1440×900 in LIGHT mode only (the
   mobile-chassis change, 7bis) — which immediately turned up the row bug in
   item 6 below, so the rest of this is worth doing properly. §VIII's two
   judgement calls are still the ones to look at first: bone at 4px under a
   field, and the row's band against the new floor — in dark the row is
   `--ah-bone` (20 19 17) under a fitted page's `interior` floor (26 26 24), six
   points apart. It may read as chrome distinguishing itself, or it may want to
   track the floor.
2. **`/about` is fitted, so it scrolls inside its vessel on a laptop.** Four
   cards. Worth deciding whether About should be cut to one screen.
3. **`/pub/[slug]/*`** — the §VI register decision, plus its missing subscribe
   button and its `font-sans` masthead h1. Both are real bugs either way.
4. **`/privacy`, `/terms`, `/community-guidelines` do not exist as routes**
   despite the documents existing. Deleting the Footer removed the dead links,
   not the requirement.
5. **`/write`'s three `animate-pulse rounded` skeletons** — the last home of the
   pattern `IndeterminateSlab` replaces. A logged-in surface, so a workspace
   pass of its own.
6. **`PublicNavRow` breaks below ~420px** (measured 2026-07-26 at 390, light,
   logged out — the first time the row has been in a browser at phone width).
   Three faults, one cause: the row lays out at its desktop measure and the
   labels are too long for the width.
   - The CTA is **65px tall inside a 56px row** — "Join the waiting list" wraps
     to two lines, so the button overflows `NAV_ROW_H` top and bottom.
   - "Log in" wraps to two lines too (35px tall, 44px wide).
   - The CTA's right edge and the lockup's left edge are **both at x=243** —
     touching, zero gap.

   It affects every public route, not just `/`, since `LayoutShell` mounts the
   row on all of them — so this is a register-wide fix, not a landing one, and
   the shape of it is a design call: shorten the labels at mobile width
   ("Join the list"? "Waiting list"?), drop the secondary "Log in" to the
   lockup's menu, or let the row grow taller on mobile (which changes
   `--ah-row-band` and every page's clearance with it). Not attempted here
   because the landing brief was the vessel, and any of the three moves the
   register's own furniture.
7. ~~**The demos (7ter, then 7quater) have never been in a browser, in either
   mode.**~~ **CLOSED by 7sexies (2026-07-28).** They have now been rendered in
   Chromium at 1440 / 820 / 390px, light and dark, and every question on the list
   is answered: `CanvasDemo`'s four seasonal walls DO still read as four distinct
   feeds in dark at the 8.5px base — identity rides the walls exactly as the
   scheme grammar claims, at the smallest surface that claim has been made at;
   `ReaderDemo`'s blurred floor still says "your feeds" rather than "grey", and
   the pane's shadow reads as lift against the dark scrim; the container query
   resolves as expected. The 390px question is now moot in the form it was asked
   — the canvas no longer sheds anything (7sexies), and it keeps its arrangement
   with every card intact at a 330px container.

   **What rendering it actually caught** is the lesson worth keeping, because
   none of it was on this list and all of it was visible in the first screenshot:
   the doubled bottom band under every feed, the ⊐ drawn as a ⊔, interior padding
   thinner than its own wall, and a void half the height of a vessel. Four
   defects in the chassis, in code that compiled, passed lint and read correctly.
   The list above was a list of *subtle* risks; what a browser found first were
   the gross ones. The general rule this is an instance of already stands in
   CLAUDE.md's memory conventions — "component ≠ feature", a thing is not done
   until it has been driven for real — and a demo of the product is not exempt
   from it merely because it is inert markup.
