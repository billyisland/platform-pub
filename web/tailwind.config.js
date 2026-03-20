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
        // Warm palette — pale salmon background, cream surfaces
        surface: {
          DEFAULT: '#FAE8E2',
          raised: '#FDF6F0',
          sunken: '#F0D5CB',
          strong: '#E0C0B5',
        },
        terracotta: {
          DEFAULT: '#A85141',
          dark: '#8C4035',
          light: '#C1614F',
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
        // Accent — terracotta
        accent: {
          DEFAULT: '#C1614F',
          50:  '#FAF0ED',
          100: '#F2D5CF',
          200: '#E4AC9F',
          300: '#D4806E',
          400: '#C96B58',
          500: '#C1614F',
          600: '#A85141',
          700: '#8C4035',
          800: '#6B3028',
          900: '#4A2019',
        },
        // Backward-compat aliases
        brand: {
          50: '#FAE8E2',
          100: '#FDF6F0',
          500: '#C1614F',
          600: '#A85141',
          700: '#8C4035',
        },
        pink: {
          light: '#FAE8E2',
          dark: '#F0D5CB',
        },
        blue: {
          light: '#F0D5CB',
          dark: '#E0C0B5',
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
            a: { color: '#A85141', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: '#8C4035' } },
            blockquote: { borderLeftColor: '#D4806E', borderLeftWidth: '2px', fontStyle: 'italic', color: '#5C5347' },
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
