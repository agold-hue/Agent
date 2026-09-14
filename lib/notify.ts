import { q } from "./db.js";
import { sendAgentMail } from "./mail.js";
import { updateSession, type SessionRow } from "./sessions.js";
import { localClock } from "./transcript.js";
import type { Tenant } from "./tenant.js";

/**
 * Deliver a message to the person who should hear it.
 * - chat: nothing to send; the chat UI reads agent messages and tool cards from the stream.
 * - email: reply to whoever asked (the owner, or a family member) with a Reply-To that routes their
 *   answer back to this session.
 */
export async function notifyOwner(t: Tenant, row: SessionRow, body: string, subjectHint?: string): Promise<void> {
  if (row.channel !== "email") return;
  const subject = row.email_subject ? (/^re:/i.test(row.email_subject) ? row.email_subject : `Re: ${row.email_subject}`) : subjectHint ?? "Update from your assistant";
  await sendAgentMail(t, {
    to: row.requester || t.email,
    subject,
    body,
    inReplyTo: row.last_message_id || undefined,
    replyTag: row.reply_tag ?? undefined,
  });
  if (!row.email_subject) await updateSession(row.id, { email_subject: subject.replace(/^re:\s*/i, "").slice(0, 200) });
}

// ---------------------------------------------------------------- Quiet hours & batching (per tenant)

function quietHours(t: Tenant): [number, number] | null {
  const m = (t.settings.quiet_hours ?? "").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function batchTimes(t: Tenant): Array<{ h: number; m: number }> {
  return (t.settings.batch_times ?? "")
    .split(",")
    .map((s) => s.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter((x): x is RegExpMatchArray => !!x)
    .map((x) => ({ h: Number(x[1]), m: Number(x[2]) }));
}

/** Should this proactive message wait for the next batch? "URGENT:" never waits. */
export function shouldDefer(t: Tenant, report: string): boolean {
  if (/^\s*URGENT\b/i.test(report)) return false;
  const { h } = localClock(t.timezone);
  const qh = quietHours(t);
  if (qh) {
    const [start, end] = qh;
    const inQuiet = start > end ? h >= start || h < end : h >= start && h < end;
    if (inQuiet) return true;
  }
  return batchTimes(t).length > 0;
}

export async function deferToDigest(t: Tenant, label: string, body: string): Promise<void> {
  await q("insert into digest_entries (user_id, label, body) values ($1, $2, $3)", [t.id, label, body.trim()]);
}

/** Everything waiting for this tenant, marked flushed. Empty string when nothing is pending. */
export async function takeDigest(t: Tenant): Promise<string> {
  const rows = await q<{ id: string; label: string; body: string; created_at: Date }>(
    "update digest_entries set flushed_at = now() where user_id = $1 and flushed_at is null returning id, label, body, created_at",
    [t.id],
  );
  if (!rows.length) return "";
  return rows.map((r) => `## ${new Date(r.created_at).toISOString()} · ${r.label}\n${r.body}`).join("\n\n");
}

export function isBatchMinute(t: Tenant): boolean {
  const now = localClock(t.timezone);
  return batchTimes(t).some((b) => b.h === now.h && b.m === now.m);
}
