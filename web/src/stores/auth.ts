import { create } from 'zustand'
import { auth, type MeResponse } from '../lib/api'

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
      set({ user, loading: false })
    } catch {
      set({ user: null, loading: false })
    }
  },

  logout: async () => {
    try {
      await auth.logout()
    } finally {
      set({ user: null })
    }
  },

  setUser: (user) => set({ user, loading: false }),
}))
