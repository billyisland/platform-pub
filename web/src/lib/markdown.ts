import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

// =============================================================================
// NIP-23 Markdown Renderer
//
// Converts NIP-23 long-form markdown content to safe HTML for rendering.
//
// Pipeline: markdown → remark AST → rehype AST → sanitized HTML
//
// Supports:
//   - Standard markdown (headings, bold, italic, links, images, lists, etc.)
//   - GFM extensions (tables, strikethrough, task lists, autolinks)
//   - Nostr-specific: nostr: URI links (nostr:npub1..., nostr:note1..., etc.)
//
// Security:
//   - rehype-sanitize strips all dangerous HTML (scripts, iframes, etc.)
//   - Only safe elements and attributes are allowed through
//   - Image sources are allowed from Blossom servers and common CDNs
//
// This runs client-side. The unified pipeline is ~15KB gzipped.
// For server-side rendering, the same pipeline works in Node.js.
// =============================================================================

// Custom sanitize schema — extends the default to allow:
//   - img src from Blossom and common image hosts
//   - class attributes on code blocks (for syntax highlighting)
//   - nostr: protocol links
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    a: ['href', 'title', 'rel', 'target'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'nostr'],
    src: ['http', 'https'],
  },
}

let processor: any = null

function getProcessor() {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: false })
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify)
  }
  return processor
}

/**
 * Convert NIP-23 markdown to sanitized HTML.
 *
 * Returns a string of HTML safe for dangerouslySetInnerHTML.
 * All untrusted content is sanitized — XSS-safe.
 * Embeddable URLs on their own line are wrapped in responsive containers.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  const proc = getProcessor()
  const file = await proc.process(markdown)
  let html = String(file)

  // Post-process: detect embeddable URLs and wrap in responsive containers
  html = enhanceEmbedUrls(html)

  return html
}

/**
 * Synchronous version for use in components that can't await.
 * Uses a simpler regex-based approach as a fallback.
 * Prefer renderMarkdown() when possible.
 */
export function renderMarkdownSync(markdown: string): string {
  return markdown
    // Block elements
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/^---$/gm, '<hr />')
    // Inline elements
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/!\[(.+?)\]\((.+?)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    // Nostr URIs — link to njump.me for resolution
    .replace(/nostr:(npub1[a-z0-9]+)/g, '<a href="https://njump.me/$1" rel="noopener noreferrer">@$1</a>')
    .replace(/nostr:(note1[a-z0-9]+)/g, '<a href="https://njump.me/$1" rel="noopener noreferrer">$1</a>')
    .replace(/nostr:(nevent1[a-z0-9]+)/g, '<a href="https://njump.me/$1" rel="noopener noreferrer">$1</a>')
    // Paragraphs (double newline)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<)/, '<p>')
    .replace(/(?!>)$/, '</p>')
}

// =============================================================================
// Embed Enhancement
// =============================================================================

const EMBED_PATTERNS: Array<{ pattern: RegExp; getEmbed: (m: RegExpMatchArray) => string }> = [
  { pattern: /https?:\/\/(www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/, getEmbed: m => `<div class="embed-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin:1em 0"><iframe src="https://www.youtube.com/embed/${m[2]}" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy"></iframe></div>` },
  { pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)/, getEmbed: m => `<div class="embed-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin:1em 0"><iframe src="https://www.youtube.com/embed/${m[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy"></iframe></div>` },
]

function enhanceEmbedUrls(html: string): string {
  // Find paragraphs that contain only a URL
  return html.replace(/<p><a href="(https?:\/\/[^"]+)"[^>]*>\1<\/a><\/p>/g, (match, url) => {
    for (const { pattern, getEmbed } of EMBED_PATTERNS) {
      const m = url.match(pattern)
      if (m) {
        return getEmbed(m)
      }
    }
    return match
  })
}
