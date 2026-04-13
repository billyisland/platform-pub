import sanitizeHtml from 'sanitize-html'

// =============================================================================
// HTML sanitisation for external content
//
// Strict allowlist per ADR §XVI.6. Applied at ingestion time — the database
// never contains unsanitised external HTML.
// =============================================================================

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'a', 'em', 'strong', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'rel'],
    img: ['src', 'alt'],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow' }),
  },
  allowedSchemes: ['http', 'https'],
}

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS)
}

export function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim()
}
