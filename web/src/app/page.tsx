import Link from 'next/link'
import { FeaturedWriters } from '../components/home/FeaturedWriters'
import { ThereforeMark } from '../components/icons/ThereforeMark'

export default function HomePage() {
  return (
    <div className="mx-auto max-w-article-frame px-6 py-24">

      {/* ── Section 1: Hero ── */}
      <section>
        <h1 className="font-serif text-[48px] font-medium leading-[1.05] text-black sm:text-[48px]" style={{ letterSpacing: '-0.03em' }}>
          Free authors.
        </h1>
        <p className="font-serif text-[48px] font-normal leading-[1.05] text-grey-300 sm:text-[48px] mt-1" style={{ letterSpacing: '-0.03em' }}>
          Writing that's worth something.
        </p>

        <div className="rule-accent mt-12" />

        <p className="mt-8 font-sans text-lg text-black leading-relaxed max-w-lg">
          At Platform, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-10">
          <Link href="/auth?mode=signup" className="btn-accent">
            Get started — free £5 credit
          </Link>
        </div>
      </section>

      {/* ── Section 2: Manifesto ── */}
      <section className="mt-32">
        <div className="rule-accent pt-8">
          <p className="mb-8 font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400">
            THE DEAL
          </p>

          {[
            'Own your name.',
            'Own your audience.',
            'Own your archive.',
            'Leave whenever you want, and take everything with you.',
          ].map((line, i, arr) => (
            <div key={i}>
              <p className="font-serif italic text-black" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 400, padding: '0.6em 0' }}>
                {line}
              </p>
              {i < arr.length - 1 && <div className="rule" />}
            </div>
          ))}
        </div>
      </section>

      {/* ── Section 3: How it works ── */}
      <section className="mt-24">
        <div className="p-[2.5rem_2rem] bg-grey-100 border border-grey-200">
          <p className="mb-8 font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400">
            HOW IT WORKS
          </p>

          <div className="grid gap-8" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            {[
              { num: '01', title: 'Write and publish', body: 'Articles and notes. Set a paywall anywhere in the text, or publish free.' },
              { num: '02', title: 'Readers pay per read', body: 'No subscriptions. Charges accumulate on a tab and settle via Stripe.' },
              { num: '03', title: 'You keep 92%', body: '8% covers running costs. No ads, no algorithmic suppression, no tricks.' },
            ].map(step => (
              <div key={step.num}>
                <p className="mb-2 font-mono text-[12px] text-crimson tracking-[0.04em]">
                  {step.num}
                </p>
                <p className="mb-1 font-sans text-[17px] font-semibold text-black">
                  {step.title}
                </p>
                <p className="font-sans text-[15px] text-grey-600 leading-[1.6]">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section 4: Featured writers ── */}
      <section className="mt-24">
        <p className="mb-8 font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400">
          NOW WRITING ON PLATFORM
        </p>

        <FeaturedWriters />

        <div className="mt-8">
          <Link href="/feed" className="btn-ghost">
            Read the feed →
          </Link>
        </div>
      </section>

      {/* ── Section 5: Closing ornament ── */}
      <div className="mt-32 ornament">
        <ThereforeMark size={24} weight="light" />
      </div>
    </div>
  )
}
