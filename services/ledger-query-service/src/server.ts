import { createApp } from './api/app';
import { config } from './config';
import { consumer, kafka } from './lib/kafka';
import { log } from './lib/logger';
import { redis } from './lib/redis';
import { createDeadLetterQueue } from './services/dlq.service';
import { createConsumerControls, createKafkaAdmin } from './services/kafka-admin.service';
import { counters, startProjection } from './services/projection.service';
import { broadcast, closeAll, startKeepAlive } from './services/stream.service';

/**
 * The entrypoint: start the parking-topic watcher, start projecting, then
 * start listening. Everything it wires together is defined elsewhere - this
 * file is only about lifecycle.
 */
async function main(): Promise<void> {
  const dlq = createDeadLetterQueue(kafka, redis, config.kafka.topic);
  const kafkaAdmin = createKafkaAdmin(kafka, [config.kafka.topic, config.kafka.dlqTopic]);
  const controls = createConsumerControls(consumer, config.kafka.topic);

  await dlq.startConsumer();
  // Parked messages appear live in the monitor alongside everything else.
  dlq.onEntry((entry) => {
    counters.deadLettered += 1;
    broadcast('dead-letter', entry);
  });

  await startProjection(dlq);

  const keepAlive = startKeepAlive();
  const server = createApp({ dlq, kafkaAdmin, controls }).listen(config.port, () =>
    log.info('listening', { port: config.port }),
  );

  const shutdown = async () => {
    clearInterval(keepAlive);
    closeAll();
    server.close();
    await dlq.stop();
    await kafkaAdmin.stop();
    await consumer.disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('failed to start', { err });
  process.exit(1);
});
