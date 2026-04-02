'use client'

import { useState } from 'react'
import { drives } from '../../lib/api'

export function DriveCreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [type, setType] = useState<'crowdfund' | 'commission'>('crowdfund')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [targetAmount, setTargetAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(targetAmount) * 100)
    if (!title.trim() || isNaN(pence) || pence <= 0) {
      setError('Title and a positive target amount are required.')
      return
    }
    setSaving(true); setError(null)
    try {
      await drives.create({ type, title: title.trim(), description: description.trim(), targetAmountPence: pence })
      onCreated()
    } catch {
      setError('Failed to create drive.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white px-6 py-5 space-y-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400">New drive</p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setType('crowdfund')}
          className={`px-3 py-1.5 text-[13px] font-sans border transition-colors ${
            type === 'crowdfund' ? 'border-black text-black' : 'border-grey-200 text-grey-400 hover:text-black'
          }`}
        >
          Crowdfund
        </button>
        <button
          type="button"
          onClick={() => setType('commission')}
          className={`px-3 py-1.5 text-[13px] font-sans border transition-colors ${
            type === 'commission' ? 'border-black text-black' : 'border-grey-200 text-grey-400 hover:text-black'
          }`}
        >
          Commission
        </button>
      </div>

      <div>
        <label className="block text-[13px] font-sans font-medium text-grey-600 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full border border-grey-200 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300"
          placeholder="e.g. Essays on Light"
          required
        />
      </div>

      <div>
        <label className="block text-[13px] font-sans font-medium text-grey-600 mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full border border-grey-200 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300 resize-y"
          rows={3}
          placeholder="What will supporters be funding?"
        />
      </div>

      <div>
        <label className="block text-[13px] font-sans font-medium text-grey-600 mb-1">Target amount (£)</label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={targetAmount}
          onChange={(e) => setTargetAmount(e.target.value)}
          className="w-48 border border-grey-200 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300"
          placeholder="50.00"
          required
        />
      </div>

      {error && <p className="text-[13px] font-sans text-crimson">{error}</p>}

      <div className="flex gap-3 pt-2">
        <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
          {saving ? 'Creating…' : 'Create drive'}
        </button>
        <button type="button" onClick={onCancel} className="text-[13px] font-sans text-grey-400 hover:text-black">
          Cancel
        </button>
      </div>
    </form>
  )
}
