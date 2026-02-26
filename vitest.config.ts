import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        lines: 35,
        functions: 70,
        statements: 35,
        branches: 60
      }
    }
  }
});
