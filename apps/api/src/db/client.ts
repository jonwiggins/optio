import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { parseSslConfig } from "./ssl.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://optio:optio_dev@localhost:5432/optio";

const sslConfig = parseSslConfig(connectionString);
const sql = postgres(connectionString, sslConfig ? { ssl: sslConfig } : {});
export const db = drizzle(sql, { schema });
export type Database = typeof db;
