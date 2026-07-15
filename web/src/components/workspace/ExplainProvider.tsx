"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ExplainKind } from "../../lib/explain/registry";

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
