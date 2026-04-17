import type { PipStatus } from '../../lib/ndk'

// =============================================================================
// TrustPip — 5px circle indicating author legibility level
//
// Not a trust score. A legibility indicator: how much the system knows about
// this author. Green = well-known. Amber = partial. Grey = unknown/no data.
// See ALLHAUS-OMNIBUS §III.7.
// =============================================================================

const PIP_COLORS: Record<PipStatus, string> = {
  known: '#1d9e75',
  partial: '#ef9f27',
  unknown: '#b0b0ab',
}

const PIP_TITLES: Record<PipStatus, string> = {
  known: 'Established author',
  partial: 'Developing profile',
  unknown: 'No trust data',
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
