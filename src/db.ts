import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Postgres. DATABASE_URL is a normal connection string in production; "pglite://<dir>" (or "pglite://" for
 * in-memory) runs an in-process Postgres for tests and local trials with the same query interface.
 */
interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

let client: Queryable | undefined;
let connecting: Promise<Queryable> | undefined;
let isLite = false;

async function connect(): Promise<Queryable> {
  const url = config.databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (url.startsWith("pglite://")) {
    isLite = true;
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = url.slice("pglite://".length);
    const lite = new PGlite(dir || undefined);
    await lite.waitReady;
    return {
      query: async (text, params) => (await lite.query(text, params as unknown[])) as { rows: never[] },
      end: () => lite.close(),
    };
  }
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({ connectionString: url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, ""), max: 8, ssl: local ? undefined : { rejectUnauthorized: false } });
  return { query: (text, params) => pool.query(text, params), end: () => pool.end() };
}

async function ensure(): Promise<Queryable> {
  if (client) return client;
  connecting ??= connect().then((c) => (client = c));
  return connecting;
}

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await (await ensure()).query<T>(text, params);
  return rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

export async function exec(sql: string): Promise<void> {
  const c = await ensure();
  if (isLite) {
    // PGlite runs one statement per query(); split the schema on statement boundaries.
    for (const stmt of splitStatements(sql)) await c.query(stmt);
    return;
  }
  await c.query(sql);
}

function splitStatements(sql: string): string[] {
  // Drop full-line comments first, then split on statement-ending semicolons (dollar-quoted bodies kept whole).
  const cleaned = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of cleaned.split("\n")) {
    if (line.includes("$$")) inDollar = !inDollar;
    cur += line + "\n";
    if (!inDollar && line.replace(/--.*$/, "").trimEnd().endsWith(";")) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function schemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", "db", "schema.sql"), path.join(here, "db", "schema.sql"), path.join(process.cwd(), "db", "schema.sql")]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("db/schema.sql not found");
}

/** Apply db/schema.sql (every statement is idempotent) whenever its hash changed. */
export async function migrate(): Promise<void> {
  const sql = fs.readFileSync(schemaPath(), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  await exec("create table if not exists schema_meta (key text primary key, value text not null, updated_at timestamptz not null default now());");
  const r = await one<{ value: string }>("select value from schema_meta where key = 'schema_hash'");
  if (r?.value === hash) return;
  await exec(sql);
  await q("insert into schema_meta (key, value) values ('schema_hash', $1) on conflict (key) do update set value = $1, updated_at = now()", [hash]);
  log.info("db", "schema applied", { hash: hash.slice(0, 12) });
}

export async function closeDb(): Promise<void> {
  if (client) await client.end();
  client = undefined;
  connecting = undefined;
}
