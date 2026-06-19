#!/bin/bash
set -e

echo "Updating navidrome-client-web..."

# 1. Fetch remote tracking branch and check for updates
echo "Fetching latest changes from Git..."
git fetch

# Get current branch and its remote tracking counterpart
BRANCH=$(git symbolic-ref --short -q HEAD || echo "main")
UPSTREAM="origin/$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "$UPSTREAM" 2>/dev/null || git rev-parse origin/main)

# Check if git pull is needed
PULLED=false
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "New updates detected ($LOCAL -> $REMOTE). Pulling updates..."
  git pull
  LOCAL=$(git rev-parse HEAD)
  PULLED=true
fi

# Get built commit hash from the Docker image
BUILT_COMMIT=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' navidrome-client-web:latest 2>/dev/null || echo "")

# Skip rebuilding if we didn't pull updates, the running container's image version matches HEAD, and the container is running
if [ "$PULLED" = false ] && [ "$LOCAL" = "$BUILT_COMMIT" ] && [ "$(docker ps -q -f name=^navidrome-web$)" ]; then
  echo "Already up to date. Docker container is running the latest version ($LOCAL)."
  exit 0
fi

# 2. Check which docker-compose is running and rebuild
if docker ps --filter "name=^navidrome$" --filter "status=running" --format "{{.Names}}" | grep -q "^navidrome$"; then
  echo "Detected full stack deployment (navidrome container is running)."
  echo "Rebuilding and restarting using docker-compose.full.yml..."
  COMMIT_HASH="$LOCAL" docker compose -f docker-compose.full.yml up -d --build
else
  echo "Detected client-only deployment."
  echo "Rebuilding and restarting using docker-compose.yml..."
  COMMIT_HASH="$LOCAL" docker compose up -d --build
fi

echo "Update complete!"
