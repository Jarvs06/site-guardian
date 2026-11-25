# Build from the repository root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
RUN corepack install
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @sg/worker...
COPY apps/worker apps/worker
RUN pnpm --filter @sg/worker build
RUN pnpm --filter @sg/worker deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
CMD ["node", "dist/main.js"]
