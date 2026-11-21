# Salonique API Server — Backend

High-performance REST API backend for the **Salonique Salon Appointment Booking Platform**, built with **Node.js**, **Express.js**, **MongoDB**, **JWT Authentication (JWKS & jose)**, and **Stripe Webhooks**.

---

## 🚀 Live Demo & Repository Links

- **Live Server API**: [https://salonique-api.onrender.com](https://salonique-api.onrender.com) *(Replace with actual deployed URL)*
- **Server GitHub Repository**: [https://github.com/your-username/salonique-server](https://github.com/your-username/salonique-server)
- **Client GitHub Repository**: [https://github.com/your-username/salonique-client](https://github.com/your-username/salonique-client)

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
  - Verified `express.raw` Webhook listener (`POST /webhook`) that confirms payment signature before marking appointments as Paid.
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

Create a `.env` file in the root of the server directory with the following variables (names only):

```env
# Server Port
PORT=8000

# MongoDB Atlas Connection String
MONGODB_URI=

# Client Application URL (for CORS and JWKS verification)
CLIENT_URL=http://localhost:3000

# Stripe Credentials (Test Mode)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Development Flags
ALLOW_DEV_AUTH_FALLBACK=true
NODE_ENV=development
```

> **Security Note**: Never commit actual secret keys or `.env` files to GitHub. Keep `.env` included in `.gitignore`.

---

## 💻 Installation & Local Development

### Prerequisites
- Node.js 20+ installed
- MongoDB Atlas cluster URI or local MongoDB daemon

### Step-by-Step Instructions

1. **Clone the server repository**:
   ```bash
   git clone https://github.com/your-username/salonique-server.git
   cd salonique-server
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
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

---

## 📄 License

This project is created for evaluation purposes. All rights reserved.
