# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && addgroup -S pit && adduser -S pit -G pit && chown -R pit:pit /data /app
USER pit
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
