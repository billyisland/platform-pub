import { request } from './client'

interface SignupInput {
  email: string
  displayName: string
  username: string
}

interface SignupResult {
  accountId: string
  pubkey: string
  username: string
}

export interface MeResponse {
  id: string
  pubkey: string
  username: string | null
  displayName: string | null
  bio: string | null
  avatar: string | null
  email: string
  isWriter: boolean
  hasPaymentMethod: boolean
  stripeConnectKycComplete: boolean
  freeAllowanceRemainingPence: number
  defaultArticlePricePence: number | null
  isAdmin: boolean
  usernameChangedAt: string | null
}

export const auth = {
  signup: (input: SignupInput) =>
    request<SignupResult>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (email: string) =>
    request<{ message: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  devLogin: (email: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verify: (token: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<MeResponse>('/auth/me'),

  connectStripe: () =>
    request<{ stripeConnectUrl: string }>('/auth/upgrade-writer', { method: 'POST' }),

  connectCard: (paymentMethodId: string) =>
    request<{ ok: boolean; hasPaymentMethod: boolean }>('/auth/connect-card', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId }),
    }),

  updateProfile: (data: { displayName?: string; bio?: string; avatar?: string | null }) =>
    request<{ ok: boolean }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deactivate: () =>
    request<{ ok: boolean }>('/auth/deactivate', { method: 'POST' }),

  deleteAccount: (emailConfirmation: string) =>
    request<{ ok: boolean }>('/auth/delete-account', {
      method: 'POST',
      body: JSON.stringify({ emailConfirmation }),
    }),

  changeEmail: (newEmail: string) =>
    request<{ ok: boolean }>('/auth/change-email', {
      method: 'POST',
      body: JSON.stringify({ newEmail }),
    }),

  verifyEmailChange: (token: string) =>
    request<{ ok: boolean }>('/auth/verify-email-change', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  changeUsername: (newUsername: string) =>
    request<{ ok: boolean; username: string }>('/auth/change-username', {
      method: 'POST',
      body: JSON.stringify({ newUsername }),
    }),

  checkUsername: (username: string) =>
    request<{ available: boolean; reason?: string }>(`/auth/check-username/${encodeURIComponent(username)}`),
}
