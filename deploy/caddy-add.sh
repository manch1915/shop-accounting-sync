#!/usr/bin/env bash
# Appends the site block to the shared Caddyfile (same inode, never sed -i), validates, reloads.
# If validation fails the Caddyfile is put back, so nobody else's next reload breaks.
set -euo pipefail
CF=/opt/policy-gateway/infra/caddy/Caddyfile
CADDY=infra-caddy-1
BACKUP=""

# anchored: a plain substring match also hits supplier-sync.narcisbin.com
if ! grep -Eq '^(http://)?sync[.]narcisbin[.]com [{]' "$CF"; then
  BACKUP="$CF.bak.$(date +%F-%H%M%S)"
  cp "$CF" "$BACKUP"
  cat /opt/shop-sync/deploy/caddy-sync.caddy >> "$CF"
fi

# the container may still see an old inode of the bind-mounted file, so validate and load a copy
docker cp "$CF" "$CADDY:/tmp/Caddyfile.live"
if ! docker exec "$CADDY" caddy validate --config /tmp/Caddyfile.live --adapter caddyfile; then
  if [ -n "$BACKUP" ]; then
    cat "$BACKUP" > "$CF"
    echo "validation failed, Caddyfile restored from $BACKUP"
  fi
  exit 1
fi
docker exec "$CADDY" caddy reload --config /tmp/Caddyfile.live --adapter caddyfile
