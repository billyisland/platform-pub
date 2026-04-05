'use client'

import { useState } from 'react'
import { giftLinks } from '../../lib/api'

interface GiftLinkModalProps {
  articleDbId: string
  onClose: () => void
}

export function GiftLinkModal({ articleDbId, onClose }: GiftLinkModalProps) {
  const [limit, setLimit] = useState(5)
  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  async function handleCreate() {
    setCreating(true)
    try {
      const result = await giftLinks.create(articleDbId, limit)
      setUrl(window.location.origin + result.url)
    } catch { /* ignore */ }
    finally { setCreating(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white border border-grey-200 shadow-lg w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-serif text-[20px] font-medium text-black mb-1">Create gift link</h3>
        <p className="text-[13px] font-sans text-grey-400 mb-4">Generate a shareable link that grants free access.</p>
        {!url ? (
          <>
            <label className="block text-[12px] font-mono text-grey-400 mb-1">Redemption limit</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
              className="w-20 border border-grey-200 px-2 py-1 text-[13px] font-sans text-black mb-4"
            />
            <div>
              <button onClick={handleCreate} disabled={creating} className="btn text-sm disabled:opacity-50">
                {creating ? 'Creating…' : 'Generate link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              readOnly
              value={url}
              className="w-full border border-grey-200 px-3 py-1.5 text-[13px] font-mono text-black bg-grey-100 mb-3"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={() => { navigator.clipboard.writeText(url) }}
              className="btn text-sm"
            >
              Copy link
            </button>
          </>
        )}
        <button onClick={onClose} className="mt-4 block text-[12px] font-mono text-grey-400 hover:text-black transition-colors">
          Close
        </button>
      </div>
    </div>
  )
}
