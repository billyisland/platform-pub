import logger from '../lib/logger.js'

// =============================================================================
// Email Service
//
// Sends transactional emails. At launch, the only email is the magic link.
//
// Provider selection via EMAIL_PROVIDER env var:
//   - 'postmark'  → Postmark API (recommended for transactional)
//   - 'resend'    → Resend API
//   - 'console'   → Logs to stdout (dev default)
//
// In dev, EMAIL_PROVIDER defaults to 'console' so magic link tokens appear
// in the terminal. In production, set EMAIL_PROVIDER and the relevant API key.
// =============================================================================

interface EmailParams {
  to: string
  subject: string
  textBody: string
  htmlBody: string
}

export async function sendEmail(params: EmailParams): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? 'console'

  switch (provider) {
    case 'postmark':
      return sendViaPostmark(params)
    case 'resend':
      return sendViaResend(params)
    case 'console':
    default:
      return sendViaConsole(params)
  }
}

// ---------------------------------------------------------------------------
// Magic link email — the specific email template
// ---------------------------------------------------------------------------

export async function sendMagicLinkEmail(
  to: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000'
  const verifyUrl = `${appUrl}/auth/verify?token=${encodeURIComponent(token)}`
  const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000)

  await sendEmail({
    to,
    subject: 'Your all.haus login link',
    textBody: [
      'Click this link to log in to all.haus:',
      '',
      verifyUrl,
      '',
      `This link expires in ${expiresInMinutes} minutes.`,
      '',
      'If you didn\'t request this, you can ignore this email.',
    ].join('\n'),
    htmlBody: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
          Log in to all.haus
        </h2>
        <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 24px;">
          Click the button below to log in. This link expires in ${expiresInMinutes} minutes.
        </p>
        <a href="${verifyUrl}"
           style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; border-radius: 6px; text-decoration: none;">
          Log in
        </a>
        <p style="font-size: 13px; color: #a8a29e; margin-top: 32px; line-height: 1.5;">
          If you didn't request this email, you can safely ignore it.
        </p>
        <p style="font-size: 12px; color: #d6d3d1; margin-top: 24px;">
          all.haus — writing worth reading
        </p>
      </div>
    `.trim(),
  })
}

// ---------------------------------------------------------------------------
// Broadcast email — for publish notifications (separate Postmark stream)
// ---------------------------------------------------------------------------

interface BroadcastEmailParams extends EmailParams {
  /** Override the From address (defaults to EMAIL_FROM_BROADCAST) */
  from?: string
}

export async function sendBroadcastEmail(params: BroadcastEmailParams): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? 'console'

  switch (provider) {
    case 'postmark':
      return sendBroadcastViaPostmark(params)
    case 'resend':
      return sendViaResend(params) // Resend has no separate broadcast concept
    case 'console':
    default:
      return sendBroadcastViaConsole(params)
  }
}

// =============================================================================
// Provider implementations
// =============================================================================

async function sendViaPostmark(params: EmailParams): Promise<void> {
  const apiKey = process.env.POSTMARK_API_KEY
  if (!apiKey) throw new Error('POSTMARK_API_KEY not set')

  const fromAddress = process.env.EMAIL_FROM ?? 'login@all.haus'

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: fromAddress,
      To: params.to,
      Subject: params.subject,
      TextBody: params.textBody,
      HtmlBody: params.htmlBody,
      MessageStream: 'outbound',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error({ status: res.status, body }, 'Postmark email failed')
    throw new Error(`Postmark API error: ${res.status}`)
  }

  logger.info({ to: params.to, subject: params.subject }, 'Email sent via Postmark')
}

async function sendViaResend(params: EmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY not set')

  const fromAddress = process.env.EMAIL_FROM ?? 'login@all.haus'

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [params.to],
      subject: params.subject,
      text: params.textBody,
      html: params.htmlBody,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error({ status: res.status, body }, 'Resend email failed')
    throw new Error(`Resend API error: ${res.status}`)
  }

  logger.info({ to: params.to, subject: params.subject }, 'Email sent via Resend')
}

async function sendViaConsole(params: EmailParams): Promise<void> {
  logger.info(
    {
      to: params.to,
      subject: params.subject,
      body: params.textBody,
    },
    '📧 Email (console provider — dev mode)'
  )
}

async function sendBroadcastViaPostmark(params: BroadcastEmailParams): Promise<void> {
  const apiKey = process.env.POSTMARK_API_KEY
  if (!apiKey) throw new Error('POSTMARK_API_KEY not set')

  const fromAddress = params.from ?? process.env.EMAIL_FROM_BROADCAST ?? 'posts@all.haus'
  const stream = process.env.POSTMARK_BROADCAST_STREAM ?? 'broadcast'

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: fromAddress,
      To: params.to,
      Subject: params.subject,
      TextBody: params.textBody,
      HtmlBody: params.htmlBody,
      MessageStream: stream,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error({ status: res.status, body }, 'Postmark broadcast email failed')
    throw new Error(`Postmark API error: ${res.status}`)
  }

  logger.info({ to: params.to, subject: params.subject, stream }, 'Broadcast email sent via Postmark')
}

async function sendBroadcastViaConsole(params: BroadcastEmailParams): Promise<void> {
  logger.info(
    {
      to: params.to,
      subject: params.subject,
      body: params.textBody,
    },
    '📧 Broadcast email (console provider — dev mode)'
  )
}
