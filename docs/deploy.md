# Deploying the demo

The demo runs as one Docker Compose project behind an existing Caddy. Postgres, Redis, the API, the worker and the sandbox stay on the project's private network; only the dashboard container joins the proxy network.

## What it needs

- Docker with Compose v2.24 or newer (the override uses `!reset`)
- An external Docker network that Caddy is attached to (`infra_default` by default, set `PROXY_NETWORK` otherwise)
- About 1.7 GB of RAM in total with the limits from `compose.prod.yaml`
- A DNS record for the dashboard host, for example `sync.example.com`

## The demo server

The public demo runs this way on a shared VPS. `deploy/` holds what was used there:

- `server-setup.sh` writes `.env` with secrets generated on the server, then starts the stack from prebuilt images;
- `caddy-sync.caddy` and `caddy-add.sh` append the site block to the shared Caddyfile, validate and reload;
- `enable-https.sh` switches the block from plain HTTP to automatic HTTPS once the DNS record resolves. Adding an HTTPS site before DNS exists makes Caddy back off from Let's Encrypt for a long time, so the block starts as `http://`.

The images were built elsewhere and loaded with `docker save | gzip | ssh server 'gunzip | docker load'`, so the server never needed the build cache.

## Steps

1. Copy the sources to the server. Without giving the server access to the repository:

   ```bash
   git archive --format=tar HEAD | ssh server "mkdir -p /opt/shop-sync && tar -x -C /opt/shop-sync"
   ```

   Do the copy, the build and the start in one SSH session if the server runs fail2ban on sshd.

2. Create `/opt/shop-sync/.env` (mode 600) from `.env.example`. Generate the secrets on the server:

   ```bash
   openssl rand -base64 32   # ENCRYPTION_KEY
   openssl rand -base64 32   # SESSION_SECRET
   ```

   Set `WEB_ORIGIN=https://sync.example.com`, `NODE_ENV=production`, and a fresh `SANDBOX_TOKEN`. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` if alerts should go to a chat.

3. Build and start:

   ```bash
   cd /opt/shop-sync
   docker compose -f compose.yaml -f compose.prod.yaml up -d --build
   docker compose -f compose.yaml -f compose.prod.yaml logs -f migrate
   ```

   The `migrate` service applies migrations and seeds the demo workspace once. Later starts skip the seed.

4. Add a site block to the Caddyfile. Append it, validate, then reload without restarting the container:

   ```caddy
   sync.example.com {
       encode zstd gzip
       reverse_proxy shop-sync-web:3000 {
           # the live feed is a long-lived event stream
           flush_interval -1
       }
       header {
           X-Content-Type-Options nosniff
           Referrer-Policy strict-origin-when-cross-origin
           X-Frame-Options DENY
       }
   }
   ```

   ```bash
   cp Caddyfile Caddyfile.bak.$(date +%F-%H%M)
   cat sync-block.caddy >> Caddyfile          # append, never sed -i a bind-mounted Caddyfile
   docker exec <caddy> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

5. Check:

   ```bash
   curl -fsS https://sync.example.com/login >/dev/null && echo dashboard ok
   docker compose -f compose.yaml -f compose.prod.yaml exec api wget -qO- http://127.0.0.1:4000/health
   ```

## Updating

Copy the new sources the same way and run `up -d --build` again. Migrations run before the API and worker start. To reset the demo data, stop the stack, run `docker compose run --rm migrate npx tsx prisma/seed.ts`, and start it again.

## Real accounts instead of the sandbox

Create the connections with real base URLs and keys (see `prisma/seed.ts` for the shape of each provider's credentials and settings), point the store's webhooks at `https://<host>/webhooks/<connection id>`, and set `DEMO_GENERATOR=false`. For МойСклад, add `?secret=<webhook secret>` to the webhook URL, since МойСклад does not sign deliveries.
