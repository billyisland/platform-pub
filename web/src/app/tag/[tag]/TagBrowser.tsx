'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { tags as tagsApi } from '../../../lib/api'
import { formatDateRelative, truncateText, stripMarkdown } from '../../../lib/format'
import { useReader } from '../../../stores/reader'
import { isModifiedClick } from '../../../components/ui/ProfileLink'

// `inOverlay` is set when TagBrowser renders inside the surface overlay
// (useSurfaceOverlay): article rows then open the reader overlay in place rather
// than navigating to /article/:dTag and escaping the workspace to the black
// topbar. The standalone /tag/[tag] page leaves it false (full-page links).
export function TagBrowser({ tagName, inOverlay = false }: { tagName: string; inOverlay?: boolean }) {
  const openArticle = useReader((s) => s.openNative)
  const [articles, setArticles] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)

  const load = useCallback(async (newOffset: number) => {
    try {
      const res = await tagsApi.getByName(tagName, 20, newOffset)
      if (newOffset === 0) {
        setArticles(res.articles)
      } else {
        setArticles(prev => [...prev, ...res.articles])
      }
      setTotal(res.total)
      setOffset(newOffset + res.articles.length)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [tagName])

  useEffect(() => { void load(0) }, [load])

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
      <h1 className="font-mono text-2xl uppercase tracking-[0.02em] text-black">
        #{tagName}
      </h1>
      <p className="label-ui text-grey-400 mt-1 mb-10">
        {total} article{total !== 1 ? 's' : ''}
      </p>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse bg-white" />)}
        </div>
      ) : articles.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">#{tagName} — No articles yet.</p>
        </div>
      ) : (
        <div className="space-y-0">
          {articles.map((a: any) => {
            const publishedAt = a.published_at ? Math.floor(new Date(a.published_at).getTime() / 1000) : 0
            const excerpt = a.summary ? truncateText(stripMarkdown(a.summary), 200) : ''
            const isPaid = a.access_mode === 'paywalled'
            const barColor = isPaid ? '#B5242A' : '#111111'

            return (
              <Link
                key={a.nostr_event_id}
                href={`/article/${a.nostr_d_tag}`}
                onClick={(e) => {
                  // In the overlay, open the reader in place; modified clicks
                  // (new tab) still follow the real link.
                  if (inOverlay && !isModifiedClick(e) && a.nostr_d_tag) {
                    e.preventDefault()
                    openArticle(a.nostr_d_tag)
                  }
                }}
                className="group block mt-9"
                style={{ borderLeft: `6px solid ${barColor}`, paddingLeft: '28px' }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="label-ui text-grey-600">
                    {a.author_display_name ?? a.author_username}
                  </span>
                  {publishedAt > 0 && (
                    <>
                      <span className="font-mono text-mono-xs text-grey-600">&middot;</span>
                      <span className="font-mono text-mono-xs tracking-[0.02em] text-grey-600">
                        {formatDateRelative(publishedAt)}
                      </span>
                    </>
                  )}
                </div>
                <h2 className="font-serif text-[28px] font-medium italic text-black leading-[1.18] tracking-[-0.02em] mb-2 group-hover:text-crimson-dark transition-colors">
                  {a.title}
                </h2>
                {excerpt && (
                  <p className="font-serif text-[15.5px] text-grey-600 leading-[1.65]" style={{ maxWidth: '540px' }}>
                    {excerpt}
                  </p>
                )}
              </Link>
            )
          })}
          {articles.length < total && (
            <div className="py-8 text-center">
              <button
                onClick={() => load(offset)}
                className="btn-text underline underline-offset-4"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
