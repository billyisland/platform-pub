-- =============================================================================
-- Migration 006: Receipt portability
--
-- Adds two columns to read_events:
--   reader_pubkey  — the reader's actual Nostr pubkey (stored privately in DB;
--                    the public kind 9901 relay event still uses the keyed HMAC
--                    hash to preserve reader privacy on the public relay)
--   receipt_token  — a full signed Nostr kind 9901 event JSON containing the
--                    reader's actual pubkey, verifiable offline with verifyEvent()
--                    from nostr-tools. Serves as a portable bearer receipt the
--                    reader can export and present to other hosts.
-- =============================================================================

ALTER TABLE read_events
  ADD COLUMN IF NOT EXISTS reader_pubkey  TEXT,
  ADD COLUMN IF NOT EXISTS receipt_token  TEXT;
