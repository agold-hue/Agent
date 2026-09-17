import nodemailer from "nodemailer";
import { marked } from "marked";
import { config } from "../config.js";
import { decrypt } from "../crypto.js";
import { one, q } from "../db.js";
import { id } from "../ids.js";
import { getFile, readFileBytes } from "../files.js";

export interface MailAccount {
  id: string;
  org_id: string;
  label: string;
  address: string;
  from_name: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_user: string | null;
  imap_pass_enc: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  last_uid: number;
  last_polled_at: Date | null;
  last_error: string | null;
  active: boolean;
}

export const mailAccounts = (orgId: string) => q<MailAccount>("select * from mail_accounts where org_id = $1 order by created_at", [orgId]);
export const primaryAccount = async (orgId: string) => one<MailAccount>("select * from mail_accounts where org_id = $1 and active and smtp_host is not null order by created_at limit 1", [orgId]);

function platformTransport() {
  if (!config.mail.configured()) return undefined;
  return nodemailer.createTransport({ host: config.mail.smtpHost(), port: config.mail.smtpPort(), secure: config.mail.smtpPort() === 465, auth: config.mail.smtpUser() ? { user: config.mail.smtpUser(), pass: config.mail.smtpPass() } : undefined });
}

function accountTransport(acc: MailAccount) {
  if (!acc.smtp_host) return undefined;
  return nodemailer.createTransport({ host: acc.smtp_host, port: acc.smtp_port ?? 587, secure: (acc.smtp_port ?? 587) === 465, auth: acc.smtp_user ? { user: acc.smtp_user, pass: acc.smtp_pass_enc ? decrypt(acc.smtp_pass_enc, acc.org_id) : "" } : undefined });
}

export function markdownToHtml(md: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${marked.parse(md, { async: false }) as string}</div>`;
}

/** Service mail (login codes, notifications) from the platform mailbox. */
export async function sendServiceMail(to: string, subject: string, markdown: string): Promise<void> {
  const t = platformTransport();
  if (!t) throw new Error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM)");
  await t.sendMail({ from: config.mail.from(), to, subject, text: markdown, html: markdownToHtml(markdown) });
}

export interface OutboundMail {
  to: string;
  cc?: string;
  subject: string;
  markdown: string;
  inReplyTo?: string;
  references?: string;
  attachments?: string[];
  taskId?: string;
}

type Sender = (orgId: string, orgName: string, m: OutboundMail, signature?: string) => Promise<{ messageId: string; from: string }>;
let senderImpl: Sender | undefined;
/** Injected for tests: replaces the SMTP transport. */
export function setMailSender(fn: Sender | undefined): void {
  senderImpl = fn;
}

/** Send as the company: from its own mailbox when connected, else from the platform mailbox with the company's name. Logged to mail_messages. */
export async function sendAsCompany(orgId: string, orgName: string, m: OutboundMail, signature?: string): Promise<{ messageId: string; from: string }> {
  if (senderImpl) return senderImpl(orgId, orgName, m, signature);
  const acc = await primaryAccount(orgId);
  const transport = acc ? accountTransport(acc) : platformTransport();
  if (!transport) throw new Error("No mailbox to send from: connect one under Settings > Mailboxes, or set the platform SMTP_* variables.");
  const from = acc ? `"${(acc.from_name || orgName).replace(/"/g, "")}" <${acc.address}>` : `"${orgName.replace(/"/g, "")}" <${config.mail.from()}>`;
  const body = signature ? `${m.markdown.trimEnd()}\n\n${signature}` : m.markdown;
  const attachments = [];
  for (const fid of m.attachments ?? []) {
    const f = await getFile(orgId, fid);
    if (f) attachments.push({ filename: f.name, content: await readFileBytes(f), contentType: f.mime });
  }
  const info = await transport.sendMail({ from, to: m.to, cc: m.cc || undefined, subject: m.subject, text: body, html: markdownToHtml(body), inReplyTo: m.inReplyTo, references: m.references ?? m.inReplyTo, attachments });
  const messageId = String(info.messageId ?? "");
  await q("insert into mail_messages (id, org_id, account_id, direction, message_id, in_reply_to, from_address, to_address, subject, body, attachments, task_id) values ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11)", [
    id("mail"),
    orgId,
    acc?.id ?? null,
    messageId,
    m.inReplyTo ?? null,
    from,
    m.to + (m.cc ? `, ${m.cc}` : ""),
    m.subject,
    body,
    JSON.stringify((m.attachments ?? []).map((fid) => ({ file_id: fid }))),
    m.taskId ?? null,
  ]);
  return { messageId, from };
}
