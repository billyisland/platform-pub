import "dotenv/config";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { paymentRoutes } from "./routes/payment.js";
import { webhookRoutes } from "./routes/webhook.js";
import { startPayoutWorker } from "./workers/payout.js";
import { startKycReconcileWorker } from "./workers/kyc-reconcile.js";
import { startSettlementReconcileWorker } from "./workers/settlement-reconcile.js";
import { pool } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "./lib/logger.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import { settlementService } from "./services/settlement.js";

// =============================================================================
// all.haus — Payment Service
// =============================================================================

// Validate required env vars at startup — fail fast
requireEnv("STRIPE_SECRET_KEY");
requireEnv("STRIPE_WEBHOOK_SECRET");
requireEnv("INTERNAL_SERVICE_TOKEN");
requireEnv("PLATFORM_SERVICE_PRIVKEY");
requireEnv("DATABASE_URL");

const app = Fastify({ logger: pinoConfig });

async function start() {
  // Plugins
  await app.register(sensible);

  // Routes
  await app.register(paymentRoutes, { prefix: "/api/v1" });
  await app.register(webhookRoutes);

  // Health check
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "payment-service" };
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const port = parseInt(process.env.PORT ?? "3001", 10);
  await app.listen({ port, host: "0.0.0.0" });

  // Resume any settlements that were reserved but crashed before Stripe responded
  settlementService.resumePendingSettlements().catch((err) => {
    logger.error({ err }, "Failed to resume pending settlements");
  });

  // Start background workers after HTTP server is ready
  startPayoutWorker();
  startKycReconcileWorker();
  startSettlementReconcileWorker();

  logger.info({ port }, "Payment service started");
}

start().catch((err) => {
  logger.error({ err }, "Failed to start payment service");
  process.exit(1);
});
