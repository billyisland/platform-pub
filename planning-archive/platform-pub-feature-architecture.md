# platform.pub — Feature architecture: DMs, pledge drives, free passes, invitation-only articles

## How the five features compose

These five features share a single structural primitive that already exists in the codebase: the `article_unlocks` table (migration 005). The `checkArticleAccess()` function in `gateway/src/services/access.ts` already checks this table before any payment flow runs. Every one of these features ultimately produces (or checks for) a row in that table. The diagram below shows the dependency graph.

```
                    ┌──────────────────────────────┐
                    │       Direct Messages         │
                    │  (NIP-17 via key-custody)     │
                    └──────┬───────────┬────────────┘
                           │           │
              negotiation  │           │  notifications
              channel      │           │  & invitations
                           │           │
          ┌────────────────▼──┐   ┌────▼──────────────────┐
          │   Pledge Drives   │   │   Free Passes          │
          │   (crowdfund or   │   │   (author→reader)      │
          │    commission)    │   │                         │
          └────────┬──────────┘   └────────┬───────────────┘
                   │                       │
                   │ on publish:           │ direct insert
                   │ fulfil pledges        │
                   │                       │
                   ▼                       ▼
          ┌────────────────────────────────────────┐
          │          article_unlocks                │
          │  (the universal access-grant primitive) │
          │                                        │
          │  unlocked_via:                          │
          │    'purchase'        ← existing         │
          │    'subscription'    ← existing         │
          │    'pledge'          ← NEW (drive)      │
          │    'author_grant'    ← NEW (free pass)  │
          │    'invitation'      ← NEW (invite-only)│
          └────────────────────────────────────────┘
                   │
                   │ checked by
                   ▼
          ┌────────────────────────────────────────┐
          │     checkArticleAccess()               │
          │     → key-service issueKey()           │
          │     → content decryption               │
          └────────────────────────────────────────┘
```

---

## 1. Direct messages

### What it does

Users send private messages to each other. DMs are the negotiation channel for commissions, the notification channel for free passes and pledge drive updates, and a standalone social feature.

### Why it exists before the others

Commissions require a way for readers to pitch ideas to writers. Free passes need a way to notify the recipient. Pledge drive updates need a channel. Without DMs, each of these features would need its own bespoke messaging system.

### Nostr integration

DMs on Nostr use NIP-17 (gift-wrapped, encrypted kind 14 events). The platform already has the cryptographic machinery: `key-custody` manages users' Nostr private keys, and `key-service/src/lib/nip44.ts` handles NIP-44 encryption (ChaCha20-Poly1305). The gap is the DB index and gateway routes.

### End-to-end encryption

DMs are encrypted end-to-end using NIP-44. The gateway asks `key-custody` to encrypt the message from the sender's Nostr private key to the recipient's Nostr public key. The `content_enc` column stores the ciphertext encrypted to the *recipient*, not to a platform key — the platform cannot read messages after writing them.

To display in the web client, the frontend requests decryption from `key-custody`, which authenticates via the same session JWT that gates all other key operations.

For multi-party conversations, the sender encrypts once per member (NIP-44 to each participant's pubkey). The `direct_messages` table stores one row per recipient with their ciphertext. For conversations with many members, a symmetric-key approach (encrypt the body once, wrap the symmetric key per-member — the NIP-17 gift-wrap pattern) scales better. For the typical commission discussion of 3–5 people, per-member encryption is fine; a group size cap keeps encryption overhead bounded.

**Trade-offs**: Platform-side search over DM content is impossible. Content moderation after the fact is impossible — the platform moderates the *ability to send* (blocks, pricing), not the content itself.

### Anti-spam: paid DMs

Users can block others from messaging them. Beyond blocking, users can set a price that others must pay to DM them — per-individual, per-group, or as a default rate for everyone. This turns harassment into revenue for the target.

```sql
CREATE TABLE dm_pricing (
  owner_id      UUID NOT NULL REFERENCES accounts(id),
  target_id     UUID REFERENCES accounts(id),  -- NULL = default rate for all senders
  price_pence   INT NOT NULL,                   -- 0 = free, >0 = pay to DM
  PRIMARY KEY (owner_id, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'))
);
```

The gateway checks this table before allowing a DM. If a price exists, the sender pays via tab accrual (same mechanism as reading a gated article). The recipient is the "writer" in the resulting `read_event` — they earn the DM fee. Lookup order: specific user override → default rate → free (platform default).

This needs further design work (group pricing rules, how pricing is surfaced in the UI, whether the first DM in a conversation is priced differently from subsequent ones, etc.) but the schema primitive is simple.

### New tables

```sql
-- Migration 015: Direct messages

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by      UUID NOT NULL REFERENCES accounts(id),
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE direct_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content_enc      TEXT NOT NULL,  -- NIP-44 encrypted to recipient's pubkey (E2E)
  nostr_event_id   TEXT UNIQUE,    -- NIP-17 event, published async
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX idx_dm_recipient ON direct_messages(recipient_id);
```

### New gateway routes

```
POST   /api/v1/messages/:conversationId    — send a DM (or create conversation)
GET    /api/v1/messages                    — list conversations (inbox)
GET    /api/v1/messages/:conversationId    — load messages in a conversation
POST   /api/v1/messages/:messageId/read    — mark as read
POST   /api/v1/conversations               — create a new conversation (with member list)
POST   /api/v1/conversations/:id/members   — add members to a conversation
```

All routes check the `blocks` table before allowing message creation. Muted users' conversations are excluded from the inbox query. A `notifications` row of type `'new_message'` is inserted on each incoming DM, plugging into the existing notification system (migration 009).

### Integration with existing code

- **Auth**: Uses `requireAuth` middleware, same as all other gateway routes.
- **Nostr**: Publishes NIP-17 gift-wrapped events to the relay asynchronously (non-blocking, same pattern as receipt publishing in `accrual.ts`).
- **Encryption**: Uses `key-custody` to encrypt on behalf of custodial users. The gateway calls key-custody's signing endpoint (already used by `gateway/src/lib/key-custody-client.ts`). Encryption is E2E — the platform stores ciphertext it cannot decrypt.
- **Blocks/mutes**: Checked against `blocks` and `mutes` tables (already in `schema.sql`).
- **DM pricing**: Checked against `dm_pricing` before allowing message creation. If a price is set, a `read_event` is created with the recipient as the writer.

---

## 2. Pledge drives (crowdfunding and commissions as feed items)

### What it does

A pledge drive is a first-class feed item — a social object that lives in the content graph alongside articles and notes. It represents a call for funding: either an author raising money for work they intend to do themselves (crowdfund), or a reader raising money to commission a specific writer (commission).

Pledge drives appear in feeds, on profile pages, and can be quoted by other users to give them social distribution. They are time-limited by default (the creator sets a deadline) with an option to be open-ended. They are pinned to the top of the creator's profile page by default, and auto-unpin when completed or expired. Creators can delete a pledge drive at any time, whether or not it has expired.

### Nostr integration

Pledge drives are published as a custom replaceable Nostr event kind on the platform relay. Articles are kind 30023 (NIP-23); pledge drives use a higher application-specific kind in the 30000–39999 replaceable range (e.g., kind 30078 or another unused slot). This gives pledge drives the same infrastructure as articles:

- Signed by the creator's custodial keypair via `key-custody`
- Published to the relay via `gateway/src/lib/nostr-publisher.ts`
- Quotable via the same mechanism as articles (NIP-18 reposts, NIP-27 content references)
- Deletable via kind 5 deletion events (same as article soft-delete)

The Nostr event's `d` tag serves as the replaceable identifier (same as articles), and additional tags encode the pledge drive metadata: target amount, deadline, target writer (for commissions), current pledge count, and status.

### Crowdfunds vs. commissions

Both produce the same visible artifact — a pledge drive. The differences:

| | Crowdfund | Commission |
|---|---|---|
| **Created by** | The writer who will do the work | A reader who wants the work done |
| **Target writer** | The creator themselves | A named writer |
| **Acceptance** | Implicit (creator is the writer) | Required — the target writer must accept |
| **Social dynamics** | "I want to write X — back me" | "I want Writer X to write about Y — pile on" |

A commission pledge drive appears publicly immediately when created. The target writer can accept (linking it to a draft), decline (sending a DM to the creator), or ignore it. The social pressure of visible pledges is a feature, not a bug — but the writer is never obligated. A declined commission stays visible with a "declined" status so pledgers know to withdraw.

### Time limits and lifecycle

Pledge drives have an explicit lifecycle:

```
open → funded → published → fulfilled
         ↓                      ↑
       expired              (async job)
         ↓
       cancelled
```

- **open**: Accepting pledges. Deadline is ticking (or open-ended).
- **funded**: Target amount reached, still accepting additional pledges.
- **expired**: Deadline passed without publication. Pledges are void (no money was committed to tabs, so no unwind needed).
- **published**: The linked article has been published. Fulfilment is pending.
- **fulfilled**: Async fulfilment job has processed all pledges — access granted, read_events created.
- **cancelled**: Creator deleted the drive. Pledges are void.

Creators can delete (cancel) a drive at any point. Because pledges are commitments, not tab charges, cancellation requires no financial unwind — pledges simply become void.

### Pinning and profile display

Pledge drives are pinned to the top of the creator's profile page by default. The creator can unpin them. When a drive reaches a terminal state (`fulfilled`, `expired`, `cancelled`), it auto-unpins. Fulfilled drives remain visible on the profile with a "funded & delivered" badge — social proof that the creator delivers. The creator can also manually delete fulfilled drives from their profile.

### Quoting

Quoting a pledge drive works identically to quoting an article. A user writes a note or article and embeds a reference to the pledge drive's Nostr event. The frontend renders a card-style preview: title, description, funding progress, deadline, and a "pledge" button. This gives pledge drives social distribution — a reader can write "back this, it's going to be great" with the drive card inline, amplifying it to their followers.

### The key insight

Pledges are commitments, not charges. When a reader pledges, nothing touches their reading tab. No `read_event` is created, no `reading_tabs` balance changes. The pledge is a record of intent — "I will pay X when this is delivered."

Money only moves when the article is published and the async fulfilment job runs. At that point, the fulfilment job creates `read_events` with `state: 'accrued'` and `article_unlocks` rows — the charge becomes real and enters the existing settlement pipeline. This means:

- Cancellation or expiry before publication requires no financial unwind.
- The existing `read_events` → `reading_tabs` → `tab_settlements` → `writer_payouts` pipeline handles all the money, untouched.
- Pledging is a low-friction social action, not a financial commitment until delivery.

### New tables

```sql
-- Migration 016: Pledge drives

CREATE TYPE drive_status AS ENUM (
  'open',        -- accepting pledges
  'funded',      -- target reached (still accepting pledges)
  'published',   -- article published, fulfilment pending
  'fulfilled',   -- all pledges processed, access granted
  'expired',     -- deadline passed without publication
  'cancelled'    -- creator deleted the drive
);

CREATE TYPE drive_origin AS ENUM (
  'crowdfund',   -- creator is the writer
  'commission'   -- creator is a reader, target writer is specified
);

CREATE TYPE pledge_status AS ENUM (
  'active',      -- pledge is live, awaiting publication
  'fulfilled',   -- article published, read_event created, access granted
  'void'         -- drive cancelled or expired, pledge is void
);

CREATE TABLE pledge_drives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id            UUID NOT NULL REFERENCES accounts(id),
  origin                drive_origin NOT NULL,
  target_writer_id      UUID NOT NULL REFERENCES accounts(id),  -- same as creator for crowdfunds
  title                 TEXT NOT NULL,
  description           TEXT,
  funding_target_pence  INT,              -- NULL = no target (open-ended amount)
  current_total_pence   INT NOT NULL DEFAULT 0,
  suggested_price_pence INT,              -- suggested per-pledge amount
  status                drive_status NOT NULL DEFAULT 'open',
  article_id            UUID REFERENCES articles(id),
  draft_id              UUID REFERENCES article_drafts(id),
  nostr_event_id        TEXT UNIQUE,      -- replaceable event on relay
  pinned                BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_at           TIMESTAMPTZ,      -- when target writer accepted (commissions)
  deadline              TIMESTAMPTZ,      -- NULL = open-ended
  published_at          TIMESTAMPTZ,
  fulfilled_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drives_creator ON pledge_drives(creator_id);
CREATE INDEX idx_drives_writer ON pledge_drives(target_writer_id);
CREATE INDEX idx_drives_status ON pledge_drives(status);
CREATE INDEX idx_drives_nostr ON pledge_drives(nostr_event_id);

CREATE TABLE pledges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_id      UUID NOT NULL REFERENCES pledge_drives(id),
  pledger_id    UUID NOT NULL REFERENCES accounts(id),
  amount_pence  INT NOT NULL,
  status        pledge_status NOT NULL DEFAULT 'active',
  read_event_id UUID REFERENCES read_events(id),  -- populated on fulfilment
  fulfilled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drive_id, pledger_id)  -- one pledge per user per drive
);

CREATE INDEX idx_pledges_drive ON pledges(drive_id);
CREATE INDEX idx_pledges_pledger ON pledges(pledger_id);
CREATE INDEX idx_pledges_status ON pledges(status);
```

### New gateway routes

```
POST   /api/v1/drives                          — create a pledge drive
GET    /api/v1/drives/:id                      — view drive + pledge count/progress
PUT    /api/v1/drives/:id                      — update drive (creator only)
DELETE /api/v1/drives/:id                      — cancel/delete drive (creator only)
POST   /api/v1/drives/:id/pledge               — pledge money
DELETE /api/v1/drives/:id/pledge               — withdraw pledge (before publication)
POST   /api/v1/drives/:id/accept               — target writer accepts a commission
POST   /api/v1/drives/:id/decline              — target writer declines a commission
POST   /api/v1/drives/:id/pin                  — pin/unpin on profile
GET    /api/v1/drives/by-user/:userId           — list a user's drives (profile view)
GET    /api/v1/my/pledges                      — list my active pledges
```

### The publication trigger and async fulfilment

The existing `POST /articles` route gains one new step after indexing:

```typescript
// After article is indexed successfully:
// Check if this article is linked to a pledge drive
const driveRow = await client.query<{ id: string }>(
  `SELECT id FROM pledge_drives
   WHERE target_writer_id = $1 AND draft_id = $2 AND status IN ('open', 'funded')
   FOR UPDATE`,
  [writerId, draftId]
)

if (driveRow.rows.length > 0) {
  // Mark drive as published — fulfilment happens async
  await client.query(
    `UPDATE pledge_drives SET article_id = $1, status = 'published',
     published_at = now() WHERE id = $2`,
    [articleId, driveRow.rows[0].id]
  )
  // Queue async fulfilment job
  await queueDriveFulfilment(driveRow.rows[0].id)
}
```

The fulfilment job runs outside the publish request path, processing pledges in batches:

```typescript
async function fulfillDrive(driveId: string) {
  const drive = await getDrive(driveId)

  // Process pledges in batches within transactions
  const pledges = await getActivePledges(driveId)

  for (const batch of chunk(pledges, 50)) {
    await withTransaction(async (client) => {
      for (const pledge of batch) {
        // 1. Create read_event (enters existing settlement pipeline)
        const readEvent = await client.query<{ id: string }>(
          `INSERT INTO read_events
             (reader_id, article_id, writer_id, amount_pence, state)
           VALUES ($1, $2, $3, $4, 'accrued')
           RETURNING id`,
          [pledge.pledger_id, drive.article_id, drive.target_writer_id, pledge.amount_pence]
        )

        // 2. Create article_unlocks → checkArticleAccess() grants access
        await client.query(
          `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
           VALUES ($1, $2, 'pledge')
           ON CONFLICT (reader_id, article_id) DO NOTHING`,
          [pledge.pledger_id, drive.article_id]
        )

        // 3. Update reading_tabs balance (charge becomes real)
        await client.query(
          `UPDATE reading_tabs
           SET balance_pence = balance_pence + $1, last_read_at = now()
           WHERE reader_id = $2`,
          [pledge.amount_pence, pledge.pledger_id]
        )

        // 4. Mark pledge as fulfilled
        await client.query(
          `UPDATE pledges SET status = 'fulfilled', read_event_id = $1,
           fulfilled_at = now() WHERE id = $2`,
          [readEvent.rows[0].id, pledge.id]
        )
      }
    })
  }

  // Mark drive as fulfilled, auto-unpin
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE pledge_drives SET status = 'fulfilled', fulfilled_at = now(),
       pinned = FALSE WHERE id = $1`,
      [driveId]
    )
  })

  // Send DM notifications to all pledgers (async, non-blocking)
  await notifyPledgersFulfilled(driveId)
}
```

### What's reused vs. new

The `read_events` → `reading_tabs` → `tab_settlements` → `writer_payouts` pipeline handles all the money. The `article_unlocks` table grants access. The `checkArticleAccess()` function serves the content key. The `key-service` issues NIP-44-wrapped decryption keys. All existing, all untouched. The new code creates the same records the gate-pass already creates — but in batch, triggered by an async job after publication rather than by a reader clicking "unlock."

### Deadline expiry

A scheduled job (cron or similar) checks for drives past their deadline:

```sql
UPDATE pledge_drives
SET status = 'expired', pinned = FALSE, updated_at = now()
WHERE status IN ('open', 'funded')
  AND deadline IS NOT NULL
  AND deadline < now();

UPDATE pledges SET status = 'void'
WHERE drive_id IN (
  SELECT id FROM pledge_drives WHERE status = 'expired'
) AND status = 'active';
```

No financial unwind is needed — pledges were commitments, not charges.

---

## 3. Free passes (author-granted access)

### What it does

An author gives a specific user free access to one of their paywalled articles. No payment, no tab accrual, no `read_event` — just an access grant.

### Implementation

A single new route:

```
POST   /api/v1/articles/:articleId/free-pass   — grant free access to a user
DELETE /api/v1/articles/:articleId/free-pass/:userId — revoke
GET    /api/v1/articles/:articleId/free-passes  — list grants (author view)
```

The route handler is minimal:

```typescript
app.post('/articles/:articleId/free-pass', { preHandler: requireAuth }, async (req, reply) => {
  const writerId = req.session!.sub!
  const { articleId } = req.params
  const { recipientId } = req.body

  // Verify author owns the article
  const article = await pool.query(
    'SELECT id FROM articles WHERE id = $1 AND writer_id = $2',
    [articleId, writerId]
  )
  if (article.rowCount === 0) return reply.status(404).send({ error: 'Not found' })

  // Insert access grant — no read_event, no tab charge
  await pool.query(
    `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
     VALUES ($1, $2, 'author_grant')
     ON CONFLICT (reader_id, article_id) DO NOTHING`,
    [recipientId, articleId]
  )

  // Send DM notification (async)
  notifyFreePass(writerId, recipientId, articleId)

  return reply.status(201).send({ ok: true })
})
```

That's it. No new tables. No `read_event` is created — free passes are not revenue events and must never appear in settlement or payout calculations. `checkArticleAccess()` already checks `article_unlocks` and will find the row. The key service issues the content key. The reader decrypts. The existing `unlocked_via` CHECK constraint on `article_unlocks` needs new values added:

```sql
ALTER TABLE article_unlocks
  DROP CONSTRAINT IF EXISTS article_unlocks_unlocked_via_check,
  ADD CONSTRAINT article_unlocks_unlocked_via_check
    CHECK (unlocked_via IN (
      'purchase', 'subscription', 'free_allowance',
      'author_grant', 'pledge', 'invitation'
    ));
```

### Revenue isolation

Free passes deliberately do not create `read_events`. This means:

- They never enter the `reading_tabs` → `tab_settlements` → `writer_payouts` pipeline.
- They cannot be used to inflate a writer's apparent readership or revenue share.
- The only record is the `article_unlocks` row, which gates access but carries no financial weight.

### DM integration

Granting a free pass sends a DM to the recipient: "Author X has given you free access to 'Article Title'." The DM contains a deep link. This uses the DM infrastructure from feature 1. Without DMs, the recipient would never know they'd been granted access.

---

## 4. Invitation-only articles

### What it does

A user creates a locked article where access is by invitation, not payment. There is no price, no gate-pass path, no tab accrual. The only way in is an `article_unlocks` row inserted by the creator.

### Schema change

The existing `is_paywalled` boolean is replaced with `access_mode` — a single column controlling access semantics, eliminating the risk of two columns diverging:

```sql
-- Migration: Replace is_paywalled with access_mode

ALTER TABLE articles ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public';

UPDATE articles SET access_mode = CASE
  WHEN is_paywalled = TRUE THEN 'paywalled'
  ELSE 'public'
END;

ALTER TABLE articles DROP CONSTRAINT paywalled_has_price;
ALTER TABLE articles ADD CONSTRAINT access_mode_price CHECK (
  (access_mode = 'public') OR
  (access_mode = 'paywalled' AND price_pence IS NOT NULL) OR
  (access_mode = 'invitation_only')
);

ALTER TABLE articles DROP COLUMN is_paywalled;
```

All existing queries referencing `is_paywalled = TRUE` are updated to `access_mode = 'paywalled'`.

### Gate-pass behaviour change

In `gateway/src/routes/articles.ts`, the gate-pass endpoint currently proceeds to the payment flow when `checkArticleAccess()` returns `{ hasAccess: false }`. For invitation-only articles, it returns a distinct error instead:

```typescript
// In the gate-pass handler, after checkArticleAccess returns hasAccess: false:
if (article.access_mode === 'invitation_only') {
  return reply.status(403).send({
    error: 'invitation_required',
    message: 'This is a private article. Contact the author to request access.',
  })
}
```

The frontend renders a different paywall UI state for `invitation_required` — no price, no payment button, just a message and a "Request access" button that opens a DM to the author (feature 1 again).

### Invitation flow

The author uses the same `POST /articles/:articleId/free-pass` route from feature 3. Every access to an invitation-only article is conceptually a "free pass." The DM channel serves as the request/grant flow: reader DMs the author → author grants access → reader gets a notification DM with a deep link.

Like free passes, invitation grants do not create `read_events`. No money changes hands, no revenue is attributed.

### Vault encryption

Invitation-only articles still encrypt their content via the vault service. The content is locked behind a key just like paywalled articles — the only difference is that the key is issued based on an `article_unlocks` row with `unlocked_via = 'invitation'` rather than a `read_event`. The key service's `issueKey()` in `key-service/src/services/vault.ts` already checks `article_unlocks` before `verifyPayment`, so this works without any key-service changes.

---

## The publication event as central orchestrator

Today, `POST /articles` just indexes the article in the DB. With these features, it becomes the trigger for a cascade. Here is the expanded flow:

```
Author hits "Publish"
│
├─ 1. Index article in DB (existing)
│
├─ 2. Create vault + encrypt paywalled body (existing)
│
├─ 3. Check for linked pledge drive (NEW)
│     └─ If found: mark drive as 'published', queue async fulfilment job
│        └─ Fulfilment job (async):
│           ├─ For each pledge: create read_event + article_unlocks + update reading_tabs
│           ├─ Mark drive as 'fulfilled', auto-unpin
│           └─ Send DM notifications to pledgers
│
├─ 4. Apply pre-specified free passes (NEW)
│     └─ If author tagged specific users on the draft:
│        insert article_unlocks rows + send DM notifications
│        (no read_events — free passes carry no financial weight)
│
├─ 5. Publish NIP-23 event to relay (existing)
│
└─ 6. Publish kind 5 for replaced events (existing, for edits)
```

Steps 1–2 and 4–6 run in the publish request. Step 3 marks the drive as published synchronously but defers the expensive per-pledge processing to an async job, keeping the publish response fast regardless of how many pledgers exist.

---

## Modification map

### Tables: new

| Table | Purpose |
|---|---|
| `conversations` | Multi-party DM threads |
| `conversation_members` | Membership join table for conversations |
| `direct_messages` | E2E encrypted message content (NIP-44 to recipient) |
| `dm_pricing` | Per-user DM pricing rules (anti-spam) |
| `pledge_drives` | Crowdfund and commission drives (first-class feed items) |
| `pledges` | Reader pledges against drives |

### Tables: modified

| Table | Change |
|---|---|
| `article_unlocks` | Expand `unlocked_via` CHECK to include `'author_grant'`, `'pledge'`, `'invitation'` |
| `articles` | Replace `is_paywalled` boolean with `access_mode` column (`'public' \| 'paywalled' \| 'invitation_only'`), amend price constraint |
| `notifications` | Add types: `'new_message'`, `'pledge_fulfilled'`, `'commission_request'`, `'free_pass_granted'`, `'drive_funded'` |

### Tables: untouched

| Table | Why |
|---|---|
| `read_events` | Pledge fulfilment creates read_events with the same schema — no changes. Free passes and invitations deliberately do not create read_events. |
| `reading_tabs` | Pledge fulfilment debits tabs via the same UPDATE |
| `tab_settlements` | Existing pipeline charges cards at threshold — works for pledge-originated reads |
| `writer_payouts` | Existing pipeline pays writers — works for pledge-originated reads |
| `vault_keys` | Key issuance unchanged — access is gated by `article_unlocks`, not payment method |
| `content_key_issuances` | Unchanged — logs issuance regardless of how access was granted |

### Services: modified

| File | Change |
|---|---|
| `gateway/src/services/access.ts` | `checkArticleAccess()` already checks `article_unlocks` — no changes needed. The new `unlocked_via` values are transparent to it. |
| `gateway/src/routes/articles.ts` | Add drive-fulfilment trigger to `POST /articles`. Add `invitation_required` response to gate-pass. Update `is_paywalled` references to `access_mode`. |
| `gateway/src/index.ts` | Register new route modules: `messageRoutes`, `driveRoutes`, `freePassRoutes`. |
| `gateway/src/lib/nostr-publisher.ts` | Add pledge drive event kind publishing and kind 5 deletion for cancelled drives. |

### Services: untouched

| File | Why |
|---|---|
| `payment-service/*` | Pledge fulfilment creates standard `read_events` with `state: 'accrued'` — the settlement and payout services process them identically |
| `key-service/*` | `issueKey()` already checks `article_unlocks` before `verifyPayment` — new unlock types are transparent |
| `key-custody/*` | Used for NIP-44 encryption in DMs — existing signing/encryption endpoints suffice |

---

## Build order

The features have natural dependencies that suggest a build sequence:

1. **`article_unlocks` expansion + `access_mode` migration** — Add the new `unlocked_via` values and replace `is_paywalled` with `access_mode`. Schema migration with targeted code updates (grep for `is_paywalled`). Unblocks everything else.

2. **Free passes** — The simplest feature. One route, no new tables, no `read_events`, immediate value. Validates that the `article_unlocks`-as-primitive approach works end to end.

3. **Invitation-only articles** — Builds on free passes. Uses `access_mode = 'invitation_only'`, amends the gate-pass endpoint, adds a new frontend state. Small diff.

4. **Direct messages** — New tables, new routes, NIP-17 integration, E2E encryption, multi-party conversations. Standalone value, but also unblocks the social substrate for pledge drives and commission negotiation. DM pricing (anti-spam) can be a fast-follow within this step.

5. **Pledge drives** — New tables (`pledge_drives`, `pledges`), new routes, Nostr event publishing, the publication trigger, async fulfilment job, profile pinning, deadline expiry cron. The most complex feature, but by this point all the primitives it depends on are in place.

6. **Commissions as pledge drives** — Incremental on top of pledge drives. Different creation flow (reader-initiated, target writer specified), acceptance/decline step, DM negotiation, public visibility of commission requests. Thin routes over the same data model.
