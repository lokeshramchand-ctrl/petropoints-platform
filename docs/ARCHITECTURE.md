# PetroPoints Platform — Architecture

Loyalty points for fuel purchases (think "credit-card petrol points"): customers earn points at
petrol bunks, merchants run a POS terminal that prints slips, and the platform operates the program.

## Why a rewrite

The legacy clients (`petropoints` Vite app, `petropoints_flutter`) talk to a CRUD API and compute
balances **on the client** (`newPoints = currentPoints + points` then `PUT /updatePoints`). That is:

- **Racy** — two cashiers awarding at once lose an update.
- **Unauditable** — a balance is a number that gets overwritten; no history.
- **Non-idempotent** — a retried request double-awards.
- It also stored Aadhaar numbers in plain form (we store only a salted hash + last 4).

## Principles

1. **The ledger is the source of truth.** Points move only via an append-only, double-entry ledger.
   Balances are a projection (`wallets.balance`) updated in the same DB transaction.
2. **Idempotent writes.** Every money-like command carries an `Idempotency-Key` (POS generates one per
   sale; retries are safe on flaky petrol-pump networks).
3. **Transactional outbox.** Domain events are written in the same transaction as the state change,
   then relayed to the event bus. No dual-write.
4. **Tenant isolation + RBAC** enforced in one shared package (`@petropoints/rbac`) used by API, web, mobile.
5. **12-factor config.** Validated at boot; separate `development` / `production` profiles.
6. **Observable by default.** Structured logs (pino), traces (OpenTelemetry), metrics (Prometheus).

## System context

```
 Customer app (RN) ─┐
 Merchant app (RN) ─┼──► API (NestJS/Fastify, stateless, N replicas) ──► PostgreSQL (OLTP, ledger)
 POS terminal (RN)  │          │   │                                  └─► Redis (cache, rate limit,
 Admin web (React) ─┘          │   └─ outbox relay ─► Redpanda/Kafka       idempotency fast-path)
                               │                         │
                               │                         ├─► consumers: notifications (email/SMS/push), slips
                               │                         └─► ClickHouse (analytics) + S3/MinIO (lake, Parquet)
                               └─► Mailpit (dev fake SMTP)
```

## Data engineering (Netflix-style "events first")

| Layer             | Tech                       | Contents                                                 |
| ----------------- | -------------------------- | -------------------------------------------------------- |
| OLTP              | PostgreSQL 17              | Ledger, wallets, tenancy, outbox                         |
| Event backbone    | Redpanda (Kafka API)       | `points.earned.v1`, `points.redeemed.v1`, `…reversed.v1` |
| Schema governance | Versioned JSON Schema      | `@petropoints/contracts`, backward-compatible only       |
| Bronze (raw)      | MinIO/S3, Parquet          | Immutable raw events, partitioned by `dt=`/`hour=`       |
| Silver (clean)    | ClickHouse                 | Deduped (by `event_id`), typed, enriched                 |
| Gold (serving)    | ClickHouse MVs             | Daily merchant/outlet aggregates, customer cohorts       |
| Quality           | Contract + dbt-style tests | Non-null, uniqueness, ledger-sums-to-zero reconciliation |

The ledger invariants are enforced in the database (balanced per transaction at COMMIT, append-only, no negative wallet). A **nightly reconciliation job** _(planned)_ should additionally prove `SUM(ledger) == wallet.balance` for every wallet and
`SUM(entries per txn) == 0`; mismatches page on-call.

## Scalability levers

- Stateless API → horizontal scale behind a load balancer; readiness/liveness probes.
- Wallet row locking (`SELECT … FOR UPDATE`) per wallet only; no global locks.
- Hot reads served from the denormalised wallet balance (`accounts.balance`), kept equal to the ledger sum in the same DB transaction. **Planned:** range-partition `ledger_entries` by month once volume warrants it (deferred constraint triggers need care on partitioned tables; deliberately not done yet). Redis caching of reads is likewise not wired in yet.
- Read replicas for reports (admin web reads via `reporting` pool).
- Rate limiting per IP/user/device (Redis token bucket).
- Async everything non-critical (email, push, analytics) via the outbox → bus.
- Cursor pagination everywhere (no OFFSET).

## RBAC

| Role             | Scope    | Purpose                                   |
| ---------------- | -------- | ----------------------------------------- |
| SUPER_ADMIN      | platform | Everything incl. manual point adjustments |
| PLATFORM_ADMIN   | platform | Operate merchants, customers, campaigns   |
| SUPPORT_AGENT    | platform | Read + reverse transactions               |
| MERCHANT_OWNER   | merchant | Own outlets, staff, devices, reports      |
| MERCHANT_MANAGER | merchant | Run outlets, reverse, reports             |
| CASHIER          | outlet   | Earn / redeem at the POS                  |
| CUSTOMER         | self     | View own wallet & history                 |

Authorization = permission **and** scope (see `packages/rbac`).

## Repo layout

```
apps/
  api/            NestJS + Fastify backend
  admin-web/      React + Vite admin panel            (branch: feat/admin-web)
  customer-app/   React Native (Expo) customer app     (branch: feat/mobile-apps)
  merchant-app/   React Native: owner dashboard + POS  (branch: feat/mobile-apps)
packages/
  rbac/           roles, permissions, scope checks
  contracts/      zod schemas + event contracts shared by all
  tsconfig/       strict shared tsconfig
infra/            docker-compose (dev & prod), otel, prometheus, grafana
docs/             ADRs and this document
```

## Environments

- `development`: docker-compose.dev.yml (Postgres, Redis, Redpanda, ClickHouse, MinIO, **Mailpit** fake email,
  Jaeger, Prometheus, Grafana). `.env.development`, verbose logs, Swagger on.
- `production`: docker-compose.prod.yml is a single-host reference; real deployments target Kubernetes.
  Swagger off, secrets from the environment/secret manager, no published datastore ports, resource limits.

## POS device

Merchants use an Android POS handset with a built-in thermal printer. The merchant app has a
`PrinterPort` interface with adapters (ESC/POS over built-in printer SDK, Bluetooth, and an on-screen
preview/mock for development). The slip contains an HMAC-signed QR so a slip can be verified later.
**Open item:** the exact device model/SDK is needed to write the production adapter.
