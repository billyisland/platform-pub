'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { auth } from '../../lib/api'
import { uploadImage } from '../../lib/media'
import { UsernameChange } from '../../components/profile/UsernameChange'
import { CardSetup } from '../../components/payment/CardSetup'
import { ExportModal } from '../../components/ExportModal'

// =============================================================================
// Profile Settings Page
//
// Lets users update their display name, bio, and avatar photo.
// Changes are saved via PATCH /auth/profile and auth state is refreshed.
// =============================================================================

export default function ProfilePage() {
  const { user, loading, fetchMe } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const fileRef = useRef<HTMLInputElement>(null)

  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [initialised, setInitialised] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [upgradingStripe, setUpgradingStripe] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const onboardingComplete = searchParams.get('onboarding') === 'complete'

  useEffect(() => { if (onboardingComplete) fetchMe() }, [onboardingComplete, fetchMe])

  // Initialise form from auth state once loaded
  if (!loading && user && !initialised) {
    setDisplayName(user.displayName ?? '')
    setBio(user.bio ?? '')
    setAvatar(user.avatar ?? null)
    setInitialised(true)
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
        <div className="h-6 w-32 animate-pulse bg-white mb-8" />
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

  async function handleConnectStripe() {
    setUpgradingStripe(true); setUpgradeError(null)
    try { const result = await auth.connectStripe(); window.location.href = result.stripeConnectUrl }
    catch { setUpgradeError('Failed to start writer setup.'); setUpgradingStripe(false) }
  }

  const initial = (displayName || user.username || '?')[0].toUpperCase()

  return (
    <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-black tracking-tight mb-8">
        Profile
      </h1>

      <form onSubmit={handleSave} className="space-y-8 max-w-md">
        {/* Avatar */}
        <div>
          <label className="block text-ui-xs text-grey-300 mb-3 uppercase tracking-wider">
            Photo
          </label>
          <div className="flex items-center gap-4">
            {avatar ? (
              <img src={avatar} alt="" className="h-16 w-16  object-cover flex-shrink-0" />
            ) : (
              <span
                className="flex h-16 w-16 items-center justify-center  text-xl font-medium text-black flex-shrink-0"
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
                  className="text-ui-xs text-grey-300 hover:text-grey-400 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Display name */}
        <div>
          <label htmlFor="displayName" className="block text-ui-xs text-grey-300 mb-2 uppercase tracking-wider">
            Display name
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder={user.username ?? ''}
            className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none"
          />
        </div>

        {/* Bio */}
        <div>
          <label htmlFor="bio" className="block text-ui-xs text-grey-300 mb-2 uppercase tracking-wider">
            Bio
          </label>
          <textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            rows={4}
            placeholder="A few words about yourself"
            className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none resize-none"
          />
          <p className="text-[11px] text-grey-300 mt-1 text-right">{bio.length}/500</p>
        </div>

        {/* Username */}
        <UsernameChange />

        {/* Public key (read-only) */}
        <div>
          <label className="block text-ui-xs text-grey-300 mb-2 uppercase tracking-wider">
            Public key
          </label>
          <p className="text-ui-xs text-grey-300 truncate">{user.pubkey}</p>
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

      {/* ================================================================= */}
      {/* Financial plumbing                                                 */}
      {/* ================================================================= */}

      <div className="mt-12 space-y-8 max-w-md">
        <h2 className="font-serif text-xl font-light text-black tracking-tight">Payment</h2>

        {/* Payment card */}
        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Payment method</p>
          {user.hasPaymentMethod ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ui-sm text-black">Card connected</p>
                <p className="text-ui-xs text-grey-300 mt-0.5">Your reading tab will settle automatically.</p>
              </div>
              <span className="text-ui-xs text-grey-400">Active</span>
            </div>
          ) : (
            <div>
              <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Add a payment method to keep reading after your free £5 allowance.</p>
              <p className="text-ui-xs text-grey-300 mb-4">Free allowance remaining: £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}</p>
              <CardSetup onSuccess={() => fetchMe()} />
            </div>
          )}
        </div>

        {/* Stripe Connect */}
        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Stripe Connect</p>
          {user.stripeConnectKycComplete ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ui-sm text-black">Verified</p>
                <p className="text-ui-xs text-grey-300 mt-0.5">Payouts are enabled.</p>
              </div>
              <span className="text-ui-xs text-grey-400">Active</span>
            </div>
          ) : (
            <div>
              <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">Connect a bank account via Stripe to receive payouts from your published articles.</p>
              {upgradeError && <p className="text-ui-xs text-red-600 mb-3">{upgradeError}</p>}
              <button onClick={handleConnectStripe} disabled={upgradingStripe} className="btn disabled:opacity-50">
                {upgradingStripe ? 'Setting up…' : 'Connect Stripe'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================= */}
      {/* Data portability                                                   */}
      {/* ================================================================= */}

      <div className="mt-12 space-y-8 max-w-md">
        <h2 className="font-serif text-xl font-light text-black tracking-tight">Data</h2>

        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Export my data</p>
          <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Download your data, receipts, and content keys.</p>
          <button onClick={() => setShowExport(true)} className="btn">Export</button>
        </div>
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
