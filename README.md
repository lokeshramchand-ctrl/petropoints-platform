# PetroPoints Platform

Fuel-purchase loyalty points ("credit-card petrol points"): customers earn at partner bunks, merchants run
a POS handset that prints slips, and the platform team operates the programme.

Replaces the legacy `petropoints` (Vite) and `petropoints_flutter` apps. Start with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

| Path                 | What                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `apps/api`           | NestJS + Fastify API, ledger, auth, outbox relay, workers               |
| `apps/admin-web`     | React admin panel (branch `feat/admin-web`)                             |
| `apps/*-app`         | React Native apps (branch `feat/mobile-apps`)                           |
| `packages/rbac`      | Roles, permissions, tenant-scope checks (shared by every app)           |
| `packages/contracts` | Zod request schemas, event contracts, shared domain rules               |
| `infra/`             | Docker compose (dev + prod reference), OTel, Prometheus, ClickHouse DDL |

## Quick start (development)

Requires Node 22+, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env.development      # then edit SEED_ADMIN_PASSWORD
pnpm infra:up                         # postgres, redis, redpanda, clickhouse, minio, mailpit, otel, grafana
set -a; . ./.env.development; set +a
pnpm --filter @petropoints/rbac --filter @petropoints/contracts build
pnpm --filter @petropoints/api migrate
pnpm --filter @petropoints/api seed:admin
pnpm --filter @petropoints/api dev                  # API on :3000, Swagger on /docs
pnpm --filter @petropoints/api worker:relay         # outbox -> redpanda
pnpm --filter @petropoints/api worker:notifications # emails land in Mailpit: http://localhost:8025
```

| Tool             | URL                    |
| ---------------- | ---------------------- |
| Mailpit (email)  | http://localhost:8025  |
| Redpanda console | http://localhost:8080  |
| Jaeger (traces)  | http://localhost:16686 |
| Grafana          | http://localhost:3001  |
| MinIO console    | http://localhost:9001  |

## Quality gates

`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`: the same sequence CI runs.
Commits follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by commitlint).

The API test suite runs the real migrations on PGlite (PostgreSQL compiled to WASM), so no Docker is needed to test.

## Environments

- **development**: `.env.development`, verbose logs, Swagger on, fake email (Mailpit).
- **production**: config is validated at boot and **refuses to start** with placeholder secrets,
  missing Redis/Kafka, Swagger enabled, or wildcard CORS. See `infra/docker-compose.prod.yml`.
