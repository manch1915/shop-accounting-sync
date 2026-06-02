#!/usr/bin/env bash
# Run once the A record for sync.narcisbin.com resolves to this server.
# Switching the block from http:// to the bare host makes Caddy treat it as a new site
# and request the certificate right away.
set -euo pipefail
CF=/opt/policy-gateway/infra/caddy/Caddyfile
CADDY=infra-caddy-1

getent hosts sync.narcisbin.com >/dev/null || { echo "DNS for sync.narcisbin.com does not resolve yet"; exit 1; }
cp "$CF" "$CF.bak.$(date +%F-%H%M)"
python3 - "$CF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
text = text.replace('http://sync.narcisbin.com {', 'sync.narcisbin.com {', 1)
with open(path, 'w', encoding='utf-8') as f:  # same inode as the bind mount
    f.write(text)
PY
docker cp "$CF" "$CADDY:/tmp/Caddyfile.live"
docker exec "$CADDY" caddy validate --config /tmp/Caddyfile.live --adapter caddyfile
docker exec "$CADDY" caddy reload --config /tmp/Caddyfile.live --adapter caddyfile
sleep 20
docker logs "$CADDY" --since 1m 2>&1 | grep -i 'sync.narcisbin.com' | grep -iE 'obtain|error' | tail -5
curl -fsS -o /dev/null -w 'https status %{http_code}\n' https://sync.narcisbin.com/login
