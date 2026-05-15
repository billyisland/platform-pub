import { useCallback, useRef, useState } from "react";
import { resolver, type ResolverResult } from "../lib/api";
import { resolveMatches, type MatchOption } from "../lib/workspace/resolve";

const DEBOUNCE_MS = 300;
const MAX_POLLS = 8;

export interface UseResolverInput {
  query: string;
  onQueryChange: (value: string) => void;
  matches: MatchOption[];
  resolving: boolean;
  resolveError: boolean;
  doneEmpty: boolean;
  reset: () => void;
}

export function useResolverInput(opts?: {
  maxPolls?: number;
}): UseResolverInput {
  const maxPolls = opts?.maxPolls ?? MAX_POLLS;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ResolverResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);

  const pollForResults = useCallback(
    async (requestId: string) => {
      pollCountRef.current++;
      if (pollCountRef.current > maxPolls) {
        setResolving(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await resolver.poll(requestId);
        setResult(res);
        if (res.status === "pending") void pollForResults(requestId);
        else setResolving(false);
      } catch {
        setResolving(false);
      }
    },
    [maxPolls],
  );

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!value.trim()) {
        setResult(null);
        setResolving(false);
        setResolveError(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setResolving(true);
        setResolveError(false);
        pollCountRef.current = 0;
        try {
          const res = await resolver.resolve(value.trim(), "subscribe");
          setResult(res);
          if (res.requestId && res.status === "pending")
            void pollForResults(res.requestId);
          else setResolving(false);
        } catch {
          setResolveError(true);
          setResolving(false);
        }
      }, DEBOUNCE_MS);
    },
    [pollForResults],
  );

  const reset = useCallback(() => {
    setQuery("");
    setResult(null);
    setResolving(false);
    setResolveError(false);
  }, []);

  const matches = resolveMatches(query, result?.matches ?? []);
  const doneEmpty =
    !resolving &&
    result !== null &&
    matches.length === 0 &&
    query.trim().length > 0;

  return {
    query,
    onQueryChange,
    matches,
    resolving,
    resolveError,
    doneEmpty,
    reset,
  };
}
