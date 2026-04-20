import { request } from './client'

export type VouchDimension = 'humanity' | 'encounter' | 'identity' | 'integrity'
export type VouchValue = 'affirm' | 'contest'
export type VouchVisibility = 'public' | 'aggregate'

export interface TrustProfileResponse {
  userId: string
  layer1: {
    accountAgeDays: number
    payingReaderCount: number
    articleCount: number
    paymentVerified: boolean
    nip05Verified: boolean
    pipStatus: 'known' | 'partial' | 'unknown'
    computedAt: string
  }
  dimensions: Record<VouchDimension, {
    score: number
    attestationCount: number
  }>
  publicEndorsements: Array<{
    id: string
    dimension: VouchDimension
    value: VouchValue
    createdAt: string
    attestor: {
      id: string
      username: string
      displayName: string | null
      avatar: string | null
    }
  }>
  layer4: {
    networkSays: string
    attributedEndorsements: Array<{
      attestor: { id: string; username: string; displayName: string | null; avatar: string | null }
      dimension: VouchDimension
      value: VouchValue
    }>
  } | null
  viewerVouches: Array<{
    id: string
    dimension: VouchDimension
    value: VouchValue
    visibility: VouchVisibility
  }>
}

export interface MyVouch {
  id: string
  dimension: VouchDimension
  value: VouchValue
  visibility: VouchVisibility
  createdAt: string
  subject: {
    id: string
    username: string
    displayName: string | null
    avatar: string | null
  }
}

export const trust = {
  getProfile: (userId: string) =>
    request<TrustProfileResponse>(`/trust/${userId}`),

  vouch: (data: {
    subjectId: string
    dimension: VouchDimension
    value: VouchValue
    visibility: VouchVisibility
  }) =>
    request<any>('/vouches', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  withdrawVouch: (id: string) =>
    request<{ ok: boolean }>(`/vouches/${id}`, { method: 'DELETE' }),

  myVouches: () =>
    request<{ vouches: MyVouch[] }>('/my/vouches'),
}
