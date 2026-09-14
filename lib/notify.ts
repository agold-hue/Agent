import { env } from "./env.js";
import { replyInThread, sendMail } from "./gmail.js";
import { anthropic, channelOf, meta, setMeta, type Session } from "./anthropic.js";
import { stamp } from "./transcript.js";

/**
 * Deliver a message to the person who should hear it.
 * - chat: nothing to send; the chat UI reads agent messages and tool cards from the stream.
 * - email with a thread: reply there. Family members who emailed a request get the reply, not the owner.
 * - email without one (a third-party reply, a proactive session): new thread to the owner, remembered so
 *   the owner's answer routes back to this session.
 */
export async function notifyOwner(session: Session, body: string, subjectHint?: string): Promise<void> {
  if (channelOf(session) !== "email") return;
  const m = meta(session);
  if (m.gmail_thread_id) {
    await replyInThread({
      threadId: m.gmail_thread_id,
      to: m.requester || undefined,
      subject: m.gmail_subject ?? subjectHint ?? "Update",
      inReplyTo: m.last_gmail_message_id_header || undefined,
      body,
    });
    return;
  }
  const subject = subjectHint ?? m.correspondent_subject ?? session.title ?? "Update from your assistant";
  const sent = await sendMail({ to: env.gmail.ownerEmail(), subject, body });
  await setMeta(session.id, { gmail_thread_id: sent.threadId, gmail_subject: subject.slice(0, 200) });
}

// ---------------------------------------------------------------- Quiet hours & batching

/** "22-7" -> owner-local hours during which non-urgent heads-ups wait. */
function quietHours(): [number, number] | null {
  const m = (process.env.QUIET_HOURS ?? "").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** "12:30,18:00" -> the times of day when a digest of deferred heads-ups goes out. */
export function batchTimes(): Array<{ h: number; m: number }> {
  return (process.env.BATCH_TIMES ?? "")
    .split(",")
    .map((s) => s.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter((x): x is RegExpMatchArray => !!x)
    .map((x) => ({ h: Number(x[1]), m: Number(x[2]) }));
}

function ownerNow(): { h: number; m: number } {
  const s = stamp();
  return { h: Number(s.slice(15, 17)), m: Number(s.slice(18, 20)) };
}

/**
 * Should this proactive message wait for the next batch? Urgent ones (the agent starts them with
 * "URGENT:") never wait. With no BATCH_TIMES configured nothing waits, except during quiet hours.
 */
export function shouldDefer(report: string): boolean {
  if (/^\s*URGENT\b/i.test(report)) return false;
  const { h } = ownerNow();
  const q = quietHours();
  if (q) {
    const [start, end] = q;
    const inQuiet = start > end ? h >= start || h < end : h >= start && h < end;
    if (inQuiet) return true;
  }
  return batchTimes().length > 0;
}

const DIGEST_PATH = "/digest-pending.md";

async function findDigest() {
  const storeId = env.anthropic.memoryStoreId();
  for await (const item of anthropic().beta.memoryStores.memories.list(storeId, { path_prefix: "/", depth: 1, limit: 1000 })) {
    if (item.type === "memory" && item.path === DIGEST_PATH) return { storeId, id: item.id };
  }
  return { storeId, id: undefined as string | undefined };
}

export async function deferToDigest(label: string, report: string): Promise<void> {
  const { storeId, id } = await findDigest();
  const entry = `\n## ${stamp()} · ${label}\n${report.trim()}\n`;
  if (!id) {
    await anthropic().beta.memoryStores.memories.create(storeId, { path: DIGEST_PATH, content: `# Pending heads-ups\n${entry}` });
    return;
  }
  const cur = await anthropic().beta.memoryStores.memories.retrieve(id, { memory_store_id: storeId });
  await anthropic().beta.memoryStores.memories.update(id, { memory_store_id: storeId, content: (cur.content ?? "") + entry });
}

/** Take everything waiting in the digest (and clear it). Empty string when nothing is pending. */
export async function takeDigest(): Promise<string> {
  const { storeId, id } = await findDigest();
  if (!id) return "";
  const cur = await anthropic().beta.memoryStores.memories.retrieve(id, { memory_store_id: storeId });
  const content = (cur.content ?? "").trim();
  if (!/^## /m.test(content)) return "";
  await anthropic().beta.memoryStores.memories.update(id, { memory_store_id: storeId, content: "# Pending heads-ups\n" });
  return content;
}

/** True during the one minute of the day that matches a batch time. */
export function isBatchMinute(): boolean {
  const now = ownerNow();
  return batchTimes().some((t) => t.h === now.h && t.m === now.m);
}
