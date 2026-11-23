# Salonique — API Server (Backend)

**Salonique** is a full-stack salon appointment booking platform. This repository contains the **Express + MongoDB REST API** that powers the platform: service catalog, appointment scheduling with double-booking prevention, role-enforced administration, and **webhook-verified Stripe payments**.

> **Related repositories**
>
> - Frontend (Next.js 16): [`Nafiz-365/Salonique-Client`](https://github.com/Nafiz-365/Salonique-Client)
> - Backend (this repo): [`Nafiz-365/Salonique-Server`](https://github.com/Nafiz-365/Salonique-Server)

---

## Table of Contents

- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [Security Model](#security-model)
- [Stripe Payment Flow](#stripe-payment-flow)
- [API Reference](#api-reference)
- [Project Layout](#project-layout)
- [Verification](#verification)
- [Links](#links)

---

## Highlights

- **Webhook-only payment state** — `paymentStatus` and the transaction ledger are written exclusively by signature-verified Stripe webhook events. No client-supplied path can mark an appointment as paid.
- **Cryptographic auth** — every protected route verifies the Better Auth **JWT via JWKS** (`jose`), then re-checks the database for blocked/suspended status and the _current_ role, so demoted admins lose access immediately.
- **Double-booking prevention** — an application-level collision check plus a **unique partial index** (`unique_active_appointment_slot`) on `{ serviceId, date, time }` for active appointments.
- **Idempotent webhooks** — Stripe retries are safe: a unique `stripeSessionId` index and duplicate-key (`11000`) handling make event processing exactly-once.
- **Strict input handling** — allow-listed service fields, validated status enums, future-date checks, and a global 404 + error handler.
- **Starts clean** — the server listens only after MongoDB connections and indexes are ready.

---

## Tech Stack

| Layer         | Technology                                                                             |
| ------------- | -------------------------------------------------------------------------------------- |
| Runtime       | **Node.js 20+** (ES modules)                                                           |
| Framework     | **Express.js 4**                                                                       |
| Database      | **MongoDB** native driver (`mongodb` v6+)                                              |
| Auth          | **`jose`** — JWKS remote key set + `jwtVerify` against the frontend's `/api/auth/jwks` |
| Payments      | **Stripe SDK** — Checkout Sessions + signed Webhooks                                   |
| Config / CORS | `dotenv`, `cors` (origin locked to `CLIENT_URL`)                                       |

---

## Architecture

```
        Next.js frontend (Salonique-Client)
        ├── public reads  ──────────────►  GET  /services, /featured-services, /service/:id
        └── BFF proxy (attaches JWT) ───►  all protected routes
                        │
                        ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  Express API  (this repo — single index.js)                   │
   │                                                               │
   │  verifyToken ── JWKS signature ──► checkBlockedUser ──► …     │
   │  verifyAdmin ── role gate (admin routes)                      │
   │                                                               │
   │  POST /webhook (raw body → Stripe signature verification)     │
   └──────────┬──────────────────────────────┬─────────────────────┘
              │                              │
              ▼                              ▼
         MongoDB                        Stripe
   services · appointments        Checkout Sessions
   users · transactions           Webhook events
```

**Request lifecycle (protected route)**

1. `verifyToken` reads `Authorization: Bearer <JWT>` and verifies it against `{CLIENT_URL}/api/auth/jwks`.
2. `checkBlockedUser` loads the user from MongoDB: blocked/suspended → **403**; the role is refreshed from the database (a demoted admin is rejected even with a still-valid token).
3. Admin routes additionally pass `verifyAdmin` → **403** for non-admins.
4. Handlers validate input, apply allow-lists, and return JSON errors from the global handlers.

---

## Getting Started

### Prerequisites

- **Node.js 20+**
- A **MongoDB Atlas** URI or local MongoDB instance
- _(Optional)_ Stripe test keys for checkout flows

### Installation

```bash
git clone https://github.com/Nafiz-365/Salonique-Server.git
cd Salonique-Server
npm install
```

### Configure environment

```bash
# create .env from the example and fill in real values
Copy-Item .env.example .env
```

### Run

```bash
npm run dev    # development (nodemon auto-reload)
npm start      # production (node index.js)
```

Verify health: `GET http://localhost:8000` →
`{ "name": "Salonique API Server", "status": "online", ... }`

---

## Environment Variables

Set these names in `.env` or your deployment environment. **Never commit actual secrets.**

| Variable                  | Required            | Purpose                                                                  |
| ------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `PORT`                    | no (default `8000`) | HTTP port                                                                |
| `MONGODB_URI`             | yes                 | MongoDB connection string                                                |
| `CLIENT_URL`              | yes                 | Frontend origin — CORS allowlist **and** JWKS endpoint base              |
| `STRIPE_SECRET_KEY`       | for payments        | Stripe API key; checkout routes return 400 until set                     |
| `STRIPE_WEBHOOK_SECRET`   | for payments        | Webhook signing secret; `/webhook` disabled until set                    |
| `NODE_ENV`                | yes                 | `production` / `development`                                             |
| `ALLOW_DEV_AUTH_FALLBACK` | no                  | `true` enables the `x-user-email` dev fallback — **never in production** |

> `.env` must stay in `.gitignore`. The dev fallback logs a warning at startup when enabled.

---

## Database

**Collections & purpose**

| Collection     | Contents                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`     | Catalog: category, price, duration, image, `isActive`, `featured`, specialist info                                                                          |
| `appointments` | Bookings: customer, service snapshot, date, time slot, status (`pending/confirmed/completed/cancelled`), `paymentStatus` (`unpaid/paid`), `stripeSessionId` |
| `users`        | Better Auth accounts: `role` (`customer`/`admin`), `isBlocked`, `status`                                                                                    |
| `transactions` | Immutable payment ledger — written only by webhook processing                                                                                               |

**Indexes created at startup**

- `services`: `{ category, price }`, `slug`
- `appointments`: `{ userEmail, createdAt }`, plus the **unique** `unique_active_appointment_slot` on active slots → database-level double-booking guarantee
- `transactions`: `{ appointmentId }`, plus **unique** `stripeSessionId` → webhook idempotency

---

## Security Model

| Control           | Implementation                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| JWT verification  | `verifyToken` — `createRemoteJWKSet` + `jwtVerify` against `{CLIENT_URL}/api/auth/jwks`; requires a valid email claim |
| Blocked accounts  | `checkBlockedUser` — `isBlocked` or `status: "suspended"` → **403** on every protected route                          |
| Role freshness    | Role re-read from MongoDB per request — demotions take effect immediately                                             |
| Admin gate        | `verifyAdmin` on all catalog, appointment-oversight, and user-management routes                                       |
| CORS              | Production allows only `CLIENT_URL`; credentials enabled                                                              |
| Mass-assignment   | `ALLOWED_SERVICE_FIELDS` allow-list when creating/updating services                                                   |
| Input validation  | Status enums, future-date rule, required-field checks, 10 MB JSON limit                                               |
| Admin protection  | Admin accounts cannot be blocked via `toggle-block`                                                                   |
| Session ownership | `/verify-session/:sessionId` only reveals sessions belonging to the requester                                         |
| Error handling    | Catch-all 404 + global error handler → structured JSON, no stack traces leaked                                        |

---

## Stripe Payment Flow

1. **Request** — customer books (`POST /booking`) → `pending` / `unpaid`.
2. **Confirm** — admin confirms (`PATCH /appointment/:id/status`) → customer may pay.
3. **Checkout** — `POST /create-checkout-session` creates a Stripe Checkout Session (previous session expired first; an existing valid session is reused), embedding `appointmentId` + `userEmail` metadata.
4. **Redirect** — customer completes payment on Stripe-hosted page.
5. **Webhook (source of truth)** — `POST /webhook` verifies the Stripe signature on the **raw body**, then:
    - `checkout.session.completed` / `async_payment_succeeded` → validates **email, amount, and currency** against the stored appointment before setting `paymentStatus: "paid"` and inserting an idempotent `paid` transaction.
    - `checkout.session.expired` / `async_payment_failed` → releases the reserved `stripeSessionId` and records a `failed` transaction (once).
    - Mismatched data is logged and **ignored** — never applied.

---

## API Reference

Base URL (local): `http://localhost:8000`

### Public

| Method | Endpoint             | Description                                                                                                            |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                  | Health check + database status                                                                                         |
| GET    | `/services`          | Paginated catalog — `search`, `category`, price range, `sort=price_asc\|price_desc\|rating\|duration`, `page`, `limit` |
| GET    | `/featured-services` | Active featured treatments                                                                                             |
| GET    | `/service/:id`       | Single service by ID or slug                                                                                           |

### Authenticated — Customer (`verifyToken`)

| Method | Endpoint                     | Description                                                                     |
| ------ | ---------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/booking`                   | Create appointment request — future-date validated, **collision-checked (409)** |
| GET    | `/my-appointments/:email`    | Caller's appointment history                                                    |
| PATCH  | `/appointment/:id/cancel`    | Cancel own pending request                                                      |
| POST   | `/create-checkout-session`   | Create Stripe Checkout session for a confirmed appointment                      |
| GET    | `/verify-session/:sessionId` | Read-only payment status of **own** session                                     |
| PATCH  | `/user/profile`              | Update own name / phone / image                                                 |
| POST   | `/webhook`                   | Stripe webhook (signature-verified; not a user route)                           |

### Authenticated — Admin (`verifyToken` + `verifyAdmin`)

| Method | Endpoint                    | Description                                   |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/admin/services`           | Active **and** inactive services              |
| POST   | `/services`                 | Create service (allow-listed fields)          |
| PATCH  | `/services/:id`             | Update service                                |
| DELETE | `/services/:id`             | Remove service from catalog                   |
| GET    | `/all-appointments`         | All appointments across the platform          |
| PATCH  | `/appointment/:id/status`   | Confirm (only from `pending`) or cancel       |
| GET    | `/users`                    | Customer directory with block status          |
| PATCH  | `/user/:email/toggle-block` | Block / unblock a customer (admins protected) |
| GET    | `/transactions`             | Payment history ledger                        |

**Error shape:** `{ "error": "…" }` (404/500 use `{ "success": false, "message": "…" }`).

---

## Project Layout

```
salonique-server/
├── index.js          # Entire API: config, middleware, webhook, routes, handlers
├── package.json      # scripts: dev (nodemon), start (node)
├── .env.example      # environment variable names with placeholders
└── README.md
```

> The API is intentionally a single, readable module — middleware, webhook processing, and route handlers are sectioned with banner comments.

---

## Verification

```bash
node --check index.js     # syntax check
npm run dev               # boot + confirm "Salonique API Server running"
curl http://localhost:8000/   # health probe → status: "online"
```

For end-to-end payment testing use Stripe **test keys** and the Stripe CLI (`stripe listen --forward-to localhost:8000/webhook`).

---

## Links

- **Live API**: https://salonique-server.onrender.com/
- **Server repository**: https://github.com/Nafiz-365/Salonique-Server
- **Client repository**: https://github.com/Nafiz-365/Salonique-Client
- **Live frontend**: https://salonique-client.vercel.app/

---

## License

This project is created for evaluation purposes. All rights reserved.
