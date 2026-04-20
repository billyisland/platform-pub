# Email-on-Publish v2 — Specification

## Context

The current email-on-publish (v1, migration 042) notifies paying subscribers when a writer publishes. It works but is limited: only paid subscribers are reached, writers have no control over whether email goes out, the email is bare (title + button), publication articles are excluded, and sending uses Postmark's transactional stream instead of a broadcast stream.

**Postmark can handle this.** They added Broadcast Message Streams in 2020 — separate IP pools from transactional, automatic List-Unsubscribe headers, suppression list management. Pricing is per-email (no broadcast markup). The main constraint is warm-up: new broadcast streams start rate-limited and ramp over 2-4 weeks.

Competitive research (Substack, Ghost, Beehiiv) informed the design decisions below.

---

## Key Decisions

### D1: Ghost-style publish dialog — writer chooses per post

The publish button becomes a two-step flow: click "Publish" -> confirmation panel with a checkbox **"Email followers and subscribers"** (checked by default for new articles, disabled for edits where email was already sent). No global writer toggle — if they never want emails, they uncheck each time.

**Rationale:** Ghost's explicit choice prevents accidental mass-emails (Substack's default-on is riskier). No email-only mode needed since articles are always Nostr events.

### D2: Followers receive emails by default (opt-out)

When a reader follows a writer, `notify_on_publish` defaults to `true`. Readers opt out via the unsubscribe link in the email or account page toggles.

**Rationale:** The follow action signals intent. Opt-in would get near-zero adoption. Substack proved opt-out works. The unsubscribe flow (D5) makes opting out trivial.

### D3: Email preference column on the `follows` table

Add `notify_on_publish BOOLEAN NOT NULL DEFAULT true` to `follows` and `publication_follows`, mirroring the existing column on `subscriptions`.

**Rationale:** A separate `email_preferences` table is over-engineering for a single boolean. The preference is scoped to the relationship. The send query deduplicates by email address so a reader who is both follower and subscriber gets one email.

### D4: Email contains excerpt, not full content

The email includes: article title, writer-provided summary (or first ~150 words of `content_free` as fallback), writer avatar, and a "Read on all.haus" button. Not the full article body.

**Rationale:** Full-content-in-email (Substack model) undermines platform engagement and complicates paywalled content. Ghost does excerpt-only and it works. For all.haus, the canonical reading experience is on-platform or any Nostr client, not in email.

### D5: Signed unsubscribe tokens (no login required)

Email footer contains: `Unsubscribe from these emails` -> `{APP_URL}/email/unsubscribe?token={hmac_signed}`. Token contains `{accountId, targetId, targetType}`, signed with `READER_HASH_KEY`. Sets `notify_on_publish = false` on the relevant relationship. Postmark also adds its own `List-Unsubscribe` header on broadcast streams (stream-level suppression).

### D6: Warm-up via configurable daily send cap

New env var `BROADCAST_DAILY_SEND_LIMIT` (default 50, 0 = unlimited). The send function checks a daily counter and stops when the cap is hit, logging skipped recipients. Operator raises the limit manually over 2-4 weeks. Skipped recipients for a given article are not retried — next article will reach them.

---

## Data Model Changes

### Migration 044

```sql
-- Follower email preferences
ALTER TABLE follows
  ADD COLUMN notify_on_publish BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE publication_follows
  ADD COLUMN notify_on_publish BOOLEAN NOT NULL DEFAULT true;

-- Track whether email was sent for an article
ALTER TABLE articles
  ADD COLUMN email_sent_at TIMESTAMPTZ;

-- Email send log for writer analytics
CREATE TABLE article_email_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id      UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_article_email_sends_article ON article_email_sends(article_id);
```

---

## Postmark Broadcast Stream

### New env vars

| Variable | Purpose | Default |
|---|---|---|
| `POSTMARK_BROADCAST_STREAM` | Message stream ID | `broadcast` |
| `EMAIL_FROM_BROADCAST` | From address for publish emails | `posts@all.haus` |
| `BROADCAST_DAILY_SEND_LIMIT` | Warm-up cap (0 = unlimited) | `50` |

### Manual Postmark setup

1. Create broadcast stream named `broadcast` in the Postmark server
2. Verify sender signature for `posts@all.haus` (or use domain-level DKIM)
3. Broadcast stream auto-manages: List-Unsubscribe headers, bounce/complaint suppression, separate IP reputation

### Code: `sendBroadcastEmail` in `shared/src/lib/email.ts`

Same structure as existing `sendEmail` but with `MessageStream: process.env.POSTMARK_BROADCAST_STREAM ?? 'broadcast'` and `From: process.env.EMAIL_FROM_BROADCAST ?? 'posts@all.haus'`. Console provider logs identically in dev.

---

## Email Template

```
+-------------------------------------------+
|                                           |
|  [Avatar]  Writer Name                    |
|            via Publication Name*          |
|                                           |
|  -----------------------------------------|
|                                           |
|  Article Title                            |
|                                           |
|  Summary or excerpt (~150 words)          |
|                                           |
|  [ Read on all.haus ]                     |
|                                           |
|  -----------------------------------------|
|                                           |
|  You follow Writer Name on all.haus.      |
|  Unsubscribe from these emails            |
|                                           |
|  all.haus -- writing worth reading        |
+-------------------------------------------+
```

**Subject lines:**
- Writer articles: `{writerName}: {articleTitle}`
- Publication articles: `{articleTitle} -- {publicationName}`

**Footer copy varies** by relationship (follow vs subscribe, writer vs publication). All include the signed unsubscribe link.

Built using the existing `emailHtml`, `paragraph`, `button` helpers from `subscription-emails.ts`, in a new `shared/src/lib/publish-email-template.ts`.

---

## API Changes

| Endpoint | Change |
|---|---|
| `POST /articles` | Accept optional `sendEmail: boolean` in body. Only trigger broadcast when `isNew && sendEmail`. |
| `POST /publications/:id/articles/:articleId/publish` | Accept `sendEmail: boolean`. Trigger broadcast on publish. |
| `POST /email/unsubscribe` (new) | Verify HMAC token, set `notify_on_publish = false`. Returns HTML confirmation page. |
| `PATCH /follows/:writerId/notifications` (new) | Toggle `notify_on_publish` on a follow. Mirrors existing subscription toggle. |
| `PATCH /publication-follows/:pubId/notifications` (new) | Same for publication follows. |
| `GET /articles/:id/email-stats` | Return `{ sentAt, recipientCount, skippedCount }` for the writer's article. |

---

## Frontend Changes

### Publish confirmation panel (ArticleEditor.tsx)

Replace direct publish with two-step: click Publish -> confirmation panel slides up:
- "Your article will be published."
- Checkbox: **"Email followers and subscribers"** (checked by default, disabled if `email_sent_at` already set)
- Two buttons: Publish / Cancel

`PublishData` interface gains `sendEmail: boolean`.

### Reader account page

Add notification toggles to followed writers list (lower priority — email unsubscribe link is the primary opt-out).

### Writer dashboard

Small email icon + count on article rows: "Emailed 342".

---

## Recipient Query (deduplicated)

```sql
SELECT DISTINCT ON (a.email)
  a.id, a.email, a.display_name, a.username,
  CASE WHEN s.id IS NOT NULL THEN 'subscriber' ELSE 'follower' END AS relationship
FROM accounts a
LEFT JOIN subscriptions s
  ON s.reader_id = a.id AND s.writer_id = $1
  AND s.status = 'active' AND s.notify_on_publish = true
LEFT JOIN follows f
  ON f.follower_id = a.id AND f.followee_id = $1
  AND f.notify_on_publish = true
WHERE a.email IS NOT NULL
  AND a.status = 'active'
  AND (s.id IS NOT NULL OR f.follower_id IS NOT NULL)
ORDER BY a.email, relationship
```

Parallel query for publication articles joins on `publication_id` instead.

---

## Phasing

### Phase 1: Broadcast stream + writer control + better template

- Move publish emails to Postmark broadcast stream
- Add `sendEmail` flag to publish API
- Build publish confirmation panel with email checkbox
- Improve email template (summary, avatar, footer)
- Add `email_sent_at` to articles
- Implement signed unsubscribe endpoint
- **Audience: paid subscribers only** (existing `notify_on_publish` on subscriptions)
- Broadcast stream warm-up starts here with low volume

**Files:** `shared/src/lib/email.ts`, `shared/src/lib/publish-emails.ts`, new `publish-email-template.ts`, `gateway/src/routes/articles.ts`, new `gateway/src/routes/unsubscribe.ts`, `web/src/components/editor/ArticleEditor.tsx`, `web/src/lib/publish.ts`, migration (just `email_sent_at` on articles)

### Phase 2: Follower emails + notification preferences

- Migration 044 (full — `notify_on_publish` on follows, `article_email_sends` table)
- Expand recipient query to include followers
- Add follow notification toggle to account page
- Raise/remove broadcast daily send cap (stream is now warm)

**Files:** migration 044, `publish-emails.ts`, new follow notification endpoints, `web/src/app/account/page.tsx`

### Phase 3: Publication email support

- Trigger emails from `publication-publisher.ts` on publish
- Add `sendEmail` flag to publication publish endpoints
- Publication subscriber/follower recipient query

### Phase 4: Analytics and polish (later)

- Writer dashboard email stats (icon + count on article rows)
- Postmark webhook integration for open/click tracking
- Audience count preview in publish dialog
- Per-recipient delivery logging

---

## Verification

- **Phase 1 test:** Publish an article with `EMAIL_PROVIDER=console` and verify the broadcast email appears in logs with correct template, subject, and unsubscribe token. Test unsubscribe endpoint with a signed token. Test that editing an article with `email_sent_at` set does not re-send.
- **Postmark test:** With `EMAIL_PROVIDER=postmark`, verify the email arrives on the broadcast stream (check Postmark dashboard for stream separation). Verify List-Unsubscribe header is present.
- **Phase 2 test:** Follow a writer, publish, verify the follower receives the email. Toggle `notify_on_publish` off, publish again, verify no email. Verify deduplication: a reader who is both follower and subscriber gets exactly one email.
