# Build from the repository root: docker build -f apps/core/Dockerfile .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
RUN corepack install
COPY packages/shared/package.json packages/shared/
COPY apps/core/package.json apps/core/
RUN pnpm install --frozen-lockfile --filter @sg/core...
COPY packages/shared packages/shared
COPY apps/core apps/core
RUN pnpm --filter @sg/shared build && pnpm --filter @sg/core build
RUN pnpm --filter @sg/core deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/core/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
