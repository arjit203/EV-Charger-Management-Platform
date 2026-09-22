# Design notes

One note per subsystem: what it does, which decisions were load-bearing, and what was
deliberately left out. They are written to be read by someone who has never seen the code —
each opens with the problem before it reaches for a solution.

[`API.md`](API.md) is the endpoint reference: every route, who may call it, and what it is for.

## Where to start

The system is easiest to follow in the order energy and money actually flow through it.

**The platform**

| | |
|---|---|
| [Project foundation](foundation.md) | Config, the error envelope, the shape everything else assumes |
| [Authentication & RBAC](auth-and-rbac.md) | Four roles, and why the database is re-read on every request |
| [Companies & multi-tenancy](companies-and-tenancy.md) | How two operators share one platform and never see each other |

**The physical estate**

| | |
|---|---|
| [Users & vehicles](users-and-vehicles.md) | Drivers, their cars, and connector compatibility |
| [Stations](stations.md) | Sites, and who may administer them |
| [Chargers & connectors](chargers-and-connectors.md) | The hardware model, and why a connector is not a charger |

**Talking to hardware**

| | |
|---|---|
| [OCPP gateway](ocpp-gateway.md) | The WebSocket protocol layer, and the simulated charge point that stands in for hardware |
| [Charging sessions](charging-sessions.md) | Sessions, meter readings, and what must be true before power flows |
| [Real-time monitoring](realtime-monitoring.md) | Socket.IO, and why the charger link and the browser link stay separate |

**Money**

| | |
|---|---|
| [Tariffs & pricing](tariffs-and-pricing.md) | Integer paise, and the rate snapshot that survives a price change |
| [Wallet & payments](wallet-and-payments.md) | Atomic debits, settlement, retry backoff, and refusing to charge on credit |

**Operations**

| | |
|---|---|
| [Complaints & support](support-and-complaints.md) | Disputes, and what the ledger is for when one arrives |
| [Notifications](notifications.md) | In-app only, and the dedupe key that makes that bearable |
| [Analytics](analytics.md) | Read models over the same rows the product writes — no reporting tables |
| [Station map](station-map.md) | Leaflet, and why proximity search is deferred |
| [Admin console](admin-console.md) | The staff view that ties the rest together |

Each note ends with its own known limits. They are worth reading — most of what this project
does not do was a decision rather than an omission.
