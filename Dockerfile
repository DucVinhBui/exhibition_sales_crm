# Multi-arch by construction: node's official images cover linux/amd64 and linux/arm64, and
# package-lock.json carries prebuilt linux-x64 AND linux-arm64 binaries for every native
# dependency (esbuild via tsx, @next/swc, sharp), so nothing here is arch-specific. No
# syntax directive: the classic frontend builds this file, and docker/dockerfile is not a
# Docker Official Image.
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

COPY --chown=node:node --from=build /app/.next ./.next
COPY tsconfig.json next.config.mjs ./
COPY src ./src
COPY db ./db

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
