import { one, q } from "./db.js";
import type { ChatMessage } from "./llm.js";
import { messageText } from "./sessions.js";

/**
 * Messages written before each one carried its own time have no `at`. The conversation log
 * (conversations/YYYY-MM-DD.md, one entry per user line and agent reply, stamped to the minute in the
 * user's time zone) does have them, so this recovers the real times once: each unstamped bubble that
 * matches a log entry by text gets that entry's time, written in place with jsonb_set so a message
 * appended meanwhile is never clobbered. Runs once per database (marker in app_meta), from the cron.
 */
const MARKER = "backfill_message_times_v1";

/** "2026-09-15 Tue 03:10 America/New_York" -> the instant it names, or undefined. */
export function stampToDate(s: string): Date | undefined {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) \w{3} (\d{2}):(\d{2}) (\S+)$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, tz] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  // The zone's offset at roughly that moment; a second pass corrects a guess that straddles a DST change.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const off = offsetAt(guess, tz);
    if (off === undefined) return undefined;
    guess = wall - off;
  }
  return new Date(guess);
}

/** Milliseconds the zone is ahead of UTC at `ms`. */
function offsetAt(ms: number, tz: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(ms));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
    return local - Math.floor(ms / 1000) * 1000;
  } catch {
    return undefined;
  }
}

export interface LogEntry {
  at: Date;
  role: "user" | "agent";
  text: string;
}

/** The entries of one day's conversation file. */
export function parseTranscript(content: string): LogEntry[] {
  const out: LogEntry[] = [];
  const re = /^### (.+?) · (Owner|Agent) \((chat|email)\)\n([\s\S]*?)(?=\n### |\n*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const at = stampToDate(m[1]);
    if (at) out.push({ at, role: m[2] === "Owner" ? "user" : "agent", text: m[4].trim() });
  }
  return out;
}

/** The bubble's text as the log would have recorded it. */
function bubbleText(m: ChatMessage): string | undefined {
  if (m.ephemeral) return undefined;
  if (m.role === "user") {
    const raw = messageText(m);
    if (!raw.startsWith("[")) return undefined; // host notes are not logged
    return raw.replace(/^\[[^\]]+\]\n/, "").trim();
  }
  if (m.role === "assistant" && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) return m.content.trim();
  return undefined;
}

/**
 * Assign times to a session's unstamped bubbles from the log entries, in order: each bubble takes
 * the first later-or-equal unused entry with the same role and text, so a line the user typed twice
 * gets two different times. Returns the (index, time) pairs to write.
 */
export function matchTimes(messages: ChatMessage[], entries: LogEntry[]): Array<[number, string]> {
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  const used = new Set<number>();
  const out: Array<[number, string]> = [];
  let cursor = 0;
  messages.forEach((m, i) => {
    if (m.at) {
      // A stamped bubble moves the cursor forward, so earlier log entries are never reused for later bubbles.
      const t = new Date(m.at).getTime();
      while (cursor < sorted.length && sorted[cursor].at.getTime() < t) cursor++;
      return;
    }
    const text = bubbleText(m);
    if (!text) return;
    const role = m.role === "user" ? "user" : "agent";
    for (let j = cursor; j < sorted.length; j++) {
      if (used.has(j) || sorted[j].role !== role || sorted[j].text !== text) continue;
      used.add(j);
      out.push([i, sorted[j].at.toISOString()]);
      cursor = j;
      break;
    }
  });
  return out;
}

export async function backfillMessageTimes(): Promise<number> {
  await q("create table if not exists app_meta (key text primary key, value text not null default '', updated_at timestamptz not null default now())");
  if (await one("select 1 from app_meta where key = $1", [MARKER])) return 0;
  const sessions = await q<{ id: string; user_id: string; created_at: Date; updated_at: Date; messages: ChatMessage[] }>(
    "select id, user_id, created_at, updated_at, messages from agent_sessions where channel = 'chat' and kind = 'chat' and created_at > now() - interval '45 days' order by created_at",
  );
  let written = 0;
  const logs = new Map<string, LogEntry[]>();
  for (const s of sessions) {
    if (!s.messages.some((m) => !m.at && bubbleText(m))) continue;
    const key = s.user_id;
    if (!logs.has(key)) {
      const files = await q<{ content: string }>("select content from memories where user_id = $1 and path like 'conversations/%' and path > $2", [key, `conversations/${new Date(Date.now() - 46 * 86_400_000).toISOString().slice(0, 10)}`]);
      logs.set(key, files.flatMap((f) => parseTranscript(f.content)));
    }
    const entries = logs.get(key)!;
    for (const [i, at] of matchTimes(s.messages, entries)) {
      await q("update agent_sessions set messages = jsonb_set(messages, $2::text[], to_jsonb($3::text)) where id = $1 and messages->($4::int)->>'at' is null", [s.id, [String(i), "at"], at, i]);
      written++;
    }
  }
  await q("insert into app_meta (key, value) values ($1, $2) on conflict (key) do update set value = $2, updated_at = now()", [MARKER, String(written)]);
  console.log(`[backfill] message times: ${written} bubbles stamped from the conversation log`);
  return written;
}
