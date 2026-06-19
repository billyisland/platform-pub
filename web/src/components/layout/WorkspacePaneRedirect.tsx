'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { usePaneRedirect } from '../../stores/paneRedirect'

// =============================================================================
// WorkspacePaneRedirect
//
// The standalone pages that back a URL-synced workspace *pane* overlay —
//   reader   → /article/<dTag> · /read/<postId>
//   profile  → /<username>     · /author/<id>
//   surface  → /source/<id> · /tag/<name> · /pub/<slug>[/sub-view]
// — are real, addressable, SEO/share/new-tab destinations, so they SSR full-page
// for logged-out visitors (the marketing/share register, black topbar and all).
//
// But the overlay puts that same canonical URL in the address bar, so a reload
// (or a shared link opened by a member) lands a *logged-in* user on the
// standalone page — escaping the workspace to the retired black topbar. This
// bounces them back in: replace the URL with /reader?overlay=<name>&<seed> so
// the workspace reopens the matching pane on that target (overlays.ts dispatcher).
//
// Mirrors HomeRedirect: mounted inside the SSR'd page so logged-out first paint
// is untouched; only authenticated sessions are redirected. `replace` (not
// `push`) keeps the standalone URL out of history. Feed context (skip ears /
// frame) is gone after a cold reload, so the pane reopens plain.
// =============================================================================

export default function WorkspacePaneRedirect({
  overlay,
  params,
}: {
  overlay: 'reader' | 'profile' | 'surface'
  params: Record<string, string>
}) {
  const router = useRouter()
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  const setRedirectActive = usePaneRedirect((s) => s.setActive)

  // Tell LayoutShell this page will redirect a logged-in visitor, so it holds
  // the black topbar through the auth-resolve window instead of flashing it.
  useEffect(() => {
    setRedirectActive(true)
    return () => setRedirectActive(false)
  }, [setRedirectActive])

  useEffect(() => {
    if (loading || !user) return
    const qs = new URLSearchParams({ overlay, ...params }).toString()
    router.replace(`/reader?${qs}`)
  }, [overlay, params, user, loading, router])

  return null
}
