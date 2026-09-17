import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { ASIDE_LIMIT, currentChatSession, isSeparateTask, looksLikeAnswer, PARALLEL_PREFIX, PARALLEL_TASKS, startAsideSession, startChatSession, startTaskSession, STATUS_PING, statusLine, wantsSideReply, withQuote } from "../../../lib/chat.js";
import type { MessageQuote } from "../../../lib/llm.js";
import { appendTranscript } from "../../../lib/memory.js";
import { codeHint, codeIn, isApprovalReply } from "../../../lib/policy.js";
import { chatSessionExhausted, kick, runSession } from "../../../lib/runtime.js";
import { isPleasantryCloser, reactionFor } from "../../../lib/reaction.js";
import { researchAck } from "../../../lib/acks.js";
import { isLookupQuestion, isQuickQuestion, reroutedModel, tierFor } from "../../../lib/router.js";
import { activeAsideSessions, activeTaskSessions, appendAssistantMessage, appendHostNote, appendUserEcho, appendUserMessage, ownSession, updateSession, UsageCapError, type SessionRow } from "../../../lib/sessions.js";

/** How long a quick question or side reply may run inside the send request before a worker takes over. */
const INLINE_MS = Number(process.env.INLINE_REPLY_MS ?? 25_000);

/** A worker that just finished a reply on this thread is still there, holding the lease, and picks the new message up itself. */
async function warmWorkerHolds(sessionId: string): Promise<boolean> {
  const { one } = await import("../../../lib/db.js");
  const r = await one<{ warm: boolean }>("select (lease_until is not null and lease_until > now() + interval '3 seconds') as warm from agent_sessions where id = $1", [sessionId]).catch(() => undefined);
  return !!r?.warm;
}

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
async function echoAnswer(session: SessionRow, text: string, reaction: string | undefined, quote?: MessageQuote): Promise<void> {
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
 * the user, when the message reads like an answer; a side reply when the thread is busy and the
 * message is a question or a greeting (answered alongside, at once, as a plain reply); a task of its
 * own when the thread is busy and the message is a fresh request (or says so); otherwise the chat
 * thread, where a steer sent mid-task is applied to the running work.
 */
async function route(t: Tenant, main: SessionRow | undefined, text: string, quote: MessageQuote | undefined): Promise<{ target: SessionRow | undefined; spawn: "task" | "aside" | "status" | null; text: string }> {
  const tasks = await activeTaskSessions(t.id);
  if (quote) {
    // Bubble ids are "<session>-<index>", cards "<session>-<index>t<call>".
    const id = quote.id.replace(/-\d+(t[\w-]*)?$/, "");
    const quoted = id === main?.id ? main : (tasks.find((s) => s.id === id) ?? (await ownSession(t.id, id)));
    // A reply to a task's bubble, or to any session's waiting card, goes to that session and never spawns.
    if (quoted && quoted.status !== "terminated" && (quoted.kind === "task" || quoted.pending_kind)) return { target: quoted, spawn: null, text };
  }
  const waiting = [main, ...tasks].filter((s): s is SessionRow => !!s?.pending_kind);
  if (waiting.length === 1 && looksLikeAnswer(text)) return { target: waiting[0], spawn: null, text };
  // A code never starts a task: it belongs to whatever is signing in (the thread, when nothing waits).
  if (codeIn(text)) return { target: main, spawn: null, text };
  const explicit = PARALLEL_PREFIX.test(text);
  const busy = !!main && (main.status === "running" || !!main.pending_kind);
  // A reply to one of the agent's own bubbles ("Are you crazy?", "tell me more about that") is a
  // question about it, answered as a reply; a reply to the user's own earlier message is a steer of
  // the work it started. Only the steer is handed to the running task.
  const steer = quote?.who === "user" ? quote : undefined;
  // A bare "?" or "status" while the thread works: the host answers from the thread's progress, no model.
  if (main && busy && !quote && STATUS_PING.test(text.trim())) return { target: main, spawn: "status", text };
  // While the thread works, a greeting, a thank-you or a question ("any luck?", "did you use the
  // Amex?", "do you have my address?") is answered alongside at once, as a plain reply in the chat,
  // from the thread's own progress; the running task is never interrupted and never has to notice.
  if (main && busy && !explicit && wantsSideReply(text, steer) && (await activeAsideSessions(t.id).catch(() => [])).length < ASIDE_LIMIT) return { target: main, spawn: "aside", text };
  if (main && (explicit || (busy && isSeparateTask(text, steer))) && tasks.length < PARALLEL_TASKS) {
    return { target: main, spawn: "task", text: text.replace(PARALLEL_PREFIX, "") };
  }
  return { target: main, spawn: null, text: text.replace(PARALLEL_PREFIX, "") };
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
    // A pure "thanks"/"perfect"/"got it" closing the exchange: react with an emoji and say nothing
    // back, the way a person taps a heart instead of typing "you're welcome". Only when nothing is
    // running or waiting (mid-task or a pending approval still gets the normal path) and it is not a
    // reply to a specific bubble. The message and its reaction are stored so the chat shows them; the
    // worker is never kicked, so no typed reply and no typing indicator.
    const idleThread = !session || (session.status !== "running" && !session.pending_kind);
    if (!routed.spawn && !quote && idleThread && isPleasantryCloser(text)) {
      const react = reaction ?? "\ud83d\udc4d";
      if (!session) {
        session = await startChatSession(t, forModel, undefined, react, quote);
      } else {
        await appendUserMessage(session, stampMessage(t, forModel, "chat"), undefined, react, quote);
      }
      await updateSession(session.id, { status: "idle", draft: null });
      await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
      return res.status(200).json({ session_id: session.id, action: "reacted", reaction: react, status: "idle" });
    }
    // A task that will take real work (a price to look up, a booking, a refund, research) gets an
    // instant "on it" bubble so the chat is never silent while the agent works. Quick chat-tier
    // messages (acks, a calendar note, recall) do not. Wording never repeats what was just said.
    const willResearch = tierFor(text, "chat") !== "chat";
    const recentSaid = (session?.messages ?? []).filter((m) => m.role === "assistant" && typeof m.content === "string").slice(-6).map((m) => m.content as string);
    let ack: string | undefined;
    let action: string;
    if (routed.spawn === "status") {
      // The host answers a status ping itself: the ping and one line on where things stand, both shown, no model run.
      await appendUserEcho(session!, text, reaction, quote);
      const line = statusLine(session!, await activeTaskSessions(t.id).catch(() => []));
      await appendAssistantMessage(session!, line, true);
      await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
      return res.status(200).json({ session_id: session!.id, action: "status", reaction, status: session!.status });
    }
    if (routed.spawn === "aside") {
      // The thread is busy: this question is answered alongside it, at once, as a normal reply.
      session = await startAsideSession(t, forModel, main!, quote, reaction);
      action = "aside";
    } else if (routed.spawn === "task") {
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
      // Every request is tiered on its own: up to the tier the message needs at any time, and back
      // down on an idle thread ("check my balance" after a refund ran on the judgment model runs on
      // the task model; "thanks" on the chat model). A thread mid-task keeps its model for a steer.
      const idle = session.status !== "running" && !session.pending_kind;
      const model = reroutedModel(session.model ?? "", text, idle, t);
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
    // The page shows typing dots and "typing…" the moment a task starts, so the "on it" bubble is off
    // by default (CHAT_ACKS=on brings it back); anything over a minute still gets its tell_user line.
    if (process.env.CHAT_ACKS === "on" && willResearch && (action === "started" || action === "sent" || action === "task_started")) {
      ack = researchAck(recentSaid);
      await appendAssistantMessage(session, ack, true);
    }
    await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
    // A greeting, a quick question, a fact lookup or a side reply is answered inside this request:
    // no kick, no worker cold start; the page shows the reply as it streams. The composer is free
    // meanwhile. A run that needs more than the inline budget is handed to a worker as usual.
    const inline = INLINE_MS > 0 && (action === "aside" || ((action === "started" || action === "sent") && (isQuickQuestion(text) || isLookupQuestion(text))));
    if (inline) {
      const outcome = await runSession(session.id, { budgetMs: INLINE_MS, noSiblingWait: true }).catch((err: unknown) => {
        console.error(`[inline] ${session!.id}: ${err instanceof Error ? err.message : String(err)}`);
        return "error" as const;
      });
      if (outcome === "continue" || outcome === "error") await kick(session.id);
    } else if (!(await warmWorkerHolds(session.id))) {
      await kick(session.id);
    }
    return res.status(200).json({ session_id: session.id, action, reaction, ack, task: routed.spawn === "task" ? session.title : undefined });
  } catch (err) {
    if (err instanceof UsageCapError) return res.status(402).json({ error: err.message });
    throw err;
  }
}
