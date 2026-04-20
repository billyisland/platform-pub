import UAParser from 'ua-parser-js'

// =============================================================================
// User-agent parsing — device type and browser family
//
// Device type classification: mobile, tablet, or desktop (default).
// Browser family: simplified name (Chrome, Firefox, Safari, etc.).
// =============================================================================

interface UAResult {
  deviceType: 'desktop' | 'mobile' | 'tablet'
  browserFamily: string | null
}

export function parseUA(userAgent: string | undefined): UAResult {
  if (!userAgent) return { deviceType: 'desktop', browserFamily: null }

  const parser = new UAParser(userAgent)
  const device = parser.getDevice()
  const browser = parser.getBrowser()

  let deviceType: 'desktop' | 'mobile' | 'tablet' = 'desktop'
  if (device.type === 'mobile') deviceType = 'mobile'
  else if (device.type === 'tablet') deviceType = 'tablet'

  return {
    deviceType,
    browserFamily: browser.name || null,
  }
}
