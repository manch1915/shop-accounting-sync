#!/usr/bin/env bash
# First start on the server: secrets are generated here and never leave the box.
set -euo pipefail
cd /opt/shop-sync

if [ ! -f .env ]; then
  umask 077
  {
    echo "NODE_ENV=production"
    echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
    echo "SESSION_SECRET=$(openssl rand -base64 32)"
    echo "SANDBOX_TOKEN=$(openssl rand -hex 24)"
    echo "SEED_OWNER_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')"
    echo "WEB_ORIGIN=https://sync.narcisbin.com"
    echo "SANDBOX_PUBLIC_URL=https://sync.narcisbin.com/sandbox"
    echo "DEMO_ENABLED=true"
    echo "DEMO_ALLOW_ACTIONS=true"
    echo "DEMO_GENERATOR=true"
    echo "SANDBOX_FAULT_RATE=0.05"
  } > .env
fi

docker compose -f compose.yaml -f compose.prod.yaml up -d --no-build
