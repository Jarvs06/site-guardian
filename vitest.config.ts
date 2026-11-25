import { defineConfig } from "vitest/config";

// Unit tests: *.test.ts (integration tests *.int.test.ts are excluded).
// Integration tests: *.int.test.ts, run with `pnpm test:integration`.
// Plugin tests: plain-JS front-end tests of the WordPress plugin, under jsdom.
// End-to-end checks live in the `e2e` package (Playwright), run with `pnpm --filter e2e test`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/*/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages}/*/src/**/*.int.test.ts", "supabase/**/*.int.test.ts"],
          globalSetup: ["supabase/tests/globalSetup.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "plugin",
          root: "plugin",
          include: ["assets/js/__tests__/**/*.test.js"],
          exclude: ["**/node_modules/**", "vendor/**", "assets/vendor/**"],
          environment: "jsdom",
        },
      },
    ],
  },
});
