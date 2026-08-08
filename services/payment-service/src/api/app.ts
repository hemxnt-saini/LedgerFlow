import express, { type Express } from 'express';
import { config } from '../config';
import { cors } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext } from './middleware/request-context';
import { accountRoutes } from './routes/account.routes';
import { paymentRoutes } from './routes/payment.routes';
import { reconciliationRoutes } from './routes/reconciliation.routes';

/**
 * Assembles the HTTP surface. Deliberately knows nothing about listening on a
 * port or connecting to anything - that is the server's job - so the app can
 * be built and exercised without starting the world.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(requestContext);
  app.use(cors);

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', service: config.serviceName }),
  );

  app.use(accountRoutes);
  app.use(paymentRoutes);
  app.use(reconciliationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
