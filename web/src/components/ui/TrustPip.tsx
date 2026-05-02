import type { PipStatus } from '../../lib/ndk'

// =============================================================================
// TrustPip — 5px circle indicating author legibility level
//
// Not a trust score. A legibility indicator: how much the system knows about
// this author. Four states (slice 17 widened from three):
//   green    — well-known (all polls positive + L1 anchor)
//   amber    — partial / developing
//   grey     — no signal yet
//   crimson  — contested (negative humanity or good_faith poll signal)
// See ALLHAUS-OMNIBUS §III.7 + CARDS-AND-PIP-PANEL-HANDOFF.md §"Trust section".
// Composition lives in feed-ingest/src/lib/trust-pip.ts.
// =============================================================================

const PIP_COLORS: Record<PipStatus, string> = {
  known: '#1d9e75',
  partial: '#ef9f27',
  unknown: '#b0b0ab',
  contested: '#B5242A',
}

const PIP_TITLES: Record<PipStatus, string> = {
  known: 'Established author',
  partial: 'Developing profile',
  unknown: 'No trust data',
  contested: 'Contested signal',
}

interface TrustPipProps {
  status?: PipStatus
}

export function TrustPip({ status = 'unknown' }: TrustPipProps) {
  return (
    <span
      className="trust-pip"
      style={{ backgroundColor: PIP_COLORS[status] }}
      title={PIP_TITLES[status]}
      aria-label={PIP_TITLES[status]}
    />
  )
}
