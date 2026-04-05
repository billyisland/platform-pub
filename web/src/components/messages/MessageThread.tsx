'use client'

import { useState, useEffect, useRef } from 'react'
import { messages as messagesApi, type DirectMessage, type DecryptedMessage } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'

function timeStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function MessageThread({
  conversationId,
  memberName,
  onBack,
}: {
  conversationId: string
  memberName: string
  onBack?: () => void
}) {
  const { user } = useAuth()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const [msgs, setMsgs] = useState<DecryptedMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [decrypting, setDecrypting] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [dmPriceError, setDmPriceError] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  async function decryptMessages(encrypted: DirectMessage[]): Promise<DecryptedMessage[]> {
    if (encrypted.length === 0) return []
    try {
      const { results } = await messagesApi.decryptBatch(
        encrypted.map(m => ({ id: m.id, counterpartyPubkey: m.counterpartyPubkey, ciphertext: m.contentEnc }))
      )
      const plaintextMap = new Map(results.map(r => [r.id, r.plaintext]))
      return encrypted.map(m => ({ ...m, content: plaintextMap.get(m.id) ?? null }))
    } catch {
      return encrypted.map(m => ({ ...m, content: null }))
    }
  }

  async function fetchMessages(cursor?: string) {
    const isInitial = !cursor
    if (isInitial) setLoading(true)
    else setLoadingMore(true)

    // Capture scroll position before loading older messages
    const scrollEl = scrollRef.current
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0

    try {
      const data = await messagesApi.getMessages(conversationId, cursor)
      setDecrypting(true)
      const decrypted = await decryptMessages(data.messages)
      // API returns newest-first; reverse to chronological (oldest at top, newest at bottom)
      const chronological = decrypted.reverse()
      if (isInitial) {
        setMsgs(chronological)
      } else {
        // Prepend older messages at the top
        setMsgs(prev => [...chronological, ...prev])
        // Restore scroll position after older messages are prepended
        requestAnimationFrame(() => {
          if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight
          }
        })
      }
      setNextCursor(data.nextCursor)

      // Mark unread messages as read
      const unreadMsgs = data.messages.filter(msg => msg.senderId !== user?.id)
      for (const msg of unreadMsgs) {
        messagesApi.markRead(msg.id).catch(err => console.error('Failed to mark message read', err))
      }
      if (unreadMsgs.length > 0) refreshUnread()
    } catch {}
    finally { setLoading(false); setLoadingMore(false); setDecrypting(false) }
  }

  useEffect(() => {
    setMsgs([])
    fetchMessages()
  }, [conversationId])

  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs.length, loading])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || sending) return
    setSending(true); setDmPriceError(null)
    try {
      await messagesApi.send(conversationId, content.trim())
      setContent('')
      fetchMessages()
    } catch (err: any) {
      if (err?.status === 402) {
        setDmPriceError(err.body?.pricePence ?? 0)
      }
    } finally {
      setSending(false)
    }
  }

  async function handleToggleLike(messageId: string) {
    try {
      const { liked } = await messagesApi.toggleLike(messageId)
      setMsgs(prev => prev.map(m =>
        m.id === messageId
          ? { ...m, likedByMe: liked, likeCount: m.likeCount + (liked ? 1 : -1) }
          : m
      ))
    } catch {}
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-grey-200 flex-shrink-0">
        {onBack && (
          <button onClick={onBack} className="font-mono text-[12px] text-grey-400 hover:text-black uppercase tracking-[0.04em]">
            &#8592;
          </button>
        )}
        <p className="text-[14px] font-sans font-semibold text-black">{memberName}</p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {nextCursor && (
          <div className="text-center">
            <button
              onClick={() => fetchMessages(nextCursor)}
              disabled={loadingMore}
              className="text-[12px] font-sans text-grey-300 hover:text-black"
            >
              {loadingMore ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}

        {loading || decrypting ? (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-8 animate-pulse bg-grey-100 rounded" />)}</div>
        ) : msgs.length === 0 ? (
          <p className="text-center text-[13px] font-sans text-grey-300 py-8">No messages yet. Start the conversation.</p>
        ) : (
          msgs.map(msg => {
            const isMine = msg.senderId === user?.id
            return (
              <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] group`}>
                  <div className={`${isMine ? 'bg-black text-white' : 'bg-grey-100 text-black'} px-4 py-2.5`}>
                    {!isMine && (
                      <p className={`text-[12px] font-sans font-semibold mb-0.5 text-grey-600`}>
                        {msg.senderDisplayName ?? msg.senderUsername}
                      </p>
                    )}
                    <p className="text-[14px] font-sans leading-relaxed whitespace-pre-wrap">
                      {msg.content ?? <span className="italic text-grey-300">Could not decrypt</span>}
                    </p>
                    <p className={`text-[10px] font-mono mt-1 ${isMine ? 'text-grey-400' : 'text-grey-300'}`}>
                      {timeStamp(msg.createdAt)}
                    </p>
                  </div>
                  {/* Like button */}
                  <div className={`flex items-center gap-1 mt-0.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <button
                      onClick={() => handleToggleLike(msg.id)}
                      className={`text-[12px] transition-colors ${
                        msg.likedByMe
                          ? 'text-crimson'
                          : 'text-grey-200 opacity-0 group-hover:opacity-100'
                      }`}
                      aria-label={msg.likedByMe ? 'Unlike' : 'Like'}
                    >
                      {msg.likedByMe ? '♥' : '♡'}
                    </button>
                    {msg.likeCount > 0 && (
                      <span className="text-[11px] font-mono text-grey-300">{msg.likeCount}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* DM pricing warning */}
      {dmPriceError !== null && (
        <div className="px-4 py-2 bg-grey-100 border-t border-grey-200">
          <p className="text-[13px] font-sans text-crimson">
            This user charges £{(dmPriceError / 100).toFixed(2)} for DMs. Send anyway?
          </p>
        </div>
      )}

      {/* Send box */}
      <form onSubmit={handleSend} className="flex items-center gap-2 px-4 py-3 border-t border-grey-200 flex-shrink-0">
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write a message…"
          className="flex-1 border border-grey-200 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300"
        />
        <button
          type="submit"
          disabled={sending || !content.trim()}
          className="btn text-sm disabled:opacity-50"
        >
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
