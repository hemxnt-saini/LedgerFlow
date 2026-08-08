import express, { type Express } from 'express';
import { config } from '../config';
import type { DeadLetterQueue } from '../services/dlq.service';
import type { ConsumerControls, KafkaAdmin } from '../services/kafka-admin.service';
import { counters } from '../services/projection.service';
import { subscribe, subscriberCount } from '../services/stream.service';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext } from './middleware/request-context';
import { createDlqRoutes } from './routes/dlq.routes';
import { createKafkaRoutes } from './routes/kafka.routes';
import { queryRoutes } from './routes/query.routes';

export interface AppDependencies {
  dlq: DeadLetterQueue;
  kafkaAdmin: KafkaAdmin;
  controls: ConsumerControls;
}

/**
 * Assembles the HTTP surface. The Kafka-facing pieces are passed in rather
 * than imported, because they own live connections whose lifecycle belongs to
 * the server, not to the router.
 */
export function createApp({ dlq, kafkaAdmin, controls }: AppDependencies): Express {
  const app = express();

  app.use(express.json());
  app.use(requestContext);

  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      service: config.serviceName,
      subscribers: subscriberCount(),
      consumerPaused: controls.isPaused(),
      // A 200 here only proves Express is alive. These prove the consumer is
      // actually consuming.
      counters,
    }),
  );

  app.get('/events/stream', (req, res) => {
    const unsubscribe = subscribe(res);
    req.on('close', unsubscribe);
  });

  app.use(queryRoutes);
  app.use(createKafkaRoutes(kafkaAdmin, controls));
  app.use(createDlqRoutes(dlq));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
