# EV-CMS — EV Charging Management Platform

A CPMS (Charge Point Management System) built from scratch: station/charger management,
an OCPP-inspired charger gateway, live charging sessions, tariffs, wallet payments and
analytics — with **simulated chargers** standing in for physical EVSE hardware.

Built one module at a time. See [`docs/`](./docs) for per-module documentation.

---

## Repository layout

```
EV-CMS/
├── backend/      Express + TypeScript API, OCPP gateway (Module 6), Socket.IO (Module 8)
├── frontend/     Next.js + React + TypeScript + Tailwind
├── simulator/    Fake charger processes (added in Module 6)
└── docs/         One document per completed module
```

## Prerequisites

- **Node.js 20+** (developed on v24)
- **MongoDB** — a local server or an Atlas cluster. You supply the connection string.

## Setup

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env        # then set MONGODB_URI

# 2. Frontend
cd ../frontend
npm install
cp .env.example .env.local
```

## Running locally

The project runs as separate processes, one per terminal. (The simulator arrives in Module 6.)

| Terminal | Directory   | Command       | URL                     |
| -------- | ----------- | ------------- | ----------------------- |
| 1        | `backend/`  | `npm run dev` | <http://localhost:5000> |
| 2        | `frontend/` | `npm run dev` | <http://localhost:3000> |

Open <http://localhost:3000> — the **System Status** page performs a live health check
against the backend and reports the real MongoDB connection state.

## Useful scripts

**backend/**

| Script              | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `npm run dev`       | Start with hot reload (`tsx watch`)        |
| `npm run build`     | Type-check and compile to `dist/`          |
| `npm start`         | Run the compiled build                     |
| `npm run typecheck` | Type-check only, no output                 |
| `npm run seed:admin`| Create the first `super_admin` (idempotent) |
| `npm run seed:demo` | Seed two demo companies + staff (idempotent) |

**frontend/**

| Script              | Purpose                        |
| ------------------- | ------------------------------ |
| `npm run dev`       | Next.js dev server             |
| `npm run build`     | Production build               |
| `npm start`         | Serve the production build     |
| `npm run lint`      | ESLint                         |
| `npm run typecheck` | Type-check only                |

## Module progress

| #     | Module                          | Status      |
| ----- | ------------------------------- | ----------- |
| 0     | Project Foundation              | ✅ Complete |
| 1     | Authentication & RBAC           | ✅ Complete |
| 2     | Company / CPO Management (MVP)  | ✅ Complete |
| 3     | User / EV Owner Management      | ✅ Complete |
| 4     | Station Management              | Not started |
| 5     | Charger & Connector Management  | Not started |
| 6     | OCPP Gateway + Simulated Charger| Not started |
| 7     | Charging Sessions               | Not started |
| 8     | Real-Time Monitoring            | Not started |
| 9     | Tariff / Pricing                | Not started |
| 10    | Wallet & Payments               | Not started |
| 11    | Complaints / Support            | Not started |
| 12    | Notifications                   | Not started |
| 13    | Analytics & Dashboards          | Not started |
| 14    | Charging Station Map            | Not started |
| 15    | Admin / Operations Dashboard    | Not started |
| 16    | Testing / QA                    | Not started |
| 17    | Deployment                      | Not started |

Modules 0–8 form the core demo: login → station → charger → simulated OCPP session →
live meter values on screen → stop → completed session.
