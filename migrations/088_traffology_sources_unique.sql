-- D36: Prevent SELECT-then-INSERT race in findOrCreateSource by adding a
-- unique constraint on (writer_id, source_type, domain, display_name).
-- NULLable domain requires a partial unique index pair.

CREATE UNIQUE INDEX idx_traf_sources_unique_with_domain
  ON traffology.sources (writer_id, source_type, domain, display_name)
  WHERE domain IS NOT NULL;

CREATE UNIQUE INDEX idx_traf_sources_unique_null_domain
  ON traffology.sources (writer_id, source_type, display_name)
  WHERE domain IS NULL;
