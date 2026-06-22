import { create } from 'zustand'
import { auth, type MeResponse } from '../lib/api'
import { useFollows } from './follows'

// =============================================================================
// Auth Store
//
// Global session state. Hydrated on app load via fetchMe().
// Components use useAuth() to access current user info and auth actions.
//
// States:
//   loading  — initial hydration in progress
//   authed   — user is logged in (user !== null)
//   anon     — no session (user === null, loading === false)
//
// Session breadcrumb (no-FOUC): the JWT is an httpOnly cookie, invisible to the
// SSR render and to client JS until fetchMe() round-trips — so a member reloading
// a workspace-backing page (/, /read/:id, /<username>, …) paints the retired
// logged-out black topbar before auth resolves and the redirect fires. We can't
// stop SSR HTML from painting; only the blocking <head> script can. So we keep a
// boolean breadcrumb in localStorage (just a hint, never a credential): the inline
// script in app/layout.tsx reads it pre-paint and adds `html.ah-session`, which
// CSS uses to suppress the topbar/footer before first paint. We keep the flag +
// class authoritative here as auth resolves. Mirrors the dark-mode no-FOUC script.
// =============================================================================

const SESSION_FLAG = 'ah:session'

// Keep the localStorage breadcrumb + the `html.ah-session` class in lockstep with
// real auth state. Safe even when stale (session expired server-side, flag lingers):
// we only ever hide chrome a logged-in member never wants, and a logged-out fetchMe
// clears it within one render, so a genuine anon visitor gets their topbar back.
function markSession(present: boolean) {
  if (typeof document === 'undefined') return
  try {
    if (present) localStorage.setItem(SESSION_FLAG, '1')
    else localStorage.removeItem(SESSION_FLAG)
  } catch {
    /* private mode / storage disabled — fall through to the class toggle */
  }
  document.documentElement.classList.toggle('ah-session', present)
}

interface AuthState {
  user: MeResponse | null
  loading: boolean

  // Actions
  fetchMe: () => Promise<void>
  logout: () => Promise<void>
  setUser: (user: MeResponse) => void
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  fetchMe: async () => {
    try {
      const user = await auth.me()
      // Re-open follow hydration if the session changed identity (or first
      // load), so the followed-id set belongs to the current user.
      if (user.id !== useAuth.getState().user?.id) useFollows.getState().reset()
      markSession(true)
      set({ user, loading: false })
    } catch {
      useFollows.getState().reset()
      markSession(false)
      set({ user: null, loading: false })
    }
  },

  logout: async () => {
    try {
      await auth.logout()
    } finally {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('unlocked:')) sessionStorage.removeItem(key)
      }
      useFollows.getState().reset()
      markSession(false)
      set({ user: null })
    }
  },

  setUser: (user) => {
    markSession(true)
    set({ user, loading: false })
  },
}))
