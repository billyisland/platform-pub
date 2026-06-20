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
// =============================================================================

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
      set({ user, loading: false })
    } catch {
      useFollows.getState().reset()
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
      set({ user: null })
    }
  },

  setUser: (user) => set({ user, loading: false }),
}))
