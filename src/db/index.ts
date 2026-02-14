import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.WINDMILL_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("WINDMILL_SERVICE_DATABASE_URL is required");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
