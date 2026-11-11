# Multi-Stage Production Dockerfile for Helping Services Sub-Backend
# Build Stage
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production Runner Stage
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=8001

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /usr/src/app/dist ./dist

# Non-root security enforcement
USER node

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:8001/api/v1/health || exit 1

CMD ["node", "dist/server.js"]

