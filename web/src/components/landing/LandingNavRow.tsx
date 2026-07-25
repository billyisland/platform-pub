import Link from 'next/link'
import { NAV_ROW_H } from '../workspace/NavRow'
import { ForallLockup } from '../brand/ForallLockup'

// =============================================================================
// LandingNavRow — `/`'s nav row, the logged-out twin of the workspace's.
//
// The black topbar is gone from `/` (LayoutShell's chromelessRoute), so this
// row is the page's only chrome. It mirrors NavRow + `ForallMenu anchor="row"`:
// same NAV_ROW_H, same `--ah-bone` ground, same lockup docked at the right end
// at disc 40 / wordmark 24. The difference is the left end — a member's row
// carries nothing there because the ∀ menu holds every destination; a visitor's
// carries the two the topbar used to (CLOSED-BETA-ADR §IV: log in, and the
// waiting list, no public signup).
//
// NO DIVIDER, for the same reason NavRow has none: the lockup docked at its end
// is indicator enough, a full-width rule is a heavier statement than the row is
// making, and the sitewide no-single-pixel-lines invariant forbids a thin one
// in its place outright.
//
// The floor never reaches behind it — `/` reserves NAV_ROW_H + GRID of bottom
// padding, the static mirror of `deriveGeometry`'s navRowH.
// =============================================================================

export function LandingNavRow() {
  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: NAV_ROW_H,
        background: 'var(--ah-bone)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 16,
        zIndex: 58,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Link
          href="/auth?mode=login"
          className="label-ui text-grey-600 hover:text-black transition-colors"
        >
          Log in
        </Link>
        {/* The page's ONLY call to action now (the vessel's was dropped), so it
            takes the accent — `.btn-accent`, as the retired topbar's did. */}
        <Link href="/waitlist" className="btn-accent btn-sm">
          Join the waiting list
        </Link>
      </div>

      {/* The lockup is the row's brand mark, but `/` IS home — a Link there is a
          dead no-op. On the landing it doubles as the get-started CTA: `/waitlist`
          is the closed-beta sign-up funnel (`/auth?mode=signup` only redirects
          there anyway). */}
      <ForallLockup href="/waitlist" />
    </div>
  )
}
