import { env } from "./env.js";
import { agentAddress, type Tenant } from "./tenant.js";

/**
 * Transactional mail through Postmark. One server, one domain (MAIL_DOMAIN) with inbound enabled,
 * so every customer has <slug>@MAIL_DOMAIN and every session can be replied to at
 * <slug>+<tag>@MAIL_DOMAIN. Swap this file to change providers; nothing else knows Postmark.
 */

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendMailOptions {
  from: string;
  fromName?: string;
  replyTo?: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: OutboundAttachment[];
}

export async function sendMail(opts: SendMailOptions): Promise<{ messageId: string }> {
  const headers: Array<{ Name: string; Value: string }> = [];
  if (opts.inReplyTo) headers.push({ Name: "In-Reply-To", Value: opts.inReplyTo }, { Name: "References", Value: opts.inReplyTo });
  const res = await fetch(`${process.env.POSTMARK_API_URL || "https://api.postmarkapp.com"}/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": env.mail.postmarkToken() },
    body: JSON.stringify({
      From: opts.fromName ? `"${opts.fromName.replace(/"/g, "")}" <${opts.from}>` : opts.from,
      ReplyTo: opts.replyTo,
      To: opts.to,
      Cc: opts.cc,
      Subject: opts.subject,
      TextBody: opts.body,
      MessageStream: "outbound",
      Headers: headers,
      Attachments: opts.attachments?.map((a) => ({ Name: a.filename, Content: a.content.toString("base64"), ContentType: a.mimeType })),
    }),
  });
  if (!res.ok) throw new Error(`Postmark send failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { MessageID: string };
  return { messageId: data.MessageID };
}

/** Service mail (login codes, billing notices) from MAIL_FROM. */
export async function sendServiceMail(opts: { to: string; subject: string; body: string }): Promise<void> {
  await sendMail({ from: env.mail.from(), fromName: "Personal Web Agent", ...opts });
}

/** Mail from a customer's agent, signed as their assistant, with replies routed to a session. */
export async function sendAgentMail(
  t: Tenant,
  opts: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; attachments?: OutboundAttachment[]; replyTag?: string },
): Promise<{ messageId: string }> {
  const ownerName = t.settings.owner_name || t.name || "";
  return sendMail({
    from: agentAddress(t),
    fromName: ownerName ? `${ownerName} (assistant)` : "Assistant",
    replyTo: opts.replyTag ? agentAddress(t, opts.replyTag) : agentAddress(t),
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    body: opts.body,
    inReplyTo: opts.inReplyTo,
    attachments: opts.attachments,
  });
}

// ---------------------------------------------------------------- Inbound

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface InboundMail {
  messageId: string;
  fromAddress: string;
  fromName: string;
  /** Local part of the recipient at MAIL_DOMAIN, e.g. "ari" for ari+s_abc@... */
  slug: string;
  /** The plus-tag, e.g. "s_abc", or "" */
  tag: string;
  subject: string;
  text: string;
  inReplyTo: string;
  attachments: InboundAttachment[];
}

/** Parse Postmark's inbound webhook JSON. */
export function parseInbound(payload: Record<string, unknown>): InboundMail | null {
  const p = payload as {
    MessageID?: string;
    FromFull?: { Email?: string; Name?: string };
    From?: string;
    ToFull?: Array<{ Email?: string; MailboxHash?: string }>;
    OriginalRecipient?: string;
    Subject?: string;
    TextBody?: string;
    HtmlBody?: string;
    StrippedTextReply?: string;
    Headers?: Array<{ Name: string; Value: string }>;
    Attachments?: Array<{ Name: string; Content: string; ContentType: string }>;
  };
  const domain = env.mail.domain().toLowerCase();
  const recipient = (p.ToFull ?? []).find((t) => (t.Email ?? "").toLowerCase().endsWith(`@${domain}`)) ?? { Email: p.OriginalRecipient, MailboxHash: "" };
  const emailAddr = (recipient.Email ?? "").toLowerCase();
  if (!emailAddr.endsWith(`@${domain}`)) return null;
  const local = emailAddr.split("@")[0];
  const [slug, tagFromLocal] = local.split("+");
  const tag = recipient.MailboxHash || tagFromLocal || "";
  const fromAddress = (p.FromFull?.Email ?? p.From ?? "").toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
  const text = (p.StrippedTextReply?.trim() || p.TextBody?.trim() || htmlToText(p.HtmlBody ?? "")).trim();
  const inReplyTo = p.Headers?.find((h) => h.Name.toLowerCase() === "in-reply-to")?.Value ?? "";
  return {
    messageId: p.MessageID ?? "",
    fromAddress,
    fromName: p.FromFull?.Name ?? "",
    slug,
    tag,
    subject: p.Subject ?? "",
    text,
    inReplyTo,
    attachments: (p.Attachments ?? []).map((a) => ({ filename: a.Name, mimeType: a.ContentType, content: Buffer.from(a.Content, "base64") })),
  };
}

export function htmlToText(html: string): string {
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

/** Strip quoted history from a reply so only the new text reaches the agent. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line.trim()) && out.length > 0) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Verification codes and links in recent inbound mail for this tenant are found via the DB-logged inbound copy (see inbound route). */
export function extractCodes(text: string): { codes: string[]; links: string[] } {
  const codes = Array.from(new Set(text.match(/\b\d{4,8}\b/g) ?? [])).filter((c) => !/^(19|20)\d{2}$/.test(c));
  const links = Array.from(new Set((text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).filter((u) => /verif|confirm|activate|token|code|magic|login|signin/i.test(u))));
  return { codes, links };
}
