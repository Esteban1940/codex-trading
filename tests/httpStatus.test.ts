import { describe, expect, it } from "vitest";
import { createApp } from "../src/apps/http.js";

describe("http status api", () => {
  it("returns status payload with uptime and metrics object", async () => {
    const app = createApp();
    const server = app.listen(0);

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unable to bind test server");
      const response = await fetch(`http://127.0.0.1:${address.port}/status`);
      const body = (await response.json()) as {
        ts: number;
        uptimeSec: number;
        heartbeatAgeMs: number | null;
        metrics: Record<string, number>;
      };

      expect(response.ok).toBe(true);
      expect(typeof body.ts).toBe("number");
      expect(typeof body.uptimeSec).toBe("number");
      expect(body.heartbeatAgeMs === null || typeof body.heartbeatAgeMs === "number").toBe(true);
      expect(typeof body.metrics).toBe("object");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
