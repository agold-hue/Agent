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

export interface InboundMail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  messageIdHeader: string;
  text: string;
  date: Date;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decode(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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

function bodyText(part: gmail_v1.Schema$MessagePart | undefined): { text: string; html: string } {
  if (!part) return { text: "", html: "" };
  let text = "";
  let html = "";
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.mimeType === "text/plain" && p.body?.data) text += decode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) html += decode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return { text, html };
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
  const { text, html } = bodyText(data.payload);
  return {
    id: data.id!,
    threadId: data.threadId!,
    from: header(data, "From"),
    subject: header(data, "Subject"),
    messageIdHeader: header(data, "Message-ID"),
    text: text.trim() || htmlToText(html),
    date: new Date(Number(data.internalDate ?? Date.now())),
  };
}

/** Unread mail from the owner, oldest first. */
export async function listUnreadFromOwner(): Promise<InboundMail[]> {
  const q = `is:unread from:${env.gmail.ownerEmail()} newer_than:2d -in:spam -in:trash`;
  const { data } = await gmail().users.messages.list({ userId: "me", q, maxResults: 20 });
  const ids = (data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const mails = await Promise.all(ids.map(fetchMessage));
  return mails.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function markRead(id: string): Promise<void> {
  await gmail().users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } });
}

function encodeSubject(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export async function replyInThread(opts: {
  threadId: string;
  subject: string;
  inReplyTo?: string;
  body: string;
}): Promise<void> {
  const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  const headers = [
    `From: ${env.gmail.agentEmail()}`,
    `To: ${env.gmail.ownerEmail()}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  const raw = headers.join("\r\n") + "\r\n\r\n" + Buffer.from(opts.body, "utf8").toString("base64");
  await gmail().users.messages.send({
    userId: "me",
    requestBody: {
      threadId: opts.threadId,
      raw: Buffer.from(raw).toString("base64url"),
    },
  });
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
  const { data } = await gmail().users.messages.list({ userId: "me", q, maxResults: 10 });
  const ids = (data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const mails = await Promise.all(ids.map(fetchMessage));
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
