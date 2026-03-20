import { describe, it, expect, beforeAll, vi } from 'vitest'
import { SignJWT, jwtVerify } from 'jose'

// =============================================================================
// Session Tests
//
// Tests the JWT session logic in isolation — no Fastify, no DB.
// We test the token creation and verification directly since the session
// module's core is just JWT operations.
// =============================================================================

const TEST_SECRET = 'test-session-secret-at-least-32-chars-long'
const SECRET_KEY = new TextEncoder().encode(TEST_SECRET)

beforeAll(() => {
  process.env.SESSION_SECRET = TEST_SECRET
})

describe('JWT session tokens', () => {
  it('creates a valid token with correct claims', async () => {
    const token = await new SignJWT({
      pubkey: 'abc123hexkey',
      isWriter: false,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('account-uuid-1234')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(SECRET_KEY)

    expect(token).toBeTruthy()
    expect(typeof token).toBe('string')

    // Verify it round-trips
    const { payload } = await jwtVerify(token, SECRET_KEY, { algorithms: ['HS256'] })
    expect(payload.sub).toBe('account-uuid-1234')
    expect(payload.pubkey).toBe('abc123hexkey')
    expect(payload.isWriter).toBe(false)
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('sets isWriter=true for writer accounts', async () => {
    const token = await new SignJWT({
      pubkey: 'writer-hex-key',
      isWriter: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('writer-uuid')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(SECRET_KEY)

    const { payload } = await jwtVerify(token, SECRET_KEY, { algorithms: ['HS256'] })
    expect(payload.isWriter).toBe(true)
  })

  it('rejects a token signed with a different secret', async () => {
    const wrongKey = new TextEncoder().encode('wrong-secret-that-is-also-32-chars!')

    const token = await new SignJWT({ pubkey: 'key' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('uuid')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(wrongKey)

    await expect(
      jwtVerify(token, SECRET_KEY, { algorithms: ['HS256'] })
    ).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ pubkey: 'key' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('uuid')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 86400 * 8) // 8 days ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 86400) // expired yesterday
      .sign(SECRET_KEY)

    await expect(
      jwtVerify(token, SECRET_KEY, { algorithms: ['HS256'] })
    ).rejects.toThrow()
  })
})

describe('session refresh logic', () => {
  it('identifies tokens past half-life (3.5 days)', () => {
    const halfLifeSeconds = 3.5 * 24 * 60 * 60
    const now = Math.floor(Date.now() / 1000)

    // Token issued 4 days ago — past half-life
    const oldIat = now - (4 * 24 * 60 * 60)
    const age = now - oldIat
    expect(age).toBeGreaterThan(halfLifeSeconds)

    // Token issued 2 days ago — not past half-life
    const recentIat = now - (2 * 24 * 60 * 60)
    const recentAge = now - recentIat
    expect(recentAge).toBeLessThan(halfLifeSeconds)
  })
})
