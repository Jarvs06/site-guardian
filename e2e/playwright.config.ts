import { defineConfig } from "@playwright/test";

// Stage 1 end-to-end checks. Needs: local Supabase (`supabase start`), the WordPress stack
// (`docker compose up -d && scripts/dev-setup.sh`). Core is built and run by the tests themselves.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  // The checks share one WordPress site and one Core process, and some stop Core: run them in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
  },
});
