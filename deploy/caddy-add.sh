#!/usr/bin/env bash
# Appends the site block to the shared Caddyfile (same inode, never sed -i), validates, reloads.
set -euo pipefail
CF=/opt/policy-gateway/infra/caddy/Caddyfile
CADDY=infra-caddy-1

if ! grep -q 'sync.narcisbin.com' "$CF"; then
  cp "$CF" "$CF.bak.$(date +%F-%H%M)"
  cat /opt/shop-sync/deploy/caddy-sync.caddy >> "$CF"
fi
# the container may still see an old inode of the bind-mounted file, so validate and load a copy
docker cp "$CF" "$CADDY:/tmp/Caddyfile.live"
docker exec "$CADDY" caddy validate --config /tmp/Caddyfile.live --adapter caddyfile
docker exec "$CADDY" caddy reload --config /tmp/Caddyfile.live --adapter caddyfile
