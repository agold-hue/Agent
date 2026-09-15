import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { currentChatSession, startChatSession } from "../../../lib/chat.js";
import { appendTranscript } from "../../../lib/memory.js";
import { isApprovalReply } from "../../../lib/policy.js";
import { kick } from "../../../lib/runtime.js";
import { reactionFor } from "../../../lib/reaction.js";
import { appendUserMessage, UsageCapError } from "../../../lib/sessions.js";
import { resolvePending } from "../../../lib/tools.js";
import { stampMessage } from "../../../lib/transcript.js";

/** POST { text } -> { session_id, action }. Sends into the live chat session (or starts one) and kicks the worker. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  const reaction = reactionFor(text);
  try {
    let session = await currentChatSession(t);
    let action: string;
    if (!session) {
      session = await startChatSession(t, text, undefined, reaction);
      action = "started";
    } else if (session.pending_kind === "checkpoint" || session.pending_kind === "send_email") {
      await resolvePending(t, session, text, isApprovalReply(text));
      action = `${session.pending_kind}_resolved`;
    } else if (session.pending_kind === "ask_user") {
      await resolvePending(t, session, text, null);
      action = "question_answered";
    } else {
      await appendUserMessage(session, stampMessage(t, text, "chat"), undefined, reaction);
      action = "sent";
    }
    await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
    await kick(session.id);
    return res.status(200).json({ session_id: session.id, action, reaction });
  } catch (err) {
    if (err instanceof UsageCapError) return res.status(402).json({ error: err.message });
    throw err;
  }
}
