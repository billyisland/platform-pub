import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { generateKeypair } from "./key-custody-client.js";
import { randomBytes } from "crypto";

// =============================================================================
// provisionAccount — create an account for an email, WITHOUT a session
//
// The one home for "make this address a member". Two callers, and they must not
// drift:
//
//   • the Google OAuth exchange's unknown-email branch (open-beta only — closed
//     beta refuses before it reaches here, CLOSED-BETA-ADR D1);
//   • the operator's Admit action on the waitlist panel (§XI.2), which is
//     deliberately allowed to bypass that gate — an admission IS the decision
//     the gate exists to reserve to a person.
//
// SEPARATE FROM `signup()` IN shared/auth/accounts.ts ON PURPOSE. That function
// takes a FastifyReply and calls createSession on it, because it serves the
// self-service path where the account holder is the one making the request.
// Neither caller here is: driving it from the admit route would set the NEW
// USER'S session cookie on the ADMIN'S response — logging the operator out of
// their own account and into the prospect's, once per admission. The session is
// the whole difference, so this provisions and stops.
//
// What it does create, matching signup() field for field: the account row with
// its custodial keypair (minted by key-custody, so the gateway never sees the
// account key), status 'active', the 500p free allowance, and the reading tab
// every reader needs. Starter feeds are NOT seeded here — they seed lazily on
// the owner's first feed list (`seedStarterFeeds`, feeds/crud.ts), so a member
// provisioned by either path gets them on first load.
// =============================================================================

/**
 * Derive a username from what we know. Display name first (it is what a person
 * would have picked), the email's local part second, and `user` as the floor —
 * then a random suffix if the base is taken.
 *
 * The uniqueness check is advisory, not a guarantee: two concurrent
 * provisions of the same base can both read "free". The UNIQUE constraint on
 * accounts.username is the real defence, and the caller surfaces a 23505 as a
 * retryable failure rather than pretending it can't happen.
 */
async function deriveUsername(
  email: string,
  displayName: string,
): Promise<string> {
  let baseUsername = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);

  if (baseUsername.length < 3) {
    baseUsername = email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 30);
  }

  if (baseUsername.length < 3) {
    baseUsername = "user";
  }

  // Use the base username if it is free, otherwise append a random suffix.
  let username = baseUsername;
  const { rows: existing } = await pool.query<{ username: string }>(
    `SELECT username FROM accounts WHERE username = $1 OR username LIKE $2 ORDER BY username`,
    [baseUsername, `${baseUsername}-%`],
  );
  if (existing.some((r) => r.username === baseUsername)) {
    const taken = new Set(existing.map((r) => r.username));
    do {
      username = `${baseUsername}-${randomBytes(3).toString("hex")}`;
    } while (taken.has(username));
  }

  return username;
}

export interface ProvisionedAccount {
  accountId: string;
  username: string;
}

/**
 * Create an active account for `email` and return it. No session is set.
 *
 * `email` must already be lower-cased and trimmed by the caller (both callers
 * normalise for their own lookups first, and normalising twice in two places
 * is how the two copies drift apart).
 */
export async function provisionAccount(
  email: string,
  displayName: string,
): Promise<ProvisionedAccount> {
  const keypair = await generateKeypair();
  const username = await deriveUsername(email, displayName);

  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         status, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, 'active', 500)
       RETURNING id`,
      [
        keypair.pubkeyHex,
        keypair.privkeyEncrypted,
        username,
        displayName,
        email,
      ],
    );

    const accountId = result.rows[0].id;

    await client.query("INSERT INTO reading_tabs (reader_id) VALUES ($1)", [
      accountId,
    ]);

    return { accountId, username };
  });
}
