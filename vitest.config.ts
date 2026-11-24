import { defineConfig } from "vitest/config";

// Unit tests: *.test.ts (integration tests *.int.test.ts are excluded).
// Integration tests: *.int.test.ts, run with `pnpm test:integration`.
// Later tasks add the `plugin` and `e2e` workspace packages.
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
    ],
  },
});
