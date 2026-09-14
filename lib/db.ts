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
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: /localhost|127\.0\.0\.1|\/tmp/.test(url) ? undefined : { rejectUnauthorized: false } });
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
