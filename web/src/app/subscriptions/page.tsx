import { redirect } from 'next/navigation'

// External-feed subscription management is now a workspace Glasshouse overlay
// (opened from the ForallMenu or via /workspace?overlay=subscriptions). This
// route is retained only as a compatibility shim: old links and bookmarks
// pointing at /subscriptions redirect into the workspace with the overlay
// opened. See the deep-link dispatcher in WorkspaceView.
export default function SubscriptionsPage() {
  redirect('/workspace?overlay=subscriptions')
}
