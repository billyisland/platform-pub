import { URL } from 'node:url'
import dns from 'node:dns/promises'
import net, { type LookupFunction } from 'node:net'
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

// Numeric IPv4 CIDR ranges as [low, high] inclusive 32-bit pairs. The old
// regex list missed non-canonical IPv6 forms ("::01" vs "::1", "fea0::1" in
// fe80::/10 but not fe80::/16); numeric comparison catches them all.
const PRIVATE_IPV4_RANGES: readonly [number, number][] = [
  [0x00000000, 0x00FFFFFF], // 0.0.0.0/8 "this network"
  [0x0A000000, 0x0AFFFFFF], // 10.0.0.0/8
  [0x7F000000, 0x7FFFFFFF], // 127.0.0.0/8 loopback
  [0xA9FE0000, 0xA9FEFFFF], // 169.254.0.0/16 link-local
  [0xAC100000, 0xAC1FFFFF], // 172.16.0.0/12
  [0xC0A80000, 0xC0A8FFFF], // 192.168.0.0/16
  [0x64400000, 0x647FFFFF], // 100.64.0.0/10 CGNAT
  [0xE0000000, 0xEFFFFFFF], // 224.0.0.0/4 multicast
  [0xF0000000, 0xFFFFFFFF], // 240.0.0.0/4 reserved
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const byte = Number(p)
    if (!Number.isInteger(byte) || byte < 0 || byte > 255 || String(byte) !== p) return null
    n = (n * 256) + byte
  }
  return n >>> 0
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => n >= lo && n <= hi)
}

// Parse any canonical IPv6 form into 8 × 16-bit words. Handles :: compression,
// zone IDs ("fe80::1%eth0"), and IPv4-embedded suffixes ("::ffff:10.0.0.1").
// Returns null on malformed input so callers treat it as "not matched" rather
// than throwing.
function parseIpv6(ip: string): number[] | null {
  const addr = ip.split('%')[0]
  if (!addr) return null

  // Detect trailing IPv4-embedded dotted quad. The separator is a single colon
  // in explicit form ("1:2:3:4:5:6:1.2.3.4") or part of a "::" compression
  // (":::1.2.3.4", "X::1.2.3.4"). After stripping, the leftover hexPart may
  // end in a single colon that's actually half of a compression marker — put
  // it back so the zero-run splitter below reads it correctly.
  let hexPart = addr
  let v4Words: number[] | null = null
  const v4Idx = hexPart.search(/:\d+\.\d+\.\d+\.\d+$/)
  if (v4Idx !== -1) {
    const v4Str = hexPart.slice(v4Idx + 1)
    const v4n = ipv4ToInt(v4Str)
    if (v4n === null) return null
    v4Words = [(v4n >>> 16) & 0xFFFF, v4n & 0xFFFF]
    hexPart = hexPart.slice(0, v4Idx)
    if (hexPart.endsWith(':') && !hexPart.endsWith('::')) hexPart += ':'
  }

  // At most one :: allowed
  const ccIdx = hexPart.indexOf('::')
  if (ccIdx !== -1 && hexPart.indexOf('::', ccIdx + 1) !== -1) return null

  let head: string[], tail: string[], hasCompression: boolean
  if (ccIdx === -1) {
    head = hexPart ? hexPart.split(':') : []
    tail = []
    hasCompression = false
  } else {
    const before = hexPart.slice(0, ccIdx)
    const after = hexPart.slice(ccIdx + 2)
    head = before ? before.split(':') : []
    tail = after ? after.split(':') : []
    hasCompression = true
  }

  const explicit = head.length + tail.length + (v4Words ? 2 : 0)
  if (explicit > 8) return null
  if (!hasCompression && explicit !== 8) return null
  const zerosNeeded = 8 - explicit

  const words: number[] = []
  for (const h of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null
    words.push(parseInt(h, 16))
  }
  for (let i = 0; i < zerosNeeded; i++) words.push(0)
  for (const h of tail) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null
    words.push(parseInt(h, 16))
  }
  if (v4Words) words.push(...v4Words)

  return words.length === 8 ? words : null
}

function isPrivateIpv6(ip: string): boolean {
  const w = parseIpv6(ip)
  if (!w) return false

  // :: (unspecified) and ::1 (loopback)
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 &&
      w[4] === 0 && w[5] === 0 && w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true

  // ::ffff:x.x.x.x (IPv4-mapped) — re-check embedded v4 against private ranges
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 &&
      w[4] === 0 && w[5] === 0xFFFF) {
    const v4 = (((w[6] << 16) >>> 0) | w[7]) >>> 0
    if (PRIVATE_IPV4_RANGES.some(([lo, hi]) => v4 >= lo && v4 <= hi)) return true
  }

  // fe80::/10 link-local, fc00::/7 unique local, ff00::/8 multicast
  if ((w[0] & 0xFFC0) === 0xFE80) return true
  if ((w[0] & 0xFE00) === 0xFC00) return true
  if ((w[0] & 0xFF00) === 0xFF00) return true

  return false
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip)
  if (net.isIPv6(ip)) return isPrivateIpv6(ip)
  return false
}

interface ResolvedHost {
  address: string
  family: 4 | 6
}

async function resolveAndValidateHost(hostname: string): Promise<ResolvedHost> {
  // Short-circuit literal IPs so safeFetch('http://10.0.0.1') still gets
  // caught — dns.resolve* only works on hostnames. Use net.isIP* rather than
  // regex so non-canonical IPv6 forms ("[::1]" stripped of brackets, etc.)
  // aren't silently treated as hostnames and fall through to DNS.
  if (net.isIPv4(hostname)) {
    if (isPrivateIpv4(hostname)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${hostname}`)
    }
    return { address: hostname, family: 4 }
  }
  if (net.isIPv6(hostname)) {
    if (isPrivateIpv6(hostname)) {
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

// Validate a WebSocket URL for SSRF AND return options that pin the resolved
// IP so the ws library's own lookup can't be tricked into connecting to a
// different (private) address between our check and the connect. Thread the
// returned object through `new WebSocket(url, protocols?, options)` — the
// `lookup` hook forces the already-validated address for the original host
// and refuses to resolve anything else.
//
// Scheme must be ws:/wss:, hostname must not resolve to a private/reserved IP.
export interface PinnedWebSocketOptions {
  lookup: LookupFunction
}

export async function pinnedWebSocketOptions(
  url: string,
  maxLength = 2048
): Promise<PinnedWebSocketOptions> {
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

  const resolved = await resolveAndValidateHost(parsed.hostname)
  const expectedHost = parsed.hostname

  return {
    lookup: (hostname, _opts, cb) => {
      // `ws` forwards this to net.connect/tls.connect. Guard against anything
      // other than the hostname we already cleared — the pinned options
      // object is built for a single request, so any other hostname means
      // something is wrong and we should refuse rather than re-resolve.
      if (hostname !== expectedHost) {
        cb(new Error(`Unexpected host ${hostname} in pinned WS lookup for ${expectedHost}`) as NodeJS.ErrnoException, '', 0)
        return
      }
      cb(null, resolved.address, resolved.family)
    },
  }
}

// Back-compat: validate without returning pin options. Kept for callers
// that only need the allow/reject decision. New call sites should use
// pinnedWebSocketOptions and thread the result into the WebSocket ctor.
export async function validateWebSocketUrl(url: string, maxLength = 2048): Promise<void> {
  await pinnedWebSocketOptions(url, maxLength)
}
