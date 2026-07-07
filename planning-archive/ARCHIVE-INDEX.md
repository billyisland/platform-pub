# Archive index

The single point of reference for retired documentation. Every doc that was once
live but is now shipped, resolved, superseded, or deleted is recorded here — what
it was, why it's gone, and where its concerns live now. Consolidated 2026-06-07.

**Active docs are NOT listed here.** For live specs and trackers see CLAUDE.md
"Key docs" (`docs/adr/`, `docs/audits/`, and the root trackers).

Status legend: **SHIPPED** (work complete, kept as history) · **RESOLVED**
(audit/diagnosis whose findings are fixed) · **SUPERSEDED** (a live doc replaces
it) · **SPECULATIVE** (designed, never built; parked) · **DELETED** (removed —
recover from git history; superseded with no residual value).

---

## Trackers — SUPERSEDED

| Doc | What it was | Live home of its content |
| --- | --- | --- |
| `feature-debt.md` | the root debt tracker + work log + attack order (2026-04 → 2026-07) | retired 2026-07-07: work-log entries duplicate `docs/audits/FIX-PROGRAMME.md` (the work log); open items absorbed into `docs/audits/CONSOLIDATED-TODO.md` (the canonical queue); the rest is shipped-work history. Docs citing "feature-debt §N" resolve here. |

## Relocated (now live, not archived)

| Doc | Was | Now |
| --- | --- | --- |
| `RELAY-OUTBOX-ADR.md` | stranded in this archive while cited as a live invariant | moved to `docs/adr/` (CLAUDE.md + feature-debt.md point here) |
| `RELAY-OUTBOX-PHASE-4-ADR.md` | same | moved to `docs/adr/` |

## Workspace build history — SHIPPED (merged to master 2026-05-29)

| Doc | What it was | Live home of its content |
| --- | --- | --- |
| `WORKSPACE-EXPERIMENT-ADR.md` | build log of the 34-slice workspace experiment | the shipped workspace code; `WORKSPACE-DESIGN-SPEC.md` for semantics |
| `WORKSPACE-MIGRATION-MAP.md` | per-surface survives/retires/folds decision map | baked into the codebase |
| `WORKSPACE-FULL-VIEW-DIAGNOSIS.md` | three full-view bugs (RESOLVED) | fixes shipped; spec is `WORKSPACE-FULL-VIEW-SPEC.md` |
| `ALLHAUS-REDESIGN-SPEC.md` | redesign spec; Phase A shipped, Phase B superseded by workspace | **§3 Compose overlay still the compose spec**; rest historical |
| `FEED-CHANGES-BUILD-PLAN-cleanup.md` | 9-task vessel/card UI build plan + post-ship audits | all tasks shipped 2026-05-30 |

## Root build-plans / handoffs — SHIPPED

| Doc | What it was |
| --- | --- |
| `REVIEW-PLAN.md` | 378KB codebase review programme; all 13 sessions done |
| `FIX-SLICES.md` | 14-slice decomposition of REVIEW-PLAN; all slices ✓ |
| `FEED-CHANGES-BUILD-PLAN.md` | 9 feed/vessel UI tasks; all ✅ |
| `CARD-BEHAVIOUR-BUILD-PLAN.md` | unified card model Phases 1–3; shipped 2026-05-26 |
| `WIREFRAME-PLAN.md` | wireframing session instructions; consumed into `WIREFRAME-DECISIONS-CONSOLIDATED.md` (live) |
| `ALLHAUS-UI-SURFACE.md` | April reconciliation bridge; superseded by live April specs |
| `AUDIT-2026-05-29.md` | security/correctness audit; all findings RESOLVED |

## Audits — RESOLVED / SUPERSEDED

| Doc | Status | Notes |
| --- | --- | --- |
| `AUDIT-REPORT.md` | RESOLVED | April 2026, 34 findings; folded into FIX-PROGRAMME |
| `AUDIT-fresh-2026-06-02.md` | RESOLVED | 9-finding tooling sweep, all fixed |
| `ADMIN-PAGE-AUDIT.md` | RESOLVED | 13 design-system issues, all shipped |
| `platform-pub-review.md` | SUPERSEDED | source for `docs/audits/FIX-PROGRAMME.md` |
| `universal-feed-audit.md` | RESOLVED | 4 passes, all findings closed |
| `BASELINE-2026-05.md` | SUPERSEDED | static-analysis snapshot; superseded by CI |
| `FEED-INGEST-HYDRATION-AUDIT.md` | RESOLVED | Tranches A/B shipped; C deferred — live plan is `docs/audits/FEED-INGEST-HYDRATION-PLAN.md` |

## Speculative specs — designed, never built (parked)

| Doc | Notes |
| --- | --- |
| `OWNER-DASHBOARD-SPEC.md` | admin ops dashboard; no implementation. Revive as a fresh ADR if built |
| `platform-bucket-system-design.md` | generalised entity-partition system; prior art for future DM/feed policy |
| `platform-pub-currency-strategy.md` | multi-currency strategy; Option 2 for launch, Option 3 post-launch — decide before building |

## Deleted — superseded, no residual value (recover from git)

| Doc | Superseded by |
| --- | --- |
| `DESIGN-BRIEF.md`, `DESIGN.md`, `ALLHAUS-DESIGN.md`, `PLATFORM-DESIGN-SPEC-v2.md` | CLAUDE.md design-system rules + `WORKSPACE-DESIGN-SPEC.md` + `WIREFRAME-DECISIONS-CONSOLIDATED.md` |
| `NAVIGATION-ARCHITECTURE.md`, `FRONTEND-GAPS.md` | workspace ADRs |
| `AUDIT.md`, `DIAGNOSIS.md`, `FIXES.md`, `FIXES-REMAINING.md` | `docs/audits/FIX-PROGRAMME.md` |
| `ALLHAUS-ADR-UNIFIED.md` | `docs/adr/ALLHAUS-OMNIBUS.md` |

---

## Older historical docs (pre-existing in this archive)

These predate the 2026-06-07 consolidation and remain as historical reference:
`FEATURES.md`, `RESILIENCE.md`, `FEED-ALGORITHM.md` (feed reach spec, Phase 1
shipped — still cited by CLAUDE.md), `LOGO-SPEC.md`, `SETTINGS-RATIONALISATION.md`,
`INSTALL.md`, `TRAFFOLOGY-BUILD-STATUS.md`, `UI-DECISIONS-2026-04-03.md`,
`UI-SOLIDIFY.md`, `STEP-4-NEW-PAGES.md`, `EXPORT-FIX.md`, `FEED_DESIGN_SPEC.md`,
`platform-pub-feature-architecture.md`.
