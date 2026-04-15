import { getAtprotoClient } from '../../shared/src/lib/atproto-oauth.js'
import logger from '../../shared/src/lib/logger.js'
import { truncateWithLink } from '../lib/text.js'

// =============================================================================
// AT Protocol outbound — creates a post record via the linked user's PDS.
//
// We go through NodeOAuthClient.restore(did) which returns an OAuthSession
// with a fetchHandler() that signs XRPC requests with a DPoP proof bound to
// the session's stored key. The session store auto-refreshes tokens if the
// access token is close to expiry.
//
// Post shape (Bluesky app.bsky.feed.post):
//   { $type: 'app.bsky.feed.post', text, createdAt,
//     reply?: { root: StrongRef, parent: StrongRef },
//     embed?: { $type: 'app.bsky.embed.record', record: StrongRef } }  // quote
//
// The 300 limit is *graphemes*, not bytes — we truncate cautiously with
// Intl.Segmenter so CJK / emoji / combining marks all count as one.
// =============================================================================

export interface AtprotoReplyRef {
  uri: string
  cid: string
}

export interface AtprotoPostInput {
  did: string
  text: string
  maxGraphemes: number
  /** all.haus canonical link appended when the body has to be truncated. */
  allHausUrl?: string
  reply?: {
    root: AtprotoReplyRef
    parent: AtprotoReplyRef
  }
  quote?: AtprotoReplyRef
}

export interface AtprotoPostResult {
  externalPostUri: string
  cid: string
}

export async function postBlueskyRecord(input: AtprotoPostInput): Promise<AtprotoPostResult> {
  const client = await getAtprotoClient()
  const session = await client.restore(input.did)

  const text = truncateWithLink(input.text, { max: input.maxGraphemes, linkSuffix: input.allHausUrl })
  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    langs: ['en'],
  }
  if (input.reply) {
    record.reply = {
      root: { uri: input.reply.root.uri, cid: input.reply.root.cid },
      parent: { uri: input.reply.parent.uri, cid: input.reply.parent.cid },
    }
  }
  if (input.quote) {
    record.embed = {
      $type: 'app.bsky.embed.record',
      record: { uri: input.quote.uri, cid: input.quote.cid },
    }
  }

  const body = {
    repo: input.did,
    collection: 'app.bsky.feed.post',
    record,
  }

  const res = await session.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    logger.warn({ status: res.status, errText, did: input.did }, 'Bluesky createRecord failed')
    throw new Error(`Bluesky createRecord HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  const json = (await res.json()) as { uri: string; cid: string }
  if (!json.uri || !json.cid) throw new Error('Bluesky createRecord response missing uri/cid')
  return { externalPostUri: json.uri, cid: json.cid }
}

