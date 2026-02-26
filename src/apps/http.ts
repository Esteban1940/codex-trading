import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "../infra/config.js";
import { snapshotMetrics } from "../infra/metrics.js";

/**
 * Builds read-only operational API app.
 */
export function createApp(): Express {
  const app = express();

  // Liveness probe for process/container health checks.
  app.get("/health", (_req, res) => { res.json({ ok: true, ts: Date.now() }); });

  // Runtime status snapshot for watchdogs/dashboards.
  app.get("/status", (_req, res) => {
    const now = Date.now();
    let heartbeatAgeMs: number | null = null;

    try {
      const raw = readFileSync(config.WORKER_HEARTBEAT_FILE, "utf-8");
      const parsed = JSON.parse(raw) as { ts?: number };
      if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
        heartbeatAgeMs = Math.max(0, now - parsed.ts);
      }
    } catch {
      // Heartbeat is optional for API-only mode.
    }

    res.json({
      ts: now,
      uptimeSec: Math.floor(process.uptime()),
      heartbeatAgeMs,
      metrics: snapshotMetrics()
    });
  });

  return app;
}

/**
 * Starts HTTP server on configured port and wires graceful shutdown signals.
 */
export function startServer(port = process.env.PORT ? Number(process.env.PORT) : 3000) {
  const app = createApp();
  const server = app.listen(port, () => { console.log(`Read-only API listening on ${port}`); });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`HTTP API shutdown requested (${signal})`);
    server.close((error?: Error) => {
      if (error) {
        console.error("HTTP API shutdown error", error);
        process.exitCode = 1;
        return;
      }
      process.exitCode = 0;
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
