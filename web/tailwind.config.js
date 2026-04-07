/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Jost"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        serif: ['"Literata"', 'Georgia', '"Times New Roman"', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        white: '#FFFFFF',
        black: '#111111',
        grey: {
          100: '#F0F0F0',
          200: '#E5E5E5',
          300: '#BBBBBB',
          400: '#999999',
          600: '#666666',
        },
        crimson: {
          DEFAULT: '#B5242A',
          dark: '#921D22',
        },
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '640px',
            fontSize: '1.0625rem',
            lineHeight: '1.8',
            color: '#111111',
            fontFamily: '"Literata", Georgia, serif',
            h1: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', letterSpacing: '-0.025em', fontSize: '2.25rem', lineHeight: '1.15' },
            h2: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', letterSpacing: '-0.02em', fontSize: '1.75rem', lineHeight: '1.2' },
            h3: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', fontSize: '1.35rem', lineHeight: '1.3' },
            a: { color: '#111111', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: '#666666' } },
            blockquote: { borderLeftColor: '#BBBBBB', borderLeftWidth: '4px', fontStyle: 'italic', color: '#666666' },
            code: { fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: '0.875em' },
            p: { marginTop: '1.5em', marginBottom: '1.5em' },
          },
        },
      },
      maxWidth: {
        article: '640px',
        'article-frame': '960px',
        feed: '780px',
        'editor-frame': '780px',
        content: '960px',
      },
      letterSpacing: {
        'mono-nav': '0.06em',
        'mono-byline': '0.06em',
        'mono-meta': '0.02em',
      },
      fontSize: {
        'mono-xs': ['0.6875rem', { lineHeight: '1.5', letterSpacing: '0.06em' }],
        'mono-sm': ['0.9375rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        'ui-xs': ['0.8125rem', { lineHeight: '1.5' }],
        'ui-sm': ['0.875rem', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
