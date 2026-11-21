# Salonique API Server — Backend

High-performance REST API backend for the **Salonique Salon Appointment Booking Platform**, built with **Node.js**, **Express.js**, **MongoDB**, **JWT Authentication (JWKS & jose)**, and **Stripe Webhooks**.

---

## 🚀 Live Demo & Repository Links

- **Live Server API**: Not verified; add the deployed URL before submission
- **Server GitHub Repository**: [https://github.com/Nafiz-365/Salonique-Server](https://github.com/Nafiz-365/Salonique-Server)
- **Client GitHub Repository**: [https://github.com/Nafiz-365/Salonique-Client](https://github.com/Nafiz-365/Salonique-Client)

---

## 🌟 Important Backend Features

- **Database Architecture (MongoDB)**:
  - `services`: Service catalog with category, price, duration, image, and active/inactive status.
  - `appointments`: Booking requests with customer ID, date, time slot, notes, status (Pending, Confirmed, Cancelled), and paymentStatus (Unpaid, Paid).
  - `user`: User accounts managed by Better Auth with role (`customer` / `admin`) and `isBlocked` flag.
  - `transactions`: Immutable payment records updated exclusively through verified Stripe Webhooks.
- **Double-Booking Collision Prevention**: Automatically checks for conflicting appointments for the same service, date, and time slot before reserving.
- **Server-Side Role & Security Verification**:
  - `verifyToken` middleware: Verifies JWT signatures via Better Auth JWKS endpoint, validates active status, and blocks suspended accounts.
  - `verifyAdmin` middleware: Enforces master administrator role on all protected service modifications, appointments oversight, and user management routes.
- **Stripe Checkout & Webhook Integration**:
  - Creates secure Stripe Checkout sessions for confirmed appointments.
  - `POST /webhook` requires a valid Stripe signature and is disabled until Stripe credentials are configured.
  - Appointment payment status and transactions are updated only by verified Stripe webhook events.
- **User Access Management**:
  - `GET /users`: Retrieves customer directory.
  - `PATCH /user/:email/toggle-block`: Allows admins to block/unblock users. Blocked users are barred from protected booking features.

---

## 🛠️ Technology Stack

- **Runtime**: Node.js 20+
- **Framework**: Express.js 4
- **Database**: MongoDB Native Driver (`mongodb` v6)
- **Security & JWT**: `jose` (JWKS verification) + CORS
- **Payments**: Stripe SDK (`stripe`)
- **Environment Management**: `dotenv`

---

## 📋 Environment Variables

Set these variable names in the server `.env` file or deployment environment:

- `PORT`
- `MONGODB_URI`
- `CLIENT_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `ALLOW_DEV_AUTH_FALLBACK`
- `NODE_ENV`

> **Security Note**: Never commit actual secret keys or `.env` files to GitHub. Keep `.env` included in `.gitignore`.

---

## 💻 Installation & Local Development

### Prerequisites
- Node.js 20+ installed
- MongoDB Atlas cluster URI or local MongoDB daemon

### Step-by-Step Instructions

1. **Clone the server repository**:
   ```bash
   git clone https://github.com/Nafiz-365/Salonique-Server.git
   cd Salonique-Server
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   Copy-Item .env.example .env
   # Add your MongoDB connection string and Stripe keys to .env
   ```

4. **Start the server**:
   ```bash
   # Development with automatic reload
   npm run dev

   # Production start
   npm start
   ```

5. **Verify server health**:
   Open [http://localhost:8000](http://localhost:8000) to view server status.

---

## 📡 REST API Documentation

### Public Endpoints
- `GET /` — API health check and database connection status
- `GET /services` — Paginated service catalog with search (`search`), category (`category`), price range, and sorting (`sort=price_asc|price_desc|rating|duration`)
- `GET /featured-services` — Active featured salon treatments
- `GET /service/:id` — Single service details by ID or slug

### Protected Endpoints (Authenticated)
- `POST /booking` — Submit appointment request (Customer only; collision checked)
- `GET /my-appointments/:email` — Retrieve customer's personal appointment history
- `PATCH /appointment/:id/cancel` — Cancel pending appointment request
- `POST /create-checkout-session` — Generate Stripe Checkout session for confirmed appointment
- `POST /webhook` — Stripe webhook listener for `checkout.session.completed`

### Protected Endpoints (Admin Only)
- `POST /services` — Create new salon treatment
- `PATCH /services/:id` — Update existing treatment
- `DELETE /services/:id` — Delete treatment from catalog
- `GET /all-appointments` — View all customer appointments across platform
- `PATCH /appointment/:id/status` — Confirm pending appointment or cancel
- `GET /users` — View registered customer list with block status
- `PATCH /user/:email/toggle-block` — Block or unblock customer account
- `GET /transactions` — View payment history
- `GET /admin/services` — View active and inactive services

---

## 📄 License

This project is created for evaluation purposes. All rights reserved.
