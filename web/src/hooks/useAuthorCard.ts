"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface AuthorCardData {
  tier: "A" | "B" | "C" | "D";
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  sourceName?: string;
  sourceDescription?: string;
  sourceUrl?: string;
  sourceProtocol?: string;
  partial?: boolean;
  followTarget?: {
    type: "user" | "source";
    id: string;
    isFollowing: boolean;
    protocol?: string;
    sourceUri?: string;
  };
}

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
  type: "native" | "external",
  id: string,
): Promise<AuthorCardData | null> {
  try {
    const res = await fetch(
      `/api/v1/author-card?type=${type}&id=${encodeURIComponent(id)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    return (await res.json()) as AuthorCardData;
  } catch {
    return null;
  }
}

export function useAuthorCard(
  type: "native" | "external",
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
      existing.finally(() => inflight.delete(cacheKey));
    }

    existing.then((data) => {
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
    fetchAuthorCard(type, id).then((data) => {
      if (data) {
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      setState({ data, loading: false });
    });
  }, [type, id]);

  return { ...state, refresh };
}
