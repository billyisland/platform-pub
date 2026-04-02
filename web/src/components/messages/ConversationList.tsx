'use client'

import { type Conversation } from '../../lib/api'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNewMessage,
}: {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNewMessage: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-grey-200">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em] text-black">Messages</p>
        <button
          onClick={onNewMessage}
          className="text-[13px] font-sans text-crimson hover:text-crimson-dark"
        >
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[13px] font-sans text-grey-300">No conversations yet.</p>
          </div>
        ) : (
          conversations.map(conv => {
            const otherMembers = conv.members.filter(m => m.username)
            const displayName = otherMembers.map(m => m.displayName ?? m.username).join(', ') || 'Conversation'
            const isActive = conv.id === activeId

            return (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`w-full text-left px-4 py-3 border-b border-grey-100 transition-colors ${
                  isActive ? 'bg-grey-100' : 'hover:bg-grey-100/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {conv.unreadCount > 0 && (
                        <span className="w-2 h-2 rounded-full bg-crimson flex-shrink-0" />
                      )}
                      <p className={`text-[14px] font-sans truncate ${conv.unreadCount > 0 ? 'font-semibold text-black' : 'text-black'}`}>
                        {displayName}
                      </p>
                    </div>
                    {conv.lastMessage && (
                      <p className="text-[13px] font-sans text-grey-400 truncate mt-0.5">
                        {conv.lastMessage.content}
                      </p>
                    )}
                  </div>
                  {conv.lastMessage && (
                    <span className="font-mono text-[12px] text-grey-300 uppercase flex-shrink-0">
                      {timeAgo(conv.lastMessage.createdAt)}
                    </span>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
