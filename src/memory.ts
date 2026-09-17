import { one, q } from "./db.js";
import { id } from "./ids.js";

/**
 * Long-term memory per business: small named notes. `fact` (durable facts and rules), `site` (how a site
 * works: sign-in, fast paths, quirks), `contact` (people and companies), `procedure` (how we do X),
 * `history` (one entry per finished task). Searched by words; the worker reads what it needs.
 */
export type MemoryKind = "fact" | "site" | "contact" | "procedure" | "history";
export interface Memory {
  id: string;
  org_id: string;
  kind: MemoryKind;
  key: string;
  content: string;
  updated_at: Date;
}

export async function saveMemory(orgId: string, kind: MemoryKind, key: string, content: string): Promise<void> {
  const k = key.trim().toLowerCase().slice(0, 200);
  await q(
    "insert into memories (id, org_id, kind, key, content) values ($1,$2,$3,$4,$5) on conflict (org_id, kind, key) do update set content = $5, updated_at = now()",
    [id("mem"), orgId, kind, k, content.slice(0, 20_000)],
  );
}

export const getMemory = (orgId: string, kind: MemoryKind, key: string) => one<Memory>("select * from memories where org_id = $1 and kind = $2 and key = $3", [orgId, kind, key.trim().toLowerCase()]);

export const deleteMemory = (orgId: string, memId: string) => q("delete from memories where org_id = $1 and id = $2", [orgId, memId]);

export const listMemories = (orgId: string, kind?: MemoryKind, limit = 200) =>
  kind ? q<Memory>("select * from memories where org_id = $1 and kind = $2 order by updated_at desc limit $3", [orgId, kind, limit]) : q<Memory>("select * from memories where org_id = $1 order by kind, updated_at desc limit $2", [orgId, limit]);

/** Every word must appear (in key or content); newest first. */
export async function searchMemory(orgId: string, query: string, kind?: MemoryKind, limit = 12): Promise<Memory[]> {
  const words = query.toLowerCase().split(/[^a-z0-9@.'-]+/i).filter((w) => w.length > 1).slice(0, 8);
  if (!words.length) return listMemories(orgId, kind, limit);
  const params: unknown[] = [orgId];
  let where = "org_id = $1";
  if (kind) {
    params.push(kind);
    where += ` and kind = $${params.length}`;
  }
  for (const w of words) {
    params.push(`%${w}%`);
    where += ` and (key ilike $${params.length} or content ilike $${params.length})`;
  }
  params.push(limit);
  const rows = await q<Memory>(`select * from memories where ${where} order by updated_at desc limit $${params.length}`, params);
  if (rows.length) return rows;
  // Fall back to any-word match so a near miss still surfaces something.
  const p2: unknown[] = [orgId, ...(kind ? [kind] : []), ...words.map((w) => `%${w}%`), limit];
  const ors = words.map((_, i) => `key ilike $${(kind ? 3 : 2) + i} or content ilike $${(kind ? 3 : 2) + i}`).join(" or ");
  return q<Memory>(`select * from memories where org_id = $1 ${kind ? "and kind = $2" : ""} and (${ors}) order by updated_at desc limit $${p2.length}`, p2);
}

export function registrableDomain(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    /* keep */
  }
  host = host.replace(/^www\./, "").split("/")[0];
  const parts = host.split(".");
  if (parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2])) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}
