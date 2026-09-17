import { Cron } from "croner";
import { marked } from "marked";
import { runBrowserAction, type BrowserSession } from "../browser/actions.js";
import { pageFor } from "../browser/pool.js";
import { config } from "../config.js";
import { q } from "../db.js";
import { fileText, getFile, listFiles, mimeFor, saveFile } from "../files.js";
import { id } from "../ids.js";
import type { ToolResultBlock } from "../llm.js";
type ToolResultContent = NonNullable<ToolResultBlock["content"]>;
import { getMail, searchMail } from "../mail/imap.js";
import { mailAccounts, sendAsCompany } from "../mail/smtp.js";
import { listMemories, saveMemory, searchMemory, type MemoryKind } from "../memory.js";
import { orgUsers, type Org } from "../orgs.js";
import { addEvent, createTask, updateTask, type Task } from "../tasks.js";
import { localStamp, parseWhen } from "../time.js";
import { webFetch, webSearch } from "../web.js";
import { autoApproved, isInternalEmail } from "./policy.js";

/**
 * What a tool call produces: text and maybe an image for the model, or a control signal that pauses
 * or ends the task. The loop turns these into tool_result blocks and status changes.
 */
export type ToolOutcome =
  | { kind: "result"; content: ToolResultContent; isError?: boolean; summary?: string }
  | { kind: "pause"; waiting: { kind: "question" | "approval"; question?: string; options?: string[]; action?: string; details?: string; amount_usd?: number; on_approve?: { type: "email_send"; payload: Record<string, unknown> } }; summary: string }
  | { kind: "sleep"; wakeAt: Date; reason: string }
  | { kind: "finish"; outcome: "done" | "blocked" | "failed"; result: string };

export interface ExecContext {
  org: Org;
  task: Task;
  browser: BrowserSession;
}

const str = (a: Record<string, unknown>, k: string) => (a[k] == null ? "" : String(a[k]).trim());
const num = (a: Record<string, unknown>, k: string): number | undefined => (a[k] === undefined || a[k] === null || a[k] === "" ? undefined : Number(a[k]));

export async function executeTool(ctx: ExecContext, name: string, a: Record<string, unknown>): Promise<ToolOutcome> {
  const { org, task } = ctx;
  if (name.startsWith("browser_")) {
    if (!task.browser_used) {
      task.browser_used = true;
      await updateTask(task.id, { browser_used: true });
    }
    const r = await runBrowserAction(ctx.browser, name, a);
    if (r.image) return { kind: "result", content: [{ type: "text", text: r.text }, { type: "image", source: { type: "base64", media_type: r.image.mediaType, data: r.image.base64 } }], summary: r.text.split("\n")[0] };
    return { kind: "result", content: r.text, summary: r.text.split("\n")[0].slice(0, 200) };
  }
  switch (name) {
    case "web_search":
      return { kind: "result", content: await webSearch(str(a, "query"), num(a, "count") ?? 8) };
    case "web_fetch":
      return { kind: "result", content: await webFetch(str(a, "url"), num(a, "max_chars") ?? 15_000) };

    case "email_send": {
      const to = str(a, "to");
      const accounts = await mailAccounts(org.id);
      const own = [...accounts.map((m) => m.address), ...(await orgUsers(org.id)).map((u) => u.email)];
      const internal = isInternalEmail(to + (str(a, "cc") ? `,${str(a, "cc")}` : ""), own);
      const payload = { to, cc: str(a, "cc") || undefined, subject: str(a, "subject"), markdown: str(a, "body"), attachments: Array.isArray(a.attachments) ? (a.attachments as string[]) : [], reply_to_message_id: str(a, "reply_to_message_id") || undefined };
      if (internal || autoApproved(org.settings, "email")) {
        const sent = await sendEmailPayload(org, task, payload);
        return { kind: "result", content: sent, summary: `Sent email to ${to}: ${payload.subject}` };
      }
      return {
        kind: "pause",
        waiting: { kind: "approval", action: `Send email to ${to}: "${payload.subject}"`, details: `${payload.cc ? `CC: ${payload.cc}\n` : ""}${payload.markdown}${payload.attachments.length ? `\n\nAttachments: ${payload.attachments.join(", ")}` : ""}`, on_approve: { type: "email_send", payload } },
        summary: `Waiting for approval to email ${to}`,
      };
    }
    case "email_search": {
      const rows = await searchMail(org.id, { query: str(a, "query"), from: str(a, "from") || undefined, days: num(a, "days"), limit: num(a, "limit") ?? 10 });
      if (!rows.length) return { kind: "result", content: "No matching emails in the connected mailbox." };
      return { kind: "result", content: rows.map((m) => `[${m.id}] ${m.direction === "out" ? "SENT" : "IN"} ${m.received_at.toISOString().slice(0, 16).replace("T", " ")} from: ${m.from_address} to: ${m.to_address}\n  subject: ${m.subject ?? "(none)"}\n  ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n") };
    }
    case "email_read": {
      const m = await getMail(org.id, str(a, "id"));
      if (!m) return { kind: "result", content: `No email with id ${str(a, "id")}`, isError: true };
      const att = m.attachments.length ? `\nAttachments: ${m.attachments.map((x) => `${x.name} (file id ${x.file_id}, ${x.mime})`).join(", ")}` : "";
      return { kind: "result", content: `From: ${m.from_address}\nTo: ${m.to_address}\nDate: ${m.received_at.toISOString()}\nSubject: ${m.subject ?? ""}\nMessage-Id: ${m.message_id ?? ""}${att}\n\n${(m.body ?? "").slice(0, 40_000)}` };
    }

    case "memory_search": {
      const kind = str(a, "kind") as MemoryKind | "";
      const rows = await searchMemory(org.id, str(a, "query"), kind || undefined);
      if (!rows.length) return { kind: "result", content: "Nothing in memory matches." };
      return { kind: "result", content: rows.map((m) => `### ${m.kind}: ${m.key} (updated ${m.updated_at.toISOString().slice(0, 10)})\n${m.content.slice(0, 3000)}`).join("\n\n") };
    }
    case "memory_save": {
      const kind = str(a, "kind") as MemoryKind;
      if (!["fact", "site", "contact", "procedure"].includes(kind)) return { kind: "result", content: "kind must be fact, site, contact or procedure", isError: true };
      const content = str(a, "content");
      if (/\b(password|passcode)\s*[:=]/i.test(content) || /\b\d{13,19}\b/.test(content.replace(/[\s-]/g, ""))) return { kind: "result", content: "Refused: the note looks like it contains a password or a card number. Save logins under Logins, and never store card numbers.", isError: true };
      await saveMemory(org.id, kind, str(a, "key"), content);
      return { kind: "result", content: `Saved ${kind} "${str(a, "key")}".`, summary: `Saved memory ${kind}: ${str(a, "key")}` };
    }

    case "file_create": {
      const name = str(a, "name") || "file.txt";
      const f = await saveFile(org.id, task.id, name, mimeFor(name), Buffer.from(str(a, "content"), "utf8"));
      return { kind: "result", content: `Created "${f.name}" (${f.bytes} bytes), file id ${f.id}.`, summary: `Created file ${f.name}` };
    }
    case "pdf_create": {
      const name = (str(a, "name") || "document").replace(/\.pdf$/i, "") + ".pdf";
      const pdf = await renderPdf(org, task.id, str(a, "markdown"), str(a, "title"));
      const f = await saveFile(org.id, task.id, name, "application/pdf", pdf);
      return { kind: "result", content: `Created PDF "${f.name}" (${f.bytes} bytes), file id ${f.id}.`, summary: `Created PDF ${f.name}` };
    }
    case "file_read": {
      const f = await getFile(org.id, str(a, "file_id"));
      if (!f) return { kind: "result", content: `No file with id ${str(a, "file_id")}`, isError: true };
      return { kind: "result", content: `File "${f.name}" (${f.mime}, ${f.bytes} bytes):\n\n${await fileText(f, num(a, "max_chars") ?? 40_000)}` };
    }
    case "file_list": {
      const rows = await listFiles(org.id, num(a, "limit") ?? 30);
      return { kind: "result", content: rows.length ? rows.map((f) => `${f.id}  ${f.name}  ${f.mime}  ${f.bytes} bytes  ${f.created_at.toISOString().slice(0, 16)}`).join("\n") : "No files yet." };
    }

    case "report_progress": {
      const text = str(a, "text");
      await updateTask(task.id, { last_progress: text.slice(0, 500) });
      await addEvent(task, "progress", text);
      return { kind: "result", content: "Noted for the user.", summary: text };
    }
    case "ask_user":
      return { kind: "pause", waiting: { kind: "question", question: str(a, "question"), options: Array.isArray(a.options) ? (a.options as string[]).map(String).slice(0, 6) : undefined }, summary: str(a, "question") };
    case "request_approval": {
      const kind = str(a, "kind") || "other";
      const amount = num(a, "amount_usd");
      if (autoApproved(org.settings, kind, amount)) {
        await addEvent(task, "approval", `Auto-approved (${kind}${amount !== undefined ? `, $${amount}` : ""}): ${str(a, "action")}`, { auto: true });
        return { kind: "result", content: `Approved automatically under the company's policy (${kind}${amount !== undefined ? `, $${amount}` : ""}). Proceed.`, summary: `Auto-approved: ${str(a, "action")}` };
      }
      return { kind: "pause", waiting: { kind: "approval", action: str(a, "action"), details: str(a, "details"), amount_usd: amount }, summary: `Approval needed: ${str(a, "action")}` };
    }
    case "wait_until": {
      const when = parseWhen(str(a, "when"));
      if (!when || when.getTime() < Date.now() - 60_000) return { kind: "result", content: `Could not read "${str(a, "when")}" as a time. Use an ISO date-time or a duration like 30m, 2h, 3d.`, isError: true };
      const max = 60 * 86_400_000;
      const wakeAt = new Date(Math.min(when.getTime(), Date.now() + max));
      return { kind: "sleep", wakeAt, reason: str(a, "reason") };
    }
    case "schedule_task": {
      const title = str(a, "title");
      const instruction = str(a, "instruction");
      if (str(a, "cron")) {
        let next: Date | null;
        try {
          next = new Cron(str(a, "cron"), { timezone: org.timezone }).nextRun();
        } catch {
          return { kind: "result", content: `Invalid cron expression "${str(a, "cron")}".`, isError: true };
        }
        await q("insert into schedules (id, org_id, title, instruction, cron, timezone, next_run_at) values ($1,$2,$3,$4,$5,$6,$7)", [id("sch"), org.id, title, instruction, str(a, "cron"), org.timezone, next]);
        return { kind: "result", content: `Scheduled "${title}" (${str(a, "cron")}); next run ${next ? localStamp(org.timezone, next) : "unknown"}.`, summary: `Scheduled recurring: ${title}` };
      }
      const when = parseWhen(str(a, "run_at") || "0m");
      if (!when) return { kind: "result", content: `Could not read run_at "${str(a, "run_at")}".`, isError: true };
      const t = await createTask({ orgId: org.id, title, instruction, source: "agent", parentId: task.id, createdBy: "agent", scheduledAt: when });
      return { kind: "result", content: `Task "${title}" (${t.id}) will run at ${localStamp(org.timezone, when)}.`, summary: `Scheduled task: ${title}` };
    }
    case "create_task": {
      const t = await createTask({ orgId: org.id, title: str(a, "title"), instruction: str(a, "instruction"), source: "agent", parentId: task.id, createdBy: "agent" });
      return { kind: "result", content: `Started task "${t.title}" (${t.id}). Its result will reach the user and be sent to you when it finishes.`, summary: `Started task: ${t.title}` };
    }
    case "finish_task": {
      const outcome = (["done", "blocked", "failed"].includes(str(a, "outcome")) ? str(a, "outcome") : "done") as "done" | "blocked" | "failed";
      return { kind: "finish", outcome, result: str(a, "result") };
    }
    default:
      return { kind: "result", content: `Unknown tool ${name}`, isError: true };
  }
}

/** Send a prepared email as the company and describe the outcome for the model. */
export async function sendEmailPayload(org: Org, task: Pick<Task, "id" | "org_id">, p: { to: string; cc?: string; subject: string; markdown: string; attachments: string[]; reply_to_message_id?: string }): Promise<string> {
  let inReplyTo: string | undefined;
  if (p.reply_to_message_id) {
    const m = await getMail(org.id, p.reply_to_message_id);
    inReplyTo = m?.message_id ?? p.reply_to_message_id;
  }
  const r = await sendAsCompany(org.id, org.name, { to: p.to, cc: p.cc, subject: p.subject, markdown: p.markdown, attachments: p.attachments, inReplyTo, taskId: task.id }, org.settings.signature);
  await addEvent(task, "tool", `Email sent to ${p.to}: ${p.subject}`, { from: r.from, message_id: r.messageId });
  return `Sent to ${p.to} from ${r.from} (message id ${r.messageId}). Subject: ${p.subject}`;
}

/** Markdown to a Letter-size PDF through Chromium. */
export async function renderPdf(org: Org, taskId: string, markdown: string, title?: string): Promise<Buffer> {
  const body = marked.parse(markdown, { async: false }) as string;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Document")}</title>
<style>body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12pt;line-height:1.45;color:#111;margin:0;padding:0}
h1{font-size:20pt;margin:0 0 12pt}h2{font-size:15pt;margin:18pt 0 6pt}h3{font-size:12.5pt;margin:14pt 0 4pt}
table{border-collapse:collapse;width:100%;margin:8pt 0}th,td{border:1px solid #bbb;padding:4pt 6pt;text-align:left;vertical-align:top}th{background:#f1f1f1}
code{font-family:Menlo,Consolas,monospace;font-size:10.5pt}pre{background:#f6f6f6;padding:8pt;overflow:auto}blockquote{border-left:3px solid #ccc;margin:8pt 0;padding-left:10pt;color:#444}
.meta{color:#666;font-size:10pt;margin-bottom:14pt}</style></head>
<body>${title ? `<h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(org.name)} · ${localStamp(org.timezone).slice(0, 15)}</div>` : ""}${body}</body></html>`;
  const { page } = await pageFor(org.id, `pdf-${taskId}`, { timezone: org.timezone });
  try {
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.8in", bottom: "0.8in", left: "0.9in", right: "0.9in" } });
  } finally {
    await page.close().catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
