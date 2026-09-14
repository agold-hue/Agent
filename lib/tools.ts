import { createBrowser, liveViewUrl, reuseBrowser } from "./browser.js";
import { env } from "./env.js";
import { findRecentCodes, replyInThread } from "./gmail.js";
import { loginToSite } from "./login.js";
import { saveCredential, registrableDomain } from "./onepassword.js";
import { autoApprove, formatCheckpointEmail, formatQuestionsEmail, type CheckpointInput } from "./policy.js";
import { channelOf, meta, sendToolResult, setMeta, type CustomToolUse, type Session } from "./anthropic.js";

/**
 * Executes one custom tool call. Everything that touches secrets or the user's money happens here,
 * on our side, never in the sandbox.
 *
 * checkpoint and ask_user leave the tool call pending: on the email channel we send a mail and the
 * inbox route resolves it from the reply; on the chat channel the UI renders the pending tool call
 * and the next chat message resolves it.
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

      case "checkpoint": {
        const cp = input as unknown as CheckpointInput;
        const verdict = autoApprove(cp);
        if (verdict.ok) return reply(`APPROVED (${verdict.reason}). Proceed exactly as described.`);
        if (channel === "email") {
          const live = m.browserbase_session_id ? await liveViewUrl(m.browserbase_session_id).catch(() => undefined) : undefined;
          await replyInThread({
            threadId: m.gmail_thread_id,
            subject: m.gmail_subject ?? "Task",
            inReplyTo: m.last_gmail_message_id_header || undefined,
            body: formatCheckpointEmail(cp, live),
          });
        }
        await setMeta(session.id, {
          pending_kind: "checkpoint",
          pending_event_id: call.id,
          pending_since: new Date().toISOString(),
          pending_deadline: "",
        });
        return; // resolved by the inbox route or the chat send route
      }

      case "ask_user": {
        const questions = (input.questions as Array<{ question: string; default: string }>) ?? [];
        const hours = env.policy.askUserDeadlineHours();
        if (channel === "email") {
          await replyInThread({
            threadId: m.gmail_thread_id,
            subject: m.gmail_subject ?? "Task",
            inReplyTo: m.last_gmail_message_id_header || undefined,
            body: formatQuestionsEmail(questions, hours),
          });
        }
        await setMeta(session.id, {
          pending_kind: "ask_user",
          pending_event_id: call.id,
          pending_since: new Date().toISOString(),
          // In chat the user is present; do not time out on them.
          pending_deadline: channel === "email" ? new Date(Date.now() + hours * 3_600_000).toISOString() : "",
        });
        return; // resolved by the inbox route (reply or deadline) or the chat send route
      }

      default:
        return reply(`Unknown tool ${call.name}`, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(`Tool ${call.name} failed: ${msg}`, true);
  }
}

/** Called when the owner replies while a checkpoint or question is pending. */
export async function resolvePending(session: Session, userText: string, approved: boolean | null): Promise<void> {
  const m = meta(session);
  if (!m.pending_event_id) return;
  let text: string;
  if (m.pending_kind === "checkpoint") {
    text = approved
      ? "APPROVED by the user. Proceed exactly as described in the checkpoint."
      : `DENIED. The user replied:\n\n${userText}\n\nTreat this as new instructions. Do not perform the checkpointed action as described.`;
  } else {
    text = `The user answered:\n\n${userText}`;
  }
  await sendToolResult(session.id, m.pending_event_id, text);
  await setMeta(session.id, { pending_kind: null, pending_event_id: null, pending_since: null, pending_deadline: null });
}

/** Called by the inbox cron: unanswered questions past their deadline proceed with defaults. */
export async function expirePending(session: Session): Promise<boolean> {
  const m = meta(session);
  if (m.pending_kind !== "ask_user" || !m.pending_deadline || !m.pending_event_id) return false;
  if (new Date(m.pending_deadline).getTime() > Date.now()) return false;
  await sendToolResult(session.id, m.pending_event_id, "NO_REPLY: the user did not answer before the deadline. Proceed with the defaults you stated.");
  await setMeta(session.id, { pending_kind: null, pending_event_id: null, pending_since: null, pending_deadline: null });
  return true;
}
