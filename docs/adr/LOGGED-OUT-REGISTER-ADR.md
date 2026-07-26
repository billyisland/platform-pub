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

1. **Nothing has been in a browser, in either mode.** §VIII's two judgement
   calls are the ones to look at first: bone at 4px under a field, and the row's
   band against the new floor — in dark the row is `--ah-bone` (20 19 17) under
   a fitted page's `interior` floor (26 26 24), six points apart. It may read as
   chrome distinguishing itself, or it may want to track the floor.
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
