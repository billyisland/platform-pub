import type { PipStatus } from "../../lib/ndk";
import { trustEnabled } from "../../lib/featureFlags";

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
  known: "var(--ah-trust-green)",
  partial: "var(--ah-trust-amber)",
  unknown: "var(--ah-trust-grey)",
  contested: "var(--ah-crimson)",
};

const PIP_TITLES: Record<PipStatus, string> = {
  known: "Established author",
  partial: "Developing profile",
  unknown: "No trust data",
  contested: "Contested signal",
};

interface TrustPipProps {
  status?: PipStatus;
}

export function TrustPip({ status = "unknown" }: TrustPipProps) {
  // Trust parked (NEXT_PUBLIC_TRUST_ENABLED off, architecture-audit item 7):
  // degrade to a neutral, semantically-empty dot. The glyph and its tap target
  // survive so the PipPanel — which also hosts the non-trust VolumeBar — stays
  // reachable, but no trust state is communicated.
  if (!trustEnabled()) {
    return (
      <span
        role="img"
        className="trust-pip"
        style={{ backgroundColor: "var(--ah-trust-grey)" }}
        title="Author"
        aria-label="Author"
      />
    );
  }
  return (
    <span
      role="img"
      className="trust-pip"
      style={{ backgroundColor: PIP_COLORS[status] }}
      title={PIP_TITLES[status]}
      aria-label={PIP_TITLES[status]}
    />
  );
}
