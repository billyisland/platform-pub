import type { Metadata } from 'next'
import './globals.css'
import { Nav } from '../components/layout/Nav'
import { Footer } from '../components/layout/Footer'
import { AuthProvider } from '../components/layout/AuthProvider'
import { LayoutShell } from '../components/layout/LayoutShell'

export const metadata: Metadata = {
  title: 'all.haus',
  description: 'A publishing platform for writers and readers',
  metadataBase: new URL('https://all.haus'),
  openGraph: {
    title: 'all.haus',
    description: 'A publishing platform for writers and readers',
    siteName: 'all.haus',
    type: 'website',
    url: 'https://all.haus',
  },
  twitter: {
    card: 'summary',
    title: 'all.haus',
    description: 'A publishing platform for writers and readers',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/jost-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/literata-latin-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/literata-latin-400-italic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/ibm-plex-mono-latin-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="all.haus — recent articles"
          href="/rss"
        />
      </head>
      <body>
        <AuthProvider>
          <LayoutShell>
            <Nav />
            <main className="min-h-screen pt-[60px]">
              {children}
            </main>
            <Footer />
          </LayoutShell>
        </AuthProvider>
      </body>
    </html>
  )
}
