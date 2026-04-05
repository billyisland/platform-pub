import { useState, useEffect } from 'react'

// =============================================================================
// useWriterName — resolves a Nostr pubkey to a display name
//
// The feed fetches articles from the relay, which only has pubkeys.
// This hook calls the gateway to resolve pubkey → display name + username,
// with a client-side cache to avoid redundant lookups.
// =============================================================================

interface WriterInfo {
  id: string | null
  displayName: string
  username: string
  avatar: string | null
}

const cache = new Map<string, WriterInfo>()
const pending = new Map<string, Promise<WriterInfo | null>>()

export function useWriterName(pubkey: string): WriterInfo | null {
  const [info, setInfo] = useState<WriterInfo | null>(cache.get(pubkey) ?? null)

  useEffect(() => {
    if (cache.has(pubkey)) {
      setInfo(cache.get(pubkey)!)
      return
    }

    let cancelled = false

    // Deduplicate in-flight requests
    if (!pending.has(pubkey)) {
      const promise = fetchWriterByPubkey(pubkey)
      pending.set(pubkey, promise)
      promise.finally(() => pending.delete(pubkey))
    }

    pending.get(pubkey)!.then((result) => {
      if (result) {
        cache.set(pubkey, result)
        if (!cancelled) setInfo(result)
      }
    })

    return () => { cancelled = true }
  }, [pubkey])

  return info
}

async function fetchWriterByPubkey(pubkey: string): Promise<WriterInfo | null> {
  try {
    const res = await fetch(`/api/v1/writers/by-pubkey/${pubkey}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      id: data.id ?? null,
      displayName: data.displayName ?? data.username ?? pubkey.slice(0, 12),
      username: data.username,
      avatar: data.avatar,
    }
  } catch {
    return null
  }
}
