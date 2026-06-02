"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { AuthorProfile } from "../lib/api/post";

// One author DTO across the codebase — the gateway AuthorCardResponse, defined
// canonically in lib/api/post.ts. Re-exported here so AuthorModal's existing
// import keeps working.
export type AuthorCardData = AuthorProfile;

// "native" / "external" hit the legacy item-keyed /author-card; "author" hits
// the Phase-4 /author/:id/profile keyed on the persistent author.id.
export type AuthorCardType = "native" | "external" | "author";

interface AuthorCardState {
  data: AuthorCardData | null;
  loading: boolean;
}

interface CacheEntry {
  data: AuthorCardData;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AuthorCardData | null>>();

async function fetchAuthorCard(
  type: AuthorCardType,
  id: string,
): Promise<AuthorCardData | null> {
  try {
    const url =
      type === "author"
        ? `/api/v1/author/${encodeURIComponent(id)}/profile`
        : `/api/v1/author-card?type=${type}&id=${encodeURIComponent(id)}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as AuthorCardData;
  } catch {
    return null;
  }
}

export function useAuthorCard(
  type: AuthorCardType,
  id: string | null,
  enabled: boolean,
): AuthorCardState & { refresh: () => void } {
  const [state, setState] = useState<AuthorCardState>({
    data: null,
    loading: false,
  });

  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !id) return;

    const cacheKey = `${type}:${id}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setState({ data: cached.data, loading: false });
      return;
    }

    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setState({ data: null, loading: true });

    let existing = inflight.get(cacheKey);
    if (!existing) {
      existing = fetchAuthorCard(type, id);
      inflight.set(cacheKey, existing);
      void existing.finally(() => inflight.delete(cacheKey));
    }

    void existing.then((data) => {
      if (data) {
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      setState({ data, loading: false });
    });
  }, [type, id, enabled]);

  useEffect(() => {
    if (!enabled) {
      fetchedRef.current = false;
    }
  }, [enabled]);

  const refresh = useCallback(() => {
    if (!id) return;
    const cacheKey = `${type}:${id}`;
    cache.delete(cacheKey);
    fetchedRef.current = false;
    setState({ data: null, loading: true });
    void fetchAuthorCard(type, id).then((data) => {
      if (data) {
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      setState({ data, loading: false });
    });
  }, [type, id]);

  return { ...state, refresh };
}
