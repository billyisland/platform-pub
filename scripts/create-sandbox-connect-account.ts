#!/usr/bin/env npx tsx
/**
 * scripts/create-sandbox-connect-account.ts
 *
 * Create a fully-onboarded connected account in a Stripe SANDBOX, via the API.
 *
 * WHY THIS EXISTS AT ALL. The Stripe web dashboard cannot currently create an
 * onboarded connected account under the new controller-properties model — the
 * API is the only route. So the recipe lives here rather than in someone's shell
 * history, because the §5 sequence needs a SECOND payable destination and
 * without one a whole claim cannot be tested at all (see below).
 *
 * WHAT NEEDS TWO ACCOUNTS, AND WHY ONE IS NOT NEARLY ENOUGH. Step 11's third arm
 * asserts that a deliberately failed publication SPLIT completes its parent
 * rather than zombifying it (§3.3c — the parent completes on "no split PENDING",
 * never "every split completed"). With a single payable member the payout has one
 * split, and a single failed split correctly fails its parent OUTRIGHT — so the
 * property has no sibling to be true of and the arm passes vacuously or not at
 * all. Two members, two splits, one failed: that is the shape the rule is about.
 *
 * IT MIRRORS THE EXISTING SANDBOX ACCOUNT rather than inventing a shape:
 * `type: none` with application-owned fees/losses and
 * `requirement_collection: application`, GB/GBP, `business_type: individual`, and
 * the `transfers` capability ALONE. That last is deliberate and matches
 * `isConnectPayable` (`payment-service/src/lib/connect-payable.ts`), which gates
 * on `transfers === 'active'` + `payouts_enabled` and deliberately does NOT
 * require `card_payments`: writers only ever RECEIVE, via transfers, so coupling
 * payability to an unused capability would strand any writer whose card_payments
 * lags transfers.
 *
 * THE TEST-MODE MAGIC VALUES ARE THE POINT. A real account clears verification
 * out of band, over days. In test mode Stripe recognises specific inputs and
 * verifies instantly: `dob` 1901-01-01, `address.line1` "address_full_match",
 * `id_number` 000000000, and the GB test bank pair (sort code 108800, account
 * 00012345). Without them the account is created but sits with `currently_due`
 * requirements, `payouts_enabled: false`, and every transfer to it fails — which
 * looks exactly like a payout defect.
 *
 * SAFETY. Refuses a live key outright. This creates a real, permanent connected
 * account on whatever account the key belongs to; on a live key that is a
 * regulated entity you would then have to deal with.
 *
 *   npx tsx scripts/create-sandbox-connect-account.ts
 *   npx tsx scripts/create-sandbox-connect-account.ts --name "Second Member"
 */
import 'dotenv/config'
import Stripe from 'stripe'

const argv = process.argv.slice(2)
const arg = (n: string): string | null => {
  const i = argv.indexOf(n)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

const NAME = arg('--name') ?? 'Sequence Member Two'

function makeStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (!key || key.startsWith('sk_test_...')) {
    console.error('STRIPE_SECRET_KEY missing or the repo placeholder.')
    process.exit(1)
  }
  if (key.startsWith('sk_live_')) {
    console.error('REFUSING: live key. This creates a real connected account.')
    process.exit(1)
  }
  return new Stripe(key)
}

const stripe = makeStripe()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const [first, ...rest] = NAME.split(' ')
  const last = rest.join(' ') || 'Member'

  const account = await stripe.accounts.create({
    country: 'GB',
    email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, '')}@sequence.test`,
    // Mirrors the existing sandbox account exactly: application-controlled,
    // no Stripe-hosted dashboard, requirements collected by us.
    controller: {
      fees: { payer: 'application' },
      losses: { payments: 'application' },
      requirement_collection: 'application',
      stripe_dashboard: { type: 'none' },
    },
    business_type: 'individual',
    // transfers ONLY — see the header. card_payments is not needed to receive.
    capabilities: { transfers: { requested: true } },
    business_profile: {
      mcc: '5815',
      url: 'https://all.haus',
      product_description: 'Writing published on all.haus',
    },
    individual: {
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, '')}@sequence.test`,
      phone: '+442071234567',
      // Test-mode instant verification triggers — see the header.
      dob: { day: 1, month: 1, year: 1901 },
      id_number: '000000000',
      address: {
        line1: 'address_full_match',
        city: 'London',
        postal_code: 'WC2N 5DU',
        country: 'GB',
      },
    },
    tos_acceptance: {
      date: Math.floor(Date.now() / 1000),
      ip: '127.0.0.1',
      service_agreement: 'full',
    },
    external_account: {
      object: 'bank_account',
      country: 'GB',
      currency: 'gbp',
      account_holder_name: NAME,
      account_holder_type: 'individual',
      routing_number: '108800',
      account_number: '00012345',
    } as unknown as string,
  } as Stripe.AccountCreateParams)

  console.log(`created ${account.id}`)

  // Capabilities activate asynchronously. Poll rather than reporting the create
  // response, which reliably shows transfers: 'pending' for a second or two and
  // would make a perfectly good account look unusable.
  let latest = account
  for (let i = 0; i < 12; i++) {
    latest = await stripe.accounts.retrieve(account.id)
    if (latest.capabilities?.transfers === 'active' && latest.payouts_enabled) break
    await sleep(2000)
  }

  const payable = latest.capabilities?.transfers === 'active' && Boolean(latest.payouts_enabled)

  console.log(`  charges_enabled : ${latest.charges_enabled}`)
  console.log(`  payouts_enabled : ${latest.payouts_enabled}`)
  console.log(`  capabilities    : ${JSON.stringify(latest.capabilities)}`)
  console.log(`  currently_due   : ${JSON.stringify(latest.requirements?.currently_due ?? [])}`)
  console.log(`  past_due        : ${JSON.stringify(latest.requirements?.past_due ?? [])}`)
  console.log(`  disabled_reason : ${latest.requirements?.disabled_reason ?? '(none)'}`)
  console.log(
    `\n  isConnectPayable() would say: ${payable ? 'YES — usable as a payout destination' : 'NO'}`,
  )

  if (!payable) {
    console.log(
      '\nNot yet payable. Anything in currently_due above is what Stripe still wants;\n' +
        'fill it with the test-mode magic values rather than real data.',
    )
  } else {
    console.log(`\n  npx tsx scripts/segregation-sequence.ts --step 11 \\`)
    console.log(`    --destination <existing_acct>,${latest.id}`)
  }
}

main().catch((err) => {
  console.error('FAILED:', err?.message ?? err)
  if (err?.raw) console.error('raw:', JSON.stringify(err.raw))
  process.exit(1)
})
