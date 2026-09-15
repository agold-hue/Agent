import pg from "pg";

/**
 * Postgres access. DATABASE_URL is a normal connection string in production. For tests,
 * "pglite://" runs an in-process Postgres (WASM) with the same query interface.
 */
interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

let client: Queryable | undefined;
let ready: Promise<Queryable> | undefined;

async function connect(): Promise<Queryable> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    const dir = url.slice("pglite://".length);
    const lite = new PGlite(dir || undefined, { extensions: { pgcrypto } });
    await lite.waitReady;
    return {
      query: async (text, params) => (await lite.query(text, params as unknown[])) as { rows: never[] },
      end: () => lite.close(),
    };
  }
  // TLS is decided here, not by the URL: strip sslmode so pg does not warn on every cold start.
  const local = /localhost|127\.0\.0\.1|\/tmp/.test(url);
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const pool = new pg.Pool({ connectionString: clean, max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
  return { query: (text, params) => pool.query(text, params), end: () => pool.end() };
}

export function db(): Queryable {
  if (!client) throw new Error("db not ready; call ready first");
  return client;
}

async function ensure(): Promise<Queryable> {
  if (client) return client;
  ready ??= connect().then((c) => (client = c));
  return ready;
}

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await (await ensure()).query<T>(text, params);
  return rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

let schemaReady: Promise<void> | undefined;
/**
 * Keep the database in step with db/schema.sql. Every statement there is idempotent, so the whole
 * file is applied whenever its hash differs from the one recorded in schema_meta: a fresh database
 * gets everything, an existing one picks up new columns and tables on the first request after a
 * deploy. Checked once per process (one small query on cold start).
 */
export async function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { createHash } = await import("node:crypto");
    const sql = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    await exec("create table if not exists schema_meta (key text primary key, value text not null, updated_at timestamptz not null default now())");
    const r = await q<{ value: string }>("select value from schema_meta where key = 'schema_hash'");
    if (r[0]?.value === hash) return;
    await exec(sql);
    await q("insert into schema_meta (key, value) values ('schema_hash', $1) on conflict (key) do update set value = $1, updated_at = now()", [hash]);
    console.log(`[db] schema applied (${hash.slice(0, 12)})`);
  })().catch((e) => {
    schemaReady = undefined;
    throw e;
  });
  return schemaReady;
}

export async function exec(sql: string): Promise<void> {
  const c = await ensure();
  if (process.env.DATABASE_URL?.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    void PGlite;
    // PGlite's query() takes one statement; run the schema statement by statement.
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await c.query(stmt);
    return;
  }
  await c.query(sql);
}

export async function closeDb(): Promise<void> {
  if (client) await client.end();
  client = undefined;
  ready = undefined;
}
