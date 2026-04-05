import { signPublishAndIndex } from './signPublishAndIndex'

// =============================================================================
// Note Publishing Service
//
// Publishes a short-form note (Nostr kind 1) via the gateway.
// No direct relay access needed — signing and publishing happen server-side.
// =============================================================================

interface PublishNoteResult {
  noteEventId: string
}

export interface QuoteTarget {
  eventId: string
  eventKind: number
  authorPubkey: string
  previewTitle?: string
  previewContent?: string
  previewAuthorName?: string
  highlightedText?: string
}

export async function publishNote(
  content: string,
  authorPubkey: string,
  quoteTarget?: QuoteTarget
): Promise<PublishNoteResult> {
  const tags: string[][] = []

  // Add q tag for quote-notes (NIP-18)
  if (quoteTarget) {
    tags.push(['q', quoteTarget.eventId, '', quoteTarget.authorPubkey])
    if (quoteTarget.highlightedText) {
      const words = quoteTarget.highlightedText.trim().split(/\s+/).slice(0, 80).join(' ')
      tags.push(['excerpt', words])
      if (quoteTarget.previewTitle) tags.push(['excerpt-title', quoteTarget.previewTitle])
      if (quoteTarget.previewAuthorName) tags.push(['excerpt-author', quoteTarget.previewAuthorName])
    }
  }

  const result = await signPublishAndIndex({
    content,
    tags,
    indexEndpoint: '/api/v1/notes',
    indexBody: (eventId) => ({
      nostrEventId: eventId,
      content,
      ...(quoteTarget && {
        isQuoteComment: true,
        quotedEventId: quoteTarget.eventId,
        quotedEventKind: quoteTarget.eventKind,
        quotedExcerpt: quoteTarget.highlightedText,
        quotedTitle: quoteTarget.previewTitle,
        quotedAuthor: quoteTarget.previewAuthorName,
      }),
    }),
  })

  return { noteEventId: result.eventId }
}
