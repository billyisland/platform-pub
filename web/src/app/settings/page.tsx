import { redirect } from 'next/navigation'

// Settings is now a workspace Glasshouse overlay (opened from the ForallMenu or
// via /workspace?overlay=settings). This route is retained only as a
// compatibility shim: old links and bookmarks pointing at /settings redirect
// into the workspace with the overlay opened. The gateway's social-account
// OAuth callback returns to /settings?linked=<flag>; that flag is forwarded so
// the panel's connect banner still shows inside the overlay. See the deep-link
// dispatcher in WorkspaceView.
export default function SettingsPage({
  searchParams,
}: {
  searchParams: { linked?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'settings' })
  const linked = Array.isArray(searchParams.linked) ? searchParams.linked[0] : searchParams.linked
  if (linked) params.set('linked', linked)
  redirect(`/workspace?${params.toString()}`)
}
