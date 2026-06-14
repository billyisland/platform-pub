'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { useIsMobile } from '../../hooks/useIsMobile'
import { messages as messagesApi, type Conversation } from '../../lib/api'
import { ConversationList } from './ConversationList'
import { MessageThread } from './MessageThread'
import { NotificationsPanel } from '../notifications/NotificationsPanel'

// =============================================================================
// MessagesInbox — the merged notifications + direct-messages surface. Three
// columns: the notifications activity log (left), the conversation list
// (middle), and the message reading pane (right). Hosted in the workspace
// Glasshouse (MessagesOverlay), which supplies the frame + overlay resize.
//
// A `new_message` notification in the left column selects that conversation in
// the reading pane in place (via NotificationsPanel's onMessageActivate) rather
// than routing away — notifications and DMs are one surface now.
//
// Layout is one flex row that doubles as a mobile surface: on <md it's a
// horizontal snap-pager (each column full-width), on md+ the columns sit
// side-by-side. The conversation-list column carries a grey ground so the three
// columns separate by surface contrast alone — no divider rule.
// =============================================================================

export function MessagesInbox({
  className = '',
  initialConversationId = null,
}: {
  className?: string
  initialConversationId?: string | null
}) {
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [newRecipient, setNewRecipient] = useState('')
  const [creating, setCreating] = useState(false)
  const readingColRef = useRef<HTMLDivElement>(null)

  async function fetchConversations() {
    try {
      const data = await messagesApi.listConversations()
      setConversations(data.conversations)
    } catch {}
  }

  const handleMessagesRead = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => prev.map(c =>
      c.id === activeConvId ? { ...c, unreadCount: 0 } : c
    ))
  }, [activeConvId])

  useEffect(() => { if (user) void fetchConversations() }, [user])

  // Seed the active conversation (overlay passes the store value), else default
  // to the most recent one.
  useEffect(() => {
    if (initialConversationId) {
      setActiveConvId(initialConversationId)
    } else if (conversations.length > 0 && !activeConvId) {
      setActiveConvId(conversations[0].id)
    }
  }, [conversations, initialConversationId])

  // Select a conversation, leaving the new-message form, and (on the mobile
  // pager) bring the reading column into view. No-op horizontally on desktop
  // (the row doesn't scroll there).
  const selectConversation = useCallback((id: string | null) => {
    setShowNewMessage(false)
    setActiveConvId(id)
    if (isMobile && id) {
      requestAnimationFrame(() => {
        readingColRef.current?.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' })
      })
    }
  }, [isMobile])

  async function handleNewConversation(e: React.FormEvent) {
    e.preventDefault()
    if (!newRecipient.trim() || creating) return
    setCreating(true)
    try {
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
    <div
      className={`flex overflow-x-auto md:overflow-x-hidden snap-x snap-mandatory md:snap-none ${className}`}
    >
      {/* Notifications — left */}
      <div className="w-full md:w-auto md:flex-1 md:min-w-[300px] shrink-0 snap-center flex flex-col min-h-0 px-5 sm:px-8 py-10">
        <NotificationsPanel
          className="flex-1 min-h-0"
          onMessageActivate={selectConversation}
        />
      </div>

      {/* Conversation list — middle. Grey ground separates it from the white
          panes either side by surface contrast (no divider rule). */}
      <div className="w-full md:w-[240px] shrink-0 snap-center flex flex-col min-h-0 bg-grey-100">
        <ConversationList
          conversations={conversations}
          activeId={activeConvId}
          onSelect={(id) => selectConversation(id)}
          onNewMessage={() => setShowNewMessage(true)}
        />
      </div>

      {/* Reading pane — right (deliberately the narrower column). */}
      <div ref={readingColRef} className="w-full md:w-[400px] shrink-0 snap-center flex flex-col min-h-0">
        {showNewMessage ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 px-4 py-3 mb-1">
              <button
                onClick={() => setShowNewMessage(false)}
                className="label-ui text-grey-600 hover:text-black"
              >
                &#8592;
              </button>
              <p className="text-ui-sm font-sans font-semibold text-black">New message</p>
            </div>
            <form onSubmit={handleNewConversation} className="p-4">
              <label className="label-ui text-grey-600 block mb-2">To</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newRecipient}
                  onChange={(e) => setNewRecipient(e.target.value)}
                  placeholder="Username"
                  className="flex-1 bg-glasshouse-well px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300"
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
            headerRightInset
          />
        ) : (
          <div className="flex-1 flex items-center justify-center px-6">
            <p className="text-ui-sm font-sans text-grey-600 text-center">Select a conversation or start a new one.</p>
          </div>
        )}
      </div>
    </div>
  )
}
