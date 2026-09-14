import fs from "node:fs";
import path from "node:path";
import { one, q } from "./db.js";
import type { Tenant } from "./tenant.js";
import { dayKey, stamp } from "./transcript.js";

/**
 * Per-customer memory as small text files in Postgres. The agent reads and writes them through tools.
 *
 * Two kinds of file live under agent/memory-seed:
 *  - templates (profile.md, contacts.md, ...): copied into each customer's memory once at signup and
 *    owned by the customer from then on;
 *  - shared playbooks (playbooks/**): never copied. They are served live from the code on every read,
 *    so a deploy updates them for every customer at once. Anything the agent writes to a playbook path
 *    is stored per customer and appended under the shared text as that customer's notes.
 */

const SHARED_PREFIX = "playbooks/";
const NOTES_HEADER = "\n\n## Notes learned for this customer\n";

function norm(p: string): string {
  return p.replace(/^\$MEMORY\/?/, "").replace(/^\/+/, "").replace(/\.\.+/g, "").trim();
}

let sharedCache: Map<string, string> | undefined;
/** Shared files from the repo, keyed by memory path. Cached per process (a deploy is a new process). */
export function sharedFiles(): Map<string, string> {
  if (sharedCache) return sharedCache;
  const seedDir = path.join(process.cwd(), "agent", "memory-seed");
  const out = new Map<string, string>();
  for (const [p, c] of seedEntries(seedDir)) if (p.startsWith(SHARED_PREFIX)) out.set(p, c);
  sharedCache = out;
  return out;
}

function seedEntries(seedDir: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const file of fs.readdirSync(seedDir, { recursive: true, encoding: "utf8" })) {
    const abs = path.join(seedDir, file);
    if (fs.statSync(abs).isDirectory()) continue;
    rows.push([file.split(path.sep).join("/"), fs.readFileSync(abs, "utf8")]);
  }
  return rows;
}

export async function ensureSeeded(t: Tenant): Promise<void> {
  const r = await one<{ n: string }>("select count(*)::text as n from memories where user_id = $1", [t.id]);
  if (Number(r?.n ?? 0) > 0) return;
  const seedDir = path.join(process.cwd(), "agent", "memory-seed");
  for (const [p, c] of seedEntries(seedDir)) {
    if (p.startsWith(SHARED_PREFIX)) continue;
    await q("insert into memories (user_id, path, content) values ($1,$2,$3) on conflict do nothing", [t.id, p, c]);
  }
}

export async function readMemory(t: Tenant, p: string): Promise<string | null> {
  const key = norm(p);
  const r = await one<{ content: string }>("select content from memories where user_id = $1 and path = $2", [t.id, key]);
  const shared = sharedFiles().get(key);
  if (shared == null) return r?.content ?? null;
  const notes = r?.content?.trim();
  return notes ? `${shared.trimEnd()}${NOTES_HEADER}${notes}\n` : shared;
}

/** For a shared path only the customer's own notes are stored; the shared text the agent echoed back is stripped. */
function customerPart(key: string, content: string): string {
  const shared = sharedFiles().get(key);
  if (shared == null) return content;
  let c = content;
  if (c.trimStart().startsWith(shared.trimEnd())) c = c.trimStart().slice(shared.trimEnd().length);
  const i = c.indexOf(NOTES_HEADER.trim());
  if (i >= 0) c = c.slice(i + NOTES_HEADER.trim().length);
  return c.trim() + "\n";
}

export async function writeMemory(t: Tenant, p: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > 200_000) throw new Error("memory file too large (200 kB max); split it");
  const key = norm(p);
  const stored = customerPart(key, content);
  if (sharedFiles().has(key) && !stored.trim()) return deleteMemory(t, key);
  await q("insert into memories (user_id, path, content) values ($1,$2,$3) on conflict (user_id, path) do update set content = $3, updated_at = now()", [t.id, key, stored]);
}

export async function appendMemory(t: Tenant, p: string, text: string): Promise<void> {
  await q(
    "insert into memories (user_id, path, content) values ($1,$2,$3) on conflict (user_id, path) do update set content = memories.content || $3, updated_at = now()",
    [t.id, norm(p), text],
  );
}

export async function deleteMemory(t: Tenant, p: string): Promise<void> {
  await q("delete from memories where user_id = $1 and path = $2", [t.id, norm(p)]);
}

export async function listMemory(t: Tenant, prefix = ""): Promise<Array<{ path: string; bytes: number; updated_at: Date }>> {
  const pre = norm(prefix);
  const rows = await q<{ path: string; bytes: number; updated_at: Date }>("select path, octet_length(content) as bytes, updated_at from memories where user_id = $1 and path like $2 order by path", [t.id, `${pre}%`]);
  const seen = new Set(rows.map((r) => r.path));
  for (const [p, c] of sharedFiles()) if (p.startsWith(pre) && !seen.has(p)) rows.push({ path: p, bytes: Buffer.byteLength(c), updated_at: new Date(0) });
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** Case-insensitive search across memory; returns matching lines with their file. */
export async function grepMemory(t: Tenant, pattern: string, prefix = "", maxLines = 60): Promise<string> {
  const rows = await q<{ path: string; content: string }>("select path, content from memories where user_id = $1 and path like $2 and content ilike $3 order by path", [
    t.id,
    `${norm(prefix)}%`,
    `%${pattern}%`,
  ]);
  const pre = norm(prefix);
  for (const [p, c] of sharedFiles()) if (p.startsWith(pre) && c.toLowerCase().includes(pattern.toLowerCase())) rows.push({ path: p, content: c });
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const out: string[] = [];
  const needle = pattern.toLowerCase();
  for (const r of rows) {
    for (const line of r.content.split("\n")) {
      if (line.toLowerCase().includes(needle)) out.push(`${r.path}: ${line.trim().slice(0, 300)}`);
      if (out.length >= maxLines) return out.join("\n") + `\n... (more matches; narrow the pattern)`;
    }
  }
  return out.length ? out.join("\n") : "(no matches)";
}

/** Durable conversation log, one file per day, used for recall. */
export async function appendTranscript(t: Tenant, entry: { channel: "chat" | "email"; role: "user" | "agent"; text: string }): Promise<void> {
  const text = entry.text.trim();
  if (!text) return;
  const p = `conversations/${dayKey(t.timezone)}.md`;
  const line = `\n### ${stamp(t.timezone)} · ${entry.role === "user" ? "Owner" : "Agent"} (${entry.channel})\n${text}\n`;
  const existing = await readMemory(t, p);
  if (existing == null) await writeMemory(t, p, `# Conversation ${dayKey(t.timezone)}\n${line}`);
  else await appendMemory(t, p, line);
}
