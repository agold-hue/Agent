import { createBrowser, liveViewUrl, reuseBrowser } from "./browser.js";
import { env } from "./env.js";
import { findRecentCodes, sendMail, type OutboundAttachment } from "./gmail.js";
import { addFollowUp, cancelFollowUps } from "./followups.js";
import { loginToSite } from "./login.js";
import { notifyOwner } from "./notify.js";
import { saveCredential, registrableDomain } from "./onepassword.js";
import { autoApprove, formatCheckpointEmail, formatEmailApproval, formatQuestionsEmail, type CheckpointInput } from "./policy.js";
import {
  channelOf,
  downloadFile,
  listAllEvents,
  listSessionOutputs,
  meta,
  sendToolResult,
  setMeta,
  type CustomToolUse,
  type Session,
} from "./anthropic.js";

export interface SendEmailInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: string[];
  mode?: "send" | "send_to_owner";
  purpose?: string;
}

/** "2h", "45m", "1d", or an ISO timestamp -> Date (null if unparseable or in the past by more than a minute). */
export function parseWhen(when: string, now = new Date()): Date | null {
  const dur = when.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const ms = unit.startsWith("m") ? n * 60_000 : unit.startsWith("h") ? n * 3_600_000 : n * 86_400_000;
    return new Date(now.getTime() + ms);
  }
  const t = new Date(when);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime() < now.getTime() - 60_000 ? null : t;
}

async function markPending(sessionId: string, kind: "checkpoint" | "ask_user" | "send_email", eventId: string, deadline = "") {
  await setMeta(sessionId, { pending_kind: kind, pending_event_id: eventId, pending_since: new Date().toISOString(), pending_deadline: deadline });
}

async function clearPending(sessionId: string) {
  await setMeta(sessionId, { pending_kind: null, pending_event_id: null, pending_since: null, pending_deadline: null });
}

/** Actually send an email the agent composed, with any attachments from the session's outputs. */
async function deliverEmail(session: Session, input: SendEmailInput): Promise<string> {
  const attachments: OutboundAttachment[] = [];
  const missing: string[] = [];
  if (input.attachments?.length) {
    const outputs = await listSessionOutputs(session.id);
    for (const name of input.attachments) {
      const f = outputs.find((o) => o.filename === name || o.filename.endsWith(`/${name}`));
      if (!f) {
        missing.push(name);
        continue;
      }
      attachments.push({ filename: name.split("/").pop() ?? name, mimeType: f.mimeType, content: await downloadFile(f.id) });
    }
  }
  const to = input.mode === "send_to_owner" ? env.gmail.ownerEmail() : input.to;
  const cc = input.mode === "send_to_owner" ? undefined : process.env.CC_OWNER_ON_OUTBOUND === "true" ? env.gmail.ownerEmail() : input.cc;
  const sent = await sendMail({ to, cc, subject: input.subject, body: input.body, attachments });
  return JSON.stringify({
    sent: true,
    to,
    thread_id: sent.threadId,
    attached: attachments.map((a) => a.filename),
    ...(missing.length ? { missing_attachments: missing } : {}),
    note: "Replies from the recipient will reach you as a new task. Record what you are waiting for in the project file.",
  });
}

/**
 * Executes one custom tool call. Everything that touches secrets, the user's money, or the user's
 * name happens here, on our side, never in the sandbox.
 *
 * checkpoint, ask_user and (when not auto-approved) send_email leave the tool call pending: on the
 * email channel the owner gets a mail and the inbox route resolves it from the reply; on chat the
 * UI renders the pending card and the next chat message resolves it.
 */
export async function handleCustomTool(session: Session, call: CustomToolUse): Promise<void> {
  const m = meta(session);
  const channel = channelOf(session);
  const input = call.input as Record<string, unknown>;
  const reply = (text: string, isError = false) => sendToolResult(session.id, call.id, text, isError);

  try {
    switch (call.name) {
      case "browser_session": {
        const existing = m.browserbase_session_id ? await reuseBrowser(m.browserbase_session_id) : undefined;
        const handle = existing ?? (await createBrowser());
        if (!existing) await setMeta(session.id, { browserbase_session_id: handle.sessionId });
        return reply(
          JSON.stringify({
            cdp_url: handle.connectUrl,
            live_view_url: handle.liveViewUrl,
            note: "Run: node /workspace/tools/browser.mjs open <cdp_url>. Include live_view_url in your final report if you could not finish.",
          }),
        );
      }

      case "login": {
        const browser = m.browserbase_session_id ? await reuseBrowser(m.browserbase_session_id) : undefined;
        if (!browser) return reply("No active browser. Call browser_session first.", true);
        const result = await loginToSite({
          connectUrl: browser.connectUrl,
          domain: String(input.domain ?? ""),
          accountHint: input.account_hint ? String(input.account_hint) : undefined,
        });
        const payload: Record<string, unknown> = { ...result };
        if (result.status === "needs_user") payload.live_view_url = browser.liveViewUrl;
        return reply(JSON.stringify(payload));
      }

      case "save_login": {
        const domain = registrableDomain(String(input.domain ?? ""));
        const id = await saveCredential({
          domain,
          username: String(input.username ?? ""),
          password: String(input.password ?? ""),
          notes: input.notes ? String(input.notes) : undefined,
        });
        return reply(JSON.stringify({ saved: true, domain, item_id: id }));
      }

      case "get_email_code": {
        const found = await findRecentCodes({
          senderHint: input.sender_hint ? String(input.sender_hint) : undefined,
          sinceMinutes: input.since_minutes ? Number(input.since_minutes) : 10,
        });
        return reply(JSON.stringify(found.slice(0, 3)));
      }

      case "send_email": {
        const draft = input as unknown as SendEmailInput;
        // Mail to the owner is never gated. Mail to anyone else is a "message" action under the policy.
        if (draft.mode === "send_to_owner") return reply(await deliverEmail(session, draft));
        const verdict = autoApprove({ action_type: "message", summary: draft.purpose ?? draft.subject, details: draft.body });
        if (verdict.ok) return reply(await deliverEmail(session, draft));
        await notifyOwner(session, formatEmailApproval(draft), `Approve email to ${draft.to}`);
        await markPending(session.id, "send_email", call.id);
        return; // resolved by the inbox route or the chat send route
      }

      case "schedule_follow_up": {
        if (input.cancel_id) {
          const n = await cancelFollowUps((f) => f.id === String(input.cancel_id));
          return reply(JSON.stringify({ cancelled: n }));
        }
        const due = parseWhen(String(input.when ?? ""));
        if (!due) return reply("Could not parse 'when'. Use ISO 8601 or a duration like '2h', '45m', '1d'.", true);
        const item = await addFollowUp({ due: due.toISOString(), what: String(input.what ?? ""), project: input.project ? String(input.project) : undefined });
        return reply(JSON.stringify({ scheduled: true, id: item.id, due: item.due, note: "A new session will start then with your note. Record it in the project file too." }));
      }

      case "checkpoint": {
        const cp = input as unknown as CheckpointInput;
        const verdict = autoApprove(cp);
        if (verdict.ok) return reply(`APPROVED (${verdict.reason}). Proceed exactly as described.`);
        const live = m.browserbase_session_id ? await liveViewUrl(m.browserbase_session_id).catch(() => undefined) : undefined;
        await notifyOwner(session, formatCheckpointEmail(cp, live), `Approval needed: ${cp.summary}`);
        await markPending(session.id, "checkpoint", call.id);
        return;
      }

      case "ask_user": {
        const questions = (input.questions as Array<{ question: string; default: string }>) ?? [];
        const hours = env.policy.askUserDeadlineHours();
        await notifyOwner(session, formatQuestionsEmail(questions, hours), "Quick questions");
        // In chat the user is present; do not time out on them.
        const deadline = channel === "email" ? new Date(Date.now() + hours * 3_600_000).toISOString() : "";
        await markPending(session.id, "ask_user", call.id, deadline);
        return;
      }

      default:
        return reply(`Unknown tool ${call.name}`, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(`Tool ${call.name} failed: ${msg}`, true);
  }
}

/** Called when the owner replies while a checkpoint, question, or outbound email is pending. */
export async function resolvePending(session: Session, userText: string, approved: boolean | null): Promise<void> {
  const m = meta(session);
  if (!m.pending_event_id) return;
  let text: string;
  let isError = false;
  if (m.pending_kind === "checkpoint") {
    text = approved
      ? "APPROVED by the user. Proceed exactly as described in the checkpoint."
      : `DENIED. The user replied:\n\n${userText}\n\nTreat this as new instructions. Do not perform the checkpointed action as described. Answer briefly.`;
  } else if (m.pending_kind === "send_email") {
    if (approved) {
      const events = await listAllEvents(session.id);
      const call = events.find((e) => e.type === "agent.custom_tool_use" && e.id === m.pending_event_id);
      if (call && call.type === "agent.custom_tool_use") {
        try {
          text = await deliverEmail(session, call.input as unknown as SendEmailInput);
        } catch (err) {
          text = `Approved, but sending failed: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      } else {
        text = "Approved, but the original email draft could not be found. Compose it again.";
        isError = true;
      }
    } else {
      text = `NOT SENT. The user replied:\n\n${userText}\n\nRevise per their instructions or drop it.`;
    }
  } else {
    text = `The user answered:\n\n${userText}`;
  }
  await sendToolResult(session.id, m.pending_event_id, text, isError);
  await clearPending(session.id);
}

/** Called by the inbox cron: unanswered questions past their deadline proceed with defaults. */
export async function expirePending(session: Session): Promise<boolean> {
  const m = meta(session);
  if (m.pending_kind !== "ask_user" || !m.pending_deadline || !m.pending_event_id) return false;
  if (new Date(m.pending_deadline).getTime() > Date.now()) return false;
  await sendToolResult(session.id, m.pending_event_id, "NO_REPLY: the user did not answer before the deadline. Proceed with the defaults you stated.");
  await clearPending(session.id);
  return true;
}
