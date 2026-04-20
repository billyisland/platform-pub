import geoip from 'geoip-lite'

// =============================================================================
// IP geolocation — country and city from IP address
//
// Uses geoip-lite's in-memory MaxMind database. No network calls.
// Returns null fields when lookup fails (private IPs, unknown ranges).
// =============================================================================

interface GeoResult {
  country: string | null
  city: string | null
}

export function lookupGeo(ip: string): GeoResult {
  const result = geoip.lookup(ip)
  if (!result) return { country: null, city: null }
  return {
    country: result.country || null,
    city: result.city || null,
  }
}
