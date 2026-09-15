import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { currentChatSession, startChatSession, withQuote } from "../../../lib/chat.js";
import type { MessageQuote } from "../../../lib/llm.js";
import { appendTranscript } from "../../../lib/memory.js";
import { codeHint, codeIn, isApprovalReply } from "../../../lib/policy.js";
import { chatSessionExhausted, kick } from "../../../lib/runtime.js";
import { reactionFor } from "../../../lib/reaction.js";
import { researchAck } from "../../../lib/acks.js";
import { tierFor, upgradedModel } from "../../../lib/router.js";
import { appendAssistantMessage, appendHostNote, appendUserEcho, appendUserMessage, updateSession, UsageCapError } from "../../../lib/sessions.js";
import { resolvePending } from "../../../lib/tools.js";
import { stampMessage } from "../../../lib/transcript.js";

/**
 * Show the user's answer as a chat bubble. Everything the user types must appear, or it looks lost:
 * a verification code shows with its digits masked (the model still gets the real one through the
 * tool result), and anything else they say while a code is pending ("didn't get one, resend it")
 * shows as is.
 */
async function echoAnswer(session: { messages: Array<{ role: string; tool_calls?: Array<{ id: string; function: { name: string } }> }>; pending_event_id: string | null }, text: string, reaction: string, quote?: MessageQuote): Promise<void> {
  const awaitingCode = session.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === session.pending_event_id && c.function.name === "request_code"));
  const shown = awaitingCode && codeIn(text) ? text.replace(/\d(?:[\d\s-]*\d)?/g, (d) => "•".repeat(d.replace(/\D/g, "").length)) : text;
  await appendUserEcho(session as never, shown, reaction, quote);
}

/** A valid reply-to from the page: the bubble id, who wrote it, and a short excerpt. */
function quoteOf(body: unknown): MessageQuote | undefined {
  const q = (body as { reply_to?: { id?: unknown; who?: unknown; text?: unknown } })?.reply_to;
  if (!q || typeof q.id !== "string" || typeof q.text !== "string" || !/^[\w-]{1,80}$/.test(q.id)) return undefined;
  return { id: q.id, who: q.who === "user" ? "user" : "agent", text: q.text.replace(/\s+/g, " ").trim().slice(0, 200) };
}

/** POST { text } -> { session_id, action }. Sends into the live chat session (or starts one) and kicks the worker. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  const quote = quoteOf(req.body);
  // The model reads the quoted line first; the page shows the quote as a card above the bubble.
  const forModel = withQuote(text, quote);

  try {
    let session = await currentChatSession(t);
    if (session && !session.pending_kind && chatSessionExhausted(session)) session = undefined; // roll over to a fresh task
    // The emojis on the last few of the user's messages, so we don't stamp the same one twice in a row.
    const recentReactions = (session?.messages ?? [])
      .filter((m) => m.role === "user" && m.reaction)
      .slice(-9)
      .map((m) => m.reaction!);
    const reaction = reactionFor(text, recentReactions);
    // A task that will take real work (a price to look up, a booking, a refund, research) gets an
    // instant "on it" bubble so the chat is never silent while the agent works. Quick chat-tier
    // messages (acks, a calendar note, recall) do not. Wording never repeats what was just said.
    const willResearch = tierFor(text, "chat") !== "chat";
    const recentSaid = (session?.messages ?? []).filter((m) => m.role === "assistant" && typeof m.content === "string").slice(-6).map((m) => m.content as string);
    let ack: string | undefined;
    let action: string;
    if (!session) {
      session = await startChatSession(t, forModel, undefined, reaction, quote);
      action = "started";
    } else if (session.pending_kind === "checkpoint" || session.pending_kind === "send_email") {
      await echoAnswer(session, text, reaction, quote);
      await resolvePending(t, session, forModel, isApprovalReply(text));
      action = `${session.pending_kind}_resolved`;
    } else if (session.pending_kind === "ask_user") {
      await echoAnswer(session, text, reaction, quote);
      await resolvePending(t, session, forModel, null);
      action = "question_answered";
    } else {
      const model = upgradedModel(session.model ?? "", text, t);
      if (model) {
        console.log(`[route] ${session.id}: ${session.model} -> ${model} for "${text.slice(0, 60)}"`);
        await updateSession(session.id, { model });
      }
      await appendUserMessage(session, stampMessage(t, forModel, "chat"), undefined, reaction, quote);
      // A code sent before the agent asked for it (the user saw the text arrive mid-login): make
      // sure it gets typed into the site rather than read as chat.
      const code = codeIn(text);
      if (code) await appendHostNote(session, codeHint(code));
      action = "sent";
    }
    if (willResearch && (action === "started" || action === "sent")) {
      ack = researchAck(recentSaid);
      await appendAssistantMessage(session, ack, true);
    }
    await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
    await kick(session.id);
    return res.status(200).json({ session_id: session.id, action, reaction, ack });
  } catch (err) {
    if (err instanceof UsageCapError) return res.status(402).json({ error: err.message });
    throw err;
  }
}
