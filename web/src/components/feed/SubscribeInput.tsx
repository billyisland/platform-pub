'use client'

import { useState, useRef, useCallback } from 'react'
import { resolver, feeds, type ResolverResult, type ResolverMatch } from '../../lib/api'

// =============================================================================
// SubscribeInput — omnivorous input for subscribing to external feeds
//
// Single text input backed by the universal resolver. Accepts URLs, handles,
// npubs — whatever the user has. Shows classification and match results
// as a dropdown.
// =============================================================================

interface SubscribeInputProps {
  onSubscribed?: () => void
}

export function SubscribeInput({ onSubscribed }: SubscribeInputProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResolverResult | null>(null)
  const [resolving, setResolving] = useState(false)
  const [subscribing, setSubscribing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)

  const handleChange = useCallback((value: string) => {
    setQuery(value)
    setError(null)
    setSuccess(null)
    setResult(null)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!value.trim()) return

    debounceRef.current = setTimeout(async () => {
      setResolving(true)
      try {
        const res = await resolver.resolve(value.trim(), 'subscribe')

        if (res.error && res.matches.length === 0) {
          setError(res.error)
          setResult(null)
          setResolving(false)
          return
        }

        setResult(res)

        // If there are pending resolutions, poll for them
        if (res.requestId && res.pendingResolutions && res.pendingResolutions.length > 0) {
          pollCountRef.current = 0
          pollForResults(res.requestId)
        } else {
          setResolving(false)
        }
      } catch {
        setError('Resolution failed')
        setResolving(false)
      }
    }, 300)
  }, [])

  const pollForResults = useCallback(async (requestId: string) => {
    pollCountRef.current++
    if (pollCountRef.current > 3) {
      setResolving(false)
      return
    }

    await new Promise(resolve => setTimeout(resolve, 1000))

    try {
      const res = await resolver.poll(requestId)
      setResult(res)

      if (res.pendingResolutions && res.pendingResolutions.length > 0) {
        pollForResults(requestId)
      } else {
        setResolving(false)
      }
    } catch {
      setResolving(false)
    }
  }, [])

  const handleSubscribe = useCallback(async (match: ResolverMatch) => {
    const key = match.externalSource?.sourceUri ?? match.rssFeed?.feedUrl ?? ''
    setSubscribing(key)
    setError(null)

    try {
      let protocol: string
      let sourceUri: string
      let displayName: string | undefined
      let description: string | undefined
      let avatarUrl: string | undefined
      let relayUrls: string[] | undefined

      if (match.rssFeed) {
        protocol = 'rss'
        sourceUri = match.rssFeed.feedUrl
        displayName = match.rssFeed.title
        description = match.rssFeed.description
      } else if (match.externalSource) {
        protocol = match.externalSource.protocol
        sourceUri = match.externalSource.sourceUri
        displayName = match.externalSource.displayName
        description = match.externalSource.description
        avatarUrl = match.externalSource.avatar
        relayUrls = match.externalSource.relayUrls
      } else {
        setError('Cannot subscribe to this type of result')
        setSubscribing(null)
        return
      }

      await feeds.subscribe({ protocol, sourceUri, displayName, description, avatarUrl, relayUrls })
      setSuccess(`Subscribed to ${displayName ?? sourceUri}`)
      setQuery('')
      setResult(null)
      onSubscribed?.()
    } catch (err: any) {
      setError(err?.message ?? 'Subscription failed')
    } finally {
      setSubscribing(null)
    }
  }, [onSubscribed])

  const INPUT_TYPE_LABELS: Record<string, string> = {
    url: 'Resolving URL...',
    npub: 'Nostr public key',
    nprofile: 'Nostr profile',
    hex_pubkey: 'Nostr public key',
    did: 'AT Protocol DID',
    bluesky_handle: 'Bluesky handle',
    fediverse_handle: 'Fediverse handle',
    ambiguous_at: 'Resolving identity...',
    platform_username: 'Platform user',
    free_text: 'Searching...',
  }

  return (
    <div>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Follow a URL, handle, or npub"
          className="w-full bg-transparent px-0 py-2.5 text-ui-sm text-black placeholder:text-grey-400 focus:outline-none border-b-4 border-black"
        />
        {resolving && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-grey-300 border-t-black rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Classification hint */}
      {resolving && result?.inputType && (
        <p className="text-mono-xs text-grey-400 mt-1.5">
          {INPUT_TYPE_LABELS[result.inputType] ?? 'Resolving...'}
        </p>
      )}

      {/* Error */}
      {error && (
        <p className="text-mono-xs text-crimson mt-1.5">{error}</p>
      )}

      {/* Success */}
      {success && (
        <p className="text-mono-xs text-black mt-1.5">{success}</p>
      )}

      {/* Match results */}
      {result && result.matches.length > 0 && !success && (
        <div className="mt-2 border border-grey-200">
          {result.matches.map((match, i) => (
            <MatchRow
              key={i}
              match={match}
              subscribing={subscribing}
              onSubscribe={handleSubscribe}
            />
          ))}
        </div>
      )}

      {/* No matches after resolution complete */}
      {result && result.matches.length === 0 && !resolving && !error && !success && query.trim() && (
        <p className="text-mono-xs text-grey-400 mt-1.5">No matches found</p>
      )}
    </div>
  )
}

function MatchRow({
  match,
  subscribing,
  onSubscribe,
}: {
  match: ResolverMatch
  subscribing: string | null
  onSubscribe: (match: ResolverMatch) => void
}) {
  const isSubscribable = match.type === 'rss_feed' || match.type === 'external_source'
  const key = match.externalSource?.sourceUri ?? match.rssFeed?.feedUrl ?? ''
  const isLoading = subscribing === key

  let name: string
  let detail: string
  let badge: string

  if (match.rssFeed) {
    name = match.rssFeed.title ?? 'RSS Feed'
    detail = match.rssFeed.feedUrl
    badge = 'RSS'
  } else if (match.externalSource) {
    name = match.externalSource.displayName ?? match.externalSource.sourceUri
    detail = match.externalSource.sourceUri
    badge = match.externalSource.protocol === 'atproto' ? 'BLUESKY'
          : match.externalSource.protocol === 'activitypub' ? 'MASTODON'
          : match.externalSource.protocol === 'nostr_external' ? 'NOSTR'
          : match.externalSource.protocol.toUpperCase()
  } else if (match.account) {
    name = match.account.displayName
    detail = `@${match.account.username}`
    badge = 'ALL.HAUS'
  } else {
    return null
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-grey-200 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-ui-sm font-semibold text-black truncate">{name}</span>
          <span className="label-ui text-grey-400 flex-shrink-0">{badge}</span>
          {match.externalSource?.protocol === 'activitypub' && (
            <span className="label-ui text-amber-600 flex-shrink-0" title="Mastodon outbox polling is best-effort — some posts may be missing depending on the instance">BETA</span>
          )}
        </div>
        <p className="text-mono-xs text-grey-400 truncate">{detail}</p>
      </div>
      {isSubscribable && (
        <button
          onClick={() => onSubscribe(match)}
          disabled={isLoading}
          className="btn text-[13px] py-1 px-3 ml-3 flex-shrink-0 disabled:opacity-50"
        >
          {isLoading ? 'Adding...' : 'Subscribe'}
        </button>
      )}
    </div>
  )
}
