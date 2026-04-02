# platform.pub — Currency strategy

## The problem

The platform is built in GBP (pence). Every financial column — `amount_pence`, `price_pence`, `balance_pence`, `free_allowance_remaining_pence` — assumes a single currency. But writers and readers will be international. A US-based author setting a price of "$6.00" shouldn't force a UK reader to do mental FX arithmetic, and vice versa.

The question is where the currency boundary lives in the stack, and how much of the billing pipeline it touches.

---

## Three options, with trade-offs

### Option 1: Multi-currency end to end

Authors price in their own currency. Readers pay in theirs. The platform reconciles.

This is the Spotify/Netflix model. It produces the cleanest UX — everyone sees and pays in their local currency — but it requires `currency` columns on nearly every financial table (`read_events`, `reading_tabs`, `tab_settlements`, `writer_payouts`, `pledges`, `vote_charges`). Every aggregation query must group by currency or convert at a point-in-time rate. The settlement service creates PaymentIntents in the reader's currency; the payout service transfers in the author's currency. Stripe handles the actual FX, but the internal ledger must track both sides. This is a significant rearchitecture of the billing pipeline.

### Option 2: Single settlement currency (GBP), display-only conversion

Everything settles in GBP. The reader's browser shows an approximate local equivalent ("≈$6.25") but their card is charged in pounds. The reader's bank handles FX. Authors set prices in GBP.

This is the simplest option. The entire billing pipeline is untouched. The downside: non-UK readers absorb their bank's FX markup (typically 1–3%), and the displayed approximation may not match what their bank actually charges.

### Option 3: A small number of settlement currencies

GBP, USD, and EUR as settlement currencies. Authors choose one. Readers in those zones pay natively; everyone else gets the nearest of the three. The billing pipeline gains a `currency` column on key tables but only needs to handle three currencies, not arbitrary ones.

---

## Recommendation

**Option 2 to launch. Option 3 as a post-launch upgrade.**

The reasoning:

The reading-tab model makes this unusually forgiving. Readers aren't paying per-article in a checkout flow where they'd notice a precise converted price. They're accumulating a tab in pence, and the tab settles at a threshold (£8–£20). The individual article price is more of a signal ("this costs about $6") than a precise commitment. By the time the reader's card is charged, it's a lump sum of many reads, and the FX conversion on a £8 or £20 charge is not something people scrutinise the way they would a per-item checkout.

The initial writer cohort is UK-based, so GBP as the settlement currency is natural. International expansion is the trigger for option 3.

---

## What to build now (option 2)

### 1. User display currency

Add a `display_currency` column to `accounts`:

```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS
  display_currency CHAR(3) NOT NULL DEFAULT 'GBP';
```

Store a currency code, not a locale. A user in Germany might prefer USD. Default is inferred from the browser's locale on signup, overridable in settings.

### 2. Exchange rate endpoint

A lightweight cached endpoint serving daily rates:

```
GET /api/v1/exchange-rates
```

Returns:

```json
{
  "base": "GBP",
  "rates": { "USD": 1.27, "EUR": 1.17, "JPY": 189.5 },
  "updatedAt": "2026-03-31T06:00:00Z"
}
```

Source rates from the ECB reference feed (free, daily, reliable) or from Stripe's rate data. Cache aggressively — rates don't need to be real-time for display purposes. A background job refreshes once or twice daily.

### 3. Frontend display conversion

When the reader sees an article priced at 300 pence and their `display_currency` is USD, the frontend shows "≈$3.75". All API calls still send and receive pence. The conversion is purely cosmetic.

The rounding logic snaps converted prices to psychologically clean numbers:

| Converted amount | Displayed as |
|---|---|
| $5.97 | ≈$6.00 |
| $4.73 | ≈$4.75 |
| $12.38 | ≈$12.50 |
| $0.83 | ≈$0.85 |

The rule: round to the nearest 0.25 for amounts under £10, nearest 0.50 for amounts over £10. The tilde/≈ prefix signals that this is an approximation, not a commitment.

### 4. Author pricing preview

When an author sets a price, the editor UI shows approximate equivalents:

> **Price: £5.00**
> Readers in the US will see ≈$6.25 · Readers in the EU will see ≈€5.75

This helps authors price with their international audience in mind, without requiring them to think in foreign currencies.

### 5. Settings UI

A dropdown in user settings:

> **Display currency:** GBP ▾
>
> Prices and amounts will be shown in your chosen currency. All charges are processed in GBP; your bank converts at their rate.

A one-line explanation manages expectations about the actual charge currency.

---

## What to build later (option 3)

When international adoption warrants it, the migration path is:

1. Add `currency CHAR(3) NOT NULL DEFAULT 'GBP'` to `reading_tabs`, `read_events`, `tab_settlements`, `pledges`, and `writer_payouts`.

2. Authors choose a payout currency (GBP, USD, or EUR) during Stripe Connect onboarding. Store this on `accounts.payout_currency`.

3. Readers in USD/EUR zones get reading tabs denominated in their local currency. The settlement service creates PaymentIntents in the reader's tab currency.

4. The payout service uses Stripe's cross-border transfers to pay authors in their chosen currency. Stripe absorbs the FX spread (currently ~2% on cross-currency transfers, deducted from the transfer amount).

5. Author-set prices become multi-currency: the author sets a base price in their payout currency, and the platform stores rounded equivalents in the other two settlement currencies (updated daily). These are stored prices, not live conversions — so a $6.00 article is always £4.75 and €5.50, not a wobbly number that changes with the rate.

6. The `platform_config` table gains per-currency threshold values (settlement threshold, payout threshold, free allowance), since £8.00 and $10.00 are different psychological thresholds.

### Tables affected by option 3

| Table | Change |
|---|---|
| `accounts` | Add `payout_currency` |
| `articles` | Add `price_usd_cents`, `price_eur_cents` (stored rounded equivalents) |
| `reading_tabs` | Add `currency` |
| `read_events` | Add `currency` |
| `tab_settlements` | Add `currency` |
| `writer_payouts` | Add `currency` |
| `pledges` | Add `currency` |
| `vote_charges` | Add `currency` |
| `platform_config` | Add per-currency threshold keys |

### Services affected by option 3

| Service | Change |
|---|---|
| `payment-service/accrual` | Create read events in reader's tab currency |
| `payment-service/settlement` | Create PaymentIntents in reader's currency |
| `payment-service/payout` | Use Stripe cross-currency transfers |
| `gateway/articles` | Serve the reader-appropriate price from stored equivalents |
| `gateway/subscriptions` | Subscription charges in reader's currency |
| Exchange rate job | Also updates stored article price equivalents |

---

## What not to do

**Don't support arbitrary currencies.** Every additional settlement currency multiplies accounting complexity. Three currencies (GBP, USD, EUR) cover the vast majority of the likely user base. Readers outside those zones see the nearest equivalent and their bank converts.

**Don't convert prices live on every request.** Store rounded equivalents and update them daily. Live conversion means the same article shows a different price every time the rate ticks — bad UX and impossible to reason about in the billing pipeline.

**Don't show converted prices without the ≈ prefix.** The displayed price is an approximation. If the reader thinks "$6.00" is a precise commitment and their bank charges $6.14, they'll feel misled. The tilde sets the right expectation.

**Don't let exchange-rate fluctuation create micro-arbitrage.** If the stored equivalent of a £5.00 article is $6.25 today but $6.50 tomorrow, a reader who pledged at $6.25 yesterday shouldn't have their pledge invalidated. Pledges and subscriptions lock in the price at the time of commitment, in whatever currency the commitment was made.
