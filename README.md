# Monitorly

Website change monitoring: give it a URL and a plain-English description of what to watch
("new Software Engineer Intern roles in India"); it checks on a schedule, detects meaningful
changes, applies your rules and alerts you in-app and by email.

## Layout

```
apps/web                 React + Vite + TanStack Query + Tailwind
services/api             Express REST API + Socket.IO live updates
services/scheduler       Finds due monitors → CheckRun + outbox (one transaction) → RabbitMQ
services/fetch-worker    HTTP fetching (consumes fetch.http); "auto" hands JS-only pages to the browser worker
services/browser-worker  Playwright/Chromium rendering (consumes fetch.browser) behind an SSRF-safe proxy
services/processing-worker  Extraction + change detection (consumes content.process, publishes content.processed)
services/rules-worker    Applies each monitor's filters to its changes (consumes rules.evaluate)
services/ai-worker       AI review of matched changes: relevance + summary (consumes ai.analyze)
services/notification-worker  Alerts: in-app notifications + email (consumes notify.dispatch, notify.email)
packages/config          .env loading + Zod validation
packages/contracts       RabbitMQ topology + message schemas (single source of truth)
packages/database        Mongoose connection, models, indexes
packages/messaging       RabbitMQ: confirms, manual acks, prefetch, retry tiers, DLQs
packages/ai              AI (OpenAI / Gemini / Ollama): description → validated filters
packages/url-safety      SSRF protection: URL rules + connect-time DNS check (on save, every fetch, every redirect)
packages/fetching        Safe HTTP fetch (Axios), content check (Cheerio), robots.txt, shared worker steps
packages/extraction      Page → normalized items with stable fingerprints; item-level diff
packages/rules           The rules engine: keywords / locations / excludes, pure functions
packages/storage         S3-compatible object storage for page snapshots (gzip)
packages/outbox          Transactional outbox: enqueue in a transaction, relay to RabbitMQ
packages/logger          Pino structured logging
packages/runtime         Graceful shutdown / crash handling for every service
e2e/                     Playwright browser tests of the main user journeys (+ axe accessibility checks)
infrastructure/          Config mounted into infra containers
```


## Prerequisites

- Node.js 22+
- Docker Desktop (running, ~4 GB RAM)

## First-time setup

```bash
npm install
cp .env.example .env        # then set JWT_SECRET (generator command is in the file)
npm run infra:up            # MongoDB, RabbitMQ, Redis, SeaweedFS (S3), Mailpit; creates the bucket
npm run setup:browser       # downloads Chromium for the browser worker (once)
```

## Daily development

```bash
npm run infra:up    # if not already running
npm run dev         # api + scheduler + all workers + web, with hot reload
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
`npm run test:e2e` (browser tests, see below), `npm run typecheck`, `npm run infra:logs`, `npm run infra:down`, `npm run infra:reset` (deletes all local data).

### Browser (end-to-end) tests

`npm run test:e2e` drives the real app in Chromium: desktop and a phone-sized screen. It covers
sign-up and login, creating monitors (with and without AI suggestions), form validation, editing
with the unsaved-changes guard, pause/resume/delete, dashboard search and filters, change and check
history with paging, live alerts, the bell and notifications page, settings, error/retry/offline
states, phone layouts, keyboard use, and axe accessibility scans (WCAG 2.2 A/AA, no serious or
critical issues allowed).

It needs `npm run infra:up` and, the first time, `npx playwright install chromium`. It starts its
own API (port 4100, AI switched off, database `monitorly_e2e`, wiped at the start of each run) and
a production build of the web app (port 5180), so it can run next to `npm run dev`. The pipeline
workers aren't started; a test-only seed server (`e2e/support/seed-server.ts`, 127.0.0.1 only)
writes the changes and alerts the workers would produce and broadcasts them on RabbitMQ, so live
pop-ups go through the real API. `npm run e2e:ui -w @monitorly/e2e` opens Playwright's UI mode.

## API

All `/api/monitors` routes require login and only ever touch the current user's monitors —
another user's monitor ID returns 404, exactly like a non-existent one.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/register | Create account (sets session cookie) |
| POST | /api/auth/login | Log in |
| POST | /api/auth/logout | Log out |
| GET | /api/auth/me | Current user |
| PATCH | /api/auth/me | Account settings: `name`, `emailNotifications` (account-wide email switch), `defaultCheckIntervalMinutes` |
| POST | /api/monitors/interpret | Suggest filters from a description (AI; saves nothing) |
| POST | /api/monitors | Create monitor |
| GET | /api/monitors | List my monitors |
| GET | /api/monitors/:id | Monitor details |
| PATCH | /api/monitors/:id | Update (only the fields sent) |
| GET | /api/monitors/:id/runs | Recent check runs (`?limit=`, max 100) |
| GET | /api/monitors/:id/events | Changes detected on this monitor, with the verdict (`?limit=`, max 200; `?only=matched`; `?cursor=`) |
| GET | /api/events | Recent changes across all my monitors (`?limit=`, max 100; `?only=matched`; `?cursor=`) |
| GET | /api/notifications | My alerts, newest first, plus `unreadCount` (`?limit=`, `?unread=true`; `?cursor=`) |
| POST | /api/notifications/:id/read | Mark one alert read |
| POST | /api/notifications/read-all | Mark all alerts read |
| POST | /api/monitors/:id/pause | Pause |
| POST | /api/monitors/:id/resume | Resume (clears errors, checks immediately) |
| DELETE | /api/monitors/:id | Delete monitor and its history |

Lists of changes and alerts are paged with a cursor: each response has `nextCursor` (pass it as
`?cursor=` for the next, older page; `null` at the end). Unlike offsets, pages stay correct while
new items arrive at the top.

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

## Fetching pages

A scheduled job goes to `fetch.http` (or straight to `fetch.browser` for monitors set to
"Full browser", or "auto" monitors that needed the browser last time).

- **HTTP worker**: checks `robots.txt`, fetches with Axios, and stores the page gzip-compressed
  at `snapshots/<monitorId>/<checkRunId>.html.gz`. It then records the `Snapshot`, completes the
  run and writes a `fetch.completed` message (a *reference* to the stored page, never the HTML)
  to the outbox, all in one transaction.
- In **auto** mode, if the page has almost no text without JavaScript (checked with Cheerio), or
  the site answers 401/403/406, the same run is handed to the **browser worker**, which renders
  it in headless Chromium. The method that worked is remembered for the next check.
- Failures: temporary ones (timeouts, 5xx, 429) retry with backoff (5 s → 30 s → 2 min).
  Permanent ones (404, blocked address, robots.txt, PDF…) fail the run at once. After
  `MONITOR_ERROR_THRESHOLD` (5) failed checks in a row the monitor is set to **error** and is no
  longer scheduled until the user resumes it.

**SSRF protection** (users can submit any URL):
- Only http/https on ports 80/443/8080/8443; no credentials in URLs; no internal hostnames.
- DNS is checked **at connect time** by a custom lookup, so the address actually connected to is
  the one that was approved (no DNS rebinding). Every redirect is followed manually and re-checked.
- Environment proxies are ignored; responses are capped at 5 MB *after decompression* (gzip
  bombs) with a total deadline.
- The browser can't be trusted to stay on the page's host (redirects, scripts, `fetch()`,
  iframes), so **all** Chromium traffic, including loopback, goes through a local proxy that applies
  the same checks. The proxy requires a per-process secret, every job gets a fresh browser
  context (no cookies or credentials), service workers and downloads are blocked.
- For production, also run the workers on a network that can only reach the public internet.

## Change detection

The processing worker consumes `fetch.completed` (queue `content.process`):

1. **Extract** items from the stored page (`packages/extraction`). Noise is removed first: scripts,
   navigation, header/footer, cookie banners, hidden elements. Then, in order of reliability:
   schema.org JSON-LD (`JobPosting`, `Product`), repeated page structure (lists, cards, table
   rows), content links. "Any change" monitors compare text blocks instead.
2. **Normalize**: Unicode NFKC, whitespace, quotes/dashes; links made absolute with tracking
   parameters removed. Volatile text ("Posted 3 days ago", clock times, view/applicant counts)
   is left out of hashes.
3. **Fingerprint**: each item's identity is its canonical link (or structured-data id, or title when
   there is no unique link); its content hash covers title, text and fields. The page hash covers
   all items, so equal hashes mean nothing changed. The structure that held the records is saved
   as a template and reused, so lists that shrink to one or two entries are still found.
4. **Compare** with the baseline: added → `new_item`, same identity with a different hash →
   `item_changed` (with which fields changed), gone → `item_removed`. Links whose query string
   changes on every load (session tokens) are matched by title + path. "Any change" monitors get
   one `page_changed` event.
5. **Guard rails**: the first check only saves a baseline. If most items vanish at once (≥5 items
   dropping below half), it's treated as a broken load: nothing is reported and the baseline is kept;
   after 3 such checks in a row the new layout is accepted quietly.
6. **Commit** in one transaction: events (unique `(monitorId, fingerprint)`, so duplicates are
   impossible), the snapshot marked processed, the baseline advanced, and `content.processed` in the
   outbox for the rules engine (queue `rules.evaluate`).

Ordering: a result older than the current baseline (or scheduled before the URL/page type changed)
is marked stale and never compared. The transaction re-checks that the baseline is still the one it
compared against; if another check moved it meanwhile, it starts over. Every snapshot and its
extracted items stay in object storage (`<checkRunId>.html.gz`, `<checkRunId>.items.json.gz`).

## Rules + AI review

The rules worker consumes `content.processed` (queue `rules.evaluate`) and applies the monitor's
filters to each change (`packages/rules`): case- and accent-insensitive substring matching, so
"intern" also matches "Internship"; **all** keywords, **any** location (a job's location field
when it has one, so "remote" in a description doesn't count), **no** excluded word. No filters =
everything matches. Updates are judged on the new version, removals on the removed item, page
changes on the passages that appeared. Each change gets a verdict and, when filtered out, the
reasons ("Doesn't mention "frontend"").

Matched changes then either go straight to notifications or, when the monitor has **AI review**
on (the default) and an AI key is set, to the AI worker (queue `ai.analyze`, batches of up to 10
changes per call). The AI judges each change against the user's own description, writes a
one-line summary and a reason. Relevant → delivered; not relevant → kept in history as "Not
relevant". Page text is fenced as untrusted data, and the AI can only answer, never act.

When the AI can't decide, the filters' decision stands and the change is delivered, because a
missed alert is worse than an unreviewed one. That covers no key, the daily limit
(`AI_REVIEW_DAILY_LIMIT` per user, `AI_REVIEW_GLOBAL_DAILY_LIMIT` overall), quota used up, a
bad answer, and a provider that is still down after the retries (5 s → 30 s → 2 min). Calls are
spaced `AI_MIN_INTERVAL_MS` apart for free tiers.

Delivery: matches go out as `event.matched` (queue `notify.dispatch`, see Notifications below). Each change is evaluated once and delivered at most once: the verdict, `alertedAt`
and the outgoing message are written in one transaction that only applies while the change is
still pending, so redeliveries and parallel copies are harmless. Changes of deleted monitors are
ignored.

## Notifications

The notification worker consumes `event.matched` (queue `notify.dispatch`) and creates one
notification per change. A unique index on the event makes redeliveries harmless. In the same
transaction it queues the follow-ups the monitor's settings ask for:

- **In the app**: `notification.created` is broadcast to every API instance. Each one pushes the
  notification over Socket.IO to the owner's open tabs (bell badge + a pop-up). The browser
  refetches the list on every (re)connect, so nothing is lost while it was closed. The socket is
  authenticated with the session cookie, and only the web app's origin may connect: browsers send
  cookies on cross-site WebSocket handshakes, so this stops other sites from listening in. Each
  socket only ever joins its own user's room.
- **By email** (`notify.email`, when the monitor has email on and the user hasn't turned email off):
  sent via SMTP (Mailpit locally: http://localhost:8025), or Resend when `RESEND_API_KEY` is set.
  A send is claimed before it starts, so parallel deliveries send once; a claim left by a crashed
  worker is taken over after 10 minutes, and Resend also gets the notification id as idempotency
  key. Temporary failures retry (5 s → 30 s → 2 min); a rejected address fails at once. At most
  `EMAIL_MAX_PER_HOUR` emails per user per hour; the rest are still in the app. Every page-derived
  string is HTML-escaped, the subject can't carry header line breaks, only http(s) links are
  rendered, and every email links to the monitor's settings to turn email off.

## Web app

- **Dashboard**: stats (active, unread alerts, failing, next check), a "Needs attention" list of
  failing monitors with a Retry button, recent alerts, and the monitor list with search, status
  filters and sorting. A first-run guide when there are no monitors yet.
- **Monitor page**: everything it watches for, the change history (all changes or alerts only,
  with why each change did or didn't alert, paged), the check history, pause/resume/retry, edit
  and delete (with a confirmation). Opening an alert jumps to and highlights its change.
- **Notifications page**: every alert, unread filter, mark all as read, paged.
- **Settings**: name, the account-wide email switch, the default check frequency for new monitors,
  and in-app/email per monitor (saved as you click).
- **Forms** run the API's own Zod schemas in the browser, so messages match the server's. Errors
  show next to the field, focus moves to the first one, and server-side checks (like a private URL)
  land on the right field. Leaving a form with unsaved edits asks first.
- **States**: placeholders while loading, an error with "Try again" when loading fails, a toast
  when an action fails, an offline banner, clear "not found" pages, and a crash screen instead of a
  blank page.
- **Accessibility**: skip link, focus moves to the page heading after navigation, page titles,
  labelled regions, errors announced to screen readers and linked to their fields, a native
  `<dialog>` for confirmations, keyboard-closable menus, reduced-motion support.
- **Phones**: the header collapses into a menu, panels fit the screen, nothing scrolls sideways.

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
- [x] Phase 5 — HTTP / Playwright fetch workers, SSRF protection, snapshots
- [x] Phase 6 — Extraction + change detection
- [x] Phase 7 — Rules engine + AI enrichment
- [x] Phase 8 — Notifications (Socket.IO + email)
- [x] Phase 9 — Frontend polish: management UX, settings, history, states, responsive, a11y, e2e tests
- [ ] Phase 10 — Reliability + tests
- [ ] Phase 11 — Dockerize + deploy
