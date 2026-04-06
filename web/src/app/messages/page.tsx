'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { messages as messagesApi, type Conversation } from '../../lib/api'
import { ConversationList } from '../../components/messages/ConversationList'
import { MessageThread } from '../../components/messages/MessageThread'

export default function MessagesPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [newRecipient, setNewRecipient] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  async function fetchConversations() {
    try {
      const data = await messagesApi.listConversations()
      setConversations(data.conversations)
    } catch {}
    finally { setDataLoading(false) }
  }

  // When messages are read in a thread, clear that conversation's unread count locally
  const handleMessagesRead = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => prev.map(c =>
      c.id === activeConvId ? { ...c, unreadCount: 0 } : c
    ))
  }, [activeConvId])

  useEffect(() => { if (user) fetchConversations() }, [user])

  // Auto-select conversation from hash (for deep-linking from /messages/:id redirect)
  // or default to the most recent conversation
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash) {
      const hash = window.location.hash.slice(1)
      if (hash) setActiveConvId(hash)
    } else if (conversations.length > 0 && !activeConvId) {
      setActiveConvId(conversations[0].id)
    }
  }, [conversations])

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
      fetchConversations()
    } catch { alert('Failed to start conversation.') }
    finally { setCreating(false) }
  }

  const activeConv = conversations.find(c => c.id === activeConvId)
  const otherMembers = activeConv?.members.filter(m => m.id !== user?.id) ?? []
  const activeMemberName = otherMembers.map(m => m.displayName ?? m.username).join(', ') || 'Conversation'
  const activeMemberId = otherMembers.length === 1 ? otherMembers[0].id : undefined

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
        <div className="h-[600px] animate-pulse bg-white" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <div className="bg-white h-[calc(100vh-160px)] min-h-[400px] flex">
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
                <p className="text-[14px] font-sans font-semibold text-black">New message</p>
              </div>
              <form onSubmit={handleNewConversation} className="p-4">
                <label className="block text-[13px] font-sans font-medium text-grey-600 mb-1">To</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newRecipient}
                    onChange={(e) => setNewRecipient(e.target.value)}
                    placeholder="Username"
                    className="flex-1 bg-grey-100 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300"
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
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[14px] font-sans text-grey-300">Select a conversation or start a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
