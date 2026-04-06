# Platform Bug Diagnosis

Two features are broken: **Direct Messages** and **Article Unlocks**. This document traces the full request flow for each, identifies where it fails, and explains why.

---

## 1. Direct Messages

### 1a. Sending a message from the thread view — silent failure

**Symptom:** You type a message in a conversation thread, hit Send, nothing happens. No error message.

**Root cause: field name mismatch between client and server.**

The client (`web/src/lib/api.ts`, line ~592) sends:

```ts
body: JSON.stringify({ content })
```

The server (`gateway/src/routes/messages.ts`) validates the incoming body against `SendMessageSchema`:

```ts
const SendMessageSchema = z.object({
  contentEnc: z.string().min(1),
})
```

The server expects `contentEnc`. The client sends `content`. Zod validation fails — `contentEnc` is required and missing — so the server returns a **400** with a validation error object. But the client's `handleSend` in `MessageThread.tsx` only catches errors with `err?.status === 402` (the DM-pricing case). A 400 is not caught, so it falls through to the generic `finally` block, `setSending(false)` runs, and the user sees nothing.

**There is a second, deeper design problem here.** Even if you fix the field name, the architecture has an unresolved contradiction. The schema says `contentEnc` because the system design calls for NIP-44 end-to-end encryption — the client is supposed to encrypt the message body before sending it. But the client sends plaintext (`content`). There is no NIP-44 encryption step anywhere in the client-side DM code. The `MessageThread` component treats message content as plain strings throughout (rendering `msg.content`, not decrypting `msg.contentEnc`). So the client was written to a plaintext-first model while the server was written to an E2E-encrypted model. Someone needs to decide which it is:

- **Option A (ship now, encrypt later):** Rename the server field to `content`, store plaintext, display plaintext. Add E2E encryption as a follow-up.
- **Option B (encrypt now):** Add a NIP-44 encryption step in the client before sending, and a decryption step when displaying. This requires the client to call the signing service to encrypt, similar to how vault content keys are wrapped.

Option A is the pragmatic fix. It requires changing one word in the Zod schema.

### 1b. Username lookup when composing a new message — user not found

**Symptom:** You type a username into the "To" field on the new-message screen and hit Start. You get "User not found."

**The flow:**

1. `handleNewConversation` in `messages/page.tsx` fires
2. It calls `/api/v1/search?q=<input>&type=writers`
3. The search route (`gateway/src/routes/search.ts`) runs a writer search
4. It looks for the first result: `const writer = data.writers?.[0]`
5. If no writer is found, it alerts "User not found"

**Root cause: the client reads `data.writers` but the server returns `data.results`.**

The search endpoint returns:

```ts
return reply.status(200).send({ query, type: 'writers', results, limit, offset })
```

The response shape is `{ results: [...] }`, not `{ writers: [...] }`. So `data.writers` is always `undefined`, `data.writers?.[0]` is always `undefined`, and the condition `if (!writer)` is always true. Every username lookup fails.

**Fix:** Change the client to read `data.results?.[0]` instead of `data.writers?.[0]`.

### 1c. Messaging from a writer's profile page

**Symptom:** You click "Message" on someone's profile. The `handleMessage` function in `WriterActivity.tsx` calls `messagesApi.createConversation([writer.id])`, which POSTs to `/conversations` with `{ memberIds: [writerId] }`. This part works correctly — a conversation is created and you're redirected to `/messages#<conversationId>`. But once there, any message you try to send fails silently for the reason described in §1a above.

---

## 2. Article Unlocks

### Symptom

Clicking "Continue reading" on a paywalled article does not reveal the content. The exact failure mode depends on where in the pipeline the break occurs — it could be a generic error message, a "Payment required" message, or a silent failure.

### The full unlock flow (7 steps, 4 services)

```
Browser                Gateway              Payment Service       Key Service        Key Custody
   │                      │                       │                    │                   │
   ├─ POST gate-pass ────►│                       │                    │                   │
   │                      ├─ checkArticleAccess ──┤                    │                   │
   │                      │  (own? unlocked? sub?) │                    │                   │
   │                      │                       │                    │                   │
   │                      ├─ POST /gate-pass ────►│                    │                   │
   │                      │                       ├─ recordGatePass    │                   │
   │                      │                       │  (provisional or   │                   │
   │                      │                       │   accrued)         │                   │
   │                      │◄─ readEvent ──────────┤                    │                   │
   │                      │                       │                    │                   │
   │                      ├─ recordPurchaseUnlock  │                    │                   │
   │                      │                       │                    │                   │
   │                      ├─ POST /key ──────────────────────────────►│                   │
   │                      │                       │                    ├─ resolveArticleId │
   │                      │                       │                    ├─ verifyPayment    │
   │                      │                       │                    ├─ decrypt key      │
   │                      │                       │                    ├─ wrapKeyForReader │
   │                      │◄─ { encryptedKey, algorithm, ciphertext } ─┤                   │
   │                      │                       │                    │                   │
   │◄─ { encryptedKey, algorithm, ciphertext } ───┤                    │                   │
   │                      │                       │                    │                   │
   ├─ POST /unwrap-key ──►│                       │                    │                   │
   │                      ├─ POST /keypairs/unwrap ──────────────────────────────────────►│
   │                      │                       │                    │                   ├─ decrypt
   │◄─ { contentKeyBase64 }                       │                    │                   │
   │                      │                       │                    │                   │
   ├─ decryptVaultContent  │                       │                    │                   │
   │  (client-side)       │                       │                    │                   │
   ├─ render markdown     │                       │                    │                   │
```

### What I traced and what checks out

The gateway orchestration in `articles.ts` (lines 347–540) is well-structured. The three access-check branches (own content, already unlocked, subscription) all correctly short-circuit to key issuance without payment. The payment path correctly records the unlock *before* requesting the key, so a retry after key-service failure won't double-charge. The key service's `issueKey` method correctly resolves by `article_id` (stable across re-publishes), not `nostr_event_id`. The vault decryption client (`vault.ts`) correctly dispatches between XChaCha20-Poly1305 and AES-256-GCM based on the algorithm field.

### Where it breaks: the client sends the wrong identifier

The client calls `gatePass` with `article.id`:

```ts
gatePassResult = await articlesApi.gatePass(article.id)
```

`article.id` here is the **Nostr event ID** (a 64-character hex string), because `ArticleReader` receives an `ArticleEvent` from NDK, and `.id` on a Nostr event is the event ID.

The API call goes to:

```ts
gatePass: (nostrEventId: string) =>
  request<GatePassResponse>(`/articles/${nostrEventId}/gate-pass`, { ... })
```

The gateway route receives this as `req.params.nostrEventId` and looks up the article:

```ts
const articleRow = await pool.query(
  `SELECT id, writer_id, price_pence, access_mode
   FROM articles WHERE nostr_event_id = $1`,
  [nostrEventId]
)
```

**This query depends on the `nostr_event_id` column in the `articles` table being populated.** The article must have been indexed by the gateway (via `POST /articles`) for this row to exist. If the article was published but not indexed — or if the Nostr event ID changed on a re-publish and the index wasn't updated — this query returns zero rows and the gateway returns 404.

**The more likely failure mode:** the `ArticleEvent` object arriving at `ArticleReader` may have its `id` field set to something other than the Nostr event ID that was indexed. This can happen if:

- The article was fetched from the relay and the event ID is the *current* replaceable event ID, but the database still holds the *original* event ID from first publish
- The article was fetched via NDK which computes event IDs client-side, and a mismatch in serialisation (field ordering, whitespace) produces a different hash

In either case, the lookup fails, the gate-pass returns 404, and the client shows "Something went wrong."

### Secondary issue: `encryptedPayload` fallback may be stale

The client has a fallback for when `gatePassResult.ciphertext` is missing:

```ts
const ciphertext: string | undefined = gatePassResult.ciphertext
  ?? article.encryptedPayload
```

`article.encryptedPayload` comes from the NIP-23 event's `['payload', ...]` tag, fetched from the relay. But since migration 011, the vault service stores ciphertext in the `vault_keys` table and returns it via `keyResult.ciphertext`. If the NIP-23 event on the relay doesn't have a `['payload', ...]` tag (because it was published before that convention was adopted, or the tag was omitted), *and* the key service doesn't return `ciphertext` for some reason, then `ciphertext` is `undefined` and the client shows "Could not find the encrypted content."

### Summary of article unlock issues

| Step | Risk | Severity |
|------|------|----------|
| Event ID mismatch on re-published articles | DB lookup fails → 404 | **High** — breaks unlock for any re-published article |
| Article not indexed in gateway DB | DB lookup fails → 404 | **High** — breaks unlock entirely |
| Ciphertext missing from both key service response and NIP-23 event | Client can't decrypt | **Medium** — fallback exists but both sources can fail |
| `READER_HASH_KEY` env var not set | Gateway throws → 500 | **High** — breaks all first-time unlocks |

---

## Recommended fixes (priority order)

1. **DM field mismatch** — rename `contentEnc` to `content` in `SendMessageSchema` (or add client-side encryption). One-line fix for immediate unblock.
2. **DM username lookup** — change `data.writers?.[0]` to `data.results?.[0]` in `messages/page.tsx`. One-line fix.
3. **Article unlock event ID** — audit the article indexing pipeline to confirm that `nostr_event_id` stays current after re-publishes. The `POST /articles` route and the editor's publish flow need to update the indexed event ID on every publish, not just the first.
4. **Env var guard** — add a startup check for `READER_HASH_KEY` so the gateway fails fast at boot rather than 500-ing on every gate pass.
