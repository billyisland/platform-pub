"use client";

import { useEffect, useState } from "react";
import { externalItems, type ExternalThreadEntry } from "../lib/api/feeds";

interface ExternalThreadState {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  loading: boolean;
  error: boolean;
}

const cache = new Map<
  string,
  { ancestors: ExternalThreadEntry[]; descendants: ExternalThreadEntry[] }
>();

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

    const cached = cache.get(key);
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
        cache.set(key, {
          ancestors: res.ancestors,
          descendants: res.descendants,
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
