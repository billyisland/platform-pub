import type { Metadata } from 'next'
import './globals.css'
import { Nav } from '../components/layout/Nav'
import { AuthProvider } from '../components/layout/AuthProvider'

export const metadata: Metadata = {
  title: 'Platform',
  description: 'A publishing platform for writers and readers',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Platform — recent articles"
          href="/rss"
        />
      </head>
      <body>
        <AuthProvider>
          <Nav />
          {/* Vertical rule separating nav from content — lg+ only */}
          <div className="hidden lg:block fixed top-0 bottom-0 left-[240px] z-40 flex items-center" style={{ pointerEvents: 'none' }}>
            <div className="mx-auto h-[calc(100%-8rem)] mt-16 border-l-2 border-ink" />
          </div>
          <main className="min-h-screen lg:pl-[240px]">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  )
}
