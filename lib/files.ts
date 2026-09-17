import { randomBytes } from "node:crypto";
import { env } from "./env.js";
import { one, q } from "./db.js";
import type { Tenant } from "./tenant.js";

/**
 * Files the agent produced: a PDF it wrote, a form it filled, a page it printed, a CSV it exported.
 * Stored per customer with a random token, so the link handed back in chat or attached to an email
 * opens that one file and nothing else. Nothing here is ever read by the model; it gets the link.
 */
export interface StoredFile {
  id: string;
  filename: string;
  mime_type: string;
  token: string;
  bytes: number;
  created_at: Date;
}

const MAX_BYTES = Number(process.env.AGENT_FILE_MAX_BYTES ?? 8 * 1024 * 1024);

export async function saveFile(t: Tenant, f: { sessionId?: string | null; filename: string; mimeType?: string; content: Buffer }): Promise<StoredFile & { url: string }> {
  if (f.content.length > MAX_BYTES) throw new Error(`file too large (${Math.round(f.content.length / 1024)} kB; limit ${Math.round(MAX_BYTES / 1024)} kB)`);
  const token = randomBytes(18).toString("base64url");
  const row = await one<StoredFile>(
    `insert into agent_files (user_id, session_id, filename, mime_type, token, content, bytes)
     values ($1,$2,$3,$4,$5,$6,$7) returning id, filename, mime_type, token, bytes, created_at`,
    [t.id, f.sessionId ?? null, f.filename.slice(0, 200), f.mimeType ?? "application/pdf", token, f.content, f.content.length],
  );
  return { ...row!, url: fileUrl(row!.token) };
}

export function fileUrl(token: string): string {
  return `${env.appUrl()}/api/files?t=${encodeURIComponent(token)}`;
}

export async function fileByToken(token: string): Promise<(StoredFile & { content: Buffer; user_id: string }) | null> {
  if (!token) return null;
  return (await one<StoredFile & { content: Buffer; user_id: string }>("select * from agent_files where token = $1", [token])) ?? null;
}

/** The files a customer has, newest first (Home tab, export). */
export async function listFiles(t: Tenant, limit = 25): Promise<Array<StoredFile & { url: string }>> {
  const rows = await q<StoredFile>("select id, filename, mime_type, token, bytes, created_at from agent_files where user_id = $1 order by created_at desc limit $2", [t.id, limit]);
  return rows.map((r) => ({ ...r, url: fileUrl(r.token) }));
}

/** Fetch a file the agent needs to work on again (fill a form it just downloaded, merge two PDFs). */
export async function fileContent(t: Tenant, idOrToken: string): Promise<{ filename: string; mimeType: string; content: Buffer } | null> {
  const row = await one<{ filename: string; mime_type: string; content: Buffer }>(
    `select filename, mime_type, content from agent_files where user_id = $1 and (token = $2 or id::text = $2) limit 1`,
    [t.id, idOrToken],
  );
  return row ? { filename: row.filename, mimeType: row.mime_type, content: row.content } : null;
}
