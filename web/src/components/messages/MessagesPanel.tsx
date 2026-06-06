'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { messages as messagesApi, type Conversation } from '../../lib/api'
import { ConversationList } from './ConversationList'
import { MessageThread } from './MessageThread'

// =============================================================================
// MessagesPanel — the conversation list + thread two-pane surface, extracted so
// both the standalone /messages page and the workspace Glasshouse overlay share
// one implementation. The caller supplies the root `className` (height / bg);
// auth gating is the caller's concern (the page redirects, the overlay only
// mounts when authenticated).
// =============================================================================

export function MessagesPanel({
  className = '',
  inOverlay = false,
  initialConversationId = null,
}: {
  className?: string
  // True when hosted in a Glasshouse overlay — reserves room in the thread
  // header for the overlay's floating close ✕.
  inOverlay?: boolean
  // Pre-selected conversation. The overlay seeds this from the store (the
  // workspace URL carries no #hash); the standalone page reads the hash instead.
  initialConversationId?: string | null
}) {
  const { user } = useAuth()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [newRecipient, setNewRecipient] = useState('')
  const [creating, setCreating] = useState(false)

  async function fetchConversations() {
    try {
      const data = await messagesApi.listConversations()
      setConversations(data.conversations)
    } catch {}
  }

  // When messages are read in a thread, clear that conversation's unread count locally
  const handleMessagesRead = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => prev.map(c =>
      c.id === activeConvId ? { ...c, unreadCount: 0 } : c
    ))
  }, [activeConvId])

  useEffect(() => { if (user) void fetchConversations() }, [user])

  // Auto-select the seeded conversation (overlay: store prop; page: URL hash),
  // else default to the most recent conversation.
  useEffect(() => {
    const hash =
      typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
    const seed = initialConversationId || hash
    if (seed) {
      setActiveConvId(seed)
    } else if (conversations.length > 0 && !activeConvId) {
      setActiveConvId(conversations[0].id)
    }
  }, [conversations, initialConversationId])

  async function handleNewConversation(e: React.FormEvent) {
    e.preventDefault()
    if (!newRecipient.trim() || creating) return
    setCreating(true)
    try {
      // Search for the user first
      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(newRecipient.trim())}&type=writers`, { credentials: 'include' })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const writer = data.results?.[0]
      if (!writer) { alert('User not found.'); return }

      const result = await messagesApi.createConversation([writer.id])
      setActiveConvId(result.conversationId)
      setShowNewMessage(false)
      setNewRecipient('')
      void fetchConversations()
    } catch { alert('Failed to start conversation.') }
    finally { setCreating(false) }
  }

  const activeConv = conversations.find(c => c.id === activeConvId)
  const otherMembers = activeConv?.members.filter(m => m.id !== user?.id) ?? []
  const activeMemberName = otherMembers.map(m => m.displayName ?? m.username).join(', ') || 'Conversation'
  const activeMemberId = otherMembers.length === 1 ? otherMembers[0].id : undefined

  return (
    <div className={`flex ${className}`}>
      {/* Conversation list — hidden on mobile when a conversation is active */}
      <div className={`w-full md:w-[280px] bg-grey-100 flex-shrink-0 ${activeConvId ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
        <ConversationList
          conversations={conversations}
          activeId={activeConvId}
          onSelect={(id) => setActiveConvId(id)}
          onNewMessage={() => setShowNewMessage(true)}
        />
      </div>

      {/* Thread panel */}
      <div className={`flex-1 ${!activeConvId ? 'hidden md:flex md:flex-col' : 'flex flex-col'}`}>
        {showNewMessage ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 px-4 py-3 mb-1">
              <button
                onClick={() => setShowNewMessage(false)}
                className="font-mono text-[12px] text-grey-400 hover:text-black uppercase tracking-[0.04em]"
              >
                &#8592;
              </button>
              <p className="text-ui-sm font-sans font-semibold text-black">New message</p>
            </div>
            <form onSubmit={handleNewConversation} className="p-4">
              <label className="block text-ui-xs font-sans font-medium text-grey-600 mb-1">To</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newRecipient}
                  onChange={(e) => setNewRecipient(e.target.value)}
                  placeholder="Username"
                  className="flex-1 bg-grey-100 px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300"
                  autoFocus
                />
                <button type="submit" disabled={creating} className="btn text-sm disabled:opacity-50">
                  {creating ? '…' : 'Start'}
                </button>
              </div>
            </form>
          </div>
        ) : activeConvId ? (
          <MessageThread
            conversationId={activeConvId}
            memberName={activeMemberName}
            memberId={activeMemberId}
            onBack={() => setActiveConvId(null)}
            onMessagesRead={handleMessagesRead}
            headerRightInset={inOverlay}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-ui-sm font-sans text-grey-300">Select a conversation or start a new one.</p>
          </div>
        )}
      </div>
    </div>
  )
}
