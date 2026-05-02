// =============================================================================
// trust-pip — pure function composing pip colour from polls + Layer 1 signals
//
// Workspace experiment slice 17. The pip used to map purely from L1 thresholds
// (account age × paying readers × payment_verified). Slice 15 added three
// poll questions (humanity / authenticity / good_faith); slice 17 blends the
// two into the four-state pip the handoff (CARDS-AND-PIP-PANEL-HANDOFF.md
// §"Trust section") describes:
//
//   green    (known)     — high confidence positive across all three polls
//                           AND L1 signal (NIP-05 OR paying readers)
//   amber    (partial)   — some positive signal — at least one poll positive
//                           OR strong L1 (≥3 articles + payment_verified)
//   grey     (unknown)   — no meaningful signal yet
//   crimson  (contested) — meaningful negative humanity OR good_faith
//                           (authenticity-no alone stays amber)
//
// Threshold values (yes-share 0.7 / 0.3, sample-size floor 3) are first-cut
// numbers chosen by feel. The full handoff §"Trust section" calls for
// confidence-interval scaling once polling has volume; we'll tune after a
// week of real data.
// =============================================================================

export type PipStatus = 'known' | 'partial' | 'unknown' | 'contested'

export interface PipLayer1 {
  accountAgeDays: number
  payingReaderCount: number
  articleCount: number
  paymentVerified: boolean
  nip05Verified: boolean
}

export interface PipPollAggregate {
  yes: number
  no: number
}

export interface PipPolls {
  humanity: PipPollAggregate
  authenticity: PipPollAggregate
  good_faith: PipPollAggregate
}

export interface PipComposeInput {
  layer1: PipLayer1
  polls: PipPolls
}

const SAMPLE_FLOOR = 3
const POSITIVE_SHARE = 0.7
const NEGATIVE_SHARE = 0.3

type PollSignal = 'positive' | 'negative' | 'ambiguous' | 'no-data'

function classifyPoll(poll: PipPollAggregate): PollSignal {
  const total = poll.yes + poll.no
  if (total < SAMPLE_FLOOR) return 'no-data'
  const yesShare = poll.yes / total
  if (yesShare >= POSITIVE_SHARE) return 'positive'
  if (yesShare <= NEGATIVE_SHARE) return 'negative'
  return 'ambiguous'
}

export function composePipStatus({ layer1, polls }: PipComposeInput): PipStatus {
  const humanity = classifyPoll(polls.humanity)
  const authenticity = classifyPoll(polls.authenticity)
  const goodFaith = classifyPoll(polls.good_faith)

  // Crimson — humanity-no or good_faith-no, both with sample. authenticity-no
  // alone is amber, not crimson: "they're not who they seem" without "they
  // engage in bad faith" is yellow-flag, not red. The handoff explicitly
  // distinguishes authenticity (deliberately weaker than the formal `identity`
  // vouch dimension) from the behavioural-honesty question good_faith.
  if (humanity === 'negative' || goodFaith === 'negative') {
    return 'contested'
  }

  // Green — all three polls positive AND a real L1 anchor. The L1 anchor stops
  // a flood of poll-positive responses on a brand-new account from minting a
  // green pip without any system-side commitment from the writer.
  const l1Anchor = layer1.nip05Verified || layer1.payingReaderCount > 0
  if (
    humanity === 'positive' &&
    authenticity === 'positive' &&
    goodFaith === 'positive' &&
    l1Anchor
  ) {
    return 'known'
  }

  // Amber — any positive poll with sample, OR strong L1 commitment. The L1
  // path lets a writer with no polling volume but real platform commitment
  // still surface above grey.
  const anyPollPositive =
    humanity === 'positive' ||
    authenticity === 'positive' ||
    goodFaith === 'positive'
  const strongL1 = layer1.articleCount >= 3 && layer1.paymentVerified
  if (anyPollPositive || strongL1) {
    return 'partial'
  }

  // Grey — no meaningful signal yet.
  return 'unknown'
}
