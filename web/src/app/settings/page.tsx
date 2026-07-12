import { redirect } from 'next/navigation'

// Settings is now a workspace Glasshouse overlay (opened from the ForallMenu or
// via /reader?overlay=settings). This route is retained only as a
// compatibility shim: old links and bookmarks pointing at /settings redirect
// into the workspace with the overlay opened. The gateway's social-account
// OAuth callback returns to /settings?linked=<flag>; that flag is forwarded so
// the panel's connect banner still shows inside the overlay. See the deep-link
// dispatcher in WorkspaceView.
export default function SettingsPage({
  searchParams,
}: {
  searchParams: { linked?: string | string[]; follows?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'settings' })
  const linked = Array.isArray(searchParams.linked) ? searchParams.linked[0] : searchParams.linked
  if (linked) params.set('linked', linked)
  // Post-link follow-import offer count (FOLLOW-GRAPH-IMPORT-ADR §7.1) —
  // rides the same channel as the connect flag.
  const follows = Array.isArray(searchParams.follows) ? searchParams.follows[0] : searchParams.follows
  if (follows) params.set('follows', follows)
  redirect(`/reader?${params.toString()}`)
}
