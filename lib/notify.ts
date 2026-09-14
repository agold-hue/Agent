import { env } from "./env.js";
import { replyInThread, sendMail } from "./gmail.js";
import { channelOf, meta, setMeta, type Session } from "./anthropic.js";

/**
 * Deliver a message to the owner on the session's channel.
 * - chat: nothing to send; the chat UI reads agent messages and tool cards from the stream.
 * - email with an owner thread: reply in that thread.
 * - email without one (a third-party reply, the daily review): start a new thread to the owner and
 *   remember it, so the owner's answer routes back to this session.
 */
export async function notifyOwner(session: Session, body: string, subjectHint?: string): Promise<void> {
  if (channelOf(session) !== "email") return;
  const m = meta(session);
  if (m.gmail_thread_id) {
    await replyInThread({
      threadId: m.gmail_thread_id,
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
