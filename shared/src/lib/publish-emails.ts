import { sendEmail } from './email.js'
import { pool } from '../db/client.js'
import { emailHtml, paragraph, button } from './subscription-emails.js'
import logger from './logger.js'

// =============================================================================
// Publish Notification Emails
//
// When a writer publishes a new article, notify all active subscribers who
// have opted in to publish notifications (notify_on_publish = true).
// =============================================================================

const APP_URL = process.env.APP_URL ?? 'http://localhost:3010'
const CONCURRENCY = 10

async function getWriterName(writerId: string): Promise<string | null> {
  const { rows } = await pool.query<{ display_name: string | null; username: string }>(
    `SELECT display_name, username FROM accounts WHERE id = $1`,
    [writerId]
  )
  if (rows.length === 0) return null
  return rows[0].display_name ?? rows[0].username
}

interface Subscriber {
  email: string
  display_name: string | null
  username: string
}

async function getOptedInSubscribers(writerId: string): Promise<Subscriber[]> {
  const { rows } = await pool.query<Subscriber>(
    `SELECT a.email, a.display_name, a.username
     FROM subscriptions s
     JOIN accounts a ON s.reader_id = a.id
     WHERE s.writer_id = $1
       AND s.status = 'active'
       AND s.notify_on_publish = true
       AND a.email IS NOT NULL`,
    [writerId]
  )
  return rows
}

async function sendOneNotification(
  subscriber: Subscriber,
  writerName: string,
  title: string,
  articleUrl: string,
): Promise<void> {
  await sendEmail({
    to: subscriber.email,
    subject: `New from ${writerName}: ${title}`,
    textBody: [
      `${writerName} just published "${title}".`,
      '',
      `Read it here: ${articleUrl}`,
      '',
      'You can manage email notifications from your account page.',
    ].join('\n'),
    htmlBody: emailHtml(
      `New from ${writerName}`,
      paragraph(`<strong>${writerName}</strong> just published a new article.`) +
      `<h3 style="font-size: 18px; color: #1c1917; margin-bottom: 16px;">${title}</h3>` +
      button(articleUrl, 'Read now') +
      paragraph(`<a href="${APP_URL}/account" style="color: #a8a29e; font-size: 12px;">Manage notifications</a>`)
    ),
  })
}

export async function sendPublishNotifications(
  writerId: string,
  articleId: string,
  title: string,
  dTag: string,
): Promise<void> {
  const writerName = await getWriterName(writerId)
  if (!writerName) return

  const subscribers = await getOptedInSubscribers(writerId)
  if (subscribers.length === 0) return

  const articleUrl = `${APP_URL}/article/${dTag}`

  logger.info(
    { writerId, articleId, subscriberCount: subscribers.length },
    'Sending publish notification emails'
  )

  // Send in batches to limit concurrency
  for (let i = 0; i < subscribers.length; i += CONCURRENCY) {
    const batch = subscribers.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(sub => sendOneNotification(sub, writerName, title, articleUrl))
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn({ err: result.reason }, 'Failed to send publish notification')
      }
    }
  }
}
