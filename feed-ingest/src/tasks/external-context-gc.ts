import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

export const externalContextGc: Task = async (_payload, _helpers) => {
  const {
    rows: [config],
  } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'external_context_gc_retention_days'`,
  );
  const retentionDays = parseInt(config?.value ?? "30", 10);

  const { rowCount } = await pool.query(
    `
    DELETE FROM external_items ei
    WHERE ei.is_context_only = TRUE
      AND ei.created_at < now() - ($1 || ' days')::interval
      AND ei.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM feed_items fi WHERE fi.external_item_id = ei.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM notes n WHERE n.external_parent_id = ei.id
      )
  `,
    [retentionDays],
  );

  if (rowCount && rowCount > 0) {
    logger.info(
      { pruned: rowCount, retentionDays },
      "Pruned context-only external items",
    );
  }
};
