import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionString = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === "production";
const useSsl =
  connectionString.includes("sslmode=require") ||
  connectionString.includes(".neon.tech") ||
  connectionString.includes("supabase.co") ||
  process.env.DB_SSL === "true" ||
  (isProduction && !connectionString.includes("localhost"));

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
export const db = drizzle(pool, { schema });


export * from "./schema";
