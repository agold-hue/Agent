import { createBrowser, liveViewUrl, reuseBrowser } from "./browser.js";
import { findCredential, registrableDomain, saveCredential } from "./credentials.js";
import { addFollowUp, cancelFollowUp, durationMs, parseWhen } from "./followups.js";
import { driveList, driveRead, driveSave, runCalendar, runOwnerInbox, type CalendarInput, type DriveInput, type OwnerInboxInput } from "./google.js";
import { recentCodes } from "./inbound.js";
import { loginToSite } from "./login.js";
import { sendAgentMail, type OutboundAttachment } from "./mail.js";
import { notifyOwner } from "./notify.js";
import { autoApprove, formatCheckpointEmail, formatEmailApproval, formatQuestionsEmail, type CheckpointInput } from "./policy.js";
import { clearPending, updateSession, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";
import { addFileToSession, downloadFile, listAllEvents, listSessionOutputs, sendToolResult, type CustomToolUse } from "./anthropic.js";

export interface SendEmailInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: string[];
  mode?: "send" | "send_to_owner";
  purpose?: string;
}

async function markPending(row: SessionRow, kind: "checkpoint" | "ask_user" | "send_email", eventId: string, deadline: Date | null = null) {
  await updateSession(row.id, { pending_kind: kind, pending_event_id: eventId, pending_deadline: deadline });
}

/** Actually send an email the agent composed, with attachments from the session's outputs. Replies route back here. */
async function deliverEmail(t: Tenant, row: SessionRow, input: SendEmailInput): Promise<string> {
  const attachments: OutboundAttachment[] = [];
  const missing: string[] = [];
  if (input.attachments?.length) {
    const outputs = await listSessionOutputs(row.id);
    for (const name of input.attachments) {
      const f = outputs.find((o) => o.filename === name || o.filename.endsWith(`/${name}`));
      if (!f) {
        missing.push(name);
        continue;
      }
      attachments.push({ filename: name.split("/").pop() ?? name, mimeType: f.mimeType, content: await downloadFile(f.id) });
    }
  }
  const to = input.mode === "send_to_owner" ? t.email : input.to;
  const cc = input.mode === "send_to_owner" ? undefined : t.settings.cc_owner_on_outbound ? t.email : input.cc;
  const sent = await sendAgentMail(t, { to, cc, subject: input.subject, body: input.body, attachments, replyTag: row.reply_tag ?? undefined });
  return JSON.stringify({
    sent: true,
    to,
    message_id: sent.messageId,
    attached: attachments.map((a) => a.filename),
    ...(missing.length ? { missing_attachments: missing } : {}),
    note: "Replies from the recipient will reach you as a new task. Record what you are waiting for in the project file.",
  });
}

/**
 * Executes one custom tool call for a tenant. Everything that touches secrets, money, or the
 * user's name happens here, on our side, never in the sandbox.
 */
export async function handleCustomTool(t: Tenant, row: SessionRow, call: CustomToolUse): Promise<void> {
  const input = call.input as Record<string, unknown>;
  const reply = (text: string, isError = false) => sendToolResult(row.id, call.id, text, isError);

  try {
    switch (call.name) {
      case "browser_session": {
        const existing = row.browserbase_session_id ? await reuseBrowser(row.browserbase_session_id) : undefined;
        const handle = existing ?? (await createBrowser(t));
        if (!existing) await updateSession(row.id, { browserbase_session_id: handle.sessionId });
        return reply(
          JSON.stringify({
            cdp_url: handle.connectUrl,
            live_view_url: handle.liveViewUrl,
            note: "Run: node /workspace/tools/browser.mjs open <cdp_url>. Include live_view_url in your final report if you could not finish.",
          }),
        );
      }

      case "login": {
        const browser = row.browserbase_session_id ? await reuseBrowser(row.browserbase_session_id) : undefined;
        if (!browser) return reply("No active browser. Call browser_session first.", true);
        const result = await loginToSite(t, {
          connectUrl: browser.connectUrl,
          domain: String(input.domain ?? ""),
          accountHint: input.account_hint ? String(input.account_hint) : undefined,
        });
        const payload: Record<string, unknown> = { ...result };
        if (result.status === "needs_user") payload.live_view_url = browser.liveViewUrl;
        if (result.status === "no_credentials") payload.note = "The user can add this login under Settings > Logins, or you can sign up (checkpoint first) and save_login.";
        return reply(JSON.stringify(payload));
      }

      case "save_login": {
        const domain = registrableDomain(String(input.domain ?? ""));
        const id = await saveCredential(t, {
          domain,
          username: String(input.username ?? ""),
          password: String(input.password ?? ""),
          notes: input.notes ? String(input.notes) : undefined,
        });
        return reply(JSON.stringify({ saved: true, domain, id }));
      }

      case "get_email_code": {
        const found = await recentCodes(t, {
          senderHint: input.sender_hint ? String(input.sender_hint) : undefined,
          sinceMinutes: input.since_minutes ? Number(input.since_minutes) : 10,
        });
        if (!found.length) return reply("No codes in forwarded mail yet. Codes only arrive here if the user auto-forwards to their agent address.");
        return reply(JSON.stringify(found.slice(0, 3)));
      }

      case "send_email": {
        const draft = input as unknown as SendEmailInput;
        if (draft.mode === "send_to_owner") return reply(await deliverEmail(t, row, draft));
        const verdict = autoApprove(t, { action_type: "message", summary: draft.purpose ?? draft.subject, details: draft.body });
        if (verdict.ok) return reply(await deliverEmail(t, row, draft));
        await notifyOwner(t, row, formatEmailApproval(draft), `Approve email to ${draft.to}`);
        await markPending(row, "send_email", call.id);
        return;
      }

      case "calendar":
        return reply(JSON.stringify(await runCalendar(t, input as unknown as CalendarInput)));

      case "owner_inbox":
        return reply(JSON.stringify(await runOwnerInbox(t, input as unknown as OwnerInboxInput)));

      case "drive": {
        const d = input as unknown as DriveInput;
        if (d.action === "save") {
          if (!d.filename) return reply("filename is required", true);
          const outputs = await listSessionOutputs(row.id);
          const f = outputs.find((o) => o.filename === d.filename || o.filename.endsWith(`/${d.filename}`));
          if (!f) return reply(`No file named ${d.filename} under /mnt/session/outputs/`, true);
          const saved = await driveSave(t, { filename: d.filename.split("/").pop() ?? d.filename, mimeType: f.mimeType, content: await downloadFile(f.id), folder: d.folder });
          return reply(JSON.stringify({ saved: true, ...saved, folder: d.folder ?? "Assistant" }));
        }
        if (d.action === "read") {
          if (!d.file_id) return reply("file_id is required", true);
          const file = await driveRead(t, d.file_id);
          const path = await addFileToSession(row.id, { filename: file.name, mimeType: file.mimeType, content: file.content });
          return reply(JSON.stringify({ mounted_at: path, name: file.name, mime_type: file.mimeType }));
        }
        return reply(JSON.stringify(await driveList(t, { folder: d.folder, query: d.query })));
      }

      case "schedule_follow_up": {
        if (input.cancel_id) {
          const n = await cancelFollowUp(t.id, String(input.cancel_id));
          return reply(JSON.stringify({ cancelled: n }));
        }
        const due = parseWhen(String(input.when ?? ""));
        if (!due) return reply("Could not parse 'when'. Use ISO 8601 or a duration like '2h', '45m', '1d'.", true);
        const repeat = input.repeat ? String(input.repeat) : undefined;
        const step = repeat ? durationMs(repeat) : null;
        if (repeat && step == null) return reply("Could not parse 'repeat'. Use a duration like '30m', '1d', '1w'.", true);
        if (step != null && step < 15 * 60_000) return reply("Watches may not repeat more often than every 15 minutes.", true);
        const item = await addFollowUp(t.id, {
          due,
          what: String(input.what ?? ""),
          project: input.project ? String(input.project) : undefined,
          repeatMs: step ?? undefined,
          until: input.until ? new Date(String(input.until)) : undefined,
        });
        return reply(JSON.stringify({ scheduled: true, id: item.id, due: item.due, repeat: repeat ?? null, note: "A new session will start then with your note. Record it in watchlist.md or the project file too." }));
      }

      case "checkpoint": {
        const cp = input as unknown as CheckpointInput;
        const verdict = autoApprove(t, cp);
        if (verdict.ok) return reply(`APPROVED (${verdict.reason}). Proceed exactly as described.`);
        const live = row.browserbase_session_id ? await liveViewUrl(row.browserbase_session_id).catch(() => undefined) : undefined;
        await notifyOwner(t, row, formatCheckpointEmail(cp, live), `Approval needed: ${cp.summary}`);
        await markPending(row, "checkpoint", call.id);
        return;
      }

      case "ask_user": {
        const questions = (input.questions as Array<{ question: string; default: string }>) ?? [];
        const hours = Number(t.settings.ask_user_deadline_hours ?? 4);
        await notifyOwner(t, row, formatQuestionsEmail(questions, hours), "Quick questions");
        const deadline = row.channel === "email" ? new Date(Date.now() + hours * 3_600_000) : null;
        await markPending(row, "ask_user", call.id, deadline);
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

/** Called when the user replies while a checkpoint, question, or outbound email is pending. */
export async function resolvePending(t: Tenant, row: SessionRow, userText: string, approved: boolean | null): Promise<void> {
  if (!row.pending_event_id) return;
  let text: string;
  let isError = false;
  if (row.pending_kind === "checkpoint") {
    text = approved
      ? "APPROVED by the user. Proceed exactly as described in the checkpoint."
      : `DENIED. The user replied:\n\n${userText}\n\nTreat this as new instructions. Do not perform the checkpointed action as described. Answer briefly.`;
  } else if (row.pending_kind === "send_email") {
    if (approved) {
      const events = await listAllEvents(row.id);
      const call = events.find((e) => e.type === "agent.custom_tool_use" && e.id === row.pending_event_id);
      if (call && call.type === "agent.custom_tool_use") {
        try {
          text = await deliverEmail(t, row, call.input as unknown as SendEmailInput);
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
  await sendToolResult(row.id, row.pending_event_id, text, isError);
  await clearPending(row.id);
}

/** Unanswered questions past their deadline proceed with defaults. */
export async function expirePending(row: SessionRow): Promise<void> {
  if (!row.pending_event_id) return;
  await sendToolResult(row.id, row.pending_event_id, "NO_REPLY: the user did not answer before the deadline. Proceed with the defaults you stated.");
  await clearPending(row.id);
}

export { findCredential };
