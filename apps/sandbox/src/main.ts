import { serve } from '@hono/node-server';
import { createSandbox } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, generator } = createSandbox(config);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`sandbox listening on http://localhost:${info.port}`);
  console.log(
    `webhooks go to ${config.webhookTarget}/webhooks/<connectionId>, fault rate ${config.faultRate}`,
  );
  if (config.generator) generator.start();
  else console.log('order generator is off, set DEMO_GENERATOR=true to start it');
});

function shutdown(): void {
  generator.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
