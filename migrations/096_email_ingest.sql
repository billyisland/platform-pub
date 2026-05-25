-- Per-source ingest mailbox for email newsletter ingestion
ALTER TABLE external_sources ADD COLUMN ingest_address TEXT;
CREATE UNIQUE INDEX idx_ext_sources_ingest_addr
  ON external_sources(ingest_address) WHERE ingest_address IS NOT NULL;

-- Canonical URL for cross-source dedup (newsletter-to-RSS overlap)
ALTER TABLE external_items ADD COLUMN canonical_url TEXT;
CREATE INDEX idx_ext_items_canonical
  ON external_items(canonical_url) WHERE canonical_url IS NOT NULL;
