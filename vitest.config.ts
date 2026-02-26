import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        lines: 38,
        functions: 70,
        statements: 38,
        branches: 60
      }
    }
  }
});
