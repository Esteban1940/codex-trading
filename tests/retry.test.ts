import { describe, expect, it, vi } from "vitest";
import { sleep, withRetry } from "../src/infra/retry.js";

describe("retry helpers", () => {
  it("sleep resolves after timer", async () => {
    vi.useFakeTimers();
    const p = sleep(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("withRetry retries and succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;

    const p = withRetry(
      async () => {
        attempt += 1;
        if (attempt < 3) throw new Error("transient");
        return "ok";
      },
      3,
      50
    );

    await vi.advanceTimersByTimeAsync(50 + 100);
    await expect(p).resolves.toBe("ok");
    expect(attempt).toBe(3);
    vi.useRealTimers();
  });

  it("withRetry does not retry when predicate returns false", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => {
          attempt += 1;
          throw new Error("fatal");
        },
        3,
        10,
        () => false
      )
    ).rejects.toThrow("fatal");
    expect(attempt).toBe(1);
  });
});
