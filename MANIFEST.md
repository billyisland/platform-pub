# all.haus logged-out register sweep — 2026-07-25

25 files. Paths under `web/` mirror the repo, so this unzips over a checkout.

## Read first
- `LOGGED-OUT-REGISTER-SWEEP.md` — the plan and ADR. §I inventory, §II
  decisions, §III tranche 1, §V the fitted-vessel amendment, §VI tranche 2,
  §VII tranche 3, §VIII the dark-mode audit.
- `TRANCHE-3-PATCHES.md` — hunks for the four share/SEO routes I did not rewrite
  whole, because I only read their render bodies.

## New — `web/src/components/public/`
| File | Role |
|---|---|
| `palette.ts` | `usePublicPalette()`, the register's constants, and the derived `controlLine` / `scrollThumb` from the dark audit |
| `PublicVessel.tsx` | Single-wall ⊔, fitted, with the scroll body + `PublicCard` / `PublicTitle` / `PublicBody` |
| `PublicShell.tsx` | Fitted chassis for vessel pages. Floor tracks `palette.interior` |
| `PublicPage.tsx` | Scrolling chassis for the share/SEO pages. No vessel |
| `PublicNavRow.tsx` | The only chrome off the workspace. Left end varies by auth |
| `Field.tsx` | `TextField`, `CheckboxField`, `PublicButton`, `PublicLink`, `FormError`, `OrDivider`, `IndeterminateSlab` |

## Rewritten
`components/layout/LayoutShell.tsx` · `components/landing/LandingVessel.tsx` ·
`app/page.tsx` · `app/auth/page.tsx` · `app/auth/verify/page.tsx` ·
`app/auth/google/callback/page.tsx` · `app/waitlist/page.tsx` ·
`app/about/page.tsx` · `app/about/AboutContent.tsx` · `app/error.tsx` ·
`app/invite/[token]/page.tsx` · `app/subscribe/[code]/page.tsx` ·
`app/tribute/claim/page.tsx` · `app/source/[id]/page.tsx` ·
`app/author/[authorId]/page.tsx`

## New page
`app/not-found.tsx` — there was none; 404s fell through to the Next.js default.

## Append, don't replace
`app/globals.additions.css` → paste into `globals.css` inside the same
`@layer components` block as the slab rules. Three blocks: `.ah-public-fit`,
`.ah-vessel-scroll`, `.ah-indeterminate-slab`.

## Delete
`components/layout/Nav.tsx` · `components/landing/LandingNavRow.tsx`
Both single-importer. `components/layout/Footer.tsx` is orphaned and points at
three legal routes that don't exist — a separate decision.

## Outstanding
1. `/pub/[slug]/*` — needs the register decision (§VI), plus its missing
   subscribe button and its `font-sans` masthead h1.
2. `.btn-accent` is broken in dark **sitewide** — `color: var(--ah-white)`
   inverts to near-black while crimson holds. Pinned inline on the row's CTA as
   a stopgap; the real fix is in `globals.css`.
3. `ComposeOverlay`'s gate wants a manual pass from `/feed` and `/dashboard` —
   it used to piggyback on `!chromeless`, which is now always false.
4. `Footer.tsx` and the missing `/privacy`, `/terms`, `/community-guidelines`.
5. Nothing has been in a browser in dark mode. Two judgement calls to look at
   first: bone at 4px under a field, and the nav row's band against the new
   floor (§VIII).
