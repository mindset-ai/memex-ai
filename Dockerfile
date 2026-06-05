# Built with the repo root as the Cloud Build context so the @memex/server
# workspace dep on @memex/shared can resolve. See packages/server/deploy.sh.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Install all workspace deps using package.jsons only — keeps this layer
# cacheable when only source files change. `--ignore-scripts` is required:
# package `prepare` hooks (shared/ac-emit-vitest run `tsc`) would fire here,
# but source + tsconfig aren't copied until the build stage below, so `tsc`
# would find no inputs and fail. The real build happens explicitly at the
# build stage; install must not try to build.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build @memex/shared first, then @memex/server.
FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/server/tsconfig.json packages/server/tsconfig.build.json ./packages/server/
COPY packages/server/src ./packages/server/src
RUN pnpm --filter @memex/shared build && pnpm --filter @memex/server build

# Slim runtime image: prod deps + built dist + bootstrap scripts.
FROM base AS production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
# --ignore-scripts: same reason as the deps stage — the runtime image copies
# prebuilt dist from the build stage, so prepare hooks must not run here either.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY packages/server/bootstrap ./packages/server/bootstrap

WORKDIR /app/packages/server
EXPOSE 8080
CMD ["node", "dist/index.js"]
