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

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date. No new updates available."
  exit 0
fi

echo "New updates detected ($LOCAL -> $REMOTE). Pulling updates..."
git pull

# 2. Check which docker-compose is running and rebuild
if docker ps --filter "name=^navidrome$" --filter "status=running" --format "{{.Names}}" | grep -q "^navidrome$"; then
  echo "Detected full stack deployment (navidrome container is running)."
  echo "Rebuilding and restarting using docker-compose.full.yml..."
  docker compose -f docker-compose.full.yml up -d --build
else
  echo "Detected client-only deployment."
  echo "Rebuilding and restarting using docker-compose.yml..."
  docker compose up -d --build
fi

echo "Update complete!"
