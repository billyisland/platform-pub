import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PublicPage } from '../../../../components/public/PublicPage'
import { formatPence } from '../../../../lib/format'

// =============================================================================
// Publication subscribe — /pub/:slug/subscribe
//
// PRICES ONLY. There is no checkout on this page and there never has been; it
// states the terms and nothing else. That is worth saying out loud so the next
// reader does not take the absence of a button for a regression — wiring the
// subscribe action is CONSOLIDATED-TODO §4, not this pass, which corrected the
// chassis and the two outlined tier boxes, both banned single-pixel lines.
//
// The tiers are `bg-glasshouse-well` panels rather than outlined boxes: on this
// page the ground is bone, so a slightly inset well reads as a card without a
// rule round it, and it inverts with the global toggle where a chosen line
// colour would have had to suit one mode and not the other.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}
  return {
    title: `Subscribe to ${pub.name} — all.haus`,
    description: pub.tagline || `Subscribe to ${pub.name} on all.haus`,
  }
}

function Tier({
  label,
  pence,
  note,
}: {
  label: string
  pence: number
  note?: string
}) {
  return (
    <div className="bg-glasshouse-well px-6 py-7 text-center">
      <p className="label-ui text-grey-600">{label}</p>
      <p className="font-sans font-medium text-black mt-2" style={{ fontSize: '2rem' }}>
        {formatPence(pence)}
        <span className="text-ui-sm text-grey-600 font-normal"> /month</span>
      </p>
      {note && <p className="text-ui-xs text-grey-600 mt-2">{note}</p>}
    </div>
  )
}

export default async function SubscribePage({ params }: { params: { slug: string } }) {
  const pub = await getPublication(params.slug)
  if (!pub) return notFound()

  const monthly: number = pub.subscription_price_pence ?? 0
  const annualDiscount: number = pub.annual_discount_pct ?? 0
  const annualMonthly = Math.round(monthly * (1 - annualDiscount / 100))

  return (
    <PublicPage>
      <PublicationMasthead pub={pub} />
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-14 pb-20">
        <h1 className="font-serif font-light text-black text-center tracking-tight" style={{ fontSize: '2rem' }}>
          Subscribe
        </h1>

        {monthly > 0 ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-9">
              <Tier label="Monthly" pence={monthly} />
              {annualDiscount > 0 && (
                <Tier
                  label="Annual"
                  pence={annualMonthly}
                  note={`${annualDiscount}% off, billed yearly`}
                />
              )}
            </div>
            <p className="font-sans text-ui-sm text-grey-600 mt-8 text-center">
              Full access to everything {pub.name} publishes. Cancel any time.
            </p>
          </>
        ) : (
          <p className="label-ui text-grey-600 py-16 text-center">
            NO SUBSCRIPTION OFFERED YET
          </p>
        )}
      </div>
    </PublicPage>
  )
}
