import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// rewrites are baked in at build time, so the Docker build passes API_INTERNAL_URL as a build arg
const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  // trace from the monorepo root so workspace packages end up in the standalone build
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default config;
