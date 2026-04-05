'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { voteCostPence } from '../../lib/voting'
import { votes as votesApi } from '../../lib/api'
import { VoteConfirmModal } from './VoteConfirmModal'

export interface VoteTally {
  upvoteCount: number
  downvoteCount: number
  netScore: number
}

export interface MyVoteCount {
  upCount: number
  downCount: number
}

interface VoteControlsProps {
  targetEventId: string
  targetKind: number
  isOwnContent: boolean
  dark?: boolean  // kept for API compat but no longer changes styling

  initialTally?: VoteTally
  initialMyVotes?: MyVoteCount
}

export function VoteControls({
  targetEventId,
  targetKind,
  isOwnContent,
  initialTally,
  initialMyVotes,
}: VoteControlsProps) {
  const { user } = useAuth()

  const [tally, setTally] = useState<VoteTally>(
    initialTally ?? { upvoteCount: 0, downvoteCount: 0, netScore: 0 }
  )
  const [myVotes, setMyVotes] = useState<MyVoteCount>(
    initialMyVotes ?? { upCount: 0, downCount: 0 }
  )
  const [showTooltip, setShowTooltip] = useState(false)
  const [pendingDirection, setPendingDirection] = useState<'up' | 'down' | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!initialTally) {
      votesApi.getTallies([targetEventId])
        .then(data => {
          if (data?.tallies?.[targetEventId]) {
            setTally(data.tallies[targetEventId])
          }
        })
        .catch(err => console.error('Failed to load vote tallies', err))
    }
  }, [targetEventId, initialTally])

  useEffect(() => {
    if (!initialMyVotes && user) {
      votesApi.getMyVotes([targetEventId])
        .then(data => {
          if (data?.voteCounts?.[targetEventId]) {
            setMyVotes(data.voteCounts[targetEventId])
          }
        })
        .catch(err => console.error('Failed to load user votes', err))
    }
  }, [targetEventId, initialMyVotes, user])

  useEffect(() => { if (initialTally) setTally(initialTally) }, [initialTally])
  useEffect(() => { if (initialMyVotes) setMyVotes(initialMyVotes) }, [initialMyVotes])

  function handleVoteClick(direction: 'up' | 'down') {
    if (!user) {
      window.location.href = '/auth?mode=login'
      return
    }
    if (isOwnContent || submitting) return

    const existingCount = direction === 'up' ? myVotes.upCount : myVotes.downCount
    const seq = existingCount + 1
    const cost = voteCostPence(direction, seq)

    if (cost === 0) {
      castVote(direction)
    } else {
      setPendingDirection(direction)
    }
  }

  async function castVote(direction: 'up' | 'down') {
    setSubmitting(true)
    try {
      const data = await votesApi.cast(targetEventId, targetKind, direction)
      setTally(data.tally)
      setMyVotes(prev => ({
        upCount: direction === 'up' ? prev.upCount + 1 : prev.upCount,
        downCount: direction === 'down' ? prev.downCount + 1 : prev.downCount,
      }))
      useAuth.getState().fetchMe()
    } catch { /* silent */ }
    finally {
      setSubmitting(false)
      setPendingDirection(null)
    }
  }

  const disabled = !user || isOwnContent || submitting

  const totalSpentPence = computeTotalSpent(myVotes)

  const pendingSeq = pendingDirection
    ? (pendingDirection === 'up' ? myVotes.upCount : myVotes.downCount) + 1
    : 1
  const pendingCost = pendingDirection ? voteCostPence(pendingDirection, pendingSeq) : 0

  return (
    <>
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => handleVoteClick('up')}
          disabled={disabled}
          title={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Upvote'}
          aria-label={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Upvote'}
          className={`px-1.5 py-0.5 text-ui-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed
            ${myVotes.upCount > 0
              ? 'text-crimson font-medium'
              : 'text-grey-300 hover:text-black hover:bg-grey-100'
            }`}
        >
          ▲
        </button>

        <div className="relative">
          <button
            className="text-ui-xs min-w-[1.5rem] text-center transition-colors text-grey-400 hover:text-black"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            {tally.netScore}
          </button>

          {showTooltip && (tally.upvoteCount > 0 || tally.downvoteCount > 0) && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-10 whitespace-nowrap bg-black px-2 py-1.5 text-[10px] text-white shadow-lg" style={{ borderRadius: '2px' }}>
              <div>↑ {tally.upvoteCount} {tally.upvoteCount !== 1 ? 'upvotes' : 'upvote'}</div>
              <div>↓ {tally.downvoteCount} {tally.downvoteCount !== 1 ? 'downvotes' : 'downvote'}</div>
            </div>
          )}
        </div>

        <button
          onClick={() => handleVoteClick('down')}
          disabled={disabled}
          title={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Downvote'}
          aria-label={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Downvote'}
          className={`px-1.5 py-0.5 text-ui-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed
            ${myVotes.downCount > 0
              ? 'text-crimson font-medium'
              : 'text-grey-300 hover:text-black hover:bg-grey-100'
            }`}
        >
          ▼
        </button>
      </div>

      {pendingDirection && (
        <VoteConfirmModal
          direction={pendingDirection}
          sequenceNumber={pendingSeq}
          costPence={pendingCost}
          totalSpentPence={totalSpentPence}
          onConfirm={() => castVote(pendingDirection)}
          onCancel={() => setPendingDirection(null)}
        />
      )}
    </>
  )
}

function computeTotalSpent(myVotes: MyVoteCount): number {
  let total = 0
  for (let i = 2; i <= myVotes.upCount; i++) {
    total += voteCostPence('up', i)
  }
  for (let i = 1; i <= myVotes.downCount; i++) {
    total += voteCostPence('down', i)
  }
  return total
}
