'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi } from '../../lib/api'

interface Props {
  publicationId: string
  publicationSlug: string
}

export function PublicationSettingsTab({ publicationId, publicationSlug }: Props) {
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [about, setAbout] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    pubApi.get(publicationSlug)
      .then((pub: any) => {
        setName(pub.name ?? '')
        setTagline(pub.tagline ?? '')
        setAbout(pub.about ?? '')
      })
      .catch(() => setMsg('Failed to load settings.'))
      .finally(() => setLoading(false))
  }, [publicationSlug])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    try {
      await pubApi.update(publicationId, {
        name: name.trim(),
        tagline: tagline.trim() || null,
        about: about.trim() || null,
      })
      setMsg('Settings saved.')
    } catch {
      setMsg('Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="h-40 animate-pulse bg-white" />

  return (
    <div className="bg-white px-6 py-5 space-y-6">
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="label-ui text-grey-400 block mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
          />
        </div>
        <div>
          <label className="label-ui text-grey-400 block mb-1">Tagline</label>
          <input
            type="text"
            value={tagline}
            onChange={e => setTagline(e.target.value)}
            className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
            placeholder="A short description"
          />
        </div>
        <div>
          <label className="label-ui text-grey-400 block mb-1">About</label>
          <textarea
            value={about}
            onChange={e => setAbout(e.target.value)}
            rows={6}
            className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
            placeholder="Mission statement, editorial focus, etc."
          />
        </div>
        <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </form>
      {msg && <p className="text-ui-xs text-grey-600">{msg}</p>}
    </div>
  )
}
