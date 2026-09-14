import { runBrowserTool } from "./browser-tools.js";
import { liveViewUrl, reuseBrowser } from "./browser.js";
import { registrableDomain, saveCredential } from "./credentials.js";
import { addFollowUp, cancelFollowUp, durationMs, parseWhen } from "./followups.js";
import { driveList, driveRead, driveSaveText, runCalendar, runOwnerInbox, type CalendarInput, type DriveInput, type OwnerInboxInput } from "./google.js";
import { addReceipt, listItems, recordWin, upsertItem, type ItemKind } from "./daily.js";
import { recentCodes } from "./inbound.js";
import { loginToSite } from "./login.js";
import { sendAgentMail } from "./mail.js";
import { appendMemory, deleteMemory, grepMemory, listMemory, readMemory, writeMemory } from "./memory.js";
import { notifyOwner } from "./notify.js";
import { autoApprove, formatCheckpointEmail, formatEmailApproval, formatQuestionsEmail, type CheckpointInput } from "./policy.js";
import { modelFor, nextTier, tierOfModel } from "./router.js";
import { appendToolResult, updateSession, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

export interface SendEmailInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  mode?: "send" | "send_to_owner";
  purpose?: string;
}

export interface ToolOutcome {
  /** Text returned to the model. */
  text: string;
  /** A screenshot to show the model (if it can see). */
  imageBase64?: string;
  /** The loop must stop and wait for the user; the result comes later via resolvePending. */
  pending?: "checkpoint" | "ask_user" | "send_email";
  /** The loop must stop and continue on a different model. */
  escalateTo?: string;
}

async function deliverEmail(t: Tenant, row: SessionRow, input: SendEmailInput): Promise<string> {
  const to = input.mode === "send_to_owner" ? t.email : input.to;
  const cc = input.mode === "send_to_owner" ? undefined : t.settings.cc_owner_on_outbound ? t.email : input.cc;
  const sent = await sendAgentMail(t, { to, cc, subject: input.subject, body: input.body, replyTag: row.reply_tag ?? undefined });
  return JSON.stringify({ sent: true, to, message_id: sent.messageId, note: "Replies from the recipient will reach you as a new task. Record what you are waiting for in the project file." });
}

/** Execute one tool call. Everything that touches secrets, money, or the user's name happens here. */
export async function executeTool(t: Tenant, row: SessionRow, name: string, args: Record<string, unknown>, callId: string): Promise<ToolOutcome> {
  const s = (k: string) => String(args[k] ?? "");
  try {
    if (name.startsWith("browser_") || name === "web_search") return await runBrowserTool(t, row, name, args);

    switch (name) {
      case "memory_read": {
        const c = await readMemory(t, s("path"));
        return { text: c == null ? `(no file ${s("path")})` : c };
      }
      case "memory_write":
        await writeMemory(t, s("path"), s("content"));
        return { text: `saved ${s("path")}` };
      case "memory_append":
        await appendMemory(t, s("path"), s("text"));
        return { text: `appended to ${s("path")}` };
      case "memory_delete":
        await deleteMemory(t, s("path"));
        return { text: `deleted ${s("path")}` };
      case "memory_list":
        return { text: (await listMemory(t, s("prefix"))).map((m) => `${m.path} (${m.bytes} B, ${new Date(m.updated_at).toISOString().slice(0, 10)})`).join("\n") || "(empty)" };
      case "memory_grep":
        return { text: await grepMemory(t, s("pattern"), s("prefix")) };

      case "login": {
        const browser = row.browserbase_session_id ? await reuseBrowser(row.browserbase_session_id) : undefined;
        if (!browser) return { text: "No active browser. Call browser_open first." };
        const result = await loginToSite(t, { connectUrl: browser.connectUrl, domain: s("domain"), accountHint: args.account_hint ? s("account_hint") : undefined });
        const payload: Record<string, unknown> = { ...result };
        if (result.status === "needs_user") payload.live_view_url = browser.liveViewUrl;
        if (result.status === "no_credentials") payload.note = "The user can add this login under Settings > Logins, or you can sign up (checkpoint first) and save_login.";
        return { text: JSON.stringify(payload) };
      }
      case "save_login": {
        const id = await saveCredential(t, { domain: registrableDomain(s("domain")), username: s("username"), password: s("password"), notes: args.notes ? s("notes") : undefined });
        return { text: JSON.stringify({ saved: true, id }) };
      }
      case "get_email_code": {
        const found = await recentCodes(t, { senderHint: args.sender_hint ? s("sender_hint") : undefined, sinceMinutes: args.since_minutes ? Number(args.since_minutes) : 10 });
        return { text: found.length ? JSON.stringify(found.slice(0, 3)) : "No codes in forwarded mail yet. Codes only arrive if the user auto-forwards to their agent address." };
      }
      case "send_email": {
        const draft = args as unknown as SendEmailInput;
        if (draft.mode === "send_to_owner") return { text: await deliverEmail(t, row, draft) };
        const verdict = autoApprove(t, { action_type: "message", summary: draft.purpose ?? draft.subject, details: draft.body });
        if (verdict.ok) return { text: await deliverEmail(t, row, draft) };
        await notifyOwner(t, row, formatEmailApproval(draft), `Approve email to ${draft.to}`);
        return { text: "", pending: "send_email" };
      }
      case "calendar":
        return { text: JSON.stringify(await runCalendar(t, args as unknown as CalendarInput)) };
      case "owner_inbox":
        return { text: JSON.stringify(await runOwnerInbox(t, args as unknown as OwnerInboxInput)) };
      case "drive": {
        const d = args as unknown as DriveInput & { content?: string };
        if (d.action === "save_text") {
          if (!d.filename || !d.content) return { text: "filename and content are required" };
          const saved = await driveSaveText(t, { filename: d.filename, content: d.content, folder: d.folder });
          return { text: JSON.stringify({ saved: true, ...saved }) };
        }
        if (d.action === "read") {
          if (!d.file_id) return { text: "file_id is required" };
          const f = await driveRead(t, d.file_id);
          const text = f.mimeType.startsWith("text/") || f.mimeType.includes("json") ? f.content.toString("utf8").slice(0, 20_000) : `(binary ${f.mimeType}, ${f.content.length} bytes; cannot display)`;
          return { text: `${f.name}\n\n${text}` };
        }
        return { text: JSON.stringify(await driveList(t, { folder: d.folder, query: d.query })) };
      }
      case "schedule_follow_up": {
        if (args.cancel_id) return { text: JSON.stringify({ cancelled: await cancelFollowUp(t.id, s("cancel_id")) }) };
        const due = parseWhen(s("when"));
        if (!due) return { text: "Could not parse 'when'. Use ISO 8601 or a duration like '2h', '45m', '1d'." };
        const repeat = args.repeat ? s("repeat") : undefined;
        const step = repeat ? durationMs(repeat) : null;
        if (repeat && step == null) return { text: "Could not parse 'repeat'. Use '30m', '1d', '1w'." };
        if (step != null && step < 15 * 60_000) return { text: "Watches may not repeat more often than every 15 minutes." };
        const item = await addFollowUp(t.id, { due, what: s("what"), project: args.project ? s("project") : undefined, repeatMs: step ?? undefined, until: args.until ? new Date(s("until")) : undefined });
        return { text: JSON.stringify({ scheduled: true, id: item.id, due: item.due, repeat: repeat ?? null }) };
      }
      case "checkpoint": {
        const cp = args as unknown as CheckpointInput;
        const verdict = autoApprove(t, cp);
        if (verdict.ok) return { text: `APPROVED (${verdict.reason}). Proceed exactly as described.` };
        const live = row.browserbase_session_id ? await liveViewUrl(row.browserbase_session_id).catch(() => undefined) : undefined;
        await notifyOwner(t, row, formatCheckpointEmail(cp, live), `Approval needed: ${cp.summary}`);
        return { text: "", pending: "checkpoint" };
      }
      case "ask_user": {
        const questions = (args.questions as Array<{ question: string; default: string }>) ?? [];
        const hours = Number(t.settings.ask_user_deadline_hours ?? 4);
        await notifyOwner(t, row, formatQuestionsEmail(questions, hours), "Quick questions");
        if (row.channel === "email") await updateSession(row.id, { pending_deadline: new Date(Date.now() + hours * 3_600_000) });
        return { text: "", pending: "ask_user" };
      }
      case "track_item": {
        const due = args.due_at ? new Date(s("due_at")) : null;
        const item = await upsertItem(t, {
          id: args.id ? s("id") : undefined,
          kind: (s("kind") || "other") as ItemKind,
          title: s("title"),
          due_at: due && !Number.isNaN(due.getTime()) ? due : null,
          status: args.status ? (s("status") as "open" | "done" | "cancelled") : undefined,
          amount_cents: args.amount_usd != null ? Math.round(Number(args.amount_usd) * 100) : null,
          details: (args.details as Record<string, unknown>) ?? {},
          source: args.source ? s("source") : `session:${row.id}`,
        });
        return { text: JSON.stringify({ id: item.id, kind: item.kind, title: item.title, due_at: item.due_at, status: item.status }) };
      }
      case "list_items": {
        const days = args.due_within_days != null ? Number(args.due_within_days) : undefined;
        const items = await listItems(t, { kind: args.kind ? s("kind") : undefined, status: args.status ? s("status") : "open", dueBefore: days != null ? new Date(Date.now() + days * 86_400_000) : undefined });
        return { text: items.length ? JSON.stringify(items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, due_at: i.due_at, status: i.status, amount_usd: i.amount_cents != null ? Number(i.amount_cents) / 100 : undefined, details: i.details }))) : "(nothing tracked)" };
      }
      case "record_win": {
        await recordWin(t, { kind: s("kind"), amountCents: args.amount_usd != null ? Math.round(Number(args.amount_usd) * 100) : 0, minutes: args.minutes != null ? Number(args.minutes) : 0, label: s("label"), sessionId: row.id });
        return { text: "win recorded" };
      }
      case "record_receipt": {
        let image: Buffer | undefined;
        if (args.screenshot && row.browserbase_session_id) {
          const shot = await runBrowserTool(t, row, "browser_screenshot", {}).catch(() => undefined);
          if (shot?.imageBase64) image = Buffer.from(shot.imageBase64, "base64");
        }
        const id = await addReceipt(t, { sessionId: row.id, title: s("title"), confirmation: args.confirmation ? s("confirmation") : undefined, details: args.details ? s("details") : undefined, image });
        return { text: JSON.stringify({ receipt_id: id, screenshot: !!image }) };
      }
      case "escalate_model": {
        const next = nextTier(tierOfModel(row.model ?? "", t));
        if (!next) return { text: "You are already on the most capable model. Keep going with what you have, or tell the user where you are stuck." };
        return { text: `Escalating to the ${next} tier: ${s("reason")}`, escalateTo: modelFor(next, t) };
      }
      default:
        return { text: `Unknown tool ${name}` };
    }
  } catch (err) {
    return { text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    void callId;
  }
}

/** The user replied while a checkpoint, question, or outbound email was pending: feed the answer back. */
export async function resolvePending(t: Tenant, row: SessionRow, userText: string, approved: boolean | null): Promise<void> {
  if (!row.pending_event_id) return;
  let text: string;
  if (row.pending_kind === "checkpoint") {
    text = approved ? "APPROVED by the user. Proceed exactly as described in the checkpoint." : `DENIED. The user replied:\n\n${userText}\n\nTreat this as new instructions. Do not perform the checkpointed action as described. Answer briefly.`;
  } else if (row.pending_kind === "send_email") {
    if (approved) {
      const call = [...row.messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === row.pending_event_id));
      const tc = call?.tool_calls?.find((c) => c.id === row.pending_event_id);
      try {
        text = tc ? await deliverEmail(t, row, JSON.parse(tc.function.arguments) as SendEmailInput) : "Approved, but the draft could not be found. Compose it again.";
      } catch (err) {
        text = `Approved, but sending failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      text = `NOT SENT. The user replied:\n\n${userText}\n\nRevise per their instructions or drop it.`;
    }
  } else {
    text = `The user answered:\n\n${userText}`;
  }
  await appendToolResult(row, row.pending_event_id, text);
}

export async function expirePending(row: SessionRow): Promise<void> {
  if (!row.pending_event_id) return;
  await appendToolResult(row, row.pending_event_id, "NO_REPLY: the user did not answer before the deadline. Proceed with the defaults you stated.");
}
