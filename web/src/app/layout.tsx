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
          <main className="min-h-screen lg:pl-[180px]">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  )
}
