import { createApp } from './api/app';
import { config } from './config';
import { pool } from './db/pool';
import { initSchema } from './db/schema';
import { log } from './lib/logger';
import type { Poller } from './lib/poller';
import { redis } from './lib/redis';
import { startOutboxPublisher } from './workers/outbox.worker';
import { startReconciliationWorker } from './workers/reconciliation.worker';
import { startCompensationWorker, startSettlementWorker } from './workers/saga.worker';

/**
 * The entrypoint: bring up the schema, start the background workers, then
 * start listening. Everything it wires together is defined elsewhere - this
 * file is only about lifecycle.
 */
async function main(): Promise<void> {
  await initSchema();

  const workers: Poller[] = [
    startOutboxPublisher(),
    startSettlementWorker(),
    startCompensationWorker(),
    startReconciliationWorker(),
  ];

  const server = createApp().listen(config.port, () =>
    log.info('listening', { port: config.port }),
  );

  const shutdown = async () => {
    server.close();
    await Promise.all(workers.map((worker) => worker.stop()));
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('failed to start', { err });
  process.exit(1);
});
