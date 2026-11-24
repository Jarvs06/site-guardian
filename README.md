# Site Guardian

pnpm monorepo: Core API (`apps/core`), worker (`apps/worker`), shared contracts (`packages/shared`). The WordPress plugin (`plugin/`) and Supabase migrations (`supabase/`) arrive in later tasks.

## Prerequisites

- Node 22 (`nvm use`, see `.nvmrc`)
- pnpm
- Docker
- Supabase CLI

## Local development

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Unit tests are `*.test.ts` (`pnpm test`). Integration tests are `*.int.test.ts` and run with `pnpm test:integration`.

Remaining steps, completed in later tasks:

1. Start local Supabase and apply migrations (Task 4).
2. Configure `.env` and run Core and the worker locally (Task 14).
