/**
 * Express application assembly.
 *
 * This file builds the app but deliberately does NOT start listening. `server.ts`
 * owns the HTTP server, which matters later: Module 6 attaches the OCPP WebSocket
 * server and Module 8 attaches Socket.IO to that same HTTP server. Keeping the app
 * free of `listen()` is what makes that possible without restructuring.
 *
 * Middleware order is significant and should not be shuffled casually:
 *   security -> CORS -> body parsing -> request logging -> routes -> 404 -> errors
 */

import express, { type Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env';
import apiRoutes from './routes';
import { notFoundHandler } from './middlewares/notFound.middleware';
import { errorHandler } from './middlewares/error.middleware';
import { ApiError } from './utils/ApiError';

const app: Application = express();

// Sensible security headers. Nothing here serves a browser UI, so the default
// content-security-policy is left on.
app.use(helmet());

// Allow only the origins listed in CORS_ORIGIN. Requests without an `Origin`
// header (curl, Postman, the simulator) are allowed through — they are not
// browser requests, so the same-origin policy does not apply to them.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      // An ApiError (not a bare Error) so the error middleware answers with a
      // 403 in the standard JSON shape instead of an opaque 500.
      callback(ApiError.forbidden(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }),
);

// Body parsing. The 1mb cap is plenty for JSON payloads and keeps a runaway
// request from exhausting memory.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging: concise in development, standard combined format in production.
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

// All application routes live under the API prefix (default: /api/v1).
app.use(env.apiPrefix, apiRoutes);

// Unmatched route -> 404 in the standard error shape.
app.use(notFoundHandler);

// Final error handler. Must be registered last.
app.use(errorHandler);

export default app;
