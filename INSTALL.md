# Phase 3: Subscriptions — Install Guide

## Files in this patch

New files (just extract):
- `migrations/005_subscriptions.sql`
- `gateway/src/routes/subscriptions.ts`
- `gateway/src/services/access.ts`
- `web/src/app/[username]/page.tsx` (replaces existing)

## Step 1: Extract the patch

```bash
cd /root/platform-pub
unzip -o /root/platform-pub-round3-subscriptions.zip
```

## Step 2: Run the migration

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -f /dev/stdin < migrations/005_subscriptions.sql
```

## Step 3: Register the subscription routes in the gateway

Edit `gateway/src/index.ts`:

```bash
nano gateway/src/index.ts
```

**Add this import** near the top, after the other route imports:

```typescript
import { subscriptionRoutes } from './routes/subscriptions.js'
```

**Add this registration** after the `searchRoutes` registration (around line 90):

```typescript
  // Subscriptions (subscribe, unsubscribe, check, list, pricing)
  await app.register(subscriptionRoutes, { prefix: '/api/v1' })
```

## Step 4: Add subscription + unlock checks to the gate-pass handler

Edit `gateway/src/routes/articles.ts`:

```bash
nano gateway/src/routes/articles.ts
```

**Add this import** at the top of the file:

```typescript
import { checkArticleAccess, recordSubscriptionRead, recordPurchaseUnlock } from '../services/access.js'
```

**Find this line** (around line 269, inside the gate-pass handler):

```typescript
        const article = articleRow.rows[0]
        if (!article.is_paywalled) {
```

**Add these lines right after** `const article = articleRow.rows[0]` and **before** `if (!article.is_paywalled)`:

```typescript
        // Check for free access (own content, permanent unlock, subscription)
        const access = await checkArticleAccess(readerId, article.id, article.writer_id)
        if (access.hasAccess) {
          // If subscription read, record the zero-cost read + permanent unlock
          if (access.reason === 'subscription' && access.subscriptionId) {
            await recordSubscriptionRead(readerId, article.id, article.writer_id, access.subscriptionId)
          }

          // Issue content key without charging
          const keyRes = await fetch(
            `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-reader-id': readerId,
                'x-reader-pubkey': readerPubkey,
              },
              body: JSON.stringify({}),
            }
          )

          if (!keyRes.ok) {
            return reply.status(502).send({ error: 'Key issuance failed' })
          }

          const keyResult = await keyRes.json()
          return reply.status(200).send({
            readEventId: null,
            readState: access.reason,
            encryptedKey: keyResult.encryptedKey,
            algorithm: keyResult.algorithm,
            isReissuance: access.reason === 'already_unlocked',
          })
        }
```

**Then find this line** (after the successful payment result, around line 360):

```typescript
        const keyResult = await keyRes.json()
```

**Add this line right before the `return reply.status(200).send({` that follows it:**

```typescript
        // Record permanent unlock for this purchase
        await recordPurchaseUnlock(readerId, article.id)
```

## Step 5: Add subscription_price_pence to the writers endpoint

Edit `gateway/src/routes/writers.ts`:

```bash
nano gateway/src/routes/writers.ts
```

Find the SELECT in the `GET /writers/:username` handler and add `subscription_price_pence` to it:

Change:
```sql
SELECT id, nostr_pubkey, username, display_name, bio,
       avatar_blossom_url, hosting_type
```

To:
```sql
SELECT id, nostr_pubkey, username, display_name, bio,
       avatar_blossom_url, hosting_type, subscription_price_pence
```

And in the response object, add:
```typescript
subscriptionPricePence: writer.subscription_price_pence,
```

## Step 6: Rebuild and restart

```bash
docker compose build --no-cache gateway web
docker compose up -d gateway web
docker compose restart nginx
```

## Step 6b: Fix the delete route conflict

The `v1_6.ts` file has a `DELETE /notes/:id` route that conflicts with the
proper one in `notes.ts`. If you haven't already removed it, do so now:

```bash
nano gateway/src/routes/v1_6.ts
```

Delete everything from `// DELETE /notes/:id` down to its closing `}` 
(before `// GET /my/tab`). Keep the `/my/tab` route.

## Step 7: Verify

1. Visit a writer's profile — you should see a green "Subscribe £5.00/mo" button
2. Click it — subscription should be created
3. The button should change to "Subscribed"
4. Check the DB: `docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "SELECT * FROM subscriptions;"`
