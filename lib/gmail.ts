import { google, type gmail_v1 } from "googleapis";
import { env } from "./env.js";

let api: gmail_v1.Gmail | undefined;
function gmail(): gmail_v1.Gmail {
  if (!api) {
    const auth = new google.auth.OAuth2(env.gmail.clientId(), env.gmail.clientSecret());
    auth.setCredentials({ refresh_token: env.gmail.refreshToken() });
    api = google.gmail({ version: "v1", auth });
  }
  return api;
}

export interface AttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface InboundMail {
  id: string;
  threadId: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  messageIdHeader: string;
  text: string;
  date: Date;
  attachments: AttachmentRef[];
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decode(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function addressOf(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined): { text: string; html: string; attachments: AttachmentRef[] } {
  const out = { text: "", html: "", attachments: [] as AttachmentRef[] };
  if (!part) return out;
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.filename && p.body?.attachmentId) {
      out.attachments.push({
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        attachmentId: p.body.attachmentId,
        size: p.body.size ?? 0,
      });
    } else if (p.mimeType === "text/plain" && p.body?.data) out.text += decode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) out.html += decode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return out;
}

/** Strip quoted history from a reply so only the new text reaches the agent. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line.trim()) && out.length > 0) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

async function fetchMessage(id: string): Promise<InboundMail> {
  const { data } = await gmail().users.messages.get({ userId: "me", id, format: "full" });
  const { text, html, attachments } = walkParts(data.payload);
  const from = header(data, "From");
  return {
    id: data.id!,
    threadId: data.threadId!,
    from,
    fromAddress: addressOf(from),
    to: header(data, "To"),
    subject: header(data, "Subject"),
    messageIdHeader: header(data, "Message-ID"),
    text: text.trim() || htmlToText(html),
    date: new Date(Number(data.internalDate ?? Date.now())),
    attachments,
  };
}

async function search(q: string, max = 20): Promise<InboundMail[]> {
  const { data } = await gmail().users.messages.list({ userId: "me", q, maxResults: max });
  const ids = (data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const mails = await Promise.all(ids.map(fetchMessage));
  return mails.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Unread mail from the owner, oldest first. */
export async function listUnreadFromOwner(): Promise<InboundMail[]> {
  return search(`is:unread from:${env.gmail.ownerEmail()} newer_than:2d -in:spam -in:trash`);
}

/**
 * Unread mail from anyone else, but only in threads the agent itself started (replies from a
 * broker, a realtor, a vendor). Newsletters and cold mail never reach the agent.
 */
export async function listUnreadCorrespondence(): Promise<InboundMail[]> {
  const candidates = await search(`is:unread -from:${env.gmail.ownerEmail()} -from:${env.gmail.agentEmail()} newer_than:7d -in:spam -in:trash`);
  const out: InboundMail[] = [];
  for (const mail of candidates) {
    if (await threadStartedByAgent(mail.threadId)) out.push(mail);
  }
  return out;
}

async function threadStartedByAgent(threadId: string): Promise<boolean> {
  const { data } = await gmail().users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From"] });
  const first = data.messages?.[0];
  return !!first && addressOf(header(first, "From")) === env.gmail.agentEmail().toLowerCase();
}

export async function downloadAttachment(messageId: string, ref: AttachmentRef): Promise<Buffer> {
  const { data } = await gmail().users.messages.attachments.get({ userId: "me", messageId, id: ref.attachmentId });
  return Buffer.from((data.data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export async function markRead(id: string): Promise<void> {
  await gmail().users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } });
}

function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendMailOptions {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  attachments?: OutboundAttachment[];
  /** Display name for the From header. Defaults to "<owner name> (assistant)". */
  fromName?: string;
}

/** Send from the agent's mailbox. Returns the Gmail thread id and message id. */
export async function sendMail(opts: SendMailOptions): Promise<{ threadId: string; messageId: string }> {
  const ownerName = process.env.OWNER_NAME || "";
  const fromName = opts.fromName ?? (ownerName ? `${ownerName} (assistant)` : "Assistant");
  const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${encodeHeader(fromName)} <${env.gmail.agentEmail()}>`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);

  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(opts.body, "utf8").toString("base64")].join("\r\n");
  let raw: string;
  if (opts.attachments?.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [textPart];
    for (const a of opts.attachments) {
      parts.push(
        [
          `Content-Type: ${a.mimeType}; name="${a.filename}"`,
          `Content-Disposition: attachment; filename="${a.filename}"`,
          "Content-Transfer-Encoding: base64",
          "",
          a.content.toString("base64").replace(/(.{76})/g, "$1\r\n"),
        ].join("\r\n"),
      );
    }
    raw = headers.join("\r\n") + "\r\n\r\n" + parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--`;
  } else {
    raw = headers.join("\r\n") + "\r\n" + textPart;
  }
  const { data } = await gmail().users.messages.send({
    userId: "me",
    requestBody: { ...(opts.threadId ? { threadId: opts.threadId } : {}), raw: Buffer.from(raw).toString("base64url") },
  });
  return { threadId: data.threadId!, messageId: data.id! };
}

/** Reply to the owner inside one of their threads. */
export async function replyInThread(opts: { threadId: string; subject: string; inReplyTo?: string; body: string }): Promise<void> {
  const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  await sendMail({ to: env.gmail.ownerEmail(), subject, body: opts.body, threadId: opts.threadId, inReplyTo: opts.inReplyTo });
}

export interface EmailCode {
  from: string;
  subject: string;
  codes: string[];
  links: string[];
  receivedAt: Date;
}

/**
 * Recent verification codes / links, newest first. Used both by the login flow
 * (email one-time codes) and by the agent's get_email_code tool.
 */
export async function findRecentCodes(opts: { senderHint?: string; sinceMinutes?: number }): Promise<EmailCode[]> {
  const since = Math.max(1, Math.round(opts.sinceMinutes ?? 10));
  const after = Math.floor((Date.now() - since * 60_000) / 1000);
  let q = `after:${after} -in:spam -in:trash -from:${env.gmail.ownerEmail()}`;
  if (opts.senderHint) {
    const hint = opts.senderHint.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    q += ` (from:${hint} OR subject:${hint.split(".")[0]})`;
  }
  const mails = await search(q, 10);
  const out: EmailCode[] = [];
  for (const m of mails) {
    const text = `${m.subject}\n${m.text}`;
    const codes = Array.from(new Set(text.match(/\b\d{4,8}\b/g) ?? [])).filter((c) => !/^(19|20)\d{2}$/.test(c));
    const links = Array.from(
      new Set((text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).filter((u) => /verif|confirm|activate|token|code|magic|login|signin/i.test(u))),
    );
    if (codes.length || links.length) out.push({ from: m.from, subject: m.subject, codes, links, receivedAt: m.date });
  }
  return out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
}
