# Monitorly

Website change monitoring: give it a URL and a plain-English description of what to watch
("new Software Engineer Intern roles in India"); it checks on a schedule, detects meaningful
changes, applies your rules and alerts you in-app and by email.

## Layout

```
apps/web                 React + Vite + TanStack Query + Tailwind
services/api             Express REST API (+ Socket.IO from Phase 8)
services/scheduler       Finds due monitors → CheckRun + outbox (one transaction) → RabbitMQ
services/fetch-worker    HTTP fetching (consumes fetch.http)
packages/config          .env loading + Zod validation
packages/contracts       RabbitMQ topology + message schemas (single source of truth)
packages/database        Mongoose connection, models, indexes
packages/messaging       RabbitMQ: confirms, manual acks, prefetch, retry tiers, DLQs
packages/ai              AI (OpenAI / Gemini / Ollama): description → validated filters
packages/url-safety      SSRF protection: blocks private/internal URLs (checked on save and before every fetch)
packages/logger          Pino structured logging
packages/runtime         Graceful shutdown / crash handling for every service
infrastructure/          Config mounted into infra containers
```

Services still to come: `browser-worker`, `processing-worker`, `ai-worker`, `notification-worker`.

## Prerequisites

- Node.js 22+
- Docker Desktop (running, ~4 GB RAM)

## First-time setup

```bash
npm install
cp .env.example .env        # then set JWT_SECRET (generator command is in the file)
npm run infra:up            # MongoDB, RabbitMQ, Redis, SeaweedFS (S3), Mailpit
```

## Daily development

```bash
npm run infra:up    # if not already running
npm run dev         # api + scheduler + fetch-worker + web, with hot reload
npm run smoke       # in another terminal: end-to-end Milestone 1 check
```

Open http://localhost:5173, create an account and add a monitor. The dev-only System page
(`/system`) shows infrastructure status and a "Send test fetch job" button.

| What | URL | Login |
|---|---|---|
| Web app | http://localhost:5173 | — |
| API | http://localhost:4000/health/ready | — |
| RabbitMQ management | http://localhost:15672 | monitorly / monitorly |
| Mailpit (test inbox) | http://localhost:8025 | — |
| SeaweedFS master | http://localhost:9333 | — |
| MongoDB | mongodb://localhost:27017 | — |

Other commands: `npm run ai:try -- "new SWE intern roles in India, not senior"` (tries the AI prompt against the configured provider; `npm run eval -w @monitorly/ai` runs a set of varied descriptions), `npm test` (needs `infra:up` — uses a separate `monitorly_test` database),
`npm run typecheck`, `npm run infra:logs`, `npm run infra:down`, `npm run infra:reset` (deletes all local data).

## API

All `/api/monitors` routes require login and only ever touch the current user's monitors —
another user's monitor ID returns 404, exactly like a non-existent one.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/register | Create account (sets session cookie) |
| POST | /api/auth/login | Log in |
| POST | /api/auth/logout | Log out |
| GET | /api/auth/me | Current user |
| POST | /api/monitors/interpret | Suggest filters from a description (AI; saves nothing) |
| POST | /api/monitors | Create monitor |
| GET | /api/monitors | List my monitors |
| GET | /api/monitors/:id | Monitor details |
| PATCH | /api/monitors/:id | Update (only the fields sent) |
| GET | /api/monitors/:id/runs | Recent check runs (`?limit=`, max 100) |
| POST | /api/monitors/:id/pause | Pause |
| POST | /api/monitors/:id/resume | Resume (clears errors, checks immediately) |
| DELETE | /api/monitors/:id | Delete monitor and its history |

Sessions are a signed JWT in an `httpOnly`, `SameSite=Lax` cookie; state-changing requests
from other origins are rejected (CSRF). Request bodies are validated with the shared Zod
schemas in `packages/contracts/src/api.ts`, and unknown fields (e.g. `userId`) are rejected.

## AI: description → filters

Choose the provider in `.env` with `AI_PROVIDER` and `AI_API_KEY`:

| Provider | Cost | Setup |
|---|---|---|
| `gemini` | Free tier (rate-limited) | Key from https://aistudio.google.com/apikey |
| `openai` | Paid | Key from https://platform.openai.com/api-keys |
| `ollama` | Free, runs locally | Install https://ollama.com, `ollama pull llama3.2`; no key |

All three are called through the OpenAI SDK's Chat Completions API with a strict JSON schema
(structured outputs). Note that Gemini's free tier may use requests to improve Google's
products — use a paid tier before real users' data goes through it.

`POST /api/monitors/interpret` sends the user's description (and only the host + path of the
URL) to the provider. The answer is clipped, de-duplicated and validated with the shared Zod
schema before the user sees it; the user reviews and edits the suggested filters, and they're
validated again when the monitor is saved. The AI only interprets intent — fetching, diffing
and matching are ordinary code.

Filters match case-insensitively as substrings: an item must mention **all** "must mention"
phrases, **any one** location (if any are set), and **none** of the "ignore" phrases.

If no provider is configured, or it is out of quota or fails, the endpoint returns a clear error
(`code: "ai_…"`) and the form lets the user fill in the filters manually. Calls are capped per
user per hour (`AI_RATE_LIMIT`).

## Scheduler

`services/scheduler` is its own process (never inside the API, so API replicas can't each
schedule the same monitor). It runs three loops:

1. **Partition leases** (every 5 s). Monitors are hashed into 64 partitions
   (`partitionFor(monitorId)`). Each instance heartbeats, then holds leases on its fair share
   (`ceil(64 / live instances)`) in the `schedulerleases` collection. An instance that crashes
   stops renewing; after `SCHEDULER_LEASE_TTL_MS` (15 s) the others take its partitions over.
   A graceful shutdown hands them back immediately.
2. **Scheduling** (every 2 s). For due monitors (`status = active`, `nextCheckAt <= now`) in
   owned partitions, one MongoDB transaction: advance `nextCheckAt` (only if unchanged since it
   was read), create a `CheckRun`, and write the fetch job to the outbox.
3. **Outbox relay**. Claims outbox messages, publishes them, waits for RabbitMQ's publisher
   confirm, then marks them published. Failures back off and retry; messages that can never be
   published are marked `failed`. Delivery is at-least-once, so consumers are idempotent.

Duplicate protection doesn't rely on leases alone: `CheckRun` has a unique index on
`(monitorId, scheduledFor)` where `scheduledFor` is the due time rounded to the minute, so two
instances (or a retry) can never create two runs for the same slot. A badly late check restarts
the cadence from now rather than firing a burst of catch-up checks.

Run more instances locally with `npm run dev:scheduler` in extra terminals; the System page
(`/system`) shows each instance's partitions, the outbox backlog and queued runs.

## Messaging model

Every work queue `<q>` has retry tiers `<q>.retry.5000|30000|120000` and a dead-letter
queue `<q>.dead`. A failing handler is retried with backoff; after 4 attempts (or on a
`NonRetryableError` / invalid message) it lands in the DLQ. Handlers must be idempotent —
a message can be delivered more than once.

If you change queue arguments in `packages/messaging/src/topology.ts`, RabbitMQ will refuse
the redeclare (`PRECONDITION_FAILED`): delete the queue in the management UI or run
`npm run infra:reset`.

## Roadmap status

- [x] Phase 1 — Foundation: monorepo, Docker infra, shared packages, API ↔ RabbitMQ ↔ worker
- [x] Phase 2 — Auth + monitor CRUD + dashboard
- [x] Phase 3 — Natural-language → validated rules (AI: Gemini / OpenAI / Ollama)
- [x] Phase 4 — Scheduler + CheckRuns + outbox + partition leases
- [ ] Phase 5 — HTTP / Playwright fetch workers, SSRF protection, snapshots
- [ ] Phase 6 — Extraction + change detection
- [ ] Phase 7 — Rules engine + AI enrichment
- [ ] Phase 8 — Notifications (Socket.IO + email)
- [ ] Phase 9 — Frontend pages
- [ ] Phase 10 — Reliability + tests
- [ ] Phase 11 — Dockerize + deploy
