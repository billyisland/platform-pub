'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { auth } from '../../lib/api'
import { uploadImage } from '../../lib/media'

// =============================================================================
// Profile Settings Page
//
// Lets users update their display name, bio, and avatar photo.
// Changes are saved via PATCH /auth/profile and auth state is refreshed.
// =============================================================================

export default function ProfilePage() {
  const { user, loading, fetchMe } = useAuth()
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [initialised, setInitialised] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialise form from auth state once loaded
  if (!loading && user && !initialised) {
    setDisplayName(user.displayName ?? '')
    setBio(user.bio ?? '')
    setAvatar(user.avatar ?? null)
    setInitialised(true)
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-article px-6 py-12">
        <div className="h-6 w-32 animate-pulse bg-card mb-8" />
      </div>
    )
  }

  if (!user) {
    router.replace('/auth?mode=login')
    return null
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const result = await uploadImage(file)
      setAvatar(result.url)
    } catch (err: any) {
      setError(err.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await auth.updateProfile({
        displayName: displayName.trim() || undefined,
        bio: bio.trim(),
        avatar: avatar,
      })
      await fetchMe()
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const initial = (displayName || user.username || '?')[0].toUpperCase()

  return (
    <div className="mx-auto max-w-article px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-content-primary tracking-tight mb-8">
        Profile
      </h1>

      <form onSubmit={handleSave} className="space-y-8 max-w-md">
        {/* Avatar */}
        <div>
          <label className="block text-ui-xs text-content-faint mb-3 uppercase tracking-wider">
            Photo
          </label>
          <div className="flex items-center gap-4">
            {avatar ? (
              <img src={avatar} alt="" className="h-16 w-16 rounded-full object-cover flex-shrink-0" />
            ) : (
              <span
                className="flex h-16 w-16 items-center justify-center rounded-full text-xl font-medium text-content-primary flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #F5D5D6, #E8A5A7)' }}
              >
                {initial}
              </span>
            )}
            <div className="flex flex-col gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : 'Upload photo'}
              </button>
              {avatar && (
                <button
                  type="button"
                  onClick={() => setAvatar(null)}
                  className="text-ui-xs text-content-faint hover:text-content-muted transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Display name */}
        <div>
          <label htmlFor="displayName" className="block text-ui-xs text-content-faint mb-2 uppercase tracking-wider">
            Display name
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder={user.username ?? ''}
            className="w-full bg-card border-2 border-ink/30 px-4 py-2.5 text-sm text-content-primary placeholder-content-faint focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
        </div>

        {/* Bio */}
        <div>
          <label htmlFor="bio" className="block text-ui-xs text-content-faint mb-2 uppercase tracking-wider">
            Bio
          </label>
          <textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            rows={4}
            placeholder="A few words about yourself"
            className="w-full bg-card border-2 border-ink/30 px-4 py-2.5 text-sm text-content-primary placeholder-content-faint focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
          />
          <p className="text-[11px] text-content-faint mt-1 text-right">{bio.length}/500</p>
        </div>

        {/* Username (read-only) */}
        <div>
          <label className="block text-ui-xs text-content-faint mb-2 uppercase tracking-wider">
            Username
          </label>
          <p className="text-sm text-content-secondary">@{user.username}</p>
          <p className="text-[11px] text-content-faint mt-1">Username cannot be changed.</p>
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        {/* Save */}
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving || uploading}
            className="btn py-2 px-6 text-sm disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {saved && (
            <span className="text-sm text-green-600">Saved</span>
          )}
        </div>
      </form>
    </div>
  )
}
