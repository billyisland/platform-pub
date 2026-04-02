'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'

// This route exists for notification deep-linking.
// It redirects to the main messages page with the conversation pre-selected.
// The actual conversation is rendered on /messages via query state.

export default function ConversationPage() {
  const router = useRouter()
  const params = useParams()
  const conversationId = params.conversationId as string

  useEffect(() => {
    // Redirect to the inbox with a hash to signal which conversation to open.
    // The messages page reads this on mount.
    router.replace(`/messages#${conversationId}`)
  }, [conversationId, router])

  return (
    <div className="mx-auto max-w-content px-6 py-10">
      <div className="h-[600px] flex items-center justify-center">
        <p className="text-[14px] font-sans text-grey-300">Loading conversation…</p>
      </div>
    </div>
  )
}
