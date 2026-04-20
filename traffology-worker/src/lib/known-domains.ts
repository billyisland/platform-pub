// =============================================================================
// Known Domain Lookup Table
//
// Maps common referrer domains to human-readable display names and source types.
// Reviewed quarterly. ~200 entries covering the most common referrers seen by
// independent publishers.
// =============================================================================

interface KnownDomain {
  displayName: string
  sourceType: 'search' | 'link' | 'mailing-list' | 'nostr' | 'platform-internal'
}

export const KNOWN_DOMAINS: Record<string, KnownDomain> = {
  // Search engines
  'google.com': { displayName: 'Google search', sourceType: 'search' },
  'www.google.com': { displayName: 'Google search', sourceType: 'search' },
  'google.co.uk': { displayName: 'Google search', sourceType: 'search' },
  'google.de': { displayName: 'Google search', sourceType: 'search' },
  'google.fr': { displayName: 'Google search', sourceType: 'search' },
  'google.ca': { displayName: 'Google search', sourceType: 'search' },
  'google.com.au': { displayName: 'Google search', sourceType: 'search' },
  'google.co.jp': { displayName: 'Google search', sourceType: 'search' },
  'google.com.br': { displayName: 'Google search', sourceType: 'search' },
  'google.co.in': { displayName: 'Google search', sourceType: 'search' },
  'bing.com': { displayName: 'Bing search', sourceType: 'search' },
  'www.bing.com': { displayName: 'Bing search', sourceType: 'search' },
  'duckduckgo.com': { displayName: 'DuckDuckGo search', sourceType: 'search' },
  'search.yahoo.com': { displayName: 'Yahoo search', sourceType: 'search' },
  'yandex.ru': { displayName: 'Yandex search', sourceType: 'search' },
  'yandex.com': { displayName: 'Yandex search', sourceType: 'search' },
  'baidu.com': { displayName: 'Baidu search', sourceType: 'search' },
  'ecosia.org': { displayName: 'Ecosia search', sourceType: 'search' },
  'www.ecosia.org': { displayName: 'Ecosia search', sourceType: 'search' },
  'search.brave.com': { displayName: 'Brave search', sourceType: 'search' },
  'kagi.com': { displayName: 'Kagi search', sourceType: 'search' },
  'perplexity.ai': { displayName: 'Perplexity', sourceType: 'search' },
  'you.com': { displayName: 'You.com search', sourceType: 'search' },

  // Social — Bluesky
  'bsky.app': { displayName: 'Bluesky', sourceType: 'link' },
  'bsky.social': { displayName: 'Bluesky', sourceType: 'link' },

  // Social — Mastodon / Fediverse (major instances)
  'mastodon.social': { displayName: 'Mastodon', sourceType: 'link' },
  'mastodon.online': { displayName: 'Mastodon', sourceType: 'link' },
  'mas.to': { displayName: 'Mastodon', sourceType: 'link' },
  'fosstodon.org': { displayName: 'Mastodon (Fosstodon)', sourceType: 'link' },
  'hachyderm.io': { displayName: 'Mastodon (Hachyderm)', sourceType: 'link' },
  'infosec.exchange': { displayName: 'Mastodon (Infosec)', sourceType: 'link' },

  // Social — Reddit
  'reddit.com': { displayName: 'Reddit', sourceType: 'link' },
  'www.reddit.com': { displayName: 'Reddit', sourceType: 'link' },
  'old.reddit.com': { displayName: 'Reddit', sourceType: 'link' },

  // Social — Hacker News
  'news.ycombinator.com': { displayName: 'Hacker News', sourceType: 'link' },

  // Social — Twitter / X
  'twitter.com': { displayName: 'Twitter/X', sourceType: 'link' },
  'x.com': { displayName: 'Twitter/X', sourceType: 'link' },

  // Social — Threads
  'threads.net': { displayName: 'Threads', sourceType: 'link' },
  'www.threads.net': { displayName: 'Threads', sourceType: 'link' },

  // Social — Facebook / Meta
  'facebook.com': { displayName: 'Facebook', sourceType: 'link' },
  'www.facebook.com': { displayName: 'Facebook', sourceType: 'link' },
  'm.facebook.com': { displayName: 'Facebook', sourceType: 'link' },
  'l.facebook.com': { displayName: 'Facebook', sourceType: 'link' },
  'lm.facebook.com': { displayName: 'Facebook', sourceType: 'link' },

  // Social — LinkedIn
  'linkedin.com': { displayName: 'LinkedIn', sourceType: 'link' },
  'www.linkedin.com': { displayName: 'LinkedIn', sourceType: 'link' },

  // Social — Other
  'lobste.rs': { displayName: 'Lobsters', sourceType: 'link' },
  'tildes.net': { displayName: 'Tildes', sourceType: 'link' },
  'lemmy.world': { displayName: 'Lemmy', sourceType: 'link' },
  'pinboard.in': { displayName: 'Pinboard', sourceType: 'link' },
  'flipboard.com': { displayName: 'Flipboard', sourceType: 'link' },

  // Messaging (referrer often stripped, but sometimes leaks)
  'web.whatsapp.com': { displayName: 'WhatsApp', sourceType: 'link' },
  'web.telegram.org': { displayName: 'Telegram', sourceType: 'link' },
  'discord.com': { displayName: 'Discord', sourceType: 'link' },
  'slack.com': { displayName: 'Slack', sourceType: 'link' },

  // Email / newsletters
  'mail.google.com': { displayName: 'Gmail', sourceType: 'mailing-list' },
  'outlook.live.com': { displayName: 'Outlook', sourceType: 'mailing-list' },
  'outlook.office365.com': { displayName: 'Outlook', sourceType: 'mailing-list' },
  'mail.yahoo.com': { displayName: 'Yahoo Mail', sourceType: 'mailing-list' },
  'open.substack.com': { displayName: 'Substack email', sourceType: 'mailing-list' },
  'substack.com': { displayName: 'Substack', sourceType: 'link' },
  'email.mg.substack.com': { displayName: 'Substack email', sourceType: 'mailing-list' },
  'ghost.org': { displayName: 'Ghost', sourceType: 'link' },
  'beehiiv.com': { displayName: 'Beehiiv', sourceType: 'link' },
  'buttondown.email': { displayName: 'Buttondown', sourceType: 'mailing-list' },
  'convertkit.com': { displayName: 'ConvertKit', sourceType: 'mailing-list' },
  'mailchimp.com': { displayName: 'Mailchimp email', sourceType: 'mailing-list' },

  // Content platforms
  'medium.com': { displayName: 'Medium', sourceType: 'link' },
  'dev.to': { displayName: 'DEV', sourceType: 'link' },
  'hashnode.com': { displayName: 'Hashnode', sourceType: 'link' },
  'wordpress.com': { displayName: 'WordPress', sourceType: 'link' },

  // AI tools
  'chatgpt.com': { displayName: 'ChatGPT', sourceType: 'search' },
  'chat.openai.com': { displayName: 'ChatGPT', sourceType: 'search' },
  'claude.ai': { displayName: 'Claude', sourceType: 'search' },
  'gemini.google.com': { displayName: 'Gemini', sourceType: 'search' },

  // News aggregators
  'news.google.com': { displayName: 'Google News', sourceType: 'link' },
  'apple.news': { displayName: 'Apple News', sourceType: 'link' },
  'feedly.com': { displayName: 'Feedly', sourceType: 'link' },
  'inoreader.com': { displayName: 'Inoreader', sourceType: 'link' },
  'newsblur.com': { displayName: 'NewsBlur', sourceType: 'link' },
  'theoldreader.com': { displayName: 'The Old Reader', sourceType: 'link' },
  'feedbin.com': { displayName: 'Feedbin', sourceType: 'link' },
  'pocket.com': { displayName: 'Pocket', sourceType: 'link' },
  'getpocket.com': { displayName: 'Pocket', sourceType: 'link' },
  'instapaper.com': { displayName: 'Instapaper', sourceType: 'link' },

  // Nostr clients
  'snort.social': { displayName: 'Snort (Nostr)', sourceType: 'nostr' },
  'iris.to': { displayName: 'Iris (Nostr)', sourceType: 'nostr' },
  'primal.net': { displayName: 'Primal (Nostr)', sourceType: 'nostr' },
  'coracle.social': { displayName: 'Coracle (Nostr)', sourceType: 'nostr' },
  'nostrudel.ninja': { displayName: 'noStrudel (Nostr)', sourceType: 'nostr' },
  'satellite.earth': { displayName: 'Satellite (Nostr)', sourceType: 'nostr' },
  'habla.news': { displayName: 'Habla (Nostr)', sourceType: 'nostr' },
  'yakihonne.com': { displayName: 'YakiHonne (Nostr)', sourceType: 'nostr' },

  // Developer
  'github.com': { displayName: 'GitHub', sourceType: 'link' },
  'stackoverflow.com': { displayName: 'Stack Overflow', sourceType: 'link' },
  'gitlab.com': { displayName: 'GitLab', sourceType: 'link' },

  // Wikipedia
  'en.wikipedia.org': { displayName: 'Wikipedia', sourceType: 'link' },
  'wikipedia.org': { displayName: 'Wikipedia', sourceType: 'link' },
}

// Shortener domains that should be followed via HEAD request
export const SHORTENER_DOMAINS = new Set([
  't.co',
  'bit.ly',
  'tinyurl.com',
  'ow.ly',
  'buff.ly',
  'dlvr.it',
  'is.gd',
  'v.gd',
  'surl.li',
  'rb.gy',
  'cutt.ly',
  'shorturl.at',
  'tiny.cc',
])

// When a shortener can't be resolved, map to its known platform
export const SHORTENER_FALLBACKS: Record<string, string> = {
  't.co': 'a link via Twitter/X',
  'buff.ly': 'a link via Buffer',
  'dlvr.it': 'a link via dlvr.it',
}
