import { request } from './client'

export interface WriterProfile {
  id: string
  pubkey: string
  username: string
  displayName: string | null
  bio: string | null
  avatar: string | null
  hostingType: string
  subscriptionPricePence: number
  annualDiscountPct: number
  showCommissionButton: boolean
  articleCount: number
  hasPaywalledArticle: boolean
  followerCount: number
  followingCount: number
}

// GET /writers/:username → native writer profile header. The /[username] page
// fetches this server-side; the profile overlay (NativeProfilePanel) needs it
// client-side.
export function getWriter(username: string): Promise<WriterProfile> {
  return request<WriterProfile>(`/writers/${encodeURIComponent(username)}`)
}
