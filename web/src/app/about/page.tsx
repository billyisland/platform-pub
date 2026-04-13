import type { Metadata } from 'next'
import { AboutContent } from './AboutContent'

export const metadata: Metadata = {
  title: 'About — all.haus',
  description: 'A place to write, publish and get paid. Own your identity, build a profile on your terms, find an audience that pays.',
  openGraph: {
    title: 'About — all.haus',
    description: 'A place to write, publish and get paid. Own your identity, build a profile on your terms, find an audience that pays.',
    type: 'website',
    siteName: 'all.haus',
  },
  twitter: {
    card: 'summary',
    title: 'About — all.haus',
    description: 'A place to write, publish and get paid. Own your identity, build a profile on your terms, find an audience that pays.',
  },
}

export default function AboutPage() {
  return <AboutContent />
}
