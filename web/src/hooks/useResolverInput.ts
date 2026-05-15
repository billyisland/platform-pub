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
  const genRef = useRef(0);

  const pollForResults = useCallback(
    async (requestId: string, gen: number) => {
      if (gen !== genRef.current) return;
      pollCountRef.current++;
      if (pollCountRef.current > maxPolls) {
        setResolving(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (gen !== genRef.current) return;
      try {
        const res = await resolver.poll(requestId);
        if (gen !== genRef.current) return;
        setResult(res);
        if (res.status === "pending") void pollForResults(requestId, gen);
        else setResolving(false);
      } catch {
        if (gen !== genRef.current) return;
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
        genRef.current++;
        setResult(null);
        setResolving(false);
        setResolveError(false);
        return;
      }
      genRef.current++;
      const gen = genRef.current;
      debounceRef.current = setTimeout(async () => {
        if (gen !== genRef.current) return;
        setResolving(true);
        setResolveError(false);
        pollCountRef.current = 0;
        try {
          const res = await resolver.resolve(value.trim(), "subscribe");
          if (gen !== genRef.current) return;
          setResult(res);
          if (res.requestId && res.status === "pending")
            void pollForResults(res.requestId, gen);
          else setResolving(false);
        } catch {
          if (gen !== genRef.current) return;
          setResolveError(true);
          setResolving(false);
        }
      }, DEBOUNCE_MS);
    },
    [pollForResults],
  );

  const reset = useCallback(() => {
    genRef.current++;
    if (debounceRef.current) clearTimeout(debounceRef.current);
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
