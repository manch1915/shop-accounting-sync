# One build for the whole monorepo; pick the service with --target api | web | sandbox.
# Runtime images carry only their own production dependencies.

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# every workspace manifest, so npm can validate the lockfile in any stage
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/demo-data/package.json packages/demo-data/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/sandbox/package.json apps/sandbox/

FROM manifests AS deps
# workspace "prepare" scripts need sources, so they run in the build stage instead
RUN npm ci --ignore-scripts

FROM deps AS build
ARG API_INTERNAL_URL=http://shop-sync-api:4000
ARG SANDBOX_INTERNAL_URL=http://shop-sync-sandbox:4010
ENV API_INTERNAL_URL=$API_INTERNAL_URL SANDBOX_INTERNAL_URL=$SANDBOX_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
# prisma.config.ts reads it; generating the client never connects
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @sas/shared -w @sas/demo-data \
 && npx -w @sas/api prisma generate \
 && npm run build -w @sas/api -w @sas/sandbox -w @sas/web

FROM manifests AS api-deps
# ignore-scripts skips the download of the schema engine migrate needs; fetch it here, as root
RUN npm ci --omit=dev --ignore-scripts -w @sas/api --include-workspace-root=false \
 && (cd node_modules/@prisma/engines && npm run postinstall)

FROM manifests AS sandbox-deps
RUN npm ci --omit=dev --ignore-scripts -w @sas/sandbox --include-workspace-root=false

FROM base AS api
ENV NODE_ENV=production
COPY --from=api-deps /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/demo-data/package.json packages/demo-data/
COPY --from=build /app/packages/demo-data/dist packages/demo-data/dist
# sources stay next to dist: the seed runs through tsx and imports them
COPY --from=build /app/apps/api/package.json /app/apps/api/tsconfig.json /app/apps/api/prisma.config.ts apps/api/
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/src apps/api/src
COPY --from=build /app/apps/api/dist apps/api/dist
COPY package.json tsconfig.base.json ./
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM base AS sandbox
ENV NODE_ENV=production
COPY --from=sandbox-deps /app/node_modules node_modules
COPY --from=build /app/packages/demo-data/package.json packages/demo-data/
COPY --from=build /app/packages/demo-data/dist packages/demo-data/dist
COPY --from=build /app/apps/sandbox/package.json apps/sandbox/
COPY --from=build /app/apps/sandbox/dist apps/sandbox/dist
COPY package.json ./
WORKDIR /app/apps/sandbox
USER node
EXPOSE 4010
CMD ["node", "dist/main.js"]

FROM base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
