# syntax=docker/dockerfile:1

# --- Stage 1: build the static bundle with Bun ---
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Build the app.
COPY . .
RUN bun run build

# --- Stage 2: serve the static assets with nginx ---
FROM nginx:1.27-alpine AS runtime

# SPA-aware nginx config (history fallback, asset caching).
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built assets.
COPY --from=build /app/dist /usr/share/nginx/html

# There is no backend: auth and all API calls happen in the browser directly
# against the user's Navidrome server.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
