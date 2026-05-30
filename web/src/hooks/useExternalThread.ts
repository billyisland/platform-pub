"use client";

import { useEffect, useState } from "react";
import { externalItems, type ExternalThreadEntry } from "../lib/api/feeds";

interface ExternalThreadState {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  loading: boolean;
  error: boolean;
}

interface CachedThread {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  ts: number;
}

// Bounded by a TTL + entry cap so the keyspace (one entry per node clicked)
// can't grow without limit and threads refresh after the TTL rather than going
// stale for the whole session (M3).
const cache = new Map<string, CachedThread>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

function readCache(key: string): CachedThread | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function writeCache(key: string, entry: CachedThread): void {
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function useExternalThread(
  itemId: string,
  expanded: boolean,
  // Source-platform id of a re-rooted node (ExternalThreadEntry.id). When set,
  // the thread is fetched relative to that node instead of the base item — this
  // is what powers in-place re-focus on external cards.
  focus?: string,
): ExternalThreadState {
  const [state, setState] = useState<ExternalThreadState>({
    ancestors: [],
    descendants: [],
    loading: false,
    error: false,
  });

  useEffect(() => {
    if (!expanded) return;

    // Cache + request are keyed on the (item, focus) pair so re-focusing onto a
    // different node refetches rather than reusing the base item's tree.
    const key = focus ? `${itemId}|${focus}` : itemId;

    const cached = readCache(key);
    if (cached) {
      setState({
        ancestors: cached.ancestors,
        descendants: cached.descendants,
        loading: false,
        error: false,
      });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));

    externalItems
      .thread(itemId, focus)
      .then((res) => {
        writeCache(key, {
          ancestors: res.ancestors,
          descendants: res.descendants,
          ts: Date.now(),
        });
        if (cancelled) return;
        setState({
          ancestors: res.ancestors,
          descendants: res.descendants,
          loading: false,
          error: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          ancestors: [],
          descendants: [],
          loading: false,
          error: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, itemId, focus]);

  return state;
}
