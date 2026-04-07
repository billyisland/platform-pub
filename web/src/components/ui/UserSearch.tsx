'use client'

import { useState, useRef, useEffect } from 'react'
import { Avatar } from './Avatar'

export interface UserSearchResult {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
}

interface UserSearchProps {
  onSelect: (user: UserSearchResult) => void
  placeholder?: string
  className?: string
}

export function UserSearch({ onSelect, placeholder = 'Search users…', className = '' }: UserSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); return }

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/v1/search?type=writers&q=${encodeURIComponent(query)}&limit=8`, {
          credentials: 'include',
        })
        if (!res.ok) return
        const data = await res.json()
        setResults(data.results ?? [])
        setOpen(true)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }, 250)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleSelect(user: UserSearchResult) {
    onSelect(user)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true) }}
        placeholder={placeholder}
        className="w-full bg-grey-100 px-3 py-1.5 text-[13px] font-sans text-black placeholder-grey-300"
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <div className="h-3 w-3 border border-grey-300 border-t-transparent  animate-spin" />
        </div>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-grey-200 shadow-sm max-h-[240px] overflow-y-auto">
          {results.map((user) => (
            <button
              key={user.id}
              onClick={() => handleSelect(user)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-grey-100 transition-colors text-left"
            >
              <Avatar src={user.avatar} name={user.displayName ?? user.username} size={24} />
              <div className="min-w-0">
                <span className="text-[13px] font-sans text-black block truncate">{user.displayName ?? user.username}</span>
                <span className="text-[11px] font-mono text-grey-400 block truncate">@{user.username}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && query.length >= 2 && results.length === 0 && !loading && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-grey-200 shadow-sm px-3 py-2">
          <span className="text-[13px] font-sans text-grey-300">No users found</span>
        </div>
      )}
    </div>
  )
}
