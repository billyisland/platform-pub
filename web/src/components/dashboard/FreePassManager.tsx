'use client'

import { useState, useEffect } from 'react'
import { freePasses, type FreePass } from '../../lib/api'

export function FreePassManager({ articleId }: { articleId: string }) {
  const [passes, setPasses] = useState<FreePass[]>([])
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [granting, setGranting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchPasses() {
    setLoading(true)
    try {
      const data = await freePasses.list(articleId)
      setPasses(data.passes)
    } catch {
      setError('Failed to load free passes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchPasses() }, [articleId])

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setGranting(true); setError(null)
    try {
      await freePasses.grant(articleId, username.trim())
      setUsername('')
      fetchPasses()
    } catch {
      setError('Failed to grant access. Check the username.')
    } finally {
      setGranting(false)
    }
  }

  async function handleRevoke(userId: string) {
    try {
      await freePasses.revoke(articleId, userId)
      setPasses(prev => prev.filter(p => p.userId !== userId))
    } catch {
      setError('Failed to revoke access.')
    }
  }

  return (
    <div className="border-t border-grey-200 px-4 py-4 bg-grey-100/50">
      <p className="label-ui text-grey-400 mb-3">Free passes</p>

      {error && <p className="text-[13px] font-sans text-crimson mb-3">{error}</p>}

      {/* Grant form */}
      <form onSubmit={handleGrant} className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          className="flex-1 border border-grey-200 px-3 py-1.5 text-[13px] font-sans text-black placeholder-grey-300 bg-white"
        />
        <button type="submit" disabled={granting} className="btn text-sm disabled:opacity-50">
          {granting ? '…' : 'Grant'}
        </button>
      </form>

      {/* Existing passes */}
      {loading ? (
        <div className="h-6 animate-pulse bg-grey-200 w-32" />
      ) : passes.length === 0 ? (
        <p className="text-[13px] font-sans text-grey-300">No free passes granted.</p>
      ) : (
        <div className="space-y-1">
          {passes.map(p => (
            <div key={p.userId} className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-[13px] font-sans text-black">{p.displayName ?? p.username}</span>
                <span className="text-[12px] font-mono text-grey-300 ml-2">@{p.username}</span>
              </div>
              <button onClick={() => handleRevoke(p.userId)} className="text-[12px] font-sans text-grey-300 hover:text-black">
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
