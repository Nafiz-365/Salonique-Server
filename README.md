# Salonique Server

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Native_Driver-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Stripe](https://img.shields.io/badge/Stripe-Checkout-635BFF?logo=stripe&logoColor=white)](https://stripe.com/)

Salonique Server is the Express REST API for the Salonique salon-booking platform. It provides the service catalog, appointment booking and administration, user management, and Stripe Checkout integration. Application data is stored in MongoDB.

The Next.js client is maintained separately in [Nafiz-365/Salonique-Client](https://github.com/Nafiz-365/Salonique-Client).

## Features

- Public service discovery with search, filters, sorting, and pagination.
- Customer appointment requests with date/time validation and duplicate-slot protection.
- Role-protected admin endpoints for services, appointments, users, and transactions.
- Better Auth JWT verification through the client's JWKS endpoint.
- Stripe Checkout sessions and signature-verified webhooks.
- MongoDB indexes for catalog lookup, appointment queries, active booking slots, and webhook idempotency.

## Technology

| Area           | Tools                                            |
| -------------- | ------------------------------------------------ |
| Runtime        | Node.js (ES modules)                             |
| HTTP API       | Express 4                                        |
| Database       | MongoDB native driver                            |
| Authentication | `jose` JWT verification against Better Auth JWKS |
| Payments       | Stripe Node SDK                                  |
| Configuration  | `dotenv`, `cors`                                 |

The API is organized in a single `index.js` module, with middleware, webhook processing, and route handlers grouped by responsibility.

## Architecture

```text
Next.js client
  ├─ Public catalog requests ─────► Express API
  └─ Authenticated BFF requests ──► Express API
                                       │
                          verify Better Auth JWT via JWKS
                          check current role and account status
                                       │
                               MongoDB database

Stripe Checkout ── signed webhook ──► Express API
                                       ├─ update appointment payment state
                                       └─ write transaction record
```

Protected requests carry a Better Auth JWT in `Authorization: Bearer <token>`. The API verifies the token using `${CLIENT_URL}/api/auth/jwks`, requires an email claim, and then checks the corresponding MongoDB user for blocked/suspended status. The role is refreshed from MongoDB on each request so role changes take effect without waiting for the JWT to expire. Admin endpoints also require the `admin` role.

The API checks MongoDB connection and index initialization before calling `listen`. If MongoDB is not configured or initialization fails, the process can still start in standby mode; the root health endpoint reports the database state, and database-dependent endpoints return an unavailable response.

## Getting Started

### Prerequisites

- Node.js 20 or newer recommended, with npm.
- MongoDB Atlas or a local MongoDB server.
- Stripe test credentials for local checkout and webhook testing.
- The Salonique Client running for Better Auth JWKS verification.

### Install

```bash
git clone https://github.com/Nafiz-365/Salonique-Server.git
cd Salonique-Server
npm ci
```

Create `.env` from `.env.example` and replace its placeholders with your own configuration. Do not commit `.env` or real credentials.

```bash
cp .env.example .env
```

Run the API:

```bash
npm run dev    # Development with nodemon
npm start      # Production process
```

By default, the API listens on port `8000`. Check `GET http://localhost:8000/` for process and dependency status:

```json
{
    "name": "Salonique API Server",
    "status": "online",
    "dbConnected": true,
    "stripeEnabled": true
}
```

The `dbConnected` and `stripeEnabled` fields reflect the current configuration; an online process does not by itself mean that every integration is configured.

## Environment Variables

| Variable                  | Required                     | Purpose                                                                                                            |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PORT`                    | No                           | HTTP port; defaults to `8000`.                                                                                     |
| `MONGODB_URI`             | Required for data operations | MongoDB connection string. The API uses the `salonique` database.                                                  |
| `CLIENT_URL`              | Yes for normal auth setup    | Client origin used for production CORS and the Better Auth JWKS URL. Defaults to `http://localhost:3000`.          |
| `STRIPE_SECRET_KEY`       | Optional                     | Stripe API key; required to create Checkout sessions. Use a test key locally.                                      |
| `STRIPE_WEBHOOK_SECRET`   | Optional                     | Signing secret for `/webhook`; required to process Stripe events.                                                  |
| `NODE_ENV`                | Recommended                  | Set to `development` locally and `production` in deployment; controls CORS behavior and development auth fallback. |
| `ALLOW_DEV_AUTH_FALLBACK` | Local development only       | Set to `true` only when intentionally testing the `x-user-email` fallback. The fallback is disabled in production. |

Set `CLIENT_URL` to the exact deployed client origin in production. The API uses it both as the CORS allowlist and as the base URL for Better Auth JWKS verification.

## API Reference

Base URL: `http://localhost:8000`

Protected endpoints require `Authorization: Bearer <Better Auth JWT>`. Admin endpoints additionally require a current admin role. Request and response bodies use JSON unless noted.

### Public

| Method | Endpoint             | Description                                         |
| ------ | -------------------- | --------------------------------------------------- |
| `GET`  | `/`                  | Health and integration status.                      |
| `GET`  | `/services`          | Active service catalog with filters and pagination. |
| `GET`  | `/featured-services` | Up to six active featured services.                 |
| `GET`  | `/service/:id`       | Active service by MongoDB ID or slug.               |

`GET /services` supports:

| Query parameter        | Description                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `search`               | Case-insensitive search across service name, descriptions, location, and specialist name.               |
| `category`             | Filter by category; `All` does not restrict the category.                                               |
| `minPrice`, `maxPrice` | Price range.                                                                                            |
| `location`             | Case-insensitive location filter.                                                                       |
| `sort`                 | `price_asc`, `price_desc`, `rating`, or `duration`.                                                     |
| `featured`             | Set to `true` to return featured services only.                                                         |
| `date`, `time`         | Filter out services with no free booking slot on the selected date/time. A time filter requires a date. |
| `page`, `limit`        | Pagination; page starts at 1 and limit is capped at 100.                                                |

The service-list response is `{ "services": [], "total": 0, "page": 1, "totalPages": 1 }`.

### Booking request

`POST /booking` accepts a JSON body with `serviceId` (MongoDB ID or slug), `date` (`YYYY-MM-DD`), and `time`. The currently accepted time values are `09:00 AM`, `10:00 AM`, `11:30 AM`, `01:00 PM`, `02:30 PM`, `03:45 PM`, `05:00 PM`, and `06:15 PM`. Optional customer details include `userPhone` and `notes` (or `message`). A successful request returns `201`; an occupied slot returns `409`.

### Customer

| Method  | Endpoint                     | Description                                                                                                              |
| ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST`  | `/booking`                   | Create a pending appointment request for the authenticated customer. Rejects invalid dates/times and occupied slots.     |
| `GET`   | `/my-appointments/:email`    | List the caller's appointments. The requested email must match the authenticated email.                                  |
| `PATCH` | `/appointment/:id/cancel`    | Customers can cancel their own pending requests. Admins can cancel pending or confirmed appointments through this route. |
| `POST`  | `/create-checkout-session`   | Create or reuse a Stripe Checkout session for the caller's confirmed, unpaid appointment.                                |
| `GET`   | `/verify-session/:sessionId` | Read payment status for the caller's own Checkout session.                                                               |
| `PATCH` | `/user/profile`              | Update the authenticated user's name, phone, and/or image.                                                               |

### Service management

`POST /services` requires `name` (or `serviceName`), `category`, a positive `price`, and a positive `duration`. `PATCH /services/:id` accepts an allowlist of service fields; `price` and `duration` must remain positive. Service IDs may be MongoDB IDs or slugs.

### Admin

| Method   | Endpoint                    | Description                                                                                       |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/services`           | List active and inactive services.                                                                |
| `POST`   | `/services`                 | Create a service.                                                                                 |
| `PATCH`  | `/services/:id`             | Update allow-listed service fields by ID or slug.                                                 |
| `DELETE` | `/services/:id`             | Delete a service; returns a conflict if it has pending or confirmed unpaid bookings.              |
| `GET`    | `/all-appointments`         | List all appointments.                                                                            |
| `PATCH`  | `/appointment/:id/status`   | Update appointment status to `pending`, `confirmed`, or `cancelled`, subject to transition rules. |
| `GET`    | `/users`                    | List non-admin users with booking summaries.                                                      |
| `PATCH`  | `/user/:email/toggle-block` | Block or unblock a non-admin user.                                                                |
| `GET`    | `/transactions`             | List payment transaction records.                                                                 |

### Stripe webhook

| Method | Endpoint   | Description                                                                                                                         |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/webhook` | Stripe webhook endpoint. Verifies the `Stripe-Signature` header against the raw request body; it is not a user-authenticated route. |

Route-level errors commonly use `{ "error": "..." }`. Unmatched routes and the final error handler use `{ "success": false, "message": "..." }`; clients should not assume one error shape for every response.

## Database

The API connects to the `salonique` database and uses these collections:

| Collection     | Purpose                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `services`     | Service catalog and active/featured state.                                |
| `appointments` | Booking details, status, active-slot reservation, and payment references. |
| `user`         | Better Auth users, roles, and blocked/suspended state.                    |
| `transactions` | Stripe payment outcomes associated with appointments.                     |

Indexes are created during initialization:

- `services`: `{ category, price }` and `{ slug }`.
- `appointments`: `{ serviceId, date, time, status }`, `{ userEmail, createdAt }`, and a unique partial index on `{ serviceId, date, time }` for documents with `activeSlot: true`.
- `transactions`: `{ appointmentId }` and a unique partial index on `stripeSessionId` when that field exists.

Booking requests also perform an application-level availability check. The partial unique index provides a database-level guard against concurrent reservations for the same active slot. Cancellation releases the slot by clearing `activeSlot`.

## Authentication and Security

- Better Auth issues the JWT; this API verifies it against the client's JWKS endpoint.
- Protected requests check the user's current blocked/suspended state and role in MongoDB.
- Admin routes use a separate role check. Customer booking and payment endpoints require the `customer` role and enforce appointment ownership.
- Production CORS allows the configured `CLIENT_URL`; development also allows `http://localhost:3000`.
- Service writes use an explicit field allowlist, and the JSON request body limit is 10 MB.
- The development auth fallback is disabled whenever `NODE_ENV=production`. Never enable it in a deployed environment.

## Stripe Checkout Flow

1. A customer submits a booking request; it begins as `pending` and `unpaid`.
2. An administrator confirms the appointment.
3. The customer requests a Checkout session. The API checks ownership, confirmed status, current service price, and payment state before creating or reusing the session.
4. Stripe redirects the customer to its hosted payment page.
5. Stripe sends an event to `/webhook`. The API verifies the signature using the raw request body.
6. Paid events update an appointment only when the appointment, Checkout session, customer email, amount, and USD currency match. A transaction record is then stored. Expired and failed sessions release the associated session reference; failed payments are recorded.

The webhook's unique `stripeSessionId` index and duplicate-key handling make Stripe retries safe for transaction insertion. A browser redirect or client request does not mark an appointment paid.

For local testing, use Stripe test keys and forward webhook events:

```bash
stripe listen --forward-to localhost:8000/webhook
```

Use the signing secret printed by Stripe CLI as `STRIPE_WEBHOOK_SECRET`.

## Scripts and Verification

```bash
npm run dev             # Start with nodemon
npm start                # Start with Node.js
node --check index.js    # Check JavaScript syntax
```

There is no automated test script configured in `package.json`.
For a local smoke check, start the API and request `GET /`; verify `dbConnected` before testing database-backed routes.

## Project Structure

```text
salonique-server/
├── index.js          # Express setup, MongoDB, auth, routes, Stripe webhook
├── package.json      # Runtime dependencies and scripts
├── package-lock.json # Locked dependency versions
├── .env.example      # Environment variable template
└── README.md
```

## Related Projects

- [Salonique Client (Next.js)](https://github.com/Nafiz-365/Salonique-Client)
- [Salonique Server repository](https://github.com/Nafiz-365/Salonique-Server)
- API deployment: [https://salonique-server.onrender.com](https://salonique-server.onrender.com)

The package metadata declares the ISC license.
