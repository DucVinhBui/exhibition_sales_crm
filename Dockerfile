# syntax=docker/dockerfile:1.19
# Multi-arch by construction: node's official images cover linux/amd64 and linux/arm64,
# and every dependency is pure JavaScript (pg included), so nothing here is arch-specific.
# Bookworm rather than Alpine to avoid the SWC/musl surprises in Next's build step.

FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json next.config.mjs ./
COPY src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Production dependencies only. tsx is a runtime dependency because the one-shot
# migrate service executes the TypeScript setup entrypoint directly.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY tsconfig.json next.config.mjs ./
COPY src ./src
COPY db ./db

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
