import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

export const relayOutboxPrune: Task = async (_payload, _helpers) => {
  const { rowCount } = await pool.query(`
    DELETE FROM relay_outbox
    WHERE status = 'sent'
      AND updated_at < now() - INTERVAL '30 days'
  `);

  if (rowCount && rowCount > 0) {
    logger.info(
      { pruned: rowCount },
      "Pruned sent relay_outbox entries older than 30 days",
    );
  }
};
