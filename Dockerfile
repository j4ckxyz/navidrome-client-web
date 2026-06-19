# syntax=docker/dockerfile:1

# --- Stage 1: build the static bundle ---
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# --- Stage 2: runtime (Bun server) ---
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# Install production deps only (includes hono).
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy server source and built assets.
COPY server/ ./server/
COPY --from=build /app/dist ./dist

# NAVIDROME_URL  — set to your Navidrome server (e.g. http://navidrome:4533).
#                 When set, the server proxies /rest/*, /auth/*, and /api/* to it.
#                 When unset, the frontend asks the user for their server URL.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://localhost:8080/api/config || exit 1

CMD ["bun", "run", "server/index.ts"]

ARG COMMIT_HASH
LABEL org.opencontainers.image.revision=${COMMIT_HASH}
