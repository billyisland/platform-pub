/**
 * Generate the ES256 signing JWK for AT Protocol OAuth (ATPROTO_PRIVATE_JWK).
 *
 * In production (ATPROTO_CLIENT_BASE_URL is a public https origin), the atproto
 * OAuth client runs as a *confidential* client using private_key_jwt, so it
 * needs a private signing key. Without ATPROTO_PRIVATE_JWK set, getAtprotoClient()
 * throws and ALL Bluesky OAuth (link an existing account AND "set one up for me")
 * is dead — see shared/src/lib/atproto-oauth.ts and NETWORK-CONCIERGE-ADR §6.1.
 *
 * The public half is served automatically at /.well-known/jwks.json (derived
 * from this key by the client), so this one secret is all you set.
 *
 * Usage:
 *   npx tsx scripts/gen-atproto-jwk.ts                 # print the JWK to stdout
 *   echo "ATPROTO_PRIVATE_JWK=$(npx tsx scripts/gen-atproto-jwk.ts)" >> .env
 *
 * Then recreate the services that consume it:
 *   docker compose up -d gateway feed-ingest
 *
 * The JWK is a single-line JSON string with no `$`, so it drops straight into a
 * .env value (docker compose interpolation won't touch it). Rotating the key
 * invalidates any in-flight OAuth flows but not stored sessions' refresh ability
 * beyond the next refresh; generate once per environment and keep it stable.
 */

import { generateKeyPair, exportJWK } from "jose";

async function main(): Promise<void> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = {
    ...(await exportJWK(privateKey)),
    alg: "ES256",
    kid: "atproto-signing-key",
  };

  // JWK → stdout only (so it can be captured/piped); guidance → stderr.
  process.stdout.write(JSON.stringify(jwk));
  process.stderr.write(
    "\n↑ Set this as ATPROTO_PRIVATE_JWK in your root .env, then: docker compose up -d gateway feed-ingest\n",
  );
}

main().catch((err) => {
  process.stderr.write(`Failed to generate JWK: ${String(err)}\n`);
  process.exit(1);
});
