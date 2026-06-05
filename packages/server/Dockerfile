FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN pnpm install --prod=false

# Build TypeScript
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Production image
FROM node:22-alpine AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --prod
COPY --from=build /app/dist ./dist
COPY bootstrap ./bootstrap

EXPOSE 8080
CMD ["node", "dist/index.js"]
