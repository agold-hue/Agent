import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env.js";
import { listUnreadFromOwner, markRead, stripQuoted } from "../lib/gmail.js";
import { createTaskSession, findSessionByThread, listRecentSessions, meta, sendUserMessage, setMeta } from "../lib/anthropic.js";
import { expirePending, resolvePending } from "../lib/tools.js";
import { isApprovalReply } from "../lib/policy.js";

/**
 * Email front door. Runs every minute from Vercel cron, and can also be the push target of a
 * Gmail Pub/Sub watch (POST ...?token=CRON_SECRET). Either way it drains unread mail from the owner.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization ?? "";
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (auth !== `Bearer ${env.cronSecret()}` && token !== env.cronSecret()) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const results: Array<Record<string, unknown>> = [];
  const passphrase = env.gmail.passphrase().toLowerCase();

  for (const mail of await listUnreadFromOwner()) {
    const text = stripQuoted(mail.text);
    const haystack = `${mail.subject}\n${text}`.toLowerCase();
    const existing = await findSessionByThread(mail.threadId);

    // A passphrase, if configured, is only required to START a task. Replies in a known thread pass.
    if (!existing && passphrase && !haystack.includes(passphrase)) {
      await markRead(mail.id);
      results.push({ id: mail.id, action: "ignored_no_passphrase" });
      continue;
    }

    try {
      if (existing) {
        const m = meta(existing);
        await setMeta(existing.id, { last_gmail_message_id: mail.id, last_gmail_message_id_header: mail.messageIdHeader });
        if (m.pending_kind === "checkpoint") {
          await resolvePending(existing, text, isApprovalReply(text));
          results.push({ id: mail.id, action: "checkpoint_resolved", session: existing.id });
        } else if (m.pending_kind === "ask_user") {
          await resolvePending(existing, text, null);
          results.push({ id: mail.id, action: "question_answered", session: existing.id });
        } else {
          await sendUserMessage(existing.id, text || mail.subject);
          results.push({ id: mail.id, action: "follow_up", session: existing.id });
        }
      } else {
        const body = [`Subject: ${mail.subject}`, ``, text || "(no body)"].join("\n");
        const session = await createTaskSession({
          threadId: mail.threadId,
          subject: mail.subject,
          messageId: mail.id,
          text: body,
        });
        await setMeta(session.id, { last_gmail_message_id_header: mail.messageIdHeader });
        results.push({ id: mail.id, action: "task_started", session: session.id });
      }
      await markRead(mail.id);
    } catch (err) {
      results.push({ id: mail.id, action: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Questions nobody answered in time proceed with the agent's stated defaults.
  let expired = 0;
  for (const s of await listRecentSessions()) {
    if (s.status === "terminated") continue;
    if (await expirePending(s)) expired++;
  }

  return res.status(200).json({ processed: results.length, expired, results });
}
