import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the module under test
const mockVerifySession = vi.fn()
const mockRefreshIfNeeded = vi.fn()
const mockQuery = vi.fn()

vi.mock('@platform-pub/shared/auth/session.js', () => ({
  verifySession: (...args: any[]) => mockVerifySession(...args),
  refreshIfNeeded: (...args: any[]) => mockRefreshIfNeeded(...args),
}))

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
}))

vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { requireAuth, optionalAuth } from '../src/middleware/auth.js'

function createMockReq(): any {
  return { headers: {} }
}

function createMockReply(): any {
  const reply: any = {}
  reply.status = vi.fn().mockReturnValue(reply)
  reply.send = vi.fn().mockReturnValue(reply)
  return reply
}

describe('requireAuth', () => {
  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
  })

  it('returns 401 when no session', async () => {
    mockVerifySession.mockResolvedValue(null)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({ error: 'Authentication required' })
  })

  it('returns 401 when session has no sub', async () => {
    mockVerifySession.mockResolvedValue({ sub: null, pubkey: 'abc' })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(401)
  })

  it('returns 403 when account not found', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(403)
  })

  it('returns 403 when account is suspended', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'suspended' }] })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(403)
  })

  it('injects headers and session for active account', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active' }] })
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(req.headers['x-reader-id']).toBe('user-1')
    expect(req.headers['x-reader-pubkey']).toBe('pk1')
    expect(req.headers['x-writer-id']).toBe('user-1')
    expect(req.session).toEqual({ sub: 'user-1', pubkey: 'pk1' })
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('calls refreshIfNeeded for valid sessions', async () => {
    const session = { sub: 'user-1', pubkey: 'pk1' }
    mockVerifySession.mockResolvedValue(session)
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active' }] })
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(mockRefreshIfNeeded).toHaveBeenCalledWith(req, reply, session)
  })
})

describe('optionalAuth', () => {
  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
  })

  it('attaches session when present', async () => {
    const session = { sub: 'user-1', pubkey: 'pk1' }
    mockVerifySession.mockResolvedValue(session)
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toEqual(session)
    expect(req.headers['x-reader-id']).toBe('user-1')
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('sets session to null when no valid session', async () => {
    mockVerifySession.mockResolvedValue(null)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toBeNull()
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('allows anonymous requests without error', async () => {
    mockVerifySession.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toBeNull()
    expect(req.headers['x-reader-id']).toBeUndefined()
  })
})
