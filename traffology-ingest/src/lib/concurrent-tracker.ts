// =============================================================================
// In-memory concurrent reader tracker
//
// Maintains a sliding-window count of active readers per piece.
// Sessions that haven't sent a beacon within WINDOW_MS are expired.
// Per ADR Section 8.4: rebuilds naturally within 5 min after restart.
// =============================================================================

const WINDOW_MS = 5 * 60 * 1000 // 5 minutes

interface ActiveSession {
  lastSeen: number
}

// Map<pieceId, Map<sessionToken, ActiveSession>>
const activeSessions = new Map<string, Map<string, ActiveSession>>()

export function touch(pieceId: string, sessionToken: string): void {
  let piece = activeSessions.get(pieceId)
  if (!piece) {
    piece = new Map()
    activeSessions.set(pieceId, piece)
  }
  piece.set(sessionToken, { lastSeen: Date.now() })
}

export function remove(pieceId: string, sessionToken: string): void {
  const piece = activeSessions.get(pieceId)
  if (!piece) return
  piece.delete(sessionToken)
  if (piece.size === 0) activeSessions.delete(pieceId)
}

export function getCount(pieceId: string): number {
  const piece = activeSessions.get(pieceId)
  if (!piece) return 0
  const cutoff = Date.now() - WINDOW_MS
  let count = 0
  for (const [token, session] of piece) {
    if (session.lastSeen < cutoff) {
      piece.delete(token)
    } else {
      count++
    }
  }
  if (piece.size === 0) activeSessions.delete(pieceId)
  return count
}

export function getCountsByPieceIds(pieceIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const pieceId of pieceIds) {
    const c = getCount(pieceId)
    if (c > 0) counts[pieceId] = c
  }
  return counts
}

// Periodic full cleanup every 60 seconds
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [pieceId, piece] of activeSessions) {
    for (const [token, session] of piece) {
      if (session.lastSeen < cutoff) piece.delete(token)
    }
    if (piece.size === 0) activeSessions.delete(pieceId)
  }
}, 60_000).unref()
