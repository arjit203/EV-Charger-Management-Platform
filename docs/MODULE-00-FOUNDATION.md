# Module 0 — Project Foundation

**Status:** ✅ Complete
**Depends on:** nothing (this is the base)

---

## 1. Purpose (from zero)

Before a CPMS can manage a single charger, there has to be a place for code to live and a
proven path for data to travel. Module 0 builds that and nothing else.

It answers one question with real evidence rather than assumption: **can a page in the
browser reach the API, and can the API reach MongoDB?** Everything in Modules 1–17 assumes
that answer is yes. Verifying it now — with a single endpoint and a single page — means
that when something breaks in Module 7, you already know the transport layer is sound and
the bug is in your session logic.

The secondary purpose is to fix the conventions that all later modules inherit without
re-litigating them: folder layout, response shape, error handling, env loading, logging.

## 2. Where it fits in the CPMS

Nowhere, functionally — there is no EV-domain concept in this module. Structurally it is
everything: the Express app, the HTTP server, and the API URL surface that Auth, Stations,
Chargers, Sessions and the OCPP gateway all attach to.

One decision here is specifically forward-looking. `server.ts` creates an explicit
`http.createServer(app)` instead of calling `app.listen()`. That HTTP server is the object
Module 6 attaches the OCPP WebSocket (`ws`) server to, and Module 8 attaches Socket.IO to.
Creating it now means neither module has to restructure the entry point later.

## 3. Dependencies on previous modules

None.

## 4. Database entities

None. Module 0 connects to MongoDB and reports the connection state, but defines no
schemas. The first model (`User`) arrives in Module 1.

## 5. Backend architecture

```
src/
├── config/
│   ├── env.ts        Loads + validates .env. The ONLY reader of process.env.
│   └── db.ts         Mongoose connection lifecycle + status reporting.
├── controllers/      Thin HTTP handlers. No business logic.
│   └── health.controller.ts
├── middlewares/
│   ├── notFound.middleware.ts   Unmatched route -> ApiError
│   └── error.middleware.ts      The ONLY place an error becomes a response.
├── routes/
│   ├── index.ts      Root router. One mount point per module.
│   └── health.routes.ts
├── utils/
│   ├── ApiError.ts      The one error type every layer throws.
│   ├── ApiResponse.ts   The one success shape every endpoint sends.
│   ├── asyncHandler.ts  Forwards async rejections to Express.
│   └── logger.ts        Timestamped logging.
├── app.ts            Express assembly. No listen().
└── server.ts         HTTP server, startup, graceful shutdown.
```

Middleware order in `app.ts` is significant and should not be shuffled:

```
helmet -> CORS -> body parsing -> morgan -> routes -> 404 handler -> error handler
```

### Key design decisions

**The API boots even when MongoDB is down.** `connectDatabase()` never throws; it logs and
resolves `false`. A failed database connection produces a *running server that tells you
what is wrong*, rather than a process that dies before you can read the error. This is also
why `/health` is useful rather than decorative.

**One response envelope, everywhere.**

```jsonc
// success
{ "success": true,  "message": "...", "data": { } }
// error
{ "success": false, "message": "...", "errorCode": "NOT_FOUND", "details": null }
```

Because the shape never varies, the frontend writes one response handler and reuses it for
auth, stations, chargers, sessions and wallet.

**Errors are centralised.** Handlers `throw ApiError.notFound(...)`; only
`error.middleware.ts` turns an error into a response. Stack traces are included in
development and stripped in production, and 5xx messages are replaced with a generic string
in production so internals never leak.

**Async errors are not silently swallowed.** Express 4 does not catch rejections from
`async` handlers, so every async controller is wrapped in `asyncHandler`.

## 6. API

| Method | Path              | Auth   | Description                     |
| ------ | ----------------- | ------ | ------------------------------- |
| `GET`  | `/api/v1/health`  | Public | Liveness + database state       |

Status codes: **200** when the database is connected, **503** when it is not. The body is
returned in both cases — 503 here means "running but degraded", not "request failed".

```jsonc
{
  "success": true,
  "message": "EV-CMS backend is healthy",
  "data": {
    "status": "ok",                    // "ok" | "degraded"
    "service": "ev-cms-backend",
    "environment": "development",
    "uptimeSeconds": 42,
    "timestamp": "2026-09-12T20:30:00.000Z",
    "database": {
      "state": "connected",            // connected | connecting | disconnected
                                       // | disconnecting | not_configured | unknown
      "name": "ev_cms",
      "host": "127.0.0.1",
      "lastError": null
    }
  }
}
```

`database.host` and `database.name` are taken from the live Mongoose connection and never
include credentials.

## 7. Frontend

```
src/
├── app/
│   ├── layout.tsx    Root layout
│   └── page.tsx      System Status page
├── components/
│   └── StatusBadge.tsx
├── lib/
│   └── config.ts     The ONLY reader of process.env
├── services/
│   ├── apiClient.ts       Shared fetch wrapper + ApiClientError
│   └── health.service.ts
└── types/
    └── api.ts        Types mirroring the backend contract
```

**System Status page** (`/`) — calls the health endpoint on mount, and renders the API
status, environment, uptime, server time and database state, with a **Check again** button.
Nothing on it is hardcoded; every value comes from the response.

### API client contract (locked here, used by every later module)

**The response envelope is the source of truth, not the HTTP status code.** If the body
parses as our envelope, the client trusts its `success` flag; only when the body is *not*
our envelope does it fall back to the status code.

This rule exists because of `/health`: it deliberately answers 503 while the database is
down, but the request succeeded and the payload is exactly the diagnostic information we
asked for. A naive `if (!res.ok) throw` client would discard it.

Failures throw `ApiClientError`, carrying `status` (0 when the server was unreachable),
`errorCode` and `details`.

## 8. Verification performed

Backend, independently (curl):

| Check                                    | Result                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/health`, MongoDB connected  | **200**, `status: "ok"`, `database.state: "connected"`, `name: "ev_cms"` |
| Atlas read/write round trip              | insert → find → delete → drop all succeeded              |
| `GET /api/v1/health`, no `MONGODB_URI`   | 503, `database.state: "not_configured"`, server stays up |
| `GET /api/v1/health`, unreachable MongoDB| 503, `state: "disconnected"`, `lastError: "connect ECONNREFUSED 127.0.0.1:27017"` |
| `GET /api/v1/does-not-exist`             | 404 in the standard error shape, `errorCode: "NOT_FOUND"` |
| `GET /health` (missing prefix)           | 404, same shape — no stray HTML error page               |
| CORS preflight from `http://localhost:3000` | 204 with `Access-Control-Allow-Origin`                |
| CORS from a disallowed origin            | 403, `errorCode: "FORBIDDEN"`                            |
| `npm run build` then `npm start`         | Compiled `dist/` runs and resolves `.env` correctly      |

Frontend:

| Check                              | Result                                      |
| ---------------------------------- | ------------------------------------------- |
| `npm run dev`                      | Compiles, serves `/` with HTTP 200          |
| `npm run build`                    | Production build succeeds                   |
| `tsc --noEmit`                     | Clean, both projects, `strict` enabled      |
| `eslint src`                       | Clean                                       |
| API base URL inlined into the page | `http://localhost:5000/api/v1` confirmed    |

## 9. Definition of done

- [x] Backend starts without errors and logs its port, health URL and CORS origins
- [x] Frontend starts without errors
- [x] The status page shows a real network round trip, not a hardcoded string
- [x] A missing or wrong `MONGODB_URI` produces a visible, sane error — not a silent hang or crash
- [x] CORS works without manual header hacks in the browser
- [x] Both projects type-check cleanly under `strict`, with no implicit `any`
- [x] Centralised error handling exists and is used by the 404 path
- [x] Graceful shutdown closes the HTTP server and the database connection
- [x] Module documented

## 10. Known state / notes

- **EV-CMS uses its own dedicated Atlas project and cluster**, holding only the `ev_cms`
  database. Verified isolated: the credentials can see `admin` and `local` and nothing else.
- **The connection string must end with `/ev_cms` before the query string.** Strings copied
  from the Atlas UI end in `/?ssl=...` with no database path, and Mongoose then silently uses
  a database called `test`. Always check `database.name` in the health response — not just
  `state` — after changing `MONGODB_URI`. Any destructive or seed script should assert
  `mongoose.connection.name === 'ev_cms'` before running.
- `tsx watch` watches `src/` only, so editing `.env` requires a manual backend restart.
- `MONGODB_URI` in `backend/.env.example` is intentionally **empty** — that file is git-tracked,
  so a real connection string must never be pasted into it. Real credentials belong only in
  `backend/.env`, which is git-ignored.
- A failed initial connection is **not** retried automatically. Restart the backend after
  fixing `MONGODB_URI`. (Mongoose reconnects on its own only after a *successful* first
  connection.)
- `frontend/AGENTS.md` and `frontend/CLAUDE.md` were generated by `create-next-app`.

## 11. What Module 1 will add

`User` model, password hashing, JWT issue/verify, `auth.middleware` and `role.middleware`,
`POST /auth/register`, `POST /auth/login`, `GET /auth/me`, and login/register pages — the
first module with real domain data, and the first to define the roles (admin, operator,
driver) that every later module authorises against.
