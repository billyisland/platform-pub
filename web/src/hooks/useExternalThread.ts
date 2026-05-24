"use client";

import { useEffect, useState, useRef } from "react";
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
): ExternalThreadState {
  const [state, setState] = useState<ExternalThreadState>({
    ancestors: [],
    descendants: [],
    loading: false,
    error: false,
  });
  const fetched = useRef(false);

  useEffect(() => {
    if (!expanded || fetched.current) return;

    const cached = cache.get(itemId);
    if (cached) {
      setState({
        ancestors: cached.ancestors,
        descendants: cached.descendants,
        loading: false,
        error: false,
      });
      return;
    }

    fetched.current = true;
    setState((prev) => ({ ...prev, loading: true }));

    externalItems
      .thread(itemId)
      .then((res) => {
        cache.set(itemId, {
          ancestors: res.ancestors,
          descendants: res.descendants,
        });
        setState({
          ancestors: res.ancestors,
          descendants: res.descendants,
          loading: false,
          error: false,
        });
      })
      .catch(() => {
        setState({
          ancestors: [],
          descendants: [],
          loading: false,
          error: true,
        });
      });
  }, [expanded, itemId]);

  return state;
}
