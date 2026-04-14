import { URL } from 'node:url'
import dns from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import logger from './logger.js'

// =============================================================================
// SSRF-hardened HTTP client
//
// Shared utility for fetching external URLs safely. Used by:
//   - feed-ingest (RSS polling, metadata refresh)
//   - gateway (universal resolver URL probing, RSS discovery)
//
// Protections:
//   - Rejects private/loopback IP ranges
//   - Rejects non-HTTP(S) schemes
//   - 10-second timeout
//   - 5MB response size limit
//   - Max 3 redirects (re-validated at each hop)
//   - Custom User-Agent identifying as a feed reader
// =============================================================================

const USER_AGENT = 'all.haus/1.0 (feed reader; +https://all.haus)'
const MAX_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024  // 5MB
const MAX_REDIRECTS = 3

// Private/reserved IP ranges (RFC 1918, loopback, link-local, etc.)
const PRIVATE_RANGES = [
  /^127\./,                         // 127.0.0.0/8 loopback
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^169\.254\./,                    // 169.254.0.0/16 link-local
  /^0\./,                           // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^::1$/,                          // IPv6 loopback
  /^fe80:/i,                        // IPv6 link-local
  /^fc00:/i,                        // IPv6 ULA
  /^fd/i,                           // IPv6 ULA
  /^::ffff:/i,                      // IPv4-mapped IPv6 — re-validated via embedded v4
  /^(22[4-9]|23\d)\./,             // 224.0.0.0/4 IPv4 multicast
  /^ff/i,                           // IPv6 multicast
]

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_RANGES.some(re => re.test(ip))) return true
  // IPv4-mapped IPv6 ("::ffff:10.0.0.1") — extract and re-check the embedded v4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped && PRIVATE_RANGES.some(re => re.test(mapped[1]))) return true
  return false
}

interface ResolvedHost {
  address: string
  family: 4 | 6
}

async function resolveAndValidateHost(hostname: string): Promise<ResolvedHost> {
  // Short-circuit literal IPs so safeFetch('http://10.0.0.1') still gets
  // caught — dns.resolve* only works on hostnames.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${hostname}`)
    }
    return { address: hostname, family: 4 }
  }
  if (hostname.includes(':') && hostname !== 'localhost') {
    if (isPrivateIp(hostname)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${hostname}`)
    }
    return { address: hostname, family: 6 }
  }

  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[])
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[])
    const allAddrs = [
      ...addresses.map(a => ({ address: a, family: 4 as const })),
      ...addresses6.map(a => ({ address: a, family: 6 as const })),
    ]

    if (allAddrs.length === 0) {
      throw new Error(`Could not resolve hostname: ${hostname}`)
    }

    for (const { address } of allAddrs) {
      if (isPrivateIp(address)) {
        throw new Error(`Hostname ${hostname} resolves to private IP ${address}`)
      }
    }
    // Return the first validated address — undici pins to this one via the
    // custom lookup hook in buildPinnedAgent(), so the OS resolver never
    // gets a second chance to return a hostile answer.
    return allAddrs[0]
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
    if (err instanceof Error && err.message.includes('Could not resolve')) throw err
    throw new Error(`DNS resolution failed for ${hostname}: ${err}`)
  }
}

// Back-compat wrapper used by validateWebSocketUrl — callers outside safeFetch
// just need the allow/reject decision, not the pinned address.
async function validateHost(hostname: string): Promise<void> {
  await resolveAndValidateHost(hostname)
}

// Build an undici Agent whose connect() is pinned to the already-validated
// address. Closes the DNS-rebinding TOCTOU gap: the OS resolver will be
// called again for the hostname once the HTTP client tries to open the
// socket, and a hostile authoritative DNS server could return a different
// (private) IP the second time. Undici's `connect.lookup` hook intercepts
// that second lookup and forces the address we already cleared.
function buildPinnedAgent(expectedHost: string, resolved: ResolvedHost): Agent {
  return new Agent({
    connect: {
      lookup(hostname, _opts, cb) {
        if (hostname !== expectedHost) {
          // Should never happen — the agent is built for a specific hostname
          // and only used for a single request — but guard anyway so we
          // never resolve an attacker-supplied CNAME.
          cb(new Error(`Unexpected host ${hostname} in pinned agent for ${expectedHost}`), '', 0)
          return
        }
        cb(null, resolved.address, resolved.family)
      },
    },
  })
}

export interface SafeFetchOptions {
  headers?: Record<string, string>
  timeout?: number
  maxBytes?: number
  method?: string
  body?: string | Uint8Array
}

export interface SafeFetchResult {
  ok: boolean
  status: number
  headers: Headers
  text: string
  url: string
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const timeout = options.timeout ?? MAX_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const parsed = new URL(currentUrl)

    // Reject non-HTTP schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported scheme: ${parsed.protocol}`)
    }

    // Validate hostname AND pin the resolved IP so undici can't be tricked by
    // a second DNS lookup into connecting to a different (private) address.
    const resolved = await resolveAndValidateHost(parsed.hostname)
    const agent = buildPinnedAgent(parsed.hostname, resolved)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await undiciFetch(currentUrl, {
        method: options.method ?? 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': '*/*',
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: agent,
      })

      // Handle redirects manually so we can re-validate each hop
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          throw new Error(`Redirect ${response.status} with no Location header`)
        }
        redirectCount++
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
        }
        // Resolve relative redirects
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }

      // Read body with size limit
      const reader = response.body?.getReader()
      if (!reader) {
        return { ok: response.ok, status: response.status, headers: response.headers as unknown as Headers, text: '', url: currentUrl }
      }

      const chunks: Uint8Array[] = []
      let totalBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel()
          throw new Error(`Response exceeds ${maxBytes} byte limit`)
        }
        chunks.push(value)
      }

      const decoder = new TextDecoder()
      const text = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode()

      return { ok: response.ok, status: response.status, headers: response.headers as unknown as Headers, text, url: currentUrl }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms: ${currentUrl}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      // Release the per-request Agent — we build a fresh one per redirect hop.
      agent.close().catch(() => { /* best-effort */ })
    }
  }
}

// Validate a WebSocket URL for SSRF: scheme must be ws:/wss:, hostname must not
// resolve to a private/reserved IP. Call before `new WebSocket(url)`.
// Note: does NOT pin the resolved IP — there is still a TOCTOU gap between
// this check and the WS library's own DNS lookup. Pinning (Dispatcher-style)
// is tracked separately (S1). This still blocks the obvious user-supplied
// `ws://169.254.169.254/…` and `ws://localhost/…` attacks.
export async function validateWebSocketUrl(url: string, maxLength = 2048): Promise<void> {
  if (url.length > maxLength) {
    throw new Error(`WebSocket URL exceeds ${maxLength} chars`)
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid WebSocket URL: ${url}`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported WebSocket scheme: ${parsed.protocol}`)
  }
  await validateHost(parsed.hostname)
}
