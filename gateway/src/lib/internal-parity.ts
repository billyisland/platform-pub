import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// internal-parity — the gateway proves, at boot, that it holds the same shared
// secrets as the services it calls.
//
// THE BUG THIS EXISTS TO END (found on prod 2026-08-07). `INTERNAL_SERVICE_TOKEN`
// differed between `gateway/.env` and `payment-service/.env`. The payment
// service answered 403 to everything the gateway proxied — including
// `/gate-pass`, which is the paywall — so EVERY paywalled unlock failed while
// the site looked entirely healthy. Nothing detected it. It surfaced only
// because a new admin panel happened to proxy on a page load rather than behind
// a button, and even then it took three rounds to identify, because the gateway
// passed the upstream status to the browser without logging it.
//
// A drifted shared secret is the worst shape a config error can take: it is
// silent, it is total for the paths it touches, and it looks like nothing. The
// fix is one line in one file — the cost is entirely in NOT KNOWING.
//
// TWO SECRETS, THREE PEERS. `INTERNAL_SECRET` (gateway → key-custody,
// key-service) has the wider surface of the two and breaks publishing, key
// issuance and paywalled delivery; `INTERNAL_SERVICE_TOKEN` (gateway → payment)
// breaks the money paths. Both are checked, because building this for only the
// one that happened to bite would leave the larger hole open.
//
// HOW THE PROOF WORKS. Each peer exposes `GET /api/v1/auth-check` behind ITS OWN
// existing internal guard. Reaching the handler proves the caller's secret
// matches the verifier's, so a 200 IS the parity proof — no hash, fingerprint or
// length is exchanged, because the guard already answers the question and an
// echoed digest would be a disclosure surface bought for nothing.
//
// WHY THIS DOES NOT BLOCK `listen()`. The gateway serves all free reading, auth
// and feeds; coupling its availability to a money or key service being up at
// startup would be a worse bug than the one being fixed. So the probe runs
// AFTER the gateway is listening and its own healthcheck can pass, and only a
// DEFINITIVE mismatch is ever acted on.
// =============================================================================

/**
 * What a peer's answer proves. The terminal/ambiguous split is the same
 * discipline `payment-service/src/lib/charge-errors.ts` applies to Stripe: a
 * deterministic rejection that will never succeed on retry is a different fact
 * from a failure that might be transient, and conflating them is how you either
 * ignore a real fault or act on a blip.
 */
export type ParityVerdict =
  /** 200 — the secrets match. */
  | "match"
  /** 401/403 — they provably differ. Terminal; retrying cannot change it. */
  | "mismatch"
  /** 404 — peer predates the probe endpoint. Not a mismatch. */
  | "no_endpoint"
  /** Anything else, including no response at all. Ambiguous; retry. */
  | "unreachable";

/**
 * Classify a peer's HTTP status.
 *
 * **401 AND 403 ARE BOTH TERMINAL, AND THIS WAS MEASURED, NOT ASSUMED.** The
 * three peers disagree about which they return: `payment-service`'s
 * `requireInternalToken` sends **403**, while `key-service`'s plugin-scope
 * preHandler and `key-custody`'s `requireInternalSecret` both send **401**. A
 * classifier written for 403 alone — the status of the incident that prompted
 * this — would silently never detect an `INTERNAL_SECRET` drift at all, which is
 * the wider of the two surfaces. It would also pass every test anyone thought to
 * write, because the one failure they had in mind was the payment one.
 *
 * **404 is NOT a mismatch.** A peer running an older image has no `/auth-check`,
 * and treating that as a definitive failure would crash-loop the gateway during
 * any partial deploy — turning a routine version skew into an outage. Reported
 * distinctly because "old peer" and "peer is down" want different responses.
 *
 * **503 is ambiguous, not terminal.** It is what `key-custody` returns when its
 * OWN secret is unset. That would be a fatal config error, but it is the peer's
 * to report — and in practice unreachable, since all three peers `requireEnv`
 * their secret and refuse to boot without it.
 */
export function classifyParityStatus(status: number): ParityVerdict {
  if (status === 200) return "match";
  if (status === 401 || status === 403) return "mismatch";
  if (status === 404) return "no_endpoint";
  return "unreachable";
}

export interface ParityPeer {
  /** Name as it appears in logs. */
  name: string;
  /** Base URL env var, e.g. PAYMENT_SERVICE_URL. */
  urlEnv: string;
  /** The header this peer authenticates on. */
  header: string;
  /** The env var holding the shared secret, e.g. INTERNAL_SECRET. */
  secretEnv: string;
}

export const PARITY_PEERS: ParityPeer[] = [
  {
    name: "payment-service",
    urlEnv: "PAYMENT_SERVICE_URL",
    header: "x-internal-token",
    secretEnv: "INTERNAL_SERVICE_TOKEN",
  },
  {
    name: "key-custody",
    urlEnv: "KEY_CUSTODY_URL",
    header: "x-internal-secret",
    secretEnv: "INTERNAL_SECRET",
  },
  {
    name: "key-service",
    urlEnv: "KEY_SERVICE_URL",
    header: "x-internal-secret",
    secretEnv: "INTERNAL_SECRET",
  },
];

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Backoff between ambiguous retries, in ms, and the number of attempts. Peers
 * start alongside the gateway, so the early attempts are expected to miss; the
 * window is generous enough to outlast an ordinary compose start and bounded so
 * a peer that never comes up produces one clear report rather than a log that
 * grows forever.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000];

async function probeOnce(peer: ParityPeer, baseUrl: string, secret: string): Promise<ParityVerdict> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/auth-check`, {
      method: "GET",
      headers: { [peer.header]: secret },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return classifyParityStatus(res.status);
  } catch {
    // No response at all — refused, timed out, DNS. Never terminal.
    return "unreachable";
  }
}

/**
 * Probe one peer until it gives a definitive answer or the retry window closes.
 *
 * Resolves `true` when parity is PROVEN, `false` when it is provably broken, and
 * `null` when we never got a definitive answer. The three are deliberately
 * distinct: "never confirmed" must not be reported as "fine", which is the whole
 * failure mode this module exists to end, one level up.
 */
export async function verifyPeerParity(
  peer: ParityPeer,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean | null> {
  const baseUrl = process.env[peer.urlEnv];
  const secret = process.env[peer.secretEnv];

  if (!baseUrl || !secret) {
    // Not this module's failure to raise: the callers of that peer already
    // requireEnv what they need, and inventing a second boot-time gate here
    // would fail the gateway for a reason unrelated to parity.
    logger.warn(
      { peer: peer.name, urlEnv: peer.urlEnv, secretEnv: peer.secretEnv },
      "Internal parity: peer URL or secret not configured — parity NOT verified for this peer",
    );
    return null;
  }

  for (let attempt = 0; ; attempt++) {
    const verdict = await probeOnce(peer, baseUrl, secret);

    if (verdict === "match") {
      logger.info({ peer: peer.name, secretEnv: peer.secretEnv }, "Internal parity: confirmed");
      return true;
    }
    if (verdict === "mismatch") return false;

    if (attempt >= RETRY_DELAYS_MS.length) {
      logger.error(
        { peer: peer.name, secretEnv: peer.secretEnv, verdict, attempts: attempt + 1 },
        verdict === "no_endpoint"
          ? "Internal parity: peer has no /auth-check — an older image? Parity was NEVER VERIFIED for this peer; a drifted secret here would be silent"
          : "Internal parity: peer never answered. Parity was NEVER VERIFIED for this peer; a drifted secret here would be silent",
      );
      return null;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * Verify every peer, and REFUSE TO RUN if any secret provably differs.
 *
 * Called after `listen()` so the gateway is already serving — see the module
 * header. The exit is deliberate and was an explicit owner decision (2026-08-07):
 * with `restart: unless-stopped` the gateway will crash-loop, so the site is
 * down until the env is fixed. That is a real cost, accepted because the failure
 * is a one-line config error that can only be introduced at a deploy — when an
 * operator is present and watching — and because the alternative, logging and
 * carrying on, is precisely what allowed a broken paywall to go unnoticed.
 *
 * The exit is reached ONLY from a definitive 401/403. An unreachable or
 * old-image peer never kills the gateway.
 */
export async function assertInternalParity(): Promise<void> {
  const results = await Promise.all(
    PARITY_PEERS.map(async (peer) => ({ peer, ok: await verifyPeerParity(peer) })),
  );

  const broken = results.filter((r) => r.ok === false).map((r) => r.peer);
  if (broken.length === 0) return;

  logger.fatal(
    {
      peers: broken.map((p) => p.name),
      secrets: [...new Set(broken.map((p) => p.secretEnv))],
    },
    "SHARED SECRET MISMATCH — this gateway holds a different secret from the service(s) named, which answered 401/403 to a probe carrying it. Every call to them will fail, silently, including paywalled unlocks and article publishing. Refusing to start. Fix: make the named env var identical in gateway/.env and that service's .env, then recreate BOTH containers.",
  );
  process.exit(1);
}
