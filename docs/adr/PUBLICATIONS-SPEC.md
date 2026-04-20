# Publications — Implementation Specification

## Overview

Publications are federated groups of writers who publish under a shared identity, subscription paywall, and editorial structure. A Publication has its own Nostr keypair, its own URL surface, its own visual identity, and its own revenue pool. It is the multi-writer counterpart to the existing individual writer model.

The founding principle: **the Publication is the publisher.** The Editor-in-Chief has final editorial authority over everything published under the Publication's name. Contributors retain their personal accounts and can publish independently, but content submitted to the Publication enters its editorial pipeline.

---

## 1. Data Model

### 1.1 `publications` table

The Publication is a first-class entity, separate from `accounts`. It has its own identity, its own Nostr keypair, and an optional Stripe Connect account.

```sql
CREATE TABLE publications (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  slug                        TEXT NOT NULL UNIQUE,        -- URL handle: /pub/<slug>
  name                        TEXT NOT NULL,
  tagline                     TEXT,
  about                       TEXT,                        -- long-form about/mission
  logo_blossom_url            TEXT,
  cover_blossom_url           TEXT,

  -- Nostr identity (custodial, same pattern as accounts)
  nostr_pubkey                TEXT NOT NULL UNIQUE,
  nostr_privkey_enc           TEXT NOT NULL,               -- AES-256-GCM encrypted

  -- Reader-facing pricing (the rate card)
  subscription_price_pence    INTEGER NOT NULL DEFAULT 800,
  annual_discount_pct         INTEGER NOT NULL DEFAULT 15,
  default_article_price_pence INTEGER NOT NULL DEFAULT 20, -- default for new articles

  -- Custom domain (Phase 4 — deferred, columns present for forward-compat)
  custom_domain               TEXT UNIQUE,                 -- e.g. 'thedrift.com'
  custom_domain_verified      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Theming (Phase 4 — deferred, column present for forward-compat)
  theme_config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_css                  TEXT,                        -- raw CSS, scoped at render

  -- Stripe (optional — only needed for flat-fee commissions)
  stripe_connect_id           TEXT UNIQUE,
  stripe_connect_kyc_complete BOOLEAN NOT NULL DEFAULT FALSE,

  -- Status
  status                      TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'suspended', 'archived')),

  founded_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_publications_slug ON publications (slug);
CREATE INDEX idx_publications_custom_domain ON publications (custom_domain)
  WHERE custom_domain IS NOT NULL;
CREATE INDEX idx_publications_nostr_pubkey ON publications (nostr_pubkey);
CREATE INDEX idx_publications_name_trgm ON publications USING gin (name gin_trgm_ops);
```

**`theme_config` JSONB structure** (defaults shown — Phase 4 work, stored now for forward-compat):

```json
{
  "accentColor": "#1a1a1a",
  "backgroundColor": "#ffffff",
  "fontHeading": "system",
  "fontBody": "system",
  "headingWeight": 700,
  "layout": "blog",
  "showMasthead": true,
  "showTableOfContents": false,
  "heroStyle": "cover"
}
```

`layout` values: `"blog"` (single-column reverse-chron), `"magazine"` (grid with featured slots), `"minimal"` (text-forward, no images).

**Stripe Connect model:** Stripe Connect on a Publication is optional. Revenue-share payouts from reads go directly from the platform to each member's personal Stripe Connect account — the platform already holds each writer's Connect ID. The only case that requires a Publication-level Connect account is flat-fee commissions, where the EiC wants to fund a one-off payment from a business account rather than platform revenue. If a flat fee is configured but the Publication has no Connect account, the payroll UI flags it as "pending — set up publication billing."

### 1.2 `publication_members` table

The join between users and Publications. Permissions are explicit boolean columns, not a bitmask, because they map directly to UI switches.

```sql
CREATE TYPE publication_role AS ENUM (
  'editor_in_chief',
  'editor',
  'contributor'
);

CREATE TYPE contributor_type AS ENUM (
  'permanent',
  'one_off'
);

CREATE TABLE publication_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id        UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role                  publication_role NOT NULL,
  contributor_type      contributor_type NOT NULL DEFAULT 'permanent',
  title                 TEXT,               -- display title, e.g. "Poetry Editor"
  is_owner              BOOLEAN NOT NULL DEFAULT FALSE,

  -- Payroll
  revenue_share_bps     INTEGER,            -- standing share in basis points; NULL for one-off

  -- Granular permissions
  can_publish           BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_others       BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_members    BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_finances   BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_settings   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Lifecycle
  invited_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  removed_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_active_member
    UNIQUE (publication_id, account_id)
);

CREATE INDEX idx_pub_members_publication ON publication_members (publication_id)
  WHERE removed_at IS NULL;
CREATE INDEX idx_pub_members_account ON publication_members (account_id)
  WHERE removed_at IS NULL;
```

**Default permissions by role:**

| Permission             | EiC  | Editor | Contributor |
|------------------------|------|--------|-------------|
| `can_publish`          | yes  | yes    | no          |
| `can_edit_others`      | yes  | yes    | no          |
| `can_manage_members`   | yes  | no     | no          |
| `can_manage_finances`  | yes  | no     | no          |
| `can_manage_settings`  | yes  | no     | no          |

EiCs can override any permission per-member.

**Ownership model:** Exactly one member per Publication holds `is_owner = TRUE`. By default this is the person who created the Publication. The Owner has irremovable EiC powers for as long as they remain Owner — no other member can demote, remove, or alter the Owner's role or permissions. The Owner can take a back seat operationally (letting other EiCs handle day-to-day editorial), but their EiC authority is always available if needed.

Only the Owner can transfer Ownership, and only to another active EiC. The transfer requires re-authentication via a fresh magic link sent to the Owner's email. The transfer is atomic (a single transaction swaps the flag) and irreversible — the UI must make this clear with a confirmation step ("This action cannot be undone. You will permanently lose Owner status.").

The only way the Owner loses EiC powers is by transferring Ownership. If the Owner wants to leave the Publication entirely, they must transfer Ownership first.

**Constraint:** The `is_owner` invariant (exactly one per Publication) is enforced by a partial unique index:

```sql
CREATE UNIQUE INDEX idx_pub_members_one_owner
  ON publication_members (publication_id)
  WHERE is_owner = TRUE AND removed_at IS NULL;
```

### 1.3 `publication_invites` table

```sql
CREATE TABLE publication_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id    UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  invited_by        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_email     TEXT,               -- if inviting by email
  invited_account_id UUID REFERENCES accounts(id), -- if inviting existing user
  role              publication_role NOT NULL DEFAULT 'contributor',
  contributor_type  contributor_type NOT NULL DEFAULT 'permanent',
  token             TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  message           TEXT,               -- personal note from the inviter
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at       TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_invites_token ON publication_invites (token)
  WHERE accepted_at IS NULL AND declined_at IS NULL;
CREATE INDEX idx_pub_invites_email ON publication_invites (invited_email)
  WHERE accepted_at IS NULL AND declined_at IS NULL;
```

**Invite flow:** If the invited person does not have an account, they sign up first (standard flow), then visit the invite link to accept. Signup and acceptance are separate steps — it is valuable for someone to create an account even if they decline the invitation.

### 1.4 `publication_article_shares` table

Per-article revenue overrides. Used for one-off contributors (guest essays) or any piece where the EiC wants to set a custom split rather than using the member's standing `revenue_share_bps`.

```sql
CREATE TABLE publication_article_shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id    UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  article_id        UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  share_type        TEXT NOT NULL CHECK (share_type IN ('revenue_bps', 'flat_fee_pence')),
  share_value       INTEGER NOT NULL,   -- bps if revenue_bps; pence if flat_fee_pence
  paid_out          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, account_id)
);
```

This gives the EiC two options per one-off piece: a revenue share (basis points of that article's net earnings) or a flat fee (paid once, regardless of performance). Both are set on the payroll card.

### 1.5 `publication_follows` table

Readers can follow a Publication the same way they follow a writer. A separate table mirrors `follows` because `follows.followee_id` references `accounts(id)` and cannot point to a publication.

```sql
CREATE TABLE publication_follows (
  follower_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  publication_id  UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  followed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, publication_id)
);

CREATE INDEX idx_pub_follows_publication ON publication_follows (publication_id);
```

Publication articles appear in the reader's Following feed when they follow the publication. The `GET /follows/pubkeys` endpoint includes followed publication pubkeys.

### 1.6 Publication payout tables

Revenue from publication articles is pooled, then distributed to members according to standing shares and per-article overrides. Separate tables keep this cleanly isolated from the existing individual writer payout flow.

```sql
CREATE TABLE publication_payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id      UUID NOT NULL REFERENCES publications(id),
  total_pool_pence    INTEGER NOT NULL,    -- gross reads for this cycle
  platform_fee_pence  INTEGER NOT NULL,    -- 8% platform cut
  flat_fees_paid_pence INTEGER NOT NULL DEFAULT 0,
  remaining_pool_pence INTEGER NOT NULL,   -- after platform fee and flat fees
  status              payout_status NOT NULL DEFAULT 'pending',
  triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_payouts_publication ON publication_payouts (publication_id);
CREATE INDEX idx_pub_payouts_status ON publication_payouts (status);

CREATE TABLE publication_payout_splits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_payout_id UUID NOT NULL REFERENCES publication_payouts(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id),
  share_bps             INTEGER,             -- standing share applied (NULL for flat fees)
  amount_pence          INTEGER NOT NULL,
  share_type            TEXT NOT NULL CHECK (share_type IN ('standing', 'article_revenue', 'flat_fee')),
  article_id            UUID REFERENCES articles(id),  -- set for per-article splits
  stripe_transfer_id    TEXT,
  status                payout_status NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_payout_splits_payout ON publication_payout_splits (publication_payout_id);
CREATE INDEX idx_pub_payout_splits_account ON publication_payout_splits (account_id);
```

### 1.7 Modifications to existing tables

**`articles`** — add `publication_id`, `publication_article_status`, and `show_on_writer_profile`:

```sql
ALTER TABLE articles ADD COLUMN publication_id UUID REFERENCES publications(id);
ALTER TABLE articles ADD COLUMN publication_article_status TEXT
  CHECK (publication_article_status IN ('submitted', 'approved', 'published', 'unpublished'));
ALTER TABLE articles ADD COLUMN show_on_writer_profile BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX idx_articles_publication ON articles (publication_id)
  WHERE publication_id IS NOT NULL;
```

When `publication_id` is set:
- The article is part of the Publication's CMS
- Its paywall is governed by the Publication's rate card
- Its revenue flows to the Publication's payout pool
- It was signed with the Publication's Nostr key
- `writer_id` still records the individual author (for byline)
- `publication_article_status` tracks the editorial pipeline state
- `show_on_writer_profile` controls whether the article also appears on the author's personal profile page (default true; toggled by the author when composing)

When `publication_id` is NULL, these columns are ignored. The `publication_article_status` column is only meaningful for publication articles.

**`article_drafts`** — add `publication_id`:

```sql
ALTER TABLE article_drafts ADD COLUMN publication_id UUID REFERENCES publications(id);
```

Set on draft creation when the author is writing in a publication context, so the draft auto-associates on publish.

**`subscriptions`** — add `publication_id`, replace unique constraint:

```sql
ALTER TABLE subscriptions ADD COLUMN publication_id UUID REFERENCES publications(id);
ALTER TABLE subscriptions ALTER COLUMN writer_id DROP NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_reader_id_writer_id_key;

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_target_check
  CHECK (num_nonnulls(writer_id, publication_id) = 1);

CREATE UNIQUE INDEX idx_subscriptions_reader_writer
  ON subscriptions (reader_id, writer_id) WHERE writer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_subscriptions_reader_publication
  ON subscriptions (reader_id, publication_id) WHERE publication_id IS NOT NULL;
```

Note: a reader's subscription to an individual writer does **not** grant access to that writer's Publication content, and vice versa. The subscription targets are distinct.

**`subscription_nudge_log`** — add nullable `publication_id`:

```sql
ALTER TABLE subscription_nudge_log ADD COLUMN publication_id UUID REFERENCES publications(id);
```

**`feed_scores`** — add nullable `publication_id`:

```sql
ALTER TABLE feed_scores ADD COLUMN publication_id UUID REFERENCES publications(id);
CREATE INDEX idx_feed_scores_publication ON feed_scores (publication_id, score DESC)
  WHERE publication_id IS NOT NULL;
```

**`platform_config`** — add publication payout threshold:

```sql
INSERT INTO platform_config (key, value, description) VALUES
  ('publication_payout_threshold_pence', '2000', 'Publication payout threshold (£20.00)');
```

All of the above is delivered as migration `038_publications.sql`. No existing data is modified. All new columns are nullable (or have defaults that don't affect existing rows). The migration is fully backwards-compatible.

---

## 2. Access Control

### 2.1 Extended `checkArticleAccess`

**File:** `gateway/src/services/access.ts`

The access checker gains new branches. When an article belongs to a Publication, subscription access is checked against the Publication, not the individual writer. Publication members get free access to their own Publication's content.

```typescript
export async function checkArticleAccess(
  readerId: string,
  articleId: string,
  writerId: string,
  publicationId?: string | null,
): Promise<AccessCheckResult> {

  // 1. Own content — always free
  if (readerId === writerId) {
    return { hasAccess: true, reason: 'own_content' }
  }

  // 2. Publication member — members read their own Publication's content free
  if (publicationId) {
    const memberResult = await pool.query<{ id: string }>(
      `SELECT id FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, readerId]
    )
    if (memberResult.rows.length > 0) {
      return { hasAccess: true, reason: 'own_content' }
    }
  }

  // 3. Permanent unlock
  const unlockResult = await pool.query<{ id: string }>(
    `SELECT id FROM article_unlocks
     WHERE reader_id = $1 AND article_id = $2`,
    [readerId, articleId]
  )
  if (unlockResult.rows.length > 0) {
    return { hasAccess: true, reason: 'already_unlocked' }
  }

  // 4. Subscription — check Publication or individual writer
  if (publicationId) {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND publication_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, publicationId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  } else {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND writer_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, writerId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  }

  return { hasAccess: false }
}
```

All callers in `gateway/src/routes/articles/gate-pass.ts` pass through the article's `publication_id`.

### 2.2 Publication permission middleware

**New file:** `gateway/src/middleware/publication-auth.ts`

```typescript
export function requirePublicationPermission(...requiredPermissions: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session?.sub
    const publicationId = (req.params as any).publicationId || (req.params as any).id

    if (!userId || !publicationId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { rows } = await pool.query<PublicationMember>(
      `SELECT * FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, userId]
    )

    if (rows.length === 0) {
      return reply.status(403).send({ error: 'Not a member of this publication' })
    }

    const member = rows[0]

    for (const perm of requiredPermissions) {
      if (!(member as any)[perm]) {
        return reply.status(403).send({
          error: `Missing permission: ${perm}`
        })
      }
    }

    req.publicationMember = member
  }
}

export function requirePublicationOwner() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Same as above, but also checks is_owner = TRUE
  }
}
```

---

## 3. Nostr Integration

### 3.1 Signing model

Articles published under a Publication are signed with the **Publication's custodial Nostr keypair**. The individual author is referenced via a `p` tag with the `author` marker:

```json
{
  "kind": 30023,
  "pubkey": "<publication_nostr_pubkey>",
  "tags": [
    ["d", "<d-tag>"],
    ["title", "The Future of Independent Publishing"],
    ["p", "<author_nostr_pubkey>", "", "author"],
    ["p", "<publication_nostr_pubkey>", "", "publisher"]
  ],
  "content": "...",
  "sig": "<signed_with_publication_key>"
}
```

This convention means:
- The Publication owns the event on the Nostr network
- Other relays index it under the Publication's pubkey
- Clients that understand the `author` marker can show the byline correctly
- Clients that don't will show the Publication as the author (acceptable degradation)
- The article federates cleanly if the Publication migrates off all.haus

### 3.2 Key-custody changes

The key-custody service handles Publication keypairs using a `signerType`/`signerId` parameter pattern. The encrypted private key is stored in `publications.nostr_privkey_enc` in the same AES-256-GCM format used for accounts.

**File:** `key-custody/src/lib/crypto.ts`

The `getDecryptedPrivkey` function gains a `signerType` parameter:

```typescript
async function getDecryptedPrivkey(
  signerId: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<Buffer> {
  const table = signerType === 'publication' ? 'publications' : 'accounts'
  const { rows } = await pool.query<{ nostr_privkey_enc: string | null }>(
    `SELECT nostr_privkey_enc FROM ${table} WHERE id = $1`,
    [signerId]
  )
  if (rows.length === 0) throw new Error(`${signerType} not found: ${signerId}`)
  const enc = rows[0].nostr_privkey_enc
  if (!enc) throw new Error(`${signerType} ${signerId} has no custodial keypair`)
  return decryptPrivkey(enc)
}
```

All callers (`signEvent`, `unwrapKey`, `nip44Encrypt`, `nip44Decrypt`) pass through the new params.

**File:** `key-custody/src/routes/keypairs.ts`

The `SignEventSchema` gains optional `signerType`/`signerId` fields (with `accountId` as backwards-compat alias):

```typescript
const SignEventSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: z.enum(['account', 'publication']).default('account'),
  accountId: z.string().uuid().optional(),  // backwards compat
  event: z.object({ ... }),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })
```

**File:** `gateway/src/lib/key-custody-client.ts`

```typescript
export async function signEvent(
  signerId: string,
  eventTemplate: EventTemplate,
  signerType: 'account' | 'publication' = 'account'
): Promise<...> {
  return post('/api/v1/keypairs/sign', { signerId, signerType, event: eventTemplate })
}
```

All existing callers pass `accountId` as `signerId` with default `signerType='account'` — no breakage.

### 3.3 Vault keys for Publication articles

Vault keys for Publication articles are created the same way as individual articles, but associated with the Publication's Nostr pubkey. The `vault_keys` table already references `article_id`, so no schema change is needed. The key issuance flow just needs to accept that the "writer" pubkey for NIP-44 wrapping may be a Publication pubkey.

### 3.4 Signing route changes

**File:** `gateway/src/routes/signing.ts`

`POST /sign` and `POST /sign-and-publish` accept an optional `publicationId` in the request body. When present:

1. Verify the caller is an active member with `can_publish` for that publication
2. Call `signEvent(publicationId, eventTemplate, 'publication')` instead of the user's account

This enables both the server-side publishing pipeline and any future need for the frontend to sign arbitrary events as a publication.

---

## 4. Revenue: Rate Card and Payroll

### 4.1 Rate card (reader-facing)

The Publication's rate card is a settings screen accessible only to members with `can_manage_finances`. It controls:

- `subscription_price_pence` — the monthly subscription price
- `annual_discount_pct` — annual subscription discount
- `default_article_price_pence` — default per-article gate price for new articles

Individual articles can still have custom prices set by the author or an editor, overriding the default.

### 4.2 Payroll card (contributor-facing)

The payroll card is accessible only to members with `can_manage_finances`. It shows:

**Standing members** (permanent contributors):
- Each member's `revenue_share_bps`
- The total of all standing shares (must not exceed 10,000 bps = 100%)
- A visual bar showing the split

**Per-article overrides** (one-off contributors and special cases):
- Article title, author, share type (revenue % or flat fee), value
- Whether the flat fee has been paid out

### 4.3 Payout flow

The existing payout worker in `payment-service/src/workers/payout.ts` calls a new `runPublicationPayoutCycle()` method after the existing individual-writer payout cycle. The two codepaths are independent.

Publication payout logic in `payment-service/src/services/payout.ts`:

1. **Identify eligible Publications:** Sum all `platform_settled` read events for articles where `publication_id IS NOT NULL`, grouped by `publication_id`. Filter to those exceeding the payout threshold.

2. **Compute the pool:** For each Publication, total net earnings = gross reads minus platform fee (8%).

3. **Handle per-article overrides first:**
   - For articles with rows in `publication_article_shares`:
     - If `share_type = 'flat_fee_pence'` and not yet `paid_out`: deduct the flat fee from the pool and pay the contributor. Mark as paid. Record in `publication_payout_splits` with `share_type = 'flat_fee'`.
     - If `share_type = 'revenue_bps'`: compute the article's net earnings, apply the contributor's bps, deduct from the pool. Record in `publication_payout_splits` with `share_type = 'article_revenue'`.

4. **Distribute the remaining pool by standing shares:**
   - For each active member with `revenue_share_bps > 0`: `member_payout = remaining_pool * (member.revenue_share_bps / total_standing_bps)`
   - Record in `publication_payout_splits` with `share_type = 'standing'`.

5. **Initiate Stripe transfers:** For each member with a payout amount > 0, initiate a Stripe Connect transfer to the member's personal `stripe_connect_id` (from the `accounts` table). Members without Stripe KYC: their split is recorded with `status = 'pending'` until verification completes.

6. **Remainder handling:** If standing shares don't sum to 10,000 bps, the remainder is retained in the pool (not transferred). It effectively stays with the platform until the EiC allocates more standing shares.

7. **Create `publication_payouts` row** linking all splits. Mark `read_events` as `writer_paid`.

---

## 5. Reader-Facing Surface

### 5.1 URL structure

Publications live at path-based routes for now. Subdomain routing (`<slug>.all.haus`) and custom domains are deferred to Phase 4 (see feature-debt.md).

| Route                              | Description                           |
|------------------------------------|---------------------------------------|
| `/pub/<slug>`                      | Publication homepage                  |
| `/pub/<slug>/<article-slug>`       | Article page                          |
| `/pub/<slug>/about`                | About / mission page                  |
| `/pub/<slug>/masthead`             | Team listing with roles               |
| `/pub/<slug>/subscribe`            | Subscription CTA page                 |
| `/pub/<slug>/archive`              | Full article archive                  |

RSS is served by the gateway at `/api/v1/pub/<slug>/rss`.

### 5.2 Publication homepage layouts

Three built-in layout modes, selectable in `theme_config.layout`:

**`blog`** — Single-column reverse-chronological list. Each article shows title, byline, date, summary. This is the default and the simplest.

**`magazine`** — CSS Grid with a featured slot (latest or pinned article as a hero card) and a grid of smaller cards below. Good for Publications with regular output and visual content.

**`minimal`** — Text-only. Article titles as a list, no images, no cards. For literary journals, academic publications, or anyone who wants the content to do the talking.

All three share the same data source; the layout is purely a CSS/component concern.

### 5.3 Theming (Phase 4 — deferred)

The Publication's theme is applied via CSS custom properties injected by the layout wrapper. The `theme_config` JSONB column stores the values and the `custom_css` column stores raw CSS that is scoped at render time. The theme settings UI, custom CSS editor, and CSS sanitiser (`scopeCSS`) are deferred to Phase 4.

For the initial implementation, publication pages use the platform's default design tokens with the publication's accent colour applied if set.

### 5.4 all.haus branding on publication pages

Limited to:
- A small "Published on all.haus" text link in the footer
- The all.haus favicon IS used (Phase 4 will replace it with the Publication's logo)
- No all.haus header/nav on Publication pages

---

## 6. Gateway API Routes

### 6.1 Publication management

All in `gateway/src/routes/publications/` (concern-split directory).

```
POST   /api/v1/publications                        — Create (creator becomes Owner + EiC)
GET    /api/v1/publications/:slug                   — Public profile
PATCH  /api/v1/publications/:id                     — Update settings (requires can_manage_settings)
DELETE /api/v1/publications/:id                     — Archive (Owner only)

GET    /api/v1/publications/:id/members             — List members (public: name/role; member: + permissions/shares)
POST   /api/v1/publications/:id/members/invite      — Invite (requires can_manage_members)
POST   /api/v1/publications/:id/members/accept      — Accept invite (token-based)
PATCH  /api/v1/publications/:id/members/:memberId   — Update role/permissions/share (requires can_manage_members)
DELETE /api/v1/publications/:id/members/:memberId   — Remove member (requires can_manage_members)
POST   /api/v1/publications/:id/transfer-ownership  — Transfer Owner (Owner only, magic link re-auth)

GET    /api/v1/publications/invites/:token          — Public invite info (for acceptance page)
GET    /api/v1/my/publications                      — List caller's publication memberships
```

### 6.2 Publication CMS

```
GET    /api/v1/publications/:id/articles                         — CMS article list (filtered by status)
POST   /api/v1/publications/:id/articles                         — Submit/publish (server-side pipeline)
PATCH  /api/v1/publications/:id/articles/:articleId              — Edit article
DELETE /api/v1/publications/:id/articles/:articleId              — Soft-delete
POST   /api/v1/publications/:id/articles/:articleId/publish      — Approve + publish submitted draft
POST   /api/v1/publications/:id/articles/:articleId/unpublish    — Pull published article
```

The `POST /publications/:id/articles` endpoint is the **server-side publishing pipeline**. It accepts article content and metadata, and the gateway orchestrates the entire flow: sign with the Publication's key (via key-custody), publish to the relay, index in the database, and encrypt the vault if paywalled. This is necessary because:

1. Contributors without `can_publish` need their articles saved as "submitted" without any Nostr event being created — only when an editor approves does signing/publishing happen.
2. The frontend should not need to know about publication key management.
3. Permission checks are authoritative when done server-side.

If the caller has `can_publish`: full pipeline executes, status is set to `published`.
If the caller lacks `can_publish`: article is saved with `publication_article_status = 'submitted'`, `published_at = NULL`. Editors are notified.

### 6.3 Rate card and payroll

```
GET    /api/v1/publications/:id/rate-card                       — View pricing (requires can_manage_finances)
PATCH  /api/v1/publications/:id/rate-card                       — Update pricing
GET    /api/v1/publications/:id/payroll                         — View payroll card
PATCH  /api/v1/publications/:id/payroll                         — Update standing shares
PATCH  /api/v1/publications/:id/payroll/article/:articleId      — Set per-article override
GET    /api/v1/publications/:id/earnings                        — Earnings dashboard
```

### 6.4 Reader-facing

```
GET    /api/v1/publications/:slug/public            — Full public profile (for homepage)
GET    /api/v1/publications/:slug/articles           — Published articles (paginated)
GET    /api/v1/publications/:slug/masthead           — Public member list with roles/titles
POST   /api/v1/subscriptions/publication/:id         — Subscribe to publication
DELETE /api/v1/subscriptions/publication/:id         — Cancel publication subscription
POST   /api/v1/follows/publication/:id               — Follow publication
DELETE /api/v1/follows/publication/:id               — Unfollow publication
GET    /api/v1/pub/:slug/rss                         — RSS feed
```

---

## 7. Frontend

### 7.1 Editor — publication selector

**File:** `web/src/components/editor/ArticleEditor.tsx`

The existing editor gains a **"Publishing as" dropdown** above the title field. It appears when the logged-in user is a member of one or more Publications:

```
Publishing as: [Your name v]
              ├─ Yourself
              ├─ The Drift
              └─ Another Publication
```

Selecting a Publication means:
- The article will be signed with the Publication's key (server-side)
- It will be indexed with the Publication's `publication_id`
- The price defaults to the Publication's `default_article_price_pence`
- If the member doesn't have `can_publish`, the submit button reads "Submit for review" and the article is saved as `submitted`

When a Publication is selected and the user is the original composer, a **"Also show on your personal profile"** checkbox appears (default checked). This sets `show_on_writer_profile` on the article.

If the user arrives via `/write?pub=<slug>`, the dropdown is pre-selected to that publication.

**File:** `web/src/app/write/page.tsx`

Reads `?pub=<slug>` query param. Fetches `publications.myMemberships()` on mount. Passes publication data to `ArticleEditor`.

**File:** `web/src/lib/publish.ts`

Existing `publishArticle()` is unchanged for personal articles. A new `publishToPublication()` function POSTs to the gateway's server-side pipeline:

```typescript
export async function publishToPublication(
  publicationId: string,
  data: PublishData & { showOnWriterProfile: boolean }
): Promise<{ articleId: string; status: string }> {
  return publications.submitArticle(publicationId, { ... })
}
```

### 7.2 Dashboard — context switcher

**File:** `web/src/app/dashboard/page.tsx`

The existing dashboard gains a **context switcher** in the header:

```
Dashboard: Personal | The Drift | Another Publication
```

When "Personal" is selected: existing tabs render (Articles, Drafts, Drives, Offers, Pricing).

When a Publication is selected: tabs swap to Publication-specific tabs:
- **Articles** — all articles in the CMS, filterable by status. EiC/editors see all; contributors see own. Action buttons for Publish/Unpublish/Edit/Delete.
- **Members** — invite, manage roles, permissions, titles, revenue shares. EiC-only for management; read-only for others.
- **Rate card** — subscription and per-article pricing. Requires `can_manage_finances`.
- **Payroll** — standing shares and per-article overrides with visual split bar. Requires `can_manage_finances`.
- **Earnings** — revenue dashboard. Requires `can_manage_finances`.
- **Settings** — name, tagline, about, logo, cover. Theme and domain placeholders. Requires `can_manage_settings`.

The "New article" button links to `/write?pub=<slug>` in publication context.

URL format: `/dashboard?context=<pub-slug>&tab=<tab>`.

**New files:**
- `web/src/components/dashboard/PublicationArticlesTab.tsx`
- `web/src/components/dashboard/MembersTab.tsx`
- `web/src/components/dashboard/PublicationSettingsTab.tsx`
- `web/src/components/dashboard/RateCardTab.tsx`
- `web/src/components/dashboard/PayrollTab.tsx`
- `web/src/components/dashboard/PublicationEarningsTab.tsx`

### 7.3 Invite acceptance page

**New file:** `web/src/app/invite/[token]/page.tsx`

Route: `/invite/<token>`

1. Fetches invite details via `GET /publications/invites/:token`
2. Shows: publication name, inviter name, role offered, personal message
3. If logged in: "Accept" and "Decline" buttons. Accept calls `POST /publications/:id/members/accept`.
4. If not logged in: "Sign up to accept this invitation" with link to `/auth?mode=signup&redirect=/invite/<token>`
5. On accept, redirect to `/dashboard?context=<pub-slug>`

### 7.4 Publication reader pages

**New files:**
- `web/src/app/pub/[slug]/layout.tsx` — publication shell with nav and footer
- `web/src/app/pub/[slug]/page.tsx` — homepage with layout mode rendering
- `web/src/app/pub/[slug]/about/page.tsx` — about/mission page
- `web/src/app/pub/[slug]/masthead/page.tsx` — team listing
- `web/src/app/pub/[slug]/subscribe/page.tsx` — subscription CTA
- `web/src/app/pub/[slug]/archive/page.tsx` — full article archive
- `web/src/app/pub/[slug]/[articleSlug]/page.tsx` — article under publication branding

**Shared components:**
- `web/src/components/publication/PublicationNav.tsx` — logo, name, nav links, subscribe CTA
- `web/src/components/publication/PublicationFooter.tsx` — "Published on all.haus" link
- `web/src/components/publication/HomepageBlog.tsx`
- `web/src/components/publication/HomepageMagazine.tsx`
- `web/src/components/publication/HomepageMinimal.tsx`

The layout wrapper applies CSS custom properties from `theme_config` when values are set. Publication pages do not show the all.haus header/nav.

### 7.5 Article page — publication awareness

**File:** `web/src/app/article/[dTag]/page.tsx`

When an article has a `publicationId`:
- Byline shows: "By Author Name **in Publication Name**" (linked to `/pub/<slug>`)
- Subscribe CTA offers publication subscription, not writer subscription
- Paywall gate-pass uses publication subscription access check

### 7.6 Writer profile — publication article filtering

**File:** `gateway/src/routes/writers.ts`

The `GET /writers/:username/articles` query gains a filter:

```sql
AND (publication_id IS NULL OR show_on_writer_profile = TRUE)
```

Publication articles only appear on the writer's personal profile when the author opted in via the "Also show on your personal profile" checkbox.

### 7.7 API client

**File:** `web/src/lib/api.ts`

New `publications` namespace covering all endpoints from §6.1–6.4, plus:

```typescript
export const publications = {
  // Management
  create, get, update, archive,
  // Members
  getMembers, invite, acceptInvite, updateMember, removeMember,
  transferOwnership,
  // CMS
  listArticles, submitArticle, publishArticle, unpublishArticle,
  // Reader-facing
  getPublic, getPublicArticles, getMasthead,
  // Follows
  follow, unfollow,
  // Revenue
  getRateCard, updateRateCard, getPayroll, updatePayroll,
  setArticleShare, getEarnings,
  // Personal
  myMemberships,
}
```

---

## 8. Feed and Search Integration

### 8.1 Feed

**File:** `gateway/src/routes/feed.ts`

The "following" feed includes articles from followed publications. The query joins `publication_follows` alongside `follows` to gather content from both followed writers and followed publications.

The "explore" feed includes publication articles via `feed_scores` with `publication_id IS NOT NULL`.

**File:** `gateway/src/workers/feed-scorer.ts`

The feed scoring worker populates `feed_scores.publication_id` for publication articles.

### 8.2 Search

**File:** `gateway/src/routes/search.ts`

Publications are searchable by name and tagline. The search endpoint returns both writers and Publications with a `type` discriminator:

```json
{
  "writers": [...],
  "publications": [
    { "type": "publication", "slug": "the-drift", "name": "The Drift", ... }
  ]
}
```

---

## 9. Notifications

New notification types, using the existing `notifications` table (`type` is TEXT, no enum migration needed):

| Event | Recipients | Type |
|-------|-----------|------|
| Article submitted for review | Members with `can_publish` | `pub_article_submitted` |
| Article published (for author) | Article author | `pub_article_published` |
| New publication subscriber | Members with `can_manage_finances` | `pub_new_subscriber` |
| Payout completed | Member who received payout | `pub_payout_completed` |
| Member joined | Members with `can_manage_members` | `pub_member_joined` |
| Member left/removed | Members with `can_manage_members` | `pub_member_left` |
| Invite received | Invited account (if existing user) | `pub_invite_received` |

---

## 10. Implementation Order

### Phase 1 — Schema and core model

| Step | Description | Files |
|------|-------------|-------|
| 1.1 | Migration 038 | `migrations/038_publications.sql` |
| 1.2 | Key-custody signerType | `key-custody/src/lib/crypto.ts`, `key-custody/src/routes/keypairs.ts` |
| 1.3 | Gateway key-custody client | `gateway/src/lib/key-custody-client.ts` |
| 1.4 | Publication auth middleware | `gateway/src/middleware/publication-auth.ts` |
| 1.5 | Publication CRUD routes | `gateway/src/routes/publications/core.ts`, `gateway/src/index.ts` |
| 1.6 | Member management routes | `gateway/src/routes/publications/members.ts` |
| 1.7 | `checkArticleAccess` extension | `gateway/src/services/access.ts` |
| 1.8 | API client publications namespace | `web/src/lib/api.ts` |

### Phase 2 — CMS and publishing

| Step | Description | Files |
|------|-------------|-------|
| 2.1 | Publication article gateway routes + server-side publisher | `gateway/src/routes/publications/cms.ts`, `gateway/src/services/publication-publisher.ts` |
| 2.2 | Signing route publication support | `gateway/src/routes/signing.ts` |
| 2.3 | Draft publication association | `gateway/src/routes/drafts.ts` |
| 2.4 | Editor publication selector + cross-post checkbox | `web/src/components/editor/ArticleEditor.tsx`, `web/src/app/write/page.tsx`, `web/src/lib/publish.ts` |
| 2.5 | Dashboard context switcher + publication tabs | `web/src/app/dashboard/page.tsx`, `web/src/components/dashboard/PublicationArticlesTab.tsx`, `MembersTab.tsx`, `PublicationSettingsTab.tsx` |
| 2.6 | Invite acceptance page | `web/src/app/invite/[token]/page.tsx` |

### Phase 3 — Reader surface

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | Public publication gateway routes | `gateway/src/routes/publications/public.ts` |
| 3.2 | Publication subscription routes | `gateway/src/routes/subscriptions/publication.ts` |
| 3.3 | Publication follows routes | `gateway/src/routes/follows.ts` |
| 3.4 | Publication RSS | `gateway/src/routes/rss.ts` |
| 3.5 | Search extension | `gateway/src/routes/search.ts` |
| 3.6 | Feed integration | `gateway/src/routes/feed.ts`, `gateway/src/workers/feed-scorer.ts` |
| 3.7 | Publication pages (layout, homepage, about, masthead, subscribe, archive, article) | `web/src/app/pub/[slug]/...`, `web/src/components/publication/...` |
| 3.8 | Article page publication awareness | `web/src/app/article/[dTag]/page.tsx`, `gateway/src/routes/articles/gate-pass.ts` |
| 3.9 | Writer profile publication filtering | `gateway/src/routes/writers.ts` |

### Phase 4 — Theming and custom domains (DEFERRED)

Tracked in `feature-debt.md`. Requires:
- Wildcard subdomain routing (nginx `*.all.haus` + Next.js middleware)
- Custom domain DNS TXT verification flow + TLS provisioning
- Theme settings UI (colour picker, font selector, layout mode)
- Custom CSS editor with live preview + server-side sanitiser (`scopeCSS`)
- Per-publication favicon from logo

### Phase 5 — Revenue

| Step | Description | Files |
|------|-------------|-------|
| 5.1 | Rate card routes | `gateway/src/routes/publications/revenue.ts` |
| 5.2 | Payroll routes | `gateway/src/routes/publications/revenue.ts` |
| 5.3 | Publication payout worker | `payment-service/src/services/payout.ts`, `payment-service/src/workers/payout.ts` |
| 5.4 | Earnings routes | `gateway/src/routes/publications/revenue.ts` |
| 5.5 | Revenue UI tabs | `web/src/components/dashboard/RateCardTab.tsx`, `PayrollTab.tsx`, `PublicationEarningsTab.tsx` |

---

## 11. Open Design Notes

**Subscription nudge for Publications:** The threshold-triggered subscription offer works per-reader-per-publication. Track cumulative per-read spend across all articles in the Publication. When it approaches the subscription price, offer the conversion. Same UX as the individual nudge, but branded as the Publication.

**Moderation:** Publication-level moderation reports target the Publication's `nostr_pubkey` or `publication_id`. The platform moderation team can suspend a Publication the same way they suspend an account (set `status = 'suspended'`).

**Subdomain migration path:** When Phase 4 delivers subdomain routing, existing `/pub/<slug>` URLs will continue to work alongside `<slug>.all.haus`. The Next.js middleware rewrites subdomain requests to the same `/pub/[slug]` route group, so the page components are shared.

**Custom domain migration path:** Custom domains require nginx wildcard TLS (lua-resty-auto-ssl or Caddy) and a `X-Custom-Domain` header. The gateway provides a domain verification endpoint. The Next.js middleware resolves domain → slug via a gateway lookup or cached mapping.
