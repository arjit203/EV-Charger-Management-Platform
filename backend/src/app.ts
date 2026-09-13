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

/*
 * Body parsing. The 1mb cap is plenty for JSON payloads and keeps a runaway request from
 * exhausting memory.
 *
 * MODULE 10 — `verify` captures the RAW BYTES before they are parsed and discarded.
 *
 * Razorpay signs its webhooks with an HMAC over the exact bytes it sent. Re-serialising the
 * parsed object does not reproduce them — key order and whitespace differ — so without this the
 * signature could never verify, and it would fail silently rather than loudly.
 *
 * Done here rather than by mounting `express.raw` on the webhook path, because that mount would
 * have to be registered BEFORE this line and the payments router would then depend on
 * middleware ordering in a file it does not own. One line here changes nothing for any other
 * route, and the webhook handler simply reads `req.rawBody`.
 */
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }),
);
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
