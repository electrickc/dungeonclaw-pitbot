# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && addgroup -S pit && adduser -S pit -G pit && chown -R pit:pit /data /app
USER pit
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
