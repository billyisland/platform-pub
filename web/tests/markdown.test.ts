import { describe, it, expect } from 'vitest'
import { renderMarkdownSync, enhanceEmbedUrls } from '../src/lib/markdown'

describe('renderMarkdownSync', () => {
  it('converts headings', () => {
    expect(renderMarkdownSync('# Title')).toContain('<h1>Title</h1>')
    expect(renderMarkdownSync('## Subtitle')).toContain('<h2>Subtitle</h2>')
    expect(renderMarkdownSync('### H3')).toContain('<h3>H3</h3>')
    expect(renderMarkdownSync('#### H4')).toContain('<h4>H4</h4>')
  })

  it('converts bold and italic', () => {
    expect(renderMarkdownSync('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdownSync('*italic*')).toContain('<em>italic</em>')
  })

  it('converts inline code', () => {
    expect(renderMarkdownSync('use `console.log`')).toContain('<code>console.log</code>')
  })

  it('converts blockquotes', () => {
    expect(renderMarkdownSync('> quote')).toContain('<blockquote><p>quote</p></blockquote>')
  })

  it('converts horizontal rules', () => {
    expect(renderMarkdownSync('---')).toContain('<hr />')
  })

  it('converts safe links with rel attribute', () => {
    const result = renderMarkdownSync('[text](https://example.com)')
    expect(result).toContain('<a href="https://example.com" rel="noopener noreferrer">text</a>')
  })

  it('allows relative and hash links', () => {
    expect(renderMarkdownSync('[text](/path)')).toContain('href="/path"')
    expect(renderMarkdownSync('[text](#anchor)')).toContain('href="#anchor"')
  })

  it('strips javascript: protocol links — XSS prevention', () => {
    const result = renderMarkdownSync('[click](javascript:alert(1))')
    expect(result).not.toContain('javascript:')
    expect(result).toContain('click') // text preserved
  })

  it('image syntax: link regex fires first, so ![alt](url) becomes !<a>', () => {
    // The link regex matches [alt](url) before the image regex can match ![alt](url)
    const result = renderMarkdownSync('![alt](https://example.com/img.png)')
    expect(result).toContain('!<a href="https://example.com/img.png"')
    expect(result).toContain('>alt</a>')
  })

  it('converts nostr npub URIs to njump links', () => {
    const npub = 'npub1' + 'a'.repeat(30)
    const result = renderMarkdownSync(`nostr:${npub}`)
    expect(result).toContain(`href="https://njump.me/${npub}"`)
    expect(result).toContain(`@${npub}`)
  })

  it('converts nostr note URIs to njump links', () => {
    const note = 'note1' + 'a'.repeat(30)
    const result = renderMarkdownSync(`nostr:${note}`)
    expect(result).toContain(`href="https://njump.me/${note}"`)
  })

  it('converts nostr nevent URIs to njump links', () => {
    const nevent = 'nevent1' + 'a'.repeat(30)
    const result = renderMarkdownSync(`nostr:${nevent}`)
    expect(result).toContain(`href="https://njump.me/${nevent}"`)
  })

  it('wraps content in paragraphs on double newlines', () => {
    const result = renderMarkdownSync('first\n\nsecond')
    expect(result).toContain('</p><p>')
  })
})

describe('enhanceEmbedUrls', () => {
  it('replaces YouTube watch URLs with iframes', () => {
    const html = '<p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" rel="noopener noreferrer">https://www.youtube.com/watch?v=dQw4w9WgXcQ</a></p>'
    const result = enhanceEmbedUrls(html)
    expect(result).toContain('<iframe')
    expect(result).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(result).not.toContain('<a href')
  })

  it('replaces youtu.be short URLs with iframes', () => {
    const html = '<p><a href="https://youtu.be/dQw4w9WgXcQ" rel="noopener noreferrer">https://youtu.be/dQw4w9WgXcQ</a></p>'
    const result = enhanceEmbedUrls(html)
    expect(result).toContain('<iframe')
    expect(result).toContain('youtube.com/embed/dQw4w9WgXcQ')
  })

  it('does not replace URLs in mixed-content paragraphs', () => {
    const html = '<p>Check this: <a href="https://www.youtube.com/watch?v=abc">https://www.youtube.com/watch?v=abc</a> cool right?</p>'
    const result = enhanceEmbedUrls(html)
    // The regex only matches paragraphs that contain ONLY a link
    expect(result).toContain('<a href')
  })

  it('does not replace non-embeddable URLs', () => {
    const html = '<p><a href="https://example.com" rel="noopener noreferrer">https://example.com</a></p>'
    const result = enhanceEmbedUrls(html)
    expect(result).not.toContain('<iframe')
    expect(result).toContain('<a href')
  })
})
