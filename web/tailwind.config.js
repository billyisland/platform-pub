/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Source Sans 3"', '"Source Sans Pro"', 'system-ui', 'sans-serif'],
        serif: ['"Literata"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', '"Courier New"', 'monospace'],
      },
      colors: {
        // ── New design tokens (DESIGN.md) ──
        surface: {
          DEFAULT: '#EDF5F0',
          deep: '#DDEEE4',
        },
        card: {
          DEFAULT: '#FFFAEF',
        },
        rule: '#B8D2C1',
        accent: {
          DEFAULT: '#B5242A',
          dark: '#921D22',
        },
        ink: {
          DEFAULT: '#0F1F18',
        },
        nav: {
          DEFAULT: '#DDEEE4',
          hover: '#82A890',
        },
        content: {
          DEFAULT: '#0F1F18',
          primary: '#0F1F18',
          secondary: '#263D32',
          muted: '#4A6B5A',
          faint: '#7A9A8A',
          'card-muted': '#8A8578',
          'card-faint': '#ACA69C',
        },
        avatar: {
          bg: '#C2DBC9',
        },
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '640px',
            fontSize: '1.125rem',
            lineHeight: '1.8',
            color: '#0F1F18',
            fontFamily: '"Literata", Georgia, serif',
            h1: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', fontStyle: 'italic', letterSpacing: '-0.025em', fontSize: '2.25rem', lineHeight: '1.15' },
            h2: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', fontStyle: 'italic', letterSpacing: '-0.02em', fontSize: '1.75rem', lineHeight: '1.2' },
            h3: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', fontStyle: 'italic', fontSize: '1.35rem', lineHeight: '1.3' },
            a: { color: '#B5242A', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: '#921D22' } },
            blockquote: { borderLeftColor: '#B5242A', borderLeftWidth: '2.5px', fontStyle: 'italic', color: '#263D32' },
            code: { fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.875em' },
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
        'mono-tight': '-0.01em',
        'mono-wide': '0.05em',
      },
      fontSize: {
        'mono-xs': ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0.03em' }],
        'mono-sm': ['0.9375rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        'mono-base': ['1rem', { lineHeight: '1.6' }],
        'ui-xs': ['0.75rem', { lineHeight: '1.5' }],
        'ui-sm': ['0.875rem', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
