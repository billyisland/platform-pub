/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Instrument Sans"', '"Inter"', 'system-ui', 'sans-serif'],
        serif: ['"Newsreader"', '"Iowan Old Style"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', '"Courier New"', 'monospace'],
      },
      colors: {
        // Unified warm palette — cream to stone
        surface: {
          DEFAULT: '#FAF7F5',
          raised: '#F3EDEA',
          sunken: '#EBE3DE',
          strong: '#DDD3CB',
        },
        ink: {
          DEFAULT: '#1A1512',
          900: '#1A1512',
          800: '#2A2320',
          700: '#3D3530',
          600: '#5C5347',
          500: '#7A6E5D',
          400: '#A8977F',
          300: '#D4C4B0',
          200: '#E6DDD4',
          100: '#F3EDEA',
          50:  '#FAF7F5',
        },
        // Semantic text colours
        content: {
          DEFAULT: '#1A1512',
          primary: '#2A2320',
          secondary: '#5C5347',
          muted: '#7A6E5D',
          faint: '#A8977F',
        },
        // Accent — muted eucalyptus green
        // Literary, contemporary, works with warm cream
        accent: {
          DEFAULT: '#6B7F6B',
          50:  '#F2F5F2',
          100: '#E0E8E0',
          200: '#C1D1C1',
          300: '#9FB39F',
          400: '#7F967F',
          500: '#6B7F6B',
          600: '#566756',
          700: '#425042',
          800: '#2E3A2E',
          900: '#1A241A',
        },
        // Backward-compat aliases
        brand: {
          50: '#FAF7F5',
          100: '#F3EDEA',
          500: '#6B7F6B',
          600: '#566756',
          700: '#425042',
        },
        pink: {
          light: '#FAF7F5',
          dark: '#F3EDEA',
        },
        blue: {
          light: '#EBE3DE',
          dark: '#DDD3CB',
        },
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '640px',
            fontSize: '1.125rem',
            lineHeight: '1.85',
            color: '#3D3530',
            fontFamily: '"Newsreader", "Iowan Old Style", Georgia, serif',
            h1: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '400', letterSpacing: '-0.01em' },
            h2: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '400', letterSpacing: '-0.005em' },
            h3: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '400' },
            a: { color: '#566756', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: '#425042' } },
            blockquote: { borderLeftColor: '#9FB39F', borderLeftWidth: '2px', fontStyle: 'italic', color: '#5C5347' },
            code: { fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.875em' },
            p: { marginTop: '1.5em', marginBottom: '1.5em' },
          },
        },
      },
      maxWidth: {
        article: '640px',
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
