import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { currentChatSession, isSeparateTask, looksLikeAnswer, PARALLEL_PREFIX, PARALLEL_TASKS, startChatSession, startTaskSession, withQuote } from "../../../lib/chat.js";
import type { MessageQuote } from "../../../lib/llm.js";
import { appendTranscript } from "../../../lib/memory.js";
import { codeHint, codeIn, isApprovalReply } from "../../../lib/policy.js";
import { chatSessionExhausted, kick } from "../../../lib/runtime.js";
import { reactionFor } from "../../../lib/reaction.js";
import { researchAck } from "../../../lib/acks.js";
import { isQuickQuestion, modelFor, tierFor, tierOfModel, upgradedModel } from "../../../lib/router.js";
import { activeTaskSessions, appendAssistantMessage, appendHostNote, appendUserEcho, appendUserMessage, ownSession, updateSession, UsageCapError, type SessionRow } from "../../../lib/sessions.js";

/** The host's note behind a message that lands while the session is mid-task. */
const MID_TASK_NOTE = "(That message arrived while you are mid-task. If it changes the task, apply it. If it needs an answer, answer it with tell_user in one line. Then continue the task; a text reply now would end it.)";
import { resolvePending } from "../../../lib/tools.js";
import { stampMessage } from "../../../lib/transcript.js";
import type { Tenant } from "../../../lib/tenant.js";

/**
 * Show the user's answer as a chat bubble. Everything the user types must appear, or it looks lost:
 * a verification code shows with its digits masked (the model still gets the real one through the
 * tool result), and anything else they say while a code is pending ("didn't get one, resend it")
 * shows as is.
 */
async function echoAnswer(session: SessionRow, text: string, reaction: string, quote?: MessageQuote): Promise<void> {
  const awaitingCode = session.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === session.pending_event_id && c.function.name === "request_code"));
  const shown = awaitingCode && codeIn(text) ? text.replace(/\d(?:[\d\s-]*\d)?/g, (d) => "•".repeat(d.replace(/\D/g, "").length)) : text;
  await appendUserEcho(session, shown, reaction, quote);
}

/** A valid reply-to from the page: the bubble id, who wrote it, and a short excerpt. */
function quoteOf(body: unknown): MessageQuote | undefined {
  const q = (body as { reply_to?: { id?: unknown; who?: unknown; text?: unknown } })?.reply_to;
  if (!q || typeof q.id !== "string" || typeof q.text !== "string" || !/^[\w-]{1,80}$/.test(q.id)) return undefined;
  return { id: q.id, who: q.who === "user" ? "user" : "agent", text: q.text.replace(/\s+/g, " ").trim().slice(0, 200) };
}

/**
 * Where a message goes. In order: the session whose bubble it replies to; the one session waiting on
 * the user, when the message reads like an answer; a task of its own when the thread is busy and the
 * message is a fresh request (or says so); otherwise the chat thread.
 */
async function route(t: Tenant, main: SessionRow | undefined, text: string, quote: MessageQuote | undefined): Promise<{ target: SessionRow | undefined; spawn: boolean; text: string }> {
  const tasks = await activeTaskSessions(t.id);
  if (quote) {
    // Bubble ids are "<session>-<index>", cards "<session>-<index>t<call>".
    const id = quote.id.replace(/-\d+(t[\w-]*)?$/, "");
    const quoted = id === main?.id ? main : (tasks.find((s) => s.id === id) ?? (await ownSession(t.id, id)));
    // A reply to a task's bubble, or to any session's waiting card, goes to that session and never spawns.
    if (quoted && quoted.status !== "terminated" && (quoted.kind === "task" || quoted.pending_kind)) return { target: quoted, spawn: false, text };
  }
  const waiting = [main, ...tasks].filter((s): s is SessionRow => !!s?.pending_kind);
  if (waiting.length === 1 && looksLikeAnswer(text)) return { target: waiting[0], spawn: false, text };
  // A code never starts a task: it belongs to whatever is signing in (the thread, when nothing waits).
  if (codeIn(text)) return { target: main, spawn: false, text };
  const explicit = PARALLEL_PREFIX.test(text);
  const busy = !!main && (main.status === "running" || !!main.pending_kind);
  // While the thread works, a greeting or status question is answered alongside at once (its own
  // small session on the fast model) instead of waiting for the task to reach it.
  if (main && busy && !quote && isQuickQuestion(text) && tasks.length < PARALLEL_TASKS) return { target: main, spawn: true, text };
  if (main && (explicit || (busy && isSeparateTask(text, quote))) && tasks.length < PARALLEL_TASKS) {
    return { target: main, spawn: true, text: text.replace(PARALLEL_PREFIX, "") };
  }
  return { target: main, spawn: false, text: text.replace(PARALLEL_PREFIX, "") };
}

/** POST { text, reply_to? } -> { session_id, action }. Sends into the right session (or starts one) and kicks the worker. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const raw = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!raw) return res.status(400).json({ error: "text required" });
  const quote = quoteOf(req.body);

  try {
    let main = await currentChatSession(t);
    if (main && !main.pending_kind && chatSessionExhausted(main)) main = undefined; // roll over to a fresh thread
    const routed = await route(t, main, raw, quote);
    const text = routed.text;
    // The model reads the quoted line first; the page shows the quote as a card above the bubble.
    const forModel = withQuote(text, quote);
    let session = routed.target;
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
    if (routed.spawn) {
      // The thread is busy: this request runs as its own task alongside it.
      session = await startTaskSession(t, forModel, main, quote, reaction);
      action = "task_started";
    } else if (!session) {
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
      // Up to the tier the message needs; and back down to the fast chat model for a quick question
      // on an idle thread ("what's up" after a bill was handled on the strong model), so a greeting
      // answers in seconds. A thread mid-task keeps its model.
      const idle = session.status !== "running" && !session.pending_kind;
      const model = upgradedModel(session.model ?? "", text, t) ?? (idle && isQuickQuestion(text) && tierOfModel(session.model ?? "", t) !== "chat" ? modelFor("chat", t) : undefined);
      if (model) {
        console.log(`[route] ${session.id}: ${session.model} -> ${model} for "${text.slice(0, 60)}"`);
        await updateSession(session.id, { model });
      }
      const midTask = session.status === "running";
      await appendUserMessage(session, stampMessage(t, forModel, "chat"), undefined, reaction, quote);
      // A code sent before the agent asked for it (the user saw the text arrive mid-login): make
      // sure it gets typed into the site rather than read as chat.
      const code = codeIn(text);
      if (code) await appendHostNote(session, codeHint(code));
      else if (midTask) await appendHostNote(session, MID_TASK_NOTE);
      action = "sent";
    }
    if (willResearch && (action === "started" || action === "sent" || action === "task_started")) {
      ack = researchAck(recentSaid);
      await appendAssistantMessage(session, ack, true);
    }
    await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
    await kick(session.id);
    return res.status(200).json({ session_id: session.id, action, reaction, ack, task: routed.spawn ? session.title : undefined });
  } catch (err) {
    if (err instanceof UsageCapError) return res.status(402).json({ error: err.message });
    throw err;
  }
}
