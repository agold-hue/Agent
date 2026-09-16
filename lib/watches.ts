import { sha256 } from "./crypto.js";
import { one, q } from "./db.js";
import { fetchPage, localeFor, searchWeb } from "./search.js";
import { createSession, type SessionRow } from "./sessions.js";
import { tenantById, type Tenant } from "./tenant.js";
import { stampMessage } from "./transcript.js";

/**
 * Change watches. "Tell me when the price drops", "when an appointment opens", "when this page says
 * in stock": the host re-reads the page (or re-runs the search) on a schedule over HTTPS, keeps a
 * hash of the part that matters, and starts a task only when it changes. No model is involved until
 * then, so a daily check costs a fraction of a cent and a watch can run for months.
 */
export interface Watch {
  id: string;
  user_id: string;
  kind: "page" | "search";
  target: string;
  focus: string | null;
  what: string;
  every_minutes: number;
  last_hash: string | null;
  last_excerpt: string | null;
  last_checked_at: Date | null;
  next_check_at: Date;
  fired: number;
  active: boolean;
  channel: "chat" | "email";
  created_at: Date;
}

export const MIN_WATCH_MINUTES = Number(process.env.WATCH_MIN_MINUTES ?? 15);
const MAX_WATCHES = Number(process.env.WATCHES_PER_USER ?? 30);

export function parseEvery(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = String(s).trim().match(/^(\d+)\s*(m|min|minutes?|h|hr|hours?|d|days?|w|weeks?)$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2][0].toLowerCase();
  return n * (u === "m" ? 1 : u === "h" ? 60 : u === "d" ? 1440 : 10_080);
}

export async function addWatch(t: Tenant, w: { kind: "page" | "search"; target: string; focus?: string; what: string; everyMinutes?: number; channel?: "chat" | "email" }): Promise<Watch> {
  const n = await one<{ n: string }>("select count(*)::text as n from watches where user_id = $1 and active", [t.id]);
  if (Number(n?.n ?? 0) >= MAX_WATCHES) throw new Error(`You already have ${MAX_WATCHES} active watches; cancel one first.`);
  const every = Math.max(MIN_WATCH_MINUTES, w.everyMinutes ?? 60);
  const row = await one<Watch>(
    "insert into watches (user_id, kind, target, focus, what, every_minutes, channel, next_check_at) values ($1,$2,$3,$4,$5,$6,$7, now()) returning *",
    [t.id, w.kind, w.target.trim(), w.focus?.trim() || null, w.what.trim(), every, w.channel ?? "chat"],
  );
  return row!;
}

export async function listWatches(t: Tenant): Promise<Watch[]> {
  return q<Watch>("select * from watches where user_id = $1 and active order by created_at", [t.id]);
}

export async function cancelWatch(t: Tenant, id: string): Promise<boolean> {
  const r = await q("update watches set active = false where user_id = $1 and id = $2 and active returning id", [t.id, id]);
  return r.length > 0;
}

/** The part of a page that the watch cares about: lines mentioning the focus words, else the head of the main text. */
export function excerptFor(text: string, focus: string | null | undefined, maxChars = 2000): string {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const words = (focus ?? "").split(/[,;]|\s+or\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
  if (words.length) {
    const lines = clean.split("\n").filter((l) => {
      const low = l.toLowerCase();
      return words.some((w) => low.includes(w));
    });
    if (lines.length) return lines.join("\n").slice(0, maxChars);
  }
  return clean.slice(0, maxChars);
}

/** Digits and prices are what change; timestamps, view counters and session ids should not count. */
export function stableHash(excerpt: string): string {
  const normalized = excerpt
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/g, "")
    .replace(/\b(updated|refreshed|as of|last checked)[^\n]{0,40}/g, "")
    .replace(/\b\d+ (views|viewing|people)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(normalized);
}

/** Read the watch's target now: the page's main text or the search's result list. */
export async function readTarget(t: Tenant | undefined, w: Pick<Watch, "kind" | "target">): Promise<{ text: string; error?: string }> {
  if (w.kind === "page") {
    const p = await fetchPage(w.target, { noCache: true });
    if (p.how === "error" || p.how === "blocked") return { text: "", error: p.error ?? p.how };
    return { text: p.text };
  }
  const o = await searchWeb({ queries: [w.target], locale: localeFor(t), readTop: 0, limit: 10 });
  if (!o.hits.length) return { text: "", error: o.errors.join("; ") || "no results" };
  return { text: o.hits.map((h) => `${h.title} | ${h.url}${h.snippet ? ` | ${h.snippet.slice(0, 160)}` : ""}`).join("\n") };
}

/** One check. Returns what changed, if anything, and updates the watch's state. */
export async function checkWatch(w: Watch, t?: Tenant): Promise<{ changed: boolean; before?: string; after?: string; error?: string }> {
  const { text, error } = await readTarget(t, w);
  const next = new Date(Date.now() + w.every_minutes * 60_000);
  if (error) {
    await q("update watches set last_checked_at = now(), next_check_at = $2 where id = $1", [w.id, next]);
    return { changed: false, error };
  }
  const excerpt = excerptFor(text, w.focus);
  const hash = stableHash(excerpt);
  const changed = !!w.last_hash && hash !== w.last_hash;
  await q("update watches set last_hash = $2, last_excerpt = $3, last_checked_at = now(), next_check_at = $4, fired = fired + $5 where id = $1", [w.id, hash, excerpt.slice(0, 4000), next, changed ? 1 : 0]);
  return changed ? { changed, before: w.last_excerpt ?? "", after: excerpt } : { changed: false };
}

/** The cron sweep: check due watches (a few per tick), and start a task for each real change. */
export async function runDueWatches(limit = Number(process.env.WATCHES_PER_TICK ?? 8)): Promise<{ checked: number; fired: number }> {
  const due = await q<Watch>("select * from watches where active and next_check_at <= now() order by next_check_at limit $1", [limit]);
  let fired = 0;
  for (const w of due) {
    const t = await tenantById(w.user_id).catch(() => undefined);
    const r = await checkWatch(w, t).catch((err) => ({ changed: false, error: err instanceof Error ? err.message : String(err) }) as Awaited<ReturnType<typeof checkWatch>>);
    if (!r.changed || !t) continue;
    fired++;
    const row = await createSession(t, {
      channel: w.channel,
      kind: "task",
      title: `Watch: ${w.what.slice(0, 100)}`,
      tier: "task",
      text: stampMessage(
        t,
        [
          `A watch you set fired: the ${w.kind === "page" ? "page" : "search"} "${w.target}" changed${w.focus ? ` where it mentions ${w.focus}` : ""}.`,
          `What the user asked for when it changes: ${w.what}`,
          ``,
          `Before:\n${(r.before ?? "").slice(0, 1500) || "(first reading)"}`,
          ``,
          `After:\n${(r.after ?? "").slice(0, 1500)}`,
          ``,
          `Judge whether this is the change the user meant (a real price drop, a real opening, not a reworded page). If it is, do what they asked and tell them in two lines with the figures. If it is not, reply exactly NO_REPORT. The watch keeps running; cancel it with watch_page(action "cancel", id "${w.id}") if the job is done.`,
        ].join("\n"),
        w.channel,
      ),
    }).catch((err) => {
      console.error(`[watch] ${w.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (row) {
      const { kick } = await import("./runtime.js");
      await kick(row.id);
    }
  }
  return { checked: due.length, fired };
}

/** The watch_page tool. */
export async function runWatchTool(t: Tenant, row: SessionRow, args: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(args[k] ?? "").trim();
  const action = s("action") || (s("url") || s("query") ? "add" : "list");
  if (action === "list") {
    const ws = await listWatches(t);
    return ws.length ? ws.map((w) => `- ${w.id}: ${w.kind} "${w.target}"${w.focus ? ` (focus: ${w.focus})` : ""} every ${w.every_minutes} min, checked ${w.last_checked_at ? new Date(w.last_checked_at).toISOString().slice(0, 16) : "never"}, fired ${w.fired}x: ${w.what}`).join("\n") : "No active watches.";
  }
  if (action === "cancel") return (await cancelWatch(t, s("id"))) ? `Cancelled watch ${s("id")}.` : `No active watch ${s("id")}.`;
  const url = s("url");
  const query = s("query");
  if (!url && !query) return "Pass url (a page to watch) or query (a search to re-run), plus what to do when it changes.";
  if (!s("what")) return "Pass `what`: what to do when it changes, in the user's words.";
  const every = parseEvery(s("every")) ?? 60;
  const w = await addWatch(t, { kind: url ? "page" : "search", target: url || query, focus: s("focus") || undefined, what: s("what"), everyMinutes: every, channel: row.channel === "email" ? "email" : "chat" });
  // The first reading is the baseline; a change is only reported against it.
  const first = await checkWatch(w, t).catch(() => ({ changed: false, error: "first read failed" }) as Awaited<ReturnType<typeof checkWatch>>);
  return `Watching ${w.kind} "${w.target}"${w.focus ? ` for changes around "${w.focus}"` : ""} every ${w.every_minutes} minutes (id ${w.id}). ${first.error ? `First read failed (${first.error}); it will retry on schedule.` : `Baseline recorded (${(w.last_excerpt ?? "").length || "some"} chars). You will get a task when it changes.`} Tell the user in one line what is being watched and how often.`;
}
