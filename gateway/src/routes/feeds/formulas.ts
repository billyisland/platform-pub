import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { getPlatformConfig } from "../../lib/platform-config.js";
import {
  UUID_RE,
  createFeedForOwner,
  loadFeed,
  tagged,
  ENQUEUE_SPACING_MS,
} from "./shared.js";
import { addSource, type AddSourceInput } from "./sources.js";

// =============================================================================
// Feed formulas — a feed's composition as a transmissible object
// (FEED-FORMULAS-ADR, Phase 1: "the object and the loop").
//
// Freeze a feed's source list into an immutable artifact stored by PORTABLE
// IDENTITY, hand out an unguessable token, and let any account redeem it into
// an ordinary fully-owned feed. Everything here is dark behind
// FEED_FORMULAS_ENABLED.
//
// TWO register functions, because the routes are not all workspace-scoped:
//   registerFeedFormulaRoutes  → mounted under /api/v1/workspace with the rest
//                                of the feeds plugin. Freeze is genuinely
//                                feed-scoped, and /api/v1/feeds is already
//                                owned by external-feeds.ts.
//   formulaPublicRoutes        → mounted at /api/v1 from index.ts. The formula
//                                page is a PUBLIC page a logged-out visitor can
//                                open; serving it from a path called
//                                "workspace" would be a lie about who it is for.
// The engine stays in one file either way.
//
// WHAT THIS IS NOT: the starter-template clone this replaced (cloneFeedForOwner,
// deleted with the flag in migration 179). That path copied external_source_id
// verbatim and took neither the feed_sub advisory lock nor a fetch job —
// shortcuts licensed ENTIRELY by its zero-feeds precondition, which a redeemer
// does not have (they hold existing feeds, so a concurrent removeSource
// teardown can race the subscription upsert, and the formula may name sources
// this instance does not hold at all). Redemption was built as a sibling of the
// clone path rather than a parameter on it (D3), which is what let the clone go
// without anything needing to be re-argued here.
// =============================================================================

// Operator brake (§8 Phase 1). Default OFF. It gates PUBLISH and
// REDEEM-BY-TOKEN — and when Phase 2 repoints seedStarterFeeds at a designated
// formula, that path must NOT be gated on this flag: turning it off would then
// silently end new-account seeding, which is the §0l outage again from the
// opposite direction (§6).
export function formulasEnabled(): boolean {
  const v = process.env.FEED_FORMULAS_ENABLED;
  return v === "1" || v === "true";
}

// Fails CLOSED by allow-list rather than by naming email (D5 as amended): the
// external_protocol enum already carries farcaster/matrix/telegram with no
// composer path today, and a future protocol addition must not leak into
// formulas by default. `email` is the one that would actually do harm —
// external_sources.ingest_address is a per-subscriber secret alias, so copying
// the row hands a recipient the author's private address and resolving it by
// identity would subscribe them to a newsletter in the author's name.
const PORTABLE_PROTOCOLS = [
  "rss",
  "nostr_external",
  "atproto",
  "activitypub",
] as const;
type PortableProtocol = (typeof PORTABLE_PROTOCOLS)[number];

function isPortableProtocol(p: string | null): p is PortableProtocol {
  return p !== null && (PORTABLE_PROTOCOLS as readonly string[]).includes(p);
}

// The publishable source cap (§6). A tuning dial, not a constant: what the
// right number is depends on redeem latency, which is a property of live
// traffic. Sized by TIME, not storage — redemption resolves N sources through
// addSource, and a genuinely new identity is probed. In practice almost every
// source in a v1 formula is already held healthy by this instance (the author
// holds it), so the known-healthy short-circuit skips the probe; the cap bounds
// the pathological case. Lower it if redeem starts timing out.
const FORMULA_MAX_SOURCES_FALLBACK = 200;
export async function formulaMaxSources(): Promise<number> {
  const cfg = await getPlatformConfig();
  const raw = cfg.get("feed_formula_max_sources");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FORMULA_MAX_SOURCES_FALLBACK;
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

interface FeedSourceForFreeze {
  source_type: "account" | "publication" | "external_source" | "tag";
  weight: string;
  sampling_mode: string;
  exclude_replies: boolean;
  tag_name: string | null;
  account_pubkey: string | null;
  account_display_name: string | null;
  account_username: string | null;
  account_avatar: string | null;
  publication_pubkey: string | null;
  publication_name: string | null;
  publication_avatar: string | null;
  external_protocol: string | null;
  external_source_uri: string | null;
  external_display_name: string | null;
  external_avatar: string | null;
  external_relay_urls: string[] | null;
}

interface FrozenSource {
  tagKind: "p" | "t" | "r" | "a";
  tagValue: string;
  tagHint: string | null;
  sourceType: FeedSourceForFreeze["source_type"];
  protocol: PortableProtocol | null;
  displayName: string | null;
  avatarUrl: string | null;
  weight: string;
  samplingMode: string;
  excludeReplies: boolean;
}

/**
 * Map one feed_sources row to its portable form, or null if it cannot travel.
 *
 * Exported for the unit tests: this is the whole of D4/D5/D8 in one function —
 * which identities are portable, what each becomes on the wire, and what is
 * excluded — and it is pure, so it can be driven without a database.
 */
export function freezeSource(row: FeedSourceForFreeze): FrozenSource | null {
  const tuning = {
    weight: row.weight,
    samplingMode: row.sampling_mode,
    excludeReplies: row.exclude_replies,
  };

  if (row.source_type === "account") {
    // NULL only when the account row is gone (the LEFT JOIN missed) — a
    // deleted member cannot travel, so it is excluded and counted like any
    // other non-portable row rather than shipped as a dangling pubkey.
    if (!row.account_pubkey) return null;
    return {
      tagKind: "p",
      tagValue: row.account_pubkey,
      tagHint: null,
      sourceType: "account",
      protocol: null,
      displayName: row.account_display_name ?? row.account_username,
      avatarUrl: row.account_avatar,
      ...tuning,
    };
  }

  if (row.source_type === "publication") {
    // D4 as amended: a publication travels by publications.nostr_pubkey (unique,
    // publications_nostr_pubkey_key), NEVER by row id — the row id is exactly
    // the local FK D4 forbids for external sources, and it is meaningless the
    // day a formula serialises off-platform. It rides a 'p' tag because a
    // publication signs its own events; source_type is what tells a 'p' that
    // is a publication from a 'p' that is a member at redeem.
    if (!row.publication_pubkey) return null;
    return {
      tagKind: "p",
      tagValue: row.publication_pubkey,
      tagHint: null,
      sourceType: "publication",
      protocol: null,
      displayName: row.publication_name,
      avatarUrl: row.publication_avatar,
      ...tuning,
    };
  }

  if (row.source_type === "tag") {
    if (!row.tag_name) return null;
    return {
      tagKind: "t",
      tagValue: row.tag_name,
      tagHint: null,
      sourceType: "tag",
      protocol: null,
      displayName: row.tag_name,
      avatarUrl: null,
      ...tuning,
    };
  }

  // external_source — allow-list, then map protocol to its wire tag.
  if (!isPortableProtocol(row.external_protocol)) return null;
  if (!row.external_source_uri) return null;
  const protocol = row.external_protocol;
  return {
    // An external Nostr source's canonical source_uri IS a hex pubkey, so it
    // takes 'p' like a native account. rss/activitypub/atproto take 'r' (D8) —
    // note atproto's value is a DID rather than a URL, which is a known
    // stretch of the 'r' slot and is why `protocol` is stored alongside.
    tagKind: protocol === "nostr_external" ? "p" : "r",
    tagValue: row.external_source_uri,
    // The NIP-51 hint slot, used for what it is for: a relay to find this
    // pubkey on. It is a TRANSPORT hint and never part of the identity — the
    // relay-free-identity invariant bans hints from identity fields, and
    // tag_value stays the bare pubkey.
    tagHint:
      protocol === "nostr_external" ? (row.external_relay_urls?.[0] ?? null) : null,
    sourceType: "external_source",
    protocol,
    displayName: row.external_display_name,
    avatarUrl: row.external_avatar,
    ...tuning,
  };
}

const publishSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

export type FreezeResult =
  | {
      ok: true;
      formulaId: string;
      token: string;
      sourceCount: number;
      excludedCount: number;
    }
  | {
      ok: false;
      reason: "empty" | "too_large";
      sourceCount: number;
      excludedCount: number;
    };

/**
 * Freeze a feed's composition into a formula, inside the caller's transaction.
 *
 * Exported and client-threaded because what
 * this must get right spans feed_sources → accounts/publications/external_sources
 * → feed_formula_sources, and the interesting half is which rows DON'T make it
 * and whether the count of them is truthful. A mocked pool.query would answer
 * from the mock rather than from the database, so the DB-backed test drives
 * this directly inside a transaction it rolls back.
 *
 * The two business refusals are RETURNED, not thrown — both are decided before
 * any INSERT, so the caller's transaction is untouched either way, and the
 * route needs the counts to say anything useful.
 */
/**
 * Read a feed's sources in the form `freezeSource` consumes, in composer order.
 *
 * ONE home, because freeze and PREVIEW must not drift. The preview's whole job
 * is to tell an author what a recipient would receive, so a preview computed
 * over a different row set — or a different ORDER BY — is a preview of
 * something that will never be published. Composer order (§11): feed_sources
 * has no ordering column, so position comes from created_at with id as the
 * tiebreak, the same ORDER BY loadFeedSources uses, so the formula page lists
 * sources in the order the author sees them.
 */
async function loadFeedSourcesForFreeze(
  client: { query: typeof pool.query },
  feedId: string,
): Promise<FeedSourceForFreeze[]> {
  const { rows } = await client.query<FeedSourceForFreeze>(
    `SELECT fs.source_type, fs.weight, fs.sampling_mode, fs.exclude_replies, fs.tag_name,
       acc.nostr_pubkey AS account_pubkey, acc.display_name AS account_display_name,
       acc.username AS account_username, acc.avatar_blossom_url AS account_avatar,
       pub.nostr_pubkey AS publication_pubkey, pub.name AS publication_name,
       pub.logo_blossom_url AS publication_avatar,
       xs.protocol::text AS external_protocol, xs.source_uri AS external_source_uri,
       xs.display_name AS external_display_name, xs.avatar_url AS external_avatar,
       xs.relay_urls AS external_relay_urls
     FROM feed_sources fs
     LEFT JOIN accounts acc ON acc.id = fs.account_id
     LEFT JOIN publications pub ON pub.id = fs.publication_id
     LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
     WHERE fs.feed_id = $1
     ORDER BY fs.created_at ASC, fs.id ASC`,
    [feedId],
  );
  return rows;
}

/** Partition a feed's sources into what travels and how much does not. */
function partitionForFreeze(rows: FeedSourceForFreeze[]): {
  frozen: FrozenSource[];
  excluded: number;
} {
  const frozen: FrozenSource[] = [];
  let excluded = 0;
  for (const row of rows) {
    const f = freezeSource(row);
    if (f) frozen.push(f);
    else excluded++;
  }
  return { frozen, excluded };
}

export async function freezeFeedIntoFormula(
  client: { query: typeof pool.query },
  params: {
    feedId: string;
    ownerId: string;
    name: string;
    description: string | null;
    appearance: Record<string, unknown>;
    maxSources: number;
  },
): Promise<FreezeResult> {
  const { frozen, excluded } = partitionForFreeze(
    await loadFeedSourcesForFreeze(client, params.feedId),
  );

  // A formula with nothing in it would redeem to an empty feed, which then
  // auto-serves the explore placeholder (§2.7) — so the recipient would receive
  // a stranger's curation and be shown the platform stream.
  if (frozen.length === 0)
    return { ok: false, reason: "empty", sourceCount: 0, excludedCount: excluded };
  if (frozen.length > params.maxSources)
    return {
      ok: false,
      reason: "too_large",
      sourceCount: frozen.length,
      excludedCount: excluded,
    };

  const token = crypto.randomBytes(16).toString("base64url");
  const {
    rows: [f],
  } = await client.query<{ id: string }>(
    `INSERT INTO feed_formulas
       (author_id, source_feed_id, name, description, appearance, token,
        source_count, excluded_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.ownerId,
      params.feedId,
      params.name,
      params.description,
      JSON.stringify(params.appearance ?? {}),
      token,
      frozen.length,
      excluded,
    ],
  );
  for (let i = 0; i < frozen.length; i++) {
    const s = frozen[i];
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, tag_hint, source_type,
          protocol, display_name, avatar_url, weight, sampling_mode, exclude_replies)
       VALUES ($1, $2, $3, $4, $5, $6, $7::external_protocol, $8, $9, $10, $11, $12)`,
      [
        f.id,
        i,
        s.tagKind,
        s.tagValue,
        s.tagHint,
        s.sourceType,
        s.protocol,
        s.displayName,
        s.avatarUrl,
        s.weight,
        s.samplingMode,
        s.excludeReplies,
      ],
    );
  }
  return {
    ok: true,
    formulaId: f.id,
    token,
    sourceCount: frozen.length,
    excludedCount: excluded,
  };
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

interface FormulaRow {
  id: string;
  name: string;
  description: string | null;
  appearance: Record<string, unknown>;
  token: string;
  source_count: number;
  excluded_count: number;
  created_at: Date;
  revoked_at: Date | null;
  is_default_seed: boolean;
  author_display_name: string | null;
  author_username: string | null;
}

interface FormulaSourceRow {
  position: number;
  source_type: string;
  protocol: string | null;
  display_name: string | null;
  avatar_url: string | null;
  tag_value: string;
}

// What a recipient sees. Deliberately display-only: a formula page is a
// composition, never content, and nobody's items appear on it (§3).
function formulaSourceToResponse(row: FormulaSourceRow) {
  const label =
    row.display_name ??
    (row.source_type === "tag" ? `#${row.tag_value}` : row.tag_value);
  return {
    position: row.position,
    kind: row.source_type,
    protocol: row.protocol,
    label: row.source_type === "tag" ? `#${row.tag_value}` : label,
    avatar: row.avatar_url,
  };
}

function formulaToResponse(f: FormulaRow, sources: FormulaSourceRow[]) {
  return {
    name: f.name,
    description: f.description,
    appearance: f.appearance ?? {},
    // D7 — attribution travels, adoption counts do not. There is no add count
    // here, public or private: an adoption metric on a curatorial object is an
    // engagement surface by another name.
    author: {
      displayName: f.author_display_name ?? f.author_username,
      username: f.author_username,
    },
    sourceCount: Number(f.source_count),
    // Named out loud, never silently omitted: an author who published a feed
    // with three email sources must be able to see that three did not travel,
    // or they believe they published their whole feed (D5).
    excludedCount: Number(f.excluded_count),
    createdAt: f.created_at.toISOString(),
    revoked: f.revoked_at !== null,
    sources: sources.map(formulaSourceToResponse),
  };
}

const FORMULA_SELECT = `
  SELECT ff.id, ff.name, ff.description, ff.appearance, ff.token,
         ff.source_count, ff.excluded_count, ff.created_at, ff.revoked_at,
         ff.is_default_seed,
         a.display_name AS author_display_name, a.username AS author_username
    FROM feed_formulas ff
    JOIN accounts a ON a.id = ff.author_id`;

async function loadFormulaSources(
  formulaId: string,
  db: { query: typeof pool.query } = pool,
): Promise<FormulaSourceRow[]> {
  const { rows } = await db.query<FormulaSourceRow>(
    `SELECT position, source_type, protocol, display_name, avatar_url, tag_value
       FROM feed_formula_sources
      WHERE formula_id = $1
      ORDER BY position ASC`,
    [formulaId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Preview — the recipient's-eye view, BEFORE the freeze
// ---------------------------------------------------------------------------

/**
 * What a recipient would receive if this feed were published right now.
 *
 * §6 requires this to exist and to run BEFORE the freeze: "publishing exposes a
 * follow graph … the preview must show the recipient's-eye view before the
 * freeze, so nobody publishes something whose legibility they had not
 * considered." D5 adds the harder half — the excluded count has to be on the
 * PUBLISH preview, not only on the finished page, or an author with three email
 * sources believes they published their whole feed and only learns otherwise by
 * opening their own link.
 *
 * It runs the real `freezeSource` over the real `loadFeedSourcesForFreeze`, so
 * the answer is the freeze's own answer rather than a second implementation of
 * the allow-list. The alternative — deriving portability client-side — would
 * put a copy of D5 in the web, where it would drift silently the first time a
 * protocol is added to the enum (the three publish-side validators are the
 * standing lesson about what that costs).
 *
 * The two refusals are REPORTED rather than thrown, because the preview's job
 * is to show the author the refusal before they press anything: `empty` is what
 * freeze would 400 on, `too_large` what it would 409 on.
 */
export async function previewFeedFormula(
  client: { query: typeof pool.query },
  feedId: string,
  maxSources: number,
): Promise<{
  sources: ReturnType<typeof formulaSourceToResponse>[];
  sourceCount: number;
  excludedCount: number;
  refusal: "empty" | "too_large" | null;
}> {
  const { frozen, excluded } = partitionForFreeze(
    await loadFeedSourcesForFreeze(client, feedId),
  );
  return {
    // Projected through the SAME function the published page uses, so the
    // preview and the page cannot render the same composition two ways. The
    // adapter is only shape: a FrozenSource has not been assigned a row yet.
    sources: frozen.map((f, i) =>
      formulaSourceToResponse({
        position: i,
        source_type: f.sourceType,
        protocol: f.protocol,
        display_name: f.displayName,
        avatar_url: f.avatarUrl,
        tag_value: f.tagValue,
      }),
    ),
    sourceCount: frozen.length,
    excludedCount: excluded,
    refusal:
      frozen.length === 0
        ? "empty"
        : frozen.length > maxSources
          ? "too_large"
          : null,
  };
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

export interface RedeemFailure {
  position: number;
  label: string;
  reason: string;
}

/**
 * Redeem a formula into a new feed for `ownerId`.
 *
 * Deliberately NOT one transaction (§6), and deliberately NOT client-threaded:
 * N sources means N addSource calls, each with its own transaction and
 * per-owner advisory lock, and wrapping the loop would hold that lock across
 * every source and serialise the whole account. So a partial redeem is a real
 * outcome — it leaves a real feed holding what resolved and REPORTS what did
 * not, the same summary shape as an import run.
 *
 * Exported so the DB-backed test can drive the whole loop rather than the
 * route's wrapping. The revoked gate lives HERE rather than in the route: a
 * core that mints feeds from a shared artifact has to enforce its own
 * precondition, or the next caller is the one that forgets. Throws
 * FORMULA_REVOKED / FORMULA_NOT_FOUND; anyone may redeem, so there is no
 * ownership check to make.
 */
export async function redeemFormulaForOwner(
  formulaId: string,
  ownerId: string,
): Promise<{ feedId: string; added: number; failed: RedeemFailure[] }> {
  const {
    rows: [f],
  } = await pool.query<{
    id: string;
    name: string;
    appearance: Record<string, unknown>;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, appearance, revoked_at FROM feed_formulas WHERE id = $1`,
    [formulaId],
  );
  if (!f) throw tagged("FORMULA_NOT_FOUND");
  // D10: revoking cannot un-add — it stops FUTURE redemptions and nothing else.
  if (f.revoked_at) throw tagged("FORMULA_REVOKED");

  // The feed exists before the first source lands, which is what makes a
  // partial redeem survivable. Appearance travels verbatim (§5) — the look is
  // part of the curatorial claim, and the recipient restyles it afterwards like
  // any feed.
  const feed = await createFeedForOwner(ownerId, f.name, pool, {
    appearance: f.appearance ?? {},
    fromFormulaId: f.id,
  });

  const { added, failed } = await populateFeedFromFormula(
    feed.id,
    ownerId,
    formulaId,
  );
  return { feedId: feed.id, added, failed };
}

/**
 * The source-population half of a redeem: resolve each frozen source by
 * portable identity and land it on an ALREADY-EXISTING feed via the addSource
 * core. Split from redeemFormulaForOwner so the starter-seed path can mint the
 * feed inside its own short claim transaction and run this on the pool
 * afterwards (§0s.4) — never call it while holding a pooled client, since
 * every addSource inside opens a further transaction of its own.
 */
export async function populateFeedFromFormula(
  feedId: string,
  ownerId: string,
  formulaId: string,
): Promise<{ added: number; failed: RedeemFailure[] }> {
  const { rows: sources } = await pool.query<{
    position: number;
    source_type: string;
    protocol: string | null;
    tag_value: string;
    tag_hint: string | null;
    display_name: string | null;
    avatar_url: string | null;
    weight: string;
    sampling_mode: string;
    exclude_replies: boolean;
  }>(
    `SELECT position, source_type, protocol::text AS protocol, tag_value, tag_hint,
            display_name, avatar_url, weight, sampling_mode, exclude_replies
       FROM feed_formula_sources WHERE formula_id = $1 ORDER BY position ASC`,
    [formulaId],
  );

  const failed: RedeemFailure[] = [];
  let added = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const label = s.display_name ?? s.tag_value;
    try {
      const input = await resolveFormulaSource(s);
      if (!input) {
        failed.push({ position: s.position, label, reason: "unresolvable" });
        continue;
      }
      const result = await addSource(feedId, ownerId, input, {
        // skipProbe deliberately NOT set (§6): a formula can be months old and
        // its URLs can rot, so a genuinely new identity is probed. Everything
        // this instance already holds healthy short-circuits the probe anyway,
        // which is the common case in v1.
        //
        // §6.4b stampede brake — trickle the subscribe-time ingest jobs rather
        // than dumping N immediate fetches on the worker.
        enqueueRunAt: new Date(
          Date.now() +
            (i + 1) * ENQUEUE_SPACING_MS +
            Math.floor(Math.random() * ENQUEUE_SPACING_MS),
        ),
      });
      // Tuning travels with the composition (§5). addSource's insert takes only
      // the target, so the weight/sampling/replies triple is applied straight
      // after — scoped to the row it just minted in the feed this call just
      // created, so there is nothing else it could touch.
      await pool.query(
        `UPDATE feed_sources SET weight = $2, sampling_mode = $3, exclude_replies = $4
          WHERE id = $1`,
        [result.source.id, s.weight, s.sampling_mode, s.exclude_replies],
      );
      added++;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "DUPLICATE") {
        // The formula named the same target twice. Idempotent, not a failure —
        // the source is on the feed either way.
        continue;
      }
      failed.push({
        position: s.position,
        label,
        reason:
          code === "SOURCE_UNREACHABLE"
            ? "unreachable"
            : code === "SOURCE_URI_INVALID"
              ? "invalid"
              : "error",
      });
      logger.warn(
        { err, ownerId, formulaId, position: s.position },
        "Formula source failed to redeem",
      );
    }
  }
  return { added, failed };
}

/**
 * Turn one frozen source back into an addSource call.
 *
 * Resolution by identity is the point (D4): a pubkey is looked UP, never
 * assumed to be the id it was at freeze time, and an external source is handed
 * to addSource's (protocol, sourceUri) branch which creates-or-finds. Returns
 * null when the identity resolves to nothing here — a member who deleted their
 * account, a publication that no longer exists — which is a reported failure,
 * not a thrown one.
 */
async function resolveFormulaSource(
  row: {
    source_type: string;
    protocol: string | null;
    tag_value: string;
    tag_hint: string | null;
    display_name: string | null;
    avatar_url: string | null;
  },
): Promise<AddSourceInput | null> {
  if (row.source_type === "account") {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
      [row.tag_value],
    );
    return rows[0] ? { sourceType: "account", accountId: rows[0].id } : null;
  }
  if (row.source_type === "publication") {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM publications WHERE nostr_pubkey = $1`,
      [row.tag_value],
    );
    return rows[0]
      ? { sourceType: "publication", publicationId: rows[0].id }
      : null;
  }
  if (row.source_type === "tag") {
    return { sourceType: "tag", tagName: row.tag_value };
  }
  if (!isPortableProtocol(row.protocol)) return null;
  return {
    sourceType: "external_source",
    protocol: row.protocol,
    sourceUri: row.tag_value,
    // Frozen display metadata rides along so a source this instance has never
    // held does not land with a bare-URI label.
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    relayUrls:
      row.protocol === "nostr_external" && row.tag_hint
        ? [row.tag_hint]
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes — workspace-scoped half
// ---------------------------------------------------------------------------

export function registerFeedFormulaRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /workspace/feeds/:id/formula/preview — what a recipient would receive
  //
  // Read-only, and the composer's publish sheet renders it before offering the
  // button (§6, D5). Registered BEFORE the POST below only for readability;
  // Fastify routes on method + path, so the order is not load-bearing.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/feeds/:id/formula/preview",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      // Owner-scoped, like every other feed read: a preview names every source
      // in the feed, so it is exactly as private as the feed itself.
      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const cap = await formulaMaxSources();
      const preview = await previewFeedFormula(pool, id, cap);
      return reply.send({
        preview: {
          ...preview,
          // The defaults the freeze would apply if the author changes neither.
          name: feed.name,
          appearance: feed.appearance ?? {},
          maxSources: cap,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /workspace/feeds/:id/formula — freeze this feed's composition
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id/formula",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = publishSchema.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.status(400).send(zodValidationError(parsed.error));

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const cap = await formulaMaxSources();
      const result = await withTransaction((client) =>
        freezeFeedIntoFormula(client, {
          feedId: id,
          ownerId,
          name: parsed.data.name ?? feed.name,
          description: parsed.data.description ?? null,
          appearance: feed.appearance ?? {},
          maxSources: cap,
        }),
      );

      if (!result.ok) {
        if (result.reason === "empty")
          return reply.status(400).send({
            error: "formula_empty",
            message:
              result.excludedCount > 0
                ? "None of this feed's sources can be shared."
                : "Add at least one source before publishing this feed as a formula.",
            excludedCount: result.excludedCount,
          });
        return reply.status(409).send({
          error: "formula_too_large",
          message: `A formula can carry at most ${cap} sources; this feed has ${result.sourceCount}.`,
          sourceCount: result.sourceCount,
          maxSources: cap,
        });
      }

      logger.info(
        {
          ownerId,
          feedId: id,
          formulaId: result.formulaId,
          sourceCount: result.sourceCount,
          excluded: result.excludedCount,
        },
        "Feed formula published",
      );
      const {
        rows: [row],
      } = await pool.query<FormulaRow>(`${FORMULA_SELECT} WHERE ff.id = $1`, [
        result.formulaId,
      ]);
      return reply.status(201).send({
        formula: {
          id: result.formulaId,
          token: result.token,
          url: `/f/${result.token}`,
          ...formulaToResponse(row, await loadFormulaSources(result.formulaId)),
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Routes — public / account-scoped half (mounted at /api/v1)
// ---------------------------------------------------------------------------

export async function formulaPublicRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /my/formulas — the author's own list
  // -------------------------------------------------------------------------
  app.get("/my/formulas", { preHandler: requireAuth }, async (req, reply) => {
    if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
    const { rows } = await pool.query<FormulaRow>(
      `${FORMULA_SELECT} WHERE ff.author_id = $1 ORDER BY ff.created_at DESC`,
      [req.session!.sub],
    );
    return reply.send({
      formulas: await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          token: r.token,
          url: `/f/${r.token}`,
          isDefaultSeed: r.is_default_seed,
          ...formulaToResponse(r, await loadFormulaSources(r.id)),
        })),
      ),
    });
  });

  // -------------------------------------------------------------------------
  // GET /formulas/:token — the public preview page's data
  //
  // optionalAuth: a logged-out visitor sees the same composition and the
  // waitlist CTA; only redeeming needs an account.
  // -------------------------------------------------------------------------
  app.get<{ Params: { token: string } }>(
    "/formulas/:token",
    { preHandler: optionalAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
      const {
        rows: [f],
      } = await pool.query<FormulaRow>(`${FORMULA_SELECT} WHERE ff.token = $1`, [
        req.params.token,
      ]);
      if (!f) return reply.status(404).send({ error: "Formula not found" });
      return reply.send({
        formula: formulaToResponse(f, await loadFormulaSources(f.id)),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /formulas/:token/redeem — mint a new feed from this composition
  //
  // Deliberately NOT one transaction (§6). N sources means N addSource calls,
  // each with its own transaction and per-owner advisory lock; wrapping the
  // loop would hold that lock across every source and serialise the whole
  // account. So a partial redeem is a real outcome: it leaves a real feed
  // holding what resolved and REPORTS what did not, the same summary shape as
  // an import run.
  // -------------------------------------------------------------------------
  app.post<{ Params: { token: string } }>(
    "/formulas/:token/redeem",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const {
        rows: [f],
      } = await pool.query<FormulaRow>(`${FORMULA_SELECT} WHERE ff.token = $1`, [
        req.params.token,
      ]);
      if (!f) return reply.status(404).send({ error: "Formula not found" });

      let result;
      try {
        result = await redeemFormulaForOwner(f.id, ownerId);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "FORMULA_REVOKED")
          return reply.status(410).send({
            error: "formula_revoked",
            message: "This formula is no longer available.",
          });
        if (code === "FORMULA_NOT_FOUND")
          return reply.status(404).send({ error: "Formula not found" });
        throw err;
      }
      logger.info(
        {
          ownerId,
          formulaId: f.id,
          feedId: result.feedId,
          added: result.added,
          failed: result.failed.length,
        },
        "Feed formula redeemed",
      );
      // `failed` is reported, never swallowed: a redeem that quietly dropped
      // four sources would read to the recipient as the author's composition.
      return reply.status(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /formulas/:id — revoke
  //
  // D10: revoking cannot un-add. It stops future redemptions and NOTHING else;
  // no feed anywhere is touched. Stated in the ADR explicitly because "revoke"
  // reads as though it ought to reach into people's workspaces.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/formulas/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "Not found" });
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid formula id" });

      // The designated default seed cannot be revoked (D11). The schema CHECK
      // backs this refusal — this 409 exists to say WHY rather than let a
      // constraint violation surface as a 500.
      const { rows } = await pool.query<{ is_default_seed: boolean }>(
        `UPDATE feed_formulas SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1 AND author_id = $2 AND NOT is_default_seed
          RETURNING is_default_seed`,
        [id, req.session!.sub],
      );
      if (rows.length === 0) {
        const {
          rows: [survivor],
        } = await pool.query<{ is_default_seed: boolean }>(
          `SELECT is_default_seed FROM feed_formulas WHERE id = $1 AND author_id = $2`,
          [id, req.session!.sub],
        );
        if (survivor?.is_default_seed)
          return reply.status(409).send({
            error: "default_seed_formula",
            message:
              "This formula seeds every new account. Designate a replacement before revoking it.",
          });
        return reply.status(404).send({ error: "Formula not found" });
      }
      return reply.status(204).send();
    },
  );
}
