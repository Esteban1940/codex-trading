import express from "express";
import { readFileSync } from "node:fs";
import { config } from "../infra/config.js";
import { snapshotMetrics } from "../infra/metrics.js";

const app = express();
// Liveness probe for process/container health checks.
app.get("/health", (_req, res) => { res.json({ ok: true, ts: Date.now() }); });
// Read-only runtime snapshot for dashboards and external watchdogs.
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

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => { console.log(`Read-only API listening on ${port}`); });
