# WASHROOM — Deployment & Production Guide

This guide explains how to deploy the WASHROOM Hostel Laundry Management system for full-scale production (100+ students) on a ₹0/month budget using free-tier services.

---

## 1. What You Need (Free-Tier Prerequisites)

1. **PostgreSQL Database** (Free Tier):
   - **Recommended**: [Neon](https://neon.tech) (Free tier: 0.5 GB storage, serverless Postgres) or [Supabase](https://supabase.com) (Free tier: 500 MB Postgres).
   - Get the Postgres connection string in the format:
     `postgresql://user:password@host/dbname?sslmode=require`

2. **Clerk Authentication** (Free Tier):
   - Create a free account at [Clerk.com](https://clerk.com).
   - Create an application (e.g. "WASHROOM Laundry").
   - Under **API Keys**, obtain:
     - `CLERK_PUBLISHABLE_KEY` (starts with `pk_test_` or `pk_live_`)
     - `CLERK_SECRET_KEY` (starts with `sk_test_` or `sk_live_`)

3. **Hosting Platform**:
   - **Render** (Free Web Service or Docker), **Railway** ($5 free credit), **Fly.io**, or any standard Linux VPS / Docker host.

---

## 2. Environment Variables Checklist

Configure these in your hosting dashboard or `.env` file:

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require` |
| `CLERK_PUBLISHABLE_KEY` | Clerk public key (server) | `pk_live_...` |
| `CLERK_SECRET_KEY` | Clerk secret key (server) | `sk_live_...` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk public key (client bundle) | `pk_live_...` |
| `PORT` | Listening port (default: 5000) | `5000` |
| `NODE_ENV` | Production flag | `production` |
| `DB_POOL_MAX` | Max Postgres pool connections | `20` |

---

## 3. Initial Database Setup

Before starting the server for the first time, push the Drizzle schema to your PostgreSQL database:

```bash
DATABASE_URL="your-postgres-url" pnpm run db:push
```

This creates all required tables:
- `laundry_students`
- `laundry_machines` (auto-seeded with "Washer 01" and "Washer 02")
- `laundry_bookings`
- `laundry_duty_shifts`
- `laundry_duty_assignments`
- `laundry_handovers`
- `laundry_qr_tokens`

---

## 4. Deployment Options

### Option A: Unified Container / Docker (Recommended)

The app is packaged as a unified server that serves both the Express 5 API and the compiled React 19 SPA from a single port.

```bash
# Build Docker image
docker build -t washroom-app .

# Run container
docker run -p 5000:5000 \
  -e DATABASE_URL="your-postgres-url" \
  -e CLERK_PUBLISHABLE_KEY="pk_live_..." \
  -e CLERK_SECRET_KEY="sk_live_..." \
  -e VITE_CLERK_PUBLISHABLE_KEY="pk_live_..." \
  washroom-app
```

### Option B: Deploying on Render (Free Web Service)

1. Connect your GitHub repository to [Render.com](https://render.com).
2. Choose **Web Service**.
3. Settings:
   - **Environment**: `Node` (or `Docker`)
   - **Build Command**: `pnpm install && pnpm run build`
   - **Start Command**: `node artifacts/api-server/dist/index.mjs`
4. Add the Environment Variables from Section 2.
5. In **Health Check Path**, enter: `/api/healthz`.

---

## 5. Scaling & High-Concurrency Features (100+ Students)

The application includes enterprise-grade safeguards designed for weekend spikes:
1. **Race-Condition Safe Machine Bookings**: Backed by a unique database constraint (`laundry_bookings_machine_start_idx`) and `onConflictDoNothing()`. If multiple students click to book the same slot simultaneously, only one succeeds; others receive a clean 409 error.
2. **Postgres Advisory Locks for Duty Allocation**: `assignUpcomingDuty` uses `pg_advisory_xact_lock(4291041)` to serialize fair shift distribution across all students without double-booking shifts.
3. **Connection Pooling & SSL**: Tuned with configurable `DB_POOL_MAX` (default 20 connections) with automatic SSL detection for managed cloud Postgres (Neon, Supabase).
4. **Interactive Camera QR Scanning**: Camera scanning via `@zxing/browser` with manual token fallback for maximum device compatibility.
