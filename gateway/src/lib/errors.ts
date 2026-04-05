import type { FastifyReply } from 'fastify'

// =============================================================================
// Standardised error response helper
//
// All gateway error responses should use this format:
//   { error: { code: string, message: string } }
//
// The `code` is a stable snake_case identifier for programmatic matching.
// The `message` is a human-readable description for debugging / display.
// =============================================================================

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } })
}
