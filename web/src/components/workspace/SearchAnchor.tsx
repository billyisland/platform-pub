'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  search as searchApi,
  type SearchArticleResult,
  type SearchWriterResult,
  type SearchPublicationResult,
} from '../../lib/api'

const TOKENS = {
  buttonBg: '#FFFFFF',
  buttonFg: '#1A1A18',
  buttonRing: '#1A1A18',
  buttonHoverBg: '#F0EFEB',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  rowHoverBg: '#F0EFEB',
  inputBg: '#FAFAF7',
  text: '#1A1A18',
  meta: '#8A8880',
  hint: '#9C9A94',
  hairline: 'rgba(26, 26, 24, 0.08)',
}

const DEBOUNCE_MS = 200
const MIN_QUERY_LEN = 2

interface Results {
  writers: SearchWriterResult[]
  articles: SearchArticleResult[]
  publications: SearchPublicationResult[]
}

const EMPTY_RESULTS: Results = { writers: [], articles: [], publications: [] }

export function SearchAnchor() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>(EMPTY_RESULTS)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<number | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    abortRef.current?.abort()
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  // Autofocus input when the panel opens.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  // Outside click + Esc close. Mirrors NotificationsAnchor.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (buttonRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Cleanup on unmount.
  useEffect(() => () => {
    abortRef.current?.abort()
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
  }, [])

  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setStatus('loading')
    try {
      const [writers, articles, publications] = await Promise.all([
        searchApi.writers(q, 5, ac.signal),
        searchApi.articles(q, 8, ac.signal),
        searchApi.publications(q, 5, ac.signal),
      ])
      if (ac.signal.aborted) return
      setResults({
        writers: writers.results,
        articles: articles.results,
        publications: publications.results,
      })
      setStatus('ready')
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      console.error('Search error:', err)
      setStatus('error')
    }
  }, [])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const trimmed = value.trim()
    if (trimmed.length < MIN_QUERY_LEN) {
      abortRef.current?.abort()
      setResults(EMPTY_RESULTS)
      setStatus('idle')
      return
    }
    debounceRef.current = window.setTimeout(() => {
      void runSearch(trimmed)
    }, DEBOUNCE_MS)
  }, [runSearch])

  const navigate = useCallback((href: string) => {
    close()
    router.push(href)
  }, [close, router])

  const totalResults =
    results.writers.length + results.articles.length + results.publications.length
  const showEmpty =
    status === 'ready' && totalResults === 0 && query.trim().length >= MIN_QUERY_LEN

  return (
    <div
      style={{
        position: 'fixed',
        right: 152, // ∀ at right: 24 (w 56) + bell at right: 96 (w 40) + 16 gap = 152
        bottom: 32, // matches bell vertical-centre against ∀'s 56px axis
        zIndex: 50,
      }}
    >
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Search"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 56,
            width: 380,
            maxHeight: 'min(480px, calc(100vh - 120px))',
            background: TOKENS.panelBg,
            border: `1px solid ${TOKENS.panelBorder}`,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '14px 16px 10px 16px',
              borderBottom: `1px solid ${TOKENS.hairline}`,
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search writers, articles, publications…"
              className="font-sans text-[14px]"
              style={{
                width: '100%',
                padding: '8px 10px',
                background: TOKENS.inputBg,
                border: `1px solid ${TOKENS.hairline}`,
                color: TOKENS.text,
                outline: 'none',
              }}
            />
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {status === 'idle' && (
              <div
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
              >
                Type at least {MIN_QUERY_LEN} characters
              </div>
            )}
            {status === 'loading' && (
              <div
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
              >
                Searching…
              </div>
            )}
            {status === 'error' && (
              <div
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
              >
                Couldn’t run search
              </div>
            )}
            {showEmpty && (
              <div
                style={{
                  color: TOKENS.hint,
                  padding: '32px 16px',
                  textAlign: 'center',
                  fontStyle: 'italic',
                }}
                className="font-serif text-[13px]"
              >
                No results for “{query.trim()}”.
              </div>
            )}

            {status === 'ready' && results.writers.length > 0 && (
              <Section label="Writers">
                {results.writers.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => navigate(`/${w.username}`)}
                    style={rowStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.background = TOKENS.rowHoverBg }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <div className="font-sans text-[13px]" style={{ color: TOKENS.text, fontWeight: 500 }}>
                      {w.displayName ?? w.username}
                    </div>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.06em]"
                      style={{ color: TOKENS.hint, marginTop: 2 }}
                    >
                      @{w.username} · {w.articleCount} article{w.articleCount === 1 ? '' : 's'}
                    </div>
                  </button>
                ))}
              </Section>
            )}

            {status === 'ready' && results.articles.length > 0 && (
              <Section label="Articles">
                {results.articles.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => navigate(`/article/${a.dTag}`)}
                    style={rowStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.background = TOKENS.rowHoverBg }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <div
                      className="font-serif text-[14px]"
                      style={{
                        color: TOKENS.text,
                        lineHeight: 1.35,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {a.title}
                    </div>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.06em]"
                      style={{ color: TOKENS.hint, marginTop: 4 }}
                    >
                      {a.writer.displayName ?? a.writer.username}
                      {a.isPaywalled ? ' · paywalled' : ''}
                    </div>
                  </button>
                ))}
              </Section>
            )}

            {status === 'ready' && results.publications.length > 0 && (
              <Section label="Publications">
                {results.publications.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => navigate(`/pub/${p.slug}`)}
                    style={rowStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.background = TOKENS.rowHoverBg }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <div className="font-sans text-[13px]" style={{ color: TOKENS.text, fontWeight: 500 }}>
                      {p.name}
                    </div>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.06em]"
                      style={{ color: TOKENS.hint, marginTop: 2 }}
                    >
                      /{p.slug} · {p.articleCount} article{p.articleCount === 1 ? '' : 's'}
                    </div>
                  </button>
                ))}
              </Section>
            )}
          </div>
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: TOKENS.buttonBg,
          color: TOKENS.buttonFg,
          border: `1px solid ${TOKENS.buttonRing}`,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'transform 120ms ease-out, background 120ms ease-out',
          transform: open ? 'scale(1.04)' : 'scale(1)',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = TOKENS.buttonHoverBg
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = TOKENS.buttonBg
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="8" cy="8" r="5" />
          <path d="M12 12l3 3" />
        </svg>
      </button>
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '10px 16px',
  background: 'transparent',
  border: 'none',
  borderBottom: `1px solid ${TOKENS.hairline}`,
  cursor: 'pointer',
  transition: 'background 80ms linear',
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="font-mono text-[11px] uppercase tracking-[0.06em]"
        style={{
          color: TOKENS.meta,
          padding: '10px 16px 6px 16px',
          background: TOKENS.inputBg,
          borderBottom: `1px solid ${TOKENS.hairline}`,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}
