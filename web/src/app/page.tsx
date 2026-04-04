import Link from 'next/link'
import { FeaturedWriters } from '../components/home/FeaturedWriters'
import { ForAllMark } from '../components/icons/ForAllMark'

export default function HomePage() {
  return (
    <div className="mx-auto max-w-article-frame px-6 py-24">

      {/* ── Section 1: Hero ── */}
      <section>
        <h1 className="hero-headline font-sans font-semibold text-black">
          Free authors.
        </h1>
        <p className="hero-headline font-sans font-semibold text-grey-600 mt-1">
          Writing that&apos;s worth something.
        </p>

        {/* 6px slab rule */}
        <div className="slab-rule mt-12" />

        <p className="mt-8 font-sans text-[18px] text-black leading-relaxed max-w-[440px]">
          At all.haus, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-10">
          <Link href="/auth?mode=signup" className="btn-accent inline-block">
            Get started — free £5 credit
          </Link>
        </div>
      </section>

      {/* ── Section 2: Manifesto ("The deal") ── */}
      <section className="mt-32">
        <div className="flex flex-col md:flex-row">
          {/* Label column — black, 180px */}
          <div className="bg-black md:w-[180px] flex-shrink-0 px-6 py-4 md:py-8">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400">THE DEAL</span>
          </div>

          {/* Manifesto lines */}
          <div className="flex-1 md:pl-8 pt-4 md:pt-0">
            {[
              'Own your name.',
              'Own your audience.',
              'Own your archive.',
              'Leave whenever you want, and take everything with you.',
            ].map((line, i, arr) => (
              <div key={i}>
                <p className="manifesto-line font-serif italic text-black py-5">
                  {line}
                </p>
                {i < arr.length - 1 && <div className="slab-rule-4" />}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section 3: How it works ── */}
      <section className="mt-24">
        {/* Label bar */}
        <div className="section-label-bar">
          <span>HOW IT WORKS</span>
        </div>

        {/* Three-column grid */}
        <div className="bg-grey-100">
          <div className="grid md:grid-cols-3">
            {[
              { num: '01', title: 'Write and publish', body: 'Articles and notes. Set a paywall anywhere in the text, or publish free.' },
              { num: '02', title: 'Readers pay per read', body: 'No subscriptions. Charges accumulate on a tab and settle via Stripe.' },
              { num: '03', title: 'You keep 92%', body: '8% covers running costs. No ads, no algorithmic suppression, no tricks.' },
            ].map((step, i) => (
              <div
                key={step.num}
                className={`p-6 md:p-8 ${i > 0 ? 'border-t-4 border-black md:border-t-0 md:border-l-4' : ''}`}
              >
                <p className="mb-2 font-mono text-[11px] text-crimson tracking-[0.04em]">
                  {step.num}
                </p>
                <p className="mb-1 font-sans text-[16px] font-semibold text-black">
                  {step.title}
                </p>
                <p className="font-sans text-[14px] text-grey-600 leading-[1.6]">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section 4: Featured writers ── */}
      <section className="mt-24">
        <div className="section-label-bar mb-0">
          <span>NOW WRITING ON ALL.HAUS</span>
        </div>

        <FeaturedWriters />

        <div className="mt-8">
          <Link href="/feed" className="btn-ghost inline-block">
            Read the feed
          </Link>
        </div>
      </section>

      {/* ── Section 5: Closing mark ── */}
      <div className="flex justify-center mt-20 mb-16">
        <ForAllMark size={24} className="text-grey-300" />
      </div>
    </div>
  )
}
