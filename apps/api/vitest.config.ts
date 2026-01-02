import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // integration specs need Postgres and Redis; CI provides them as services
    exclude: process.env.INTEGRATION ? [] : ['test/integration/**'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
});
