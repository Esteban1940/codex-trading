import express from "express";
import { snapshotMetrics } from "../infra/metrics.js";

const app = express();
// Liveness probe for process/container health checks.
app.get("/health", (_req, res) => { res.json({ ok: true, ts: Date.now() }); });
// Read-only runtime snapshot for dashboards and external watchdogs.
app.get("/status", (_req, res) => { res.json({ ts: Date.now(), metrics: snapshotMetrics() }); });

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => { console.log(`Read-only API listening on ${port}`); });
