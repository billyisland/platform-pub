/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Source Sans 3"', '"Source Sans Pro"', 'system-ui', 'sans-serif'],
        serif: ['"Newsreader"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', '"Courier New"', 'monospace'],
      },
      colors: {
        surface: {
          DEFAULT: '#F5F0E8',
          raised: '#FFFFFF',
          card: '#FAF7F2',
          sunken: 'rgb(234 229 220 / <alpha-value>)',
          strong: 'rgb(212 209 204 / <alpha-value>)',
        },
        crimson: {
          DEFAULT: '#9B1C20',
          dark: '#7A1519',
          light: '#B52226',
        },
        slate: {
          DEFAULT: '#3D4A52',
          dark: '#2E383F',
          light: '#4F5F69',
        },
        ink: {
          DEFAULT: '#111111',
          900: '#111111',
          800: '#222222',
          700: '#333333',
          600: '#4A4845',
          500: '#7A7774',
          400: '#9E9B97',
          300: '#D4D1CC',
          200: '#E8E6E3',
          100: '#F2F0EE',
          50:  '#F5F0E8',       // match new surface
        },
        // Semantic text colours
        content: {
          DEFAULT: '#111111',
          primary: '#1A1A1A',
          secondary: '#4A4845',
          muted: '#7A7774',
          faint: '#9E9B97',
        },
        // Accent — crimson
        accent: {
          DEFAULT: '#9B1C20',
          50:  '#FDF2F2',
          100: '#F5D5D6',
          200: '#E8A5A7',
          300: '#D46F72',
          400: '#C44548',
          500: '#B52226',
          600: '#9B1C20',
          700: '#7A1519',
          800: '#5C1013',
          900: '#3D0A0D',
        },
        brand: {
          50: '#F5F0E8',
          100: '#FFFFFF',
          500: '#B52226',
          600: '#9B1C20',
          700: '#7A1519',
        },
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '640px',
            fontSize: '1.125rem',
            lineHeight: '1.85',
            color: '#1A1A1A',
            fontFamily: '"Newsreader", Georgia, serif',
            h1: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '500', letterSpacing: '-0.025em' },
            h2: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '500', letterSpacing: '-0.015em' },
            h3: { fontFamily: '"Newsreader", Georgia, serif', fontWeight: '500' },
            a: { color: '#9B1C20', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: '#7A1519' } },
            blockquote: { borderLeftColor: '#9B1C20', borderLeftWidth: '2px', fontStyle: 'italic', color: '#4A4845' },
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
