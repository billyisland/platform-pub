'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi, type PublicationMember } from '../../lib/api'

interface Props {
  publicationId: string
  publicationName: string
  canManageMembers: boolean
  isOwner: boolean
}

export function MembersTab({ publicationId, publicationName, canManageMembers, isOwner }: Props) {
  const [members, setMembers] = useState<PublicationMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<string>('contributor')
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)

  // Inline role editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<string>('')
  const [savingRole, setSavingRole] = useState(false)

  // Leave
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    pubApi.getMembers(publicationId)
      .then(res => setMembers(res.members))
      .catch(() => setError('Failed to load members.'))
      .finally(() => setLoading(false))
  }, [publicationId])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setInviting(true)
    setInviteMsg(null)
    try {
      const result = await pubApi.invite(publicationId, { email: inviteEmail, role: inviteRole })
      setInviteMsg(`Invite sent. Token: ${result.token}`)
      setInviteEmail('')
    } catch {
      setInviteMsg('Failed to send invite.')
    } finally {
      setInviting(false)
    }
  }

  async function handleRemove(memberId: string) {
    try {
      await pubApi.removeMember(publicationId, memberId)
      setMembers(prev => prev.filter(m => m.id !== memberId))
    } catch { setError('Failed to remove member.') }
  }

  function startEditRole(member: PublicationMember) {
    setEditingId(member.id)
    setEditRole(member.role)
  }

  function cancelEditRole() {
    setEditingId(null)
    setEditRole('')
  }

  async function handleSaveRole(memberId: string) {
    setSavingRole(true)
    try {
      await pubApi.updateMember(publicationId, memberId, { role: editRole })
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: editRole } : m))
      setEditingId(null)
    } catch {
      setError('Failed to update role.')
    } finally {
      setSavingRole(false)
    }
  }

  async function handleLeave() {
    if (!confirm(`Leave ${publicationName}? Your articles will remain in the publication but you will lose editorial access.`)) return
    setLeaving(true)
    try {
      await pubApi.leave(publicationId)
      window.location.href = '/dashboard?msg=left-publication'
    } catch {
      setError('Failed to leave publication.')
      setLeaving(false)
    }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>
  if (error) return <div className="bg-white px-4 py-3 text-ui-xs text-black">{error}</div>

  return (
    <div className="space-y-6">
      {/* Member list */}
      <div className="overflow-x-auto bg-white">
        <table className="w-full text-ui-xs">
          <thead>
            <tr className="border-b-2 border-grey-200">
              <th className="px-4 py-3 text-left label-ui text-grey-400">Name</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Role</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Title</th>
              <th className="px-4 py-3 text-right label-ui text-grey-400">Share (bps)</th>
              {canManageMembers && <th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className="border-b-2 border-grey-200 last:border-b-0">
                <td className="px-4 py-3">
                  <span className="text-black">{m.display_name || m.username}</span>
                  {m.is_owner && <span className="ml-2 text-ui-xs text-grey-300">Owner</span>}
                </td>
                <td className="px-4 py-3">
                  {editingId === m.id ? (
                    <select
                      value={editRole}
                      onChange={e => setEditRole(e.target.value)}
                      className="bg-grey-100 px-3 py-1.5 text-sm text-black"
                    >
                      <option value="contributor">Contributor</option>
                      <option value="editor">Editor</option>
                      <option value="editor_in_chief">Editor-in-Chief</option>
                    </select>
                  ) : (
                    <span className="text-grey-400">{m.role.replace(/_/g, ' ')}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-grey-400">{m.title || '--'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{m.revenue_share_bps ?? '--'}</td>
                {canManageMembers && (
                  <td className="px-4 py-3 text-right">
                    {!m.is_owner && (
                      <div className="flex items-center justify-end gap-3">
                        {editingId === m.id ? (
                          <>
                            <button
                              onClick={() => handleSaveRole(m.id)}
                              disabled={savingRole}
                              className="text-[13px] text-black font-medium disabled:opacity-50"
                            >
                              {savingRole ? '...' : 'Save'}
                            </button>
                            <button
                              onClick={cancelEditRole}
                              className="text-[13px] text-grey-300 hover:text-black"
                            >
                              &times;
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditRole(m)}
                              className="text-grey-300 hover:text-black"
                            >
                              Change role
                            </button>
                            <button onClick={() => handleRemove(m.id)} className="text-grey-300 hover:text-black">
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Leave publication — non-owner only */}
      {!isOwner && (
        <button
          onClick={handleLeave}
          disabled={leaving}
          className="text-[13px] text-grey-300 hover:text-black transition-colors disabled:opacity-50"
        >
          {leaving ? 'Leaving...' : 'Leave this publication'}
        </button>
      )}

      {/* Invite form */}
      {canManageMembers && (
        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Invite a member</p>
          <form onSubmit={handleInvite} className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-ui-xs text-grey-400 block mb-1">Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                className="bg-grey-100 px-3 py-1.5 text-sm text-black w-60"
                placeholder="writer@example.com"
              />
            </div>
            <div>
              <label className="text-ui-xs text-grey-400 block mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="bg-grey-100 px-3 py-1.5 text-sm text-black"
              >
                <option value="contributor">Contributor</option>
                <option value="editor">Editor</option>
                <option value="editor_in_chief">Editor-in-Chief</option>
              </select>
            </div>
            <button type="submit" disabled={inviting} className="btn text-sm disabled:opacity-50">
              {inviting ? 'Sending...' : 'Send invite'}
            </button>
          </form>
          {inviteMsg && <p className="text-ui-xs text-grey-600 mt-2">{inviteMsg}</p>}
        </div>
      )}
    </div>
  )
}
