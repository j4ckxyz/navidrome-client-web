#!/bin/bash
set -e

echo "Updating navidrome-client-web..."

# 1. Pull the latest version
echo "Pulling latest version from Git..."
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
