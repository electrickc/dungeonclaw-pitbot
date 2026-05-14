FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist

# Run as a non-root user. SecretVM also enforces this at the platform layer.
RUN addgroup -S pit && adduser -S pit -G pit
USER pit

CMD ["node", "dist/index.js"]
