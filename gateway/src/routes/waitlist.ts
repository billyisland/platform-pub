import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";

// =============================================================================
// Waitlist Routes — closed-beta waiting list (CLOSED-BETA-ADR Phase 2, D2/D3)
//
// POST /waitlist — capture a prospective user's interest.
//
// Capture, not a mailto (D2): the stored list is the launch-cohort recruitment
// pipeline. Admitting a waitlister is a manual/next-phase action — this route
// only stores interest.
//
// ENUMERATION-SAFE by construction (D2/D5): the response is a fixed generic
// acknowledgement whether the email is new or already on the list, so the
// waitlist never leaks who is already a member or already waiting — mirroring
// the "if an account exists…" posture on POST /auth/login. The UNIQUE(email)
// constraint (migration 162) turns a repeat into an ON CONFLICT DO NOTHING
// no-op; email is lower-cased before insert so case variants collapse onto one
// row.
//
// Rate-limited like the other unauthenticated auth routes (5/min).
// =============================================================================

export async function waitlistRoutes(app: FastifyInstance) {
  const JoinSchema = z.object({
    // Trim first so a pasted "  you@x.com " passes .email() (Zod validates the
    // raw string) — the route then lower-cases for the unique key.
    // .max(254): the RFC 5321 address ceiling — Zod's .email() doesn't bound
    // length, and this route WRITES the value (a multi-KB "email" would insert
    // a junk row).
    email: z.string().trim().max(254).email(),
    // D3 — reader is the default identity; publishing is a single soft opt-in.
    // Optional so a stale/minimal client that omits it defaults to reader.
    publishInterest: z.boolean().optional(),
  });

  app.post(
    "/waitlist",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = JoinSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const email = parsed.data.email.toLowerCase().trim();
      const publishInterest = parsed.data.publishInterest ?? false;

      try {
        // Upsert. ON CONFLICT DO NOTHING keeps the endpoint enumeration-safe:
        // a repeat email is a silent no-op and returns the same ack. We do NOT
        // update publish_interest on conflict — the first expressed intent
        // stands, and flipping it on a repeat POST would leak (via a later
        // export) that the row already existed. A prospect who changes their
        // mind can write to the contact line (D2 mailto fallback).
        await pool.query(
          `INSERT INTO waitlist (email, publish_interest)
           VALUES ($1, $2)
           ON CONFLICT (email) DO NOTHING`,
          [email, publishInterest],
        );
      } catch (err) {
        // A storage failure must not reveal itself as different from success in
        // a way that aids enumeration, but a 500 here is a genuine fault worth
        // surfacing (the client can retry). Log with a redacted email.
        logger.error(
          { err, email: email.slice(0, 3) + "***" },
          "Waitlist join failed",
        );
        return reply.status(500).send({ error: "Failed to join the list" });
      }

      // Always the same acknowledgement — new or already present.
      return reply.status(200).send({
        ok: true,
        message: "You're on the list. We'll be in touch when there's room.",
      });
    },
  );
}
