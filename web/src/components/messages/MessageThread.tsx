'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { messages as messagesApi, type DirectMessage, type DecryptedMessage } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'

const POLL_INTERVAL = 5_000

function timeStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function MessageThread({
  conversationId,
  memberName,
  onBack,
  onMessagesRead,
}: {
  conversationId: string
  memberName: string
  onBack?: () => void
  onMessagesRead?: () => void
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
  const [replyTo, setReplyTo] = useState<DecryptedMessage | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const latestCreatedAt = useRef<string | null>(null)

  async function decryptMessages(encrypted: DirectMessage[]): Promise<DecryptedMessage[]> {
    if (encrypted.length === 0) return []

    // Collect all ciphertexts to decrypt: message bodies + reply previews
    const toDecrypt: { id: string; counterpartyPubkey: string; ciphertext: string }[] = []
    for (const m of encrypted) {
      toDecrypt.push({ id: m.id, counterpartyPubkey: m.counterpartyPubkey, ciphertext: m.contentEnc })
      if (m.replyTo?.contentEnc && m.replyTo.counterpartyPubkey) {
        toDecrypt.push({
          id: `reply:${m.id}`,
          counterpartyPubkey: m.replyTo.counterpartyPubkey,
          ciphertext: m.replyTo.contentEnc,
        })
      }
    }

    try {
      const { results } = await messagesApi.decryptBatch(toDecrypt)
      const plaintextMap = new Map(results.map(r => [r.id, r.plaintext]))
      return encrypted.map(m => ({
        ...m,
        content: plaintextMap.get(m.id) ?? null,
        replyToContent: plaintextMap.get(`reply:${m.id}`) ?? null,
      }))
    } catch {
      return encrypted.map(m => ({ ...m, content: null, replyToContent: null }))
    }
  }

  const fetchMessages = useCallback(async (before?: string) => {
    const isInitial = !before
    if (isInitial) setLoading(true)
    else setLoadingMore(true)

    const scrollEl = scrollRef.current
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0

    try {
      const data = await messagesApi.getMessages(conversationId, before)
      setDecrypting(true)
      const decrypted = await decryptMessages(data.messages)
      const chronological = decrypted.reverse()

      if (isInitial) {
        setMsgs(chronological)
        if (chronological.length > 0) {
          latestCreatedAt.current = chronological[chronological.length - 1].createdAt
        }
      } else {
        setMsgs(prev => [...chronological, ...prev])
        requestAnimationFrame(() => {
          if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight
          }
        })
      }
      setNextCursor(data.nextCursor)

      // Mark all messages in conversation as read (single batch call).
      // Always fire — the loaded page may not include the unread messages
      // (they could be older than the most recent 50).
      await messagesApi.markAllRead(conversationId).catch(() => {})
      refreshUnread()
      onMessagesRead?.()
    } catch {}
    finally { setLoading(false); setLoadingMore(false); setDecrypting(false) }
  }, [conversationId, user?.id])

  // Poll for new messages in the active thread
  const pollForNew = useCallback(async () => {
    if (!latestCreatedAt.current) return
    try {
      // Fetch messages newer than what we have by getting the first page
      // and filtering to only truly new ones
      const data = await messagesApi.getMessages(conversationId)
      if (data.messages.length === 0) return

      // Find messages newer than our latest
      const newMsgs = data.messages.filter(m =>
        new Date(m.createdAt) > new Date(latestCreatedAt.current!)
      )
      if (newMsgs.length === 0) return

      const decrypted = await decryptMessages(newMsgs)
      const chronological = decrypted.reverse()

      setMsgs(prev => {
        const existingIds = new Set(prev.map(m => m.id))
        const unique = chronological.filter(m => !existingIds.has(m.id))
        if (unique.length === 0) return prev
        return [...prev, ...unique]
      })

      latestCreatedAt.current = chronological[chronological.length - 1].createdAt

      // Mark new messages from others as read (batch)
      const hasUnread = newMsgs.some(msg => msg.senderId !== user?.id)
      if (hasUnread) {
        await messagesApi.markAllRead(conversationId).catch(() => {})
        refreshUnread()
        onMessagesRead?.()
      }
    } catch {}
  }, [conversationId, user?.id])

  // Initial fetch + set up polling
  useEffect(() => {
    setMsgs([])
    setReplyTo(null)
    latestCreatedAt.current = null
    fetchMessages()

    pollRef.current = setInterval(pollForNew, POLL_INTERVAL)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [conversationId])

  // Auto-scroll when new messages appear
  useEffect(() => {
    if (!loading) {
      const el = scrollRef.current
      if (!el) return
      // Only auto-scroll if user is near the bottom (within 150px)
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [msgs.length, loading])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || sending) return
    const text = content.trim()
    const replyToId = replyTo?.id

    // Optimistic update: add the message to the UI immediately
    const optimisticId = `optimistic-${Date.now()}`
    const optimisticMsg: DecryptedMessage = {
      id: optimisticId,
      conversationId,
      senderId: user!.id,
      senderUsername: user!.username ?? '',
      senderDisplayName: user!.displayName ?? null,
      counterpartyPubkey: '',
      contentEnc: '',
      replyTo: replyTo ? {
        id: replyTo.id,
        senderUsername: replyTo.senderUsername,
        contentEnc: null,
        counterpartyPubkey: null,
      } : null,
      content: text,
      replyToContent: replyTo?.content ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
      likeCount: 0,
      likedByMe: false,
    } as any

    setMsgs(prev => [...prev, optimisticMsg])
    setContent('')
    setReplyTo(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSending(true)
    setDmPriceError(null)

    try {
      const result = await messagesApi.send(conversationId, text, replyToId)
      // Replace optimistic message with real ID
      if (result.messageIds?.[0]) {
        setMsgs(prev => prev.map(m =>
          m.id === optimisticId ? { ...m, id: result.messageIds[0] } : m
        ))
        latestCreatedAt.current = new Date().toISOString()
      }
    } catch (err: any) {
      // Remove optimistic message on failure
      setMsgs(prev => prev.filter(m => m.id !== optimisticId))
      setContent(text) // Restore the text so user doesn't lose it
      if (replyToId && replyTo) setReplyTo(replyTo)
      if (err?.status === 402) {
        setDmPriceError(err.body?.pricePence ?? 0)
      }
    } finally {
      setSending(false)
    }
  }

  async function handleToggleLike(messageId: string) {
    // Snapshot current state for rollback
    const prev = msgs.find(m => m.id === messageId)
    if (!prev) return

    // Optimistic toggle
    setMsgs(ms => ms.map(m =>
      m.id === messageId
        ? { ...m, likedByMe: !m.likedByMe, likeCount: m.likeCount + (m.likedByMe ? -1 : 1) }
        : m
    ))
    try {
      await messagesApi.toggleLike(messageId)
    } catch {
      // Revert to snapshot
      setMsgs(ms => ms.map(m =>
        m.id === messageId
          ? { ...m, likedByMe: prev.likedByMe, likeCount: prev.likeCount }
          : m
      ))
    }
  }

  function handleReply(msg: DecryptedMessage) {
    setReplyTo(msg)
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0">
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
              {loadingMore ? 'Loading\u2026' : 'Load older messages'}
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
                  {/* Reply context */}
                  {msg.replyTo && (
                    <div className={`flex items-start gap-1.5 mb-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className="bg-grey-100/60 px-3 py-1.5 border-l-2 border-grey-300">
                        <p className="text-[11px] font-sans font-semibold text-grey-400">
                          {msg.replyTo.senderUsername ?? 'Unknown'}
                        </p>
                        <p className="text-[12px] font-sans text-grey-400 truncate max-w-[200px]">
                          {msg.replyToContent ?? <span className="italic">Encrypted message</span>}
                        </p>
                      </div>
                    </div>
                  )}

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

                  {/* Like + Reply buttons */}
                  <div className={`flex items-center gap-2 mt-0.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
                    {/* Reply — hover-reveal on desktop, always visible on mobile */}
                    <button
                      onClick={() => handleReply(msg)}
                      className="text-[11px] font-sans text-grey-300 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:text-black"
                    >
                      Reply
                    </button>

                    {/* Like — always visible when liked; hover-reveal when not */}
                    {(msg.likedByMe || msg.likeCount > 0) ? (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="flex items-center gap-1 text-[12px] text-crimson hover:opacity-70 transition-opacity"
                        aria-label={msg.likedByMe ? 'Unlike' : 'Like'}
                      >
                        <span>{msg.likedByMe ? '\u2665' : '\u2661'}</span>
                        <span className="text-[11px] font-mono">{msg.likeCount}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="text-[12px] text-grey-300 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:text-black"
                        aria-label="Like"
                      >
                        {'\u2661'}
                      </button>
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
        <div className="px-4 py-2 bg-grey-100">
          <p className="text-[13px] font-sans text-crimson">
            This user charges \u00a3{(dmPriceError / 100).toFixed(2)} for DMs. Send anyway?
          </p>
        </div>
      )}

      {/* Reply preview bar */}
      {replyTo && (
        <div className="flex items-center gap-2 px-4 py-2 bg-grey-100/80 border-t border-grey-200">
          <div className="flex-1 min-w-0 border-l-2 border-crimson pl-2">
            <p className="text-[11px] font-sans font-semibold text-grey-500">
              Replying to {replyTo.senderDisplayName ?? replyTo.senderUsername}
            </p>
            <p className="text-[12px] font-sans text-grey-400 truncate">
              {replyTo.content ?? 'Encrypted message'}
            </p>
          </div>
          <button
            onClick={() => setReplyTo(null)}
            className="text-[12px] text-grey-400 hover:text-black flex-shrink-0"
            aria-label="Cancel reply"
          >
            &#10005;
          </button>
        </div>
      )}

      {/* Send box */}
      <form onSubmit={handleSend} className="flex items-end gap-2 px-4 py-3 flex-shrink-0">
        <textarea
          ref={inputRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            // Auto-resize: reset then expand to scrollHeight
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend(e)
            }
          }}
          placeholder={replyTo ? 'Write a reply\u2026' : 'Write a message\u2026'}
          rows={1}
          className="flex-1 bg-grey-100 px-3 py-2 text-[14px] font-sans text-black placeholder-grey-300 resize-none overflow-y-auto"
          style={{ maxHeight: '160px' }}
        />
        <button
          type="submit"
          disabled={sending || !content.trim()}
          className="btn text-sm disabled:opacity-50"
        >
          {sending ? '\u2026' : 'Send'}
        </button>
      </form>
    </div>
  )
}
