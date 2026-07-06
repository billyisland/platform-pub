import { request } from './client'

export interface VoteTally {
  upvoteCount: number
  downvoteCount: number
  netScore: number
}

export interface MyVoteCount {
  upCount: number
  downCount: number
}

export const votes = {
  // F9 (2026-07-06): voting is free — the response no longer carries cost fields.
  cast: (targetEventId: string, targetKind: number, direction: 'up' | 'down') =>
    request<{
      ok: boolean
      sequenceNumber: number
      tally: VoteTally
    }>('/votes', {
      method: 'POST',
      body: JSON.stringify({ targetEventId, targetKind, direction }),
    }),

  getTallies: (eventIds: string[]) =>
    request<{ tallies: Record<string, VoteTally> }>(
      `/votes/tally?eventIds=${eventIds.join(',')}`
    ),

  getMyVotes: (eventIds: string[]) =>
    request<{ voteCounts: Record<string, MyVoteCount> }>(
      `/votes/mine?eventIds=${eventIds.join(',')}`
    ),
}
