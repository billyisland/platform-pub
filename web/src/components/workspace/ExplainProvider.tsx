"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  type ExplainKind,
  buildExplainSequence,
  explainCopy,
  explainVesselLabel,
} from "../../lib/explain/registry";
import { useExplain, type Annotation, type Program } from "../../stores/explain";

// =============================================================================
// ExplainProvider — the registration substrate for the Explain engine.
//
// EXPLAIN-ADR D4/§8. Holds a live Map of the explainable ROOTS on the workspace
// floor (`floor`, `disc`, each `vessel`). Roots register their DOM ref via
// `useExplainable`; leaves (`vessel.name`, `card.byline`, …) are NOT registered
// here — they carry `data-explain="…"` attributes and are discovered by DOM
// query at resolve time (D4: registered roots + delegated leaves).
//
// The Map holds LIVE refs, so a registration survives drag / reorder / mount
// churn: the engine reads `ref.current.getBoundingClientRect()` at open()/hover,
// never a cached snapshot (D11). This slice ships the substrate only — nothing
// consumes the Map yet (no visible UI).
// =============================================================================

export interface ExplainRegistration {
  kind: ExplainKind;
  // Singleton kinds key on the kind itself; per-feed `vessel` keys on feedId.
  key: string;
  ref: React.RefObject<HTMLElement>;
  // Ordering hint — the vessel's sort_rank, for the derived sequence (D4).
  order?: number;
  // Copy-fork inputs read off the anchored object (vessel: { feedName,
  // fromStarter }).
  params?: Record<string, unknown>;
}

interface ExplainRegistry {
  register: (reg: ExplainRegistration) => () => void;
  // A snapshot of the current registrations (call at open()/hover, never cache).
  snapshot: () => ExplainRegistration[];
}

const ExplainContext = createContext<ExplainRegistry | null>(null);

export function ExplainProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<Map<string, ExplainRegistration>>(new Map());

  const register = useCallback((reg: ExplainRegistration) => {
    const id = `${reg.kind}:${reg.key}`;
    mapRef.current.set(id, reg);
    return () => {
      // Guard the remount race: only drop the slot if it still holds THIS
      // registration (a fast unmount→remount may have already replaced it).
      if (mapRef.current.get(id) === reg) mapRef.current.delete(id);
    };
  }, []);

  const snapshot = useCallback(
    () => Array.from(mapRef.current.values()),
    [],
  );

  const value = useMemo<ExplainRegistry>(
    () => ({ register, snapshot }),
    [register, snapshot],
  );

  return (
    <ExplainContext.Provider value={value}>{children}</ExplainContext.Provider>
  );
}

// Read the registry directly (the engine's resolver, later slice).
export function useExplainRegistry(): ExplainRegistry | null {
  return useContext(ExplainContext);
}

// ---------------------------------------------------------------------------
// Program resolution (EXPLAIN-ADR §9 slice 4, D4/D5/D7).
//
// The Explain program is built ONCE at open() from the live registry: the
// registered vessel roots ∪ the tagged descendants present at that moment,
// ordered floor → per-vessel (by sort_rank) → representative card kinds → disc
// (buildExplainSequence). Each step's copy is resolved here — the vessel label
// forks on the anchored feed's `fromStarter` param (D7); card kinds contribute
// ONE representative annotation each (D5, gated on any vessel actually having
// cards). Runs against the registry, so it must be called from inside the
// provider (the ForallMenu Explain row is — it lives on the floor).
// ---------------------------------------------------------------------------

function resolveExplainProgram(registry: ExplainRegistry): Program {
  const roots = registry.snapshot();
  const vesselRoots = roots.filter((r) => r.kind === "vessel");

  // A vessel "has cards" iff its live subtree contains a tagged card leaf. The
  // representative card annotation (D5) then anchors to the lowest-sort_rank
  // such vessel (resolved in the overlay's elementFor).
  const hasCards = vesselRoots.some(
    (v) => !!v.ref.current?.querySelector('[data-explain="card"]'),
  );

  const steps = buildExplainSequence(
    vesselRoots.map((v) => ({ key: v.key, order: v.order ?? 0 })),
    hasCards,
  );

  const fromStarterByKey = new Map(
    vesselRoots.map((v) => [v.key, !!v.params?.fromStarter]),
  );

  const annotations: Annotation[] = steps.map((s) => ({
    kind: s.kind,
    key: s.key,
    copy:
      s.kind === "vessel"
        ? explainVesselLabel(fromStarterByKey.get(s.key ?? "") ?? false)
        : explainCopy(s.kind),
  }));

  return { kind: "explain", annotations };
}

// Returns a callback that resolves the Explain program from the live registry
// and opens it (EXPLAIN-ADR §8). No-op outside a provider or with zero targets
// (the latter is genuinely unreachable on the desktop floor once ≥1 vessel is
// registered — floor + disc alone already give a non-empty sequence).
export function useOpenExplain(): () => void {
  const registry = useContext(ExplainContext);
  return useCallback(() => {
    if (!registry) return;
    const program = resolveExplainProgram(registry);
    if (program.annotations.length === 0) return;
    useExplain.getState().open(program);
  }, [registry]);
}

// Register an explainable ROOT. Pass an existing `ref` (the vessel/floor already
// owns one) or let the hook mint one and attach the returned ref to the DOM
// node. Outside a provider (e.g. the loading-state Floor) this is an inert
// no-op. Re-registers when key/order/params change.
export function useExplainable<T extends HTMLElement = HTMLElement>(
  kind: ExplainKind,
  opts?: {
    key?: string;
    ref?: React.RefObject<T>;
    order?: number;
    params?: Record<string, unknown>;
  },
): React.RefObject<T> {
  const registry = useContext(ExplainContext);
  const internalRef = useRef<T>(null);
  const ref = opts?.ref ?? internalRef;
  const key = opts?.key ?? kind;
  const order = opts?.order;
  const params = opts?.params;
  // Serialise params so the effect re-registers when a value (feedName /
  // fromStarter) changes, without depending on object identity.
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    if (!registry) return;
    return registry.register({
      kind,
      key,
      ref: ref as unknown as React.RefObject<HTMLElement>,
      order,
      params,
    });
    // params is captured via paramsKey; ref identity is stable per element.
  }, [registry, kind, key, order, paramsKey, ref]);

  return ref;
}
