import { runBrowserTool } from "./browser-tools.js";
import { fileContent, listFiles, saveFile } from "./files.js";
import { upsertLesson } from "./learning.js";
import { fillPdfForm, makePdf, pdfFormFields, pdfInfo } from "./pdf.js";
import { liveViewUrl, reuseBrowser } from "./browser.js";
import { recordLoginOutcome, registrableDomain, saveCredential } from "./credentials.js";
import { addFollowUp, cancelFollowUp, durationMs, parseWhen } from "./followups.js";
import { driveList, driveRead, driveSaveText, runCalendar, runOwnerInbox, type CalendarInput, type DriveInput, type OwnerInboxInput } from "./google.js";
import { addReceipt, listItems, recordWin, upsertItem, type ItemKind } from "./daily.js";
import { recentCodes } from "./inbound.js";
import { loginToSite } from "./login.js";
import { sendAgentMail } from "./mail.js";
import { appendMemory, deleteMemory, grepMemory, listMemory, readMemory, writeMemory } from "./memory.js";
import { notifyOwner } from "./notify.js";
import { autoApprove, codeHint, codeIn, formatCheckpointEmail, formatEmailApproval, formatQuestionsEmail, type CheckpointInput } from "./policy.js";
import { runDocumentTool } from "./docstore.js";
import { approvalProposal, logApproval, resolveFixesFor } from "./proactive.js";
import { updateSettings } from "./tenant.js";
import { runBankTool } from "./plaid.js";
import { runLocalBrowserTool } from "./relay.js";
import { runResearchTool } from "./research.js";
import { runTrackTool } from "./tracking.js";
import { runWatchTool } from "./watches.js";
import { auditMoneyMove, HOLD_PREFIX } from "./audit.js";
import { tooDearForValue } from "./tactics.js";
import { modelFor, nextTier, tierOfModel } from "./router.js";
import { appendAssistantMessage, appendHostNote, appendToolResult, taskStart, taskUserText, updateSession, type SessionRow } from "./sessions.js";
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
    // Search and reading run over HTTPS from this process, never through the browser; the browser's
    // own DuckDuckGo page is the last fallback and only when this session already has one open.
    if (name === "web_search" || name === "fetch_page") return await runResearchTool(t, row, name, args, (query) => runBrowserTool(t, row, "web_search_browser", { query }));
    if (name.startsWith("browser_") || name === "solve_captcha") return await runBrowserTool(t, row, name, args);
    if (name === "watch_page") return { text: await runWatchTool(t, row, args) };
    if (name === "local_browser") return { text: await runLocalBrowserTool(t, row, args) };
    if (name === "document") return { text: await runDocumentTool(t, row, args) };
    if (name === "set_preferred_name") {
      const preferred = s("name").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!preferred) return { text: "Nothing saved; pass the name they asked for." };
      await updateSettings(t, { preferred_name: preferred });
      t.settings.preferred_name = preferred;
      return { text: `Saved: the user goes by "${preferred}" from now on (shown under Settings). Use it in this reply and every one after; never the old name.` };
    }
    if (name === "approval_rule") {
      const rules = [...(t.settings.auto_approve_rules ?? [])];
      const action = s("action") || "list";
      if (action === "add") {
        const rule = { action_type: s("action_type").toLowerCase() || "purchase", ...(s("merchant") ? { merchant: s("merchant").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "") } : {}), ...(args.max_usd != null ? { max_usd: Number(args.max_usd) } : {}) };
        if (!rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) rules.push(rule);
        await updateSettings(t, { auto_approve_rules: rules });
        return { text: `Rule saved: ${rule.action_type}${rule.merchant ? ` at ${rule.merchant}` : ""}${rule.max_usd != null ? ` under $${rule.max_usd}` : ""} no longer needs approval. Tell the user in one line; they can change it under Settings.` };
      }
      if (action === "remove") {
        const keep = rules.filter((r) => !(r.action_type === s("action_type").toLowerCase() && (r.merchant ?? "") === (s("merchant").toLowerCase() || "")));
        await updateSettings(t, { auto_approve_rules: keep });
        return { text: `Removed ${rules.length - keep.length} rule(s).` };
      }
      return { text: rules.length ? rules.map((r) => `- ${r.action_type}${r.merchant ? ` at ${r.merchant}` : ""}${r.max_usd != null ? ` under $${r.max_usd}` : ""}`).join("\n") : "No learned approval rules." };
    }
    if (name === "bank") return { text: await runBankTool(t, args) };
    if (name === "track_package") return { text: await runTrackTool(args) };

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
        const result = await loginToSite(t, { connectUrl: browser.connectUrl, domain: s("domain"), accountHint: args.account_hint ? s("account_hint") : undefined, username: args.username ? s("username") : undefined, code: args.code ? s("code") : undefined, targetId: row.browser_target_id });
        console.log(`[login] ${row.id} ${s("domain")}: ${result.status}${"reason" in result ? ` (${result.reason})` : ""}`);
        if (result.status !== "no_credentials" && result.status !== "needs_code") await recordLoginOutcome(t, s("domain"), result.status === "logged_in" || result.status === "already_logged_in", "reason" in result ? result.reason : undefined).catch(() => {});
        const payload: Record<string, unknown> = { ...result };
        if (result.status === "needs_user") payload.live_view_url = browser.liveViewUrl;
        if (result.status === "needs_user" && /code/i.test(result.reason)) payload.hint = "If the site offers to text or email a code, click that, then request_code.";
        if (result.status === "no_credentials") payload.note = "Nothing saved for this site. If the user gave you their phone or email for it in chat, call login again with `username` set to it (most apps then text a code: request_code, then login with the code). Otherwise ask them in one line for the login, or to add it under Settings > Logins.";
        if (result.status === "logged_in" && args.username && !args.code) payload.note = "Signed in with the identifier from chat. Call save_login with this username and no password so next time it is known, and note it in facts.md.";
        if ("remembered" in result && result.remembered) payload.note = `${payload.note ? `${payload.note} ` : ""}The host will do this on its own next time: ${result.remembered}. Keep the ## Sign-in section of sites/${registrableDomain(s("domain"))}.md to what it does not know (a second code, a security question, a device prompt).`;
        return { text: JSON.stringify(payload) };
      }
      case "save_login": {
        // Phone-and-code accounts (Uber, Lyft, many apps) have no password: the username alone is saved.
        const id = await saveCredential(t, { domain: registrableDomain(s("domain")), username: s("username"), password: args.password ? s("password") : "", notes: args.notes ? s("notes") : undefined });
        await resolveFixesFor(t, "add_login", registrableDomain(s("domain"))).catch(() => {});
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
        const item = await addFollowUp(t.id, { due, what: s("what"), project: args.project ? s("project") : undefined, repeatMs: step ?? undefined, until: args.until ? new Date(s("until")) : undefined, channel: row.channel === "email" ? "email" : "chat" });
        return { text: JSON.stringify({ scheduled: true, id: item.id, due: item.due, repeat: repeat ?? null, note: "When it fires, your report from that session is delivered to the user immediately (chat and, if enabled, email)." }) };
      }
      case "checkpoint": {
        const cp = args as unknown as CheckpointInput;
        const verdict = autoApprove(t, cp);
        if (verdict.ok) return { text: `APPROVED (${verdict.reason}). Proceed exactly as described.` };
        // A second reading before money moves: a cheap model checks the amount, the payee and the card on
        // the page against the claim, the request and the facts. A discrepancy goes back to the working
        // model as a HOLD with the specifics, before the user is ever asked.
        if (row.browserbase_session_id && /^(purchase|payment)$/.test(String(cp.action_type))) {
          const page = await runBrowserTool(t, row, "browser_text", {}).catch(() => undefined);
          if (page?.text) {
            const audit = await auditMoneyMove(t, row, cp, page.text).catch(() => ({ ok: true as const }));
            if (!audit.ok) return { text: `${HOLD_PREFIX} ${audit.problem} Fix it on the page (the right amount, account or card), or if the page is right and the checkpoint was wrong, call checkpoint again with the correct figures and say what differs from the request in details.` };
          }
        }
        const live = row.browserbase_session_id ? await liveViewUrl(row.browserbase_session_id).catch(() => undefined) : undefined;
        // A dry-run preview: the page as it stands (cart, payment form, confirmation) rides with the approval card.
        if (row.browserbase_session_id && /^(purchase|payment|agreement|cancellation|dispute|account_change|signup)$/.test(String(cp.action_type))) {
          const shot = await runBrowserTool(t, row, "browser_screenshot", {}).catch(() => undefined);
          if (shot?.imageBase64) {
            const id = await addReceipt(t, { sessionId: row.id, title: `Preview: ${String(cp.summary ?? "").slice(0, 120)}`, details: String(cp.details ?? "").slice(0, 2000), image: Buffer.from(shot.imageBase64, "base64") }).catch(() => undefined);
            const owner = row.messages.find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === callId));
            if (id && owner) owner.previews = { ...(owner.previews ?? {}), [callId]: id };
          }
        }
        await notifyOwner(t, row, formatCheckpointEmail(cp, live), `Approval needed: ${cp.summary}`);
        return { text: "", pending: "checkpoint" };
      }
      case "request_code": {
        // A code went to the user's phone: one line to the user, then wait. Never counts as a question.
        const message = s("message") || "A verification code was just sent to your phone. Send it here and I'll continue.";
        await notifyOwner(t, row, message, "Code needed");
        if (row.channel === "email") await updateSession(row.id, { pending_deadline: new Date(Date.now() + 30 * 60_000) });
        return { text: "", pending: "ask_user" };
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
        // last_updated tells the model how stale a claim is: an item untouched for days is checked at the source before it is repeated.
        return { text: items.length ? JSON.stringify(items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, due_at: i.due_at, status: i.status, amount_usd: i.amount_cents != null ? Number(i.amount_cents) / 100 : undefined, details: i.details, last_updated: i.updated_at, source: i.source }))) + "\n(Each item is what was last known when it was last updated. A cancellation or change since then wins: for anything that matters, check the newest email or the order page before repeating it, and update the item.)" : "(nothing tracked)" };
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
      case "tell_user": {
        // A progress line the user sees at once, without ending the turn. The chat copy is UI-only;
        // the model remembers what it said through this call's arguments.
        const text = s("text").trim();
        if (!text) return { text: "Nothing to show; pass text." };
        if (row.channel !== "chat") return { text: "The user is on email, where only your final report is delivered. Noted; continue and put it in the report." };
        // A line that says nothing, or the same line again, is worse than silence: the user watched
        // "Still working…" arrive four times in eight minutes while nothing happened. Refused, with
        // the reason, so the step is spent on the task instead of on narrating it.
        const empty = emptyProgress(text);
        if (empty) return { text: empty };
        const said = progressLinesSince(row);
        if (said.some((prior) => sameProgress(prior, text))) {
          return { text: "You have already told the user that, in those words. Do not repeat yourself: either take the next step of the task now, or, if you are stuck, stop and say exactly what is blocking you." };
        }
        if (said.length >= Number(process.env.MAX_PROGRESS_LINES ?? 3)) {
          return { text: `You have sent ${said.length} progress lines on this task already. No more: finish it, or stop and tell the user what you need.` };
        }
        await appendAssistantMessage(row, text.slice(0, 500), true);
        return { text: "Shown to the user. Continue the task; your final reply is still needed when it is done." };
      }
      case "start_task": {
        const text = s("text").trim();
        if (!text) return { text: "Nothing to start; pass the request." };
        const { startTaskSession } = await import("./chat.js");
        const { kick } = await import("./runtime.js");
        const started = await startTaskSession(t, text, row.kind === "chat" ? row : undefined);
        await kick(started.id);
        return { text: `Started as its own task (${started.id}): "${text.slice(0, 80)}". It reports into the chat when done; do not wait for it.` };
      }
      case "make_pdf": {
        const body = s("markdown");
        if (!body.trim()) return { text: "Nothing to write; pass markdown." };
        const name = s("filename").replace(/[^\w .()-]+/g, " ").trim() || "document.pdf";
        const pdf = await makePdf(body, { title: args.title ? s("title") : undefined, footer: args.footer ? s("footer") : `${t.name ?? "Prepared"} · ${new Date().toISOString().slice(0, 10)}` });
        const saved = await saveFile(t, { sessionId: row.id, filename: name.endsWith(".pdf") ? name : `${name}.pdf`, mimeType: "application/pdf", content: pdf });
        const info = await pdfInfo(pdf).catch(() => ({ pages: 0 }));
        return { text: JSON.stringify({ made: true, file: saved.id, filename: saved.filename, pages: info.pages, kb: Math.round(saved.bytes / 1024), link: saved.url, note: "Give the link to the user in your reply, or attach it with email_file, or upload it with browser_upload." }) };
      }
      case "read_pdf_fields": {
        const f = await fileContent(t, s("file"));
        if (!f) return { text: `No stored file "${s("file")}". list_files shows what you have.` };
        const fields = await pdfFormFields(f.content).catch((e: unknown) => {
          throw new Error(`that PDF's form could not be read (${e instanceof Error ? e.message : String(e)})`);
        });
        if (!fields.length) return { text: `${f.filename} has no fillable fields. It is a flat PDF: fill it by hand is not possible, so either ask the site for the online form, or write the answers into a new document with make_pdf.` };
        return { text: JSON.stringify({ filename: f.filename, fields: fields.slice(0, 120) }) };
      }
      case "fill_pdf": {
        const f = await fileContent(t, s("file"));
        if (!f) return { text: `No stored file "${s("file")}". list_files shows what you have.` };
        const values = (args.values as Record<string, string | boolean>) ?? {};
        if (!Object.keys(values).length) return { text: "Nothing to fill; pass values as a map of field name to value." };
        const out = await fillPdfForm(f.content, values, args.flatten !== false);
        const name = (args.filename ? s("filename") : `filled-${f.filename}`).replace(/[^\w .()-]+/g, " ").trim();
        const saved = await saveFile(t, { sessionId: row.id, filename: name.endsWith(".pdf") ? name : `${name}.pdf`, mimeType: "application/pdf", content: out.pdf });
        return { text: JSON.stringify({ filled: out.filled, skipped: out.skipped, file: saved.id, filename: saved.filename, link: saved.url, note: out.skipped.length ? "Check the skipped fields: read_pdf_fields shows the exact names and options." : "Every value landed." }) };
      }
      case "list_files": {
        const files = await listFiles(t, Math.min(Number(args.limit ?? 10), 50));
        return { text: files.length ? JSON.stringify(files.map((f) => ({ file: f.id, filename: f.filename, kb: Math.round(f.bytes / 1024), made: f.created_at, link: f.url }))) : "(no files yet)" };
      }
      case "email_file": {
        const f = await fileContent(t, s("file"));
        if (!f) return { text: `No stored file "${s("file")}".` };
        const draft = { to: s("to") || t.email, subject: s("subject"), body: s("body"), mode: (args.mode as "send" | "send_to_owner") ?? (s("to") && s("to") !== t.email ? "send" : "send_to_owner") };
        if (draft.mode === "send") {
          const verdict = autoApprove(t, { action_type: "message", summary: `Email "${draft.subject}" with ${f.filename} attached`, details: draft.body });
          if (!verdict.ok) {
            await notifyOwner(t, row, formatEmailApproval({ ...draft, body: `${draft.body}\n\n[attached: ${f.filename}]` }), `Approve email to ${draft.to}`);
            return { text: "", pending: "send_email" };
          }
        }
        const to = draft.mode === "send_to_owner" ? t.email : draft.to;
        const sent = await sendAgentMail(t, { to, subject: draft.subject, body: draft.body, replyTag: row.reply_tag ?? undefined, attachments: [{ filename: f.filename, mimeType: f.mimeType, content: f.content }] });
        return { text: JSON.stringify({ sent: true, to, attached: f.filename, message_id: sent.messageId }) };
      }
      case "record_lesson": {
        await upsertLesson(t, { scope: args.scope ? s("scope") : "general", topic: s("topic"), lesson: s("lesson"), keywords: args.keywords ? s("keywords") : undefined, sessionId: row.id });
        return { text: "Kept. It will be in the prompt of later tasks that match." };
      }
      case "spending_report": {
        const { spendingReport, periodAsked } = await import("./ledger.js");
        // The inbox first: receipt emails cover the period with no sign-in and no page reading.
        if (t.googleRefreshToken && args.period) {
          const { spendingFromInbox, spendingQuestion } = await import("./receipts.js");
          const period = periodAsked(s("period"));
          const merchant = spendingQuestion(`spent on ${s("site") || ""} in ${s("period")}`)?.merchant;
          if (period) {
            const fromInbox = await spendingFromInbox(t, { period, merchant }).catch(() => undefined);
            if (fromInbox) return { text: `SPENDING REPORT for ${period.label} (${period.from.toISOString().slice(0, 10)} to ${period.to.toISOString().slice(0, 10)}) from the user's receipt emails, computed by the host. COVERS ${period.from.toISOString().slice(0, 10)}..${period.to.toISOString().slice(0, 10)}.\n${fromInbox}\n(Report these figures as they are; say they come from the receipts in their inbox.)` };
          }
        }
        return { text: await spendingReport(t, row, { period: args.period ? s("period") : undefined, site: args.site ? s("site") : undefined, next_label: args.next_label ? s("next_label") : undefined }) };
      }
      case "escalate_model": {
        const next = nextTier(tierOfModel(row.model ?? "", t));
        if (!next) return { text: "You are already on the most capable model. Keep going with what you have, or tell the user where you are stuck." };
        if (tooDearForValue(taskUserText(row.messages), next)) return { text: "Not escalating: the amount at stake in this request is small, and a dearer model would cost more than it is worth. Finish with what you have, or report in one line exactly what blocks and what the user can do." };
        return { text: `Escalating to the ${next} tier: ${s("reason")}`, escalateTo: modelFor(next, t) };
      }
      default:
        return { text: `Unknown tool ${name}` };
    }
  } catch (err) {
    return { text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    /* nothing to release */
  }
}

/** The user replied while a checkpoint, question, or outbound email was pending: feed the answer back. */
export async function resolvePending(t: Tenant, row: SessionRow, userText: string, approved: boolean | null): Promise<void> {
  if (!row.pending_event_id) return;
  let text: string;
  if (row.pending_kind === "checkpoint") {
    text = approved ? "APPROVED by the user. Proceed exactly as described in the checkpoint." : `DENIED. The user replied:\n\n${userText}\n\nTreat this as new instructions. Do not perform the checkpointed action as described. Answer briefly.`;
    // The decision goes in the approval history; three approvals of the same kind become an offer to stop asking.
    const logged = await logApproval(t, row, approved ? "approved" : "denied").catch(() => undefined);
    if (approved && logged) {
      const proposal = await approvalProposal(t, logged).catch(() => undefined);
      if (proposal) await appendHostNote(row, proposal).catch(() => {});
    }
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
    const code = codeIn(userText);
    // How many codes this task has already asked for: past two, the browser is being lost between
    // codes (navigation, reload, a second browser), not the code.
    const asked = row.messages.slice(taskStart(row.messages)).filter((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "request_code")).length;
    const warn = code && asked >= 2 ? ` This is code #${asked} in this task: enter it with login(domain, code) as the very next call, without reloading, navigating, opening a new tab or taking a screenshot first. Do not ask for another code unless the site says this one is invalid; if the site keeps asking, the session is being lost, so tell the user in one line rather than request again.` : "";
    text = `The user answered:\n\n${userText}${code ? `\n\n${codeHint(code)}${warn}` : ""}`;
  }
  await appendToolResult(row, row.pending_event_id, text);
}

export async function expirePending(row: SessionRow): Promise<void> {
  if (!row.pending_event_id) return;
  await appendToolResult(row, row.pending_event_id, "NO_REPLY: the user did not answer before the deadline. Proceed with the defaults you stated.");
}

/** Progress lines with no information in them: the ones a stuck model emits instead of working. */
const EMPTY_PROGRESS = /^(ok(ay)?[.!]?|go|sure|still (working|on it|going)|working( on it)?|one (moment|sec(ond)?)|just a (moment|sec(ond)?)|hang on|almost (there|done)|in progress|processing|continuing|on it|let me (check|see|look)|thinking)\b[\s.!…]*$/i;

/** The refusal text for a contentless progress line, or "" when the line actually says something. */
export function emptyProgress(text: string): string {
  if (!EMPTY_PROGRESS.test(text.trim())) return "";
  return "That line tells the user nothing, so it was not shown. A progress line names what you just did or what you are doing now (\"Signed in, pulling the bill up now\"). Take the next step of the task instead, and only call tell_user when you have something to report.";
}

/** Two progress lines that say the same thing, allowing for punctuation and an ellipsis. */
export function sameProgress(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** What this task has already shown the user through tell_user. */
function progressLinesSince(row: SessionRow): string[] {
  const out: string[] = [];
  for (let i = taskStart(row.messages); i < row.messages.length; i++) {
    const m = row.messages[i];
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) {
      if (c.function.name !== "tell_user") continue;
      try {
        const line = String((JSON.parse(c.function.arguments || "{}") as { text?: unknown }).text ?? "").trim();
        if (line) out.push(line);
      } catch {
        /* unparsable call; it showed nothing */
      }
    }
  }
  return out;
}
