import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decrypt } from "../crypto.js";
import { one, q } from "../db.js";
import { saveFile, mimeFor } from "../files.js";
import { id } from "../ids.js";
import { log, errText } from "../log.js";
import type { MailAccount } from "./smtp.js";

/**
 * Pull new mail from a connected mailbox over IMAP. We remember the last UID per account and fetch
 * everything above it, so nothing is missed and nothing is read twice. Attachments become files.
 */
export interface StoredMail {
  id: string;
  org_id: string;
  account_id: string | null;
  direction: "in" | "out";
  uid: number | null;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body: string | null;
  attachments: Array<{ file_id: string; name: string; mime: string; bytes: number }>;
  received_at: Date;
  triage: Record<string, unknown> | null;
  task_id: string | null;
}

export async function pollAccount(acc: MailAccount): Promise<StoredMail[]> {
  if (!acc.imap_host || !acc.imap_user) return [];
  const client = new ImapFlow({
    host: acc.imap_host,
    port: acc.imap_port ?? 993,
    secure: (acc.imap_port ?? 993) === 993,
    auth: { user: acc.imap_user, pass: acc.imap_pass_enc ? decrypt(acc.imap_pass_enc, acc.org_id) : "" },
    logger: false,
    socketTimeout: 60_000,
  });
  const stored: StoredMail[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      const uidNext = mailbox && typeof mailbox === "object" && "uidNext" in mailbox ? Number(mailbox.uidNext) : 0;
      let from = acc.last_uid + 1;
      // First poll on a mailbox: start from the newest 20 messages rather than the whole history.
      if (acc.last_uid === 0 && uidNext > 21) from = uidNext - 20;
      if (uidNext && from >= uidNext) {
        await q("update mail_accounts set last_polled_at = now(), last_error = null where id = $1", [acc.id]);
        return [];
      }
      let maxUid = acc.last_uid;
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true, envelope: true })) {
        if (msg.uid <= acc.last_uid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        try {
          const parsed = await simpleParser(msg.source!);
          const attachments: StoredMail["attachments"] = [];
          for (const att of parsed.attachments ?? []) {
            if (!att.content?.length || att.content.length > 25 * 1024 * 1024) continue;
            const f = await saveFile(acc.org_id, null, att.filename || "attachment", att.contentType || mimeFor(att.filename || ""), att.content);
            attachments.push({ file_id: f.id, name: f.name, mime: f.mime, bytes: f.bytes });
          }
          const fromAddr = parsed.from?.text ?? "";
          const toAddr = Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : (parsed.to?.text ?? acc.address);
          const body = (parsed.text ?? "").trim() || htmlToText(parsed.html || "");
          const row = await one<StoredMail>(
            `insert into mail_messages (id, org_id, account_id, direction, uid, message_id, in_reply_to, from_address, to_address, subject, body, attachments, received_at)
             values ($1,$2,$3,'in',$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
            [id("mail"), acc.org_id, acc.id, msg.uid, parsed.messageId ?? null, parsed.inReplyTo ?? null, fromAddr, toAddr, parsed.subject ?? null, body.slice(0, 100_000), JSON.stringify(attachments), parsed.date ?? new Date()],
          );
          if (row) stored.push(row);
        } catch (e) {
          log.error("imap", "could not parse a message", e, { account: acc.id, uid: msg.uid });
        }
      }
      await q("update mail_accounts set last_uid = $2, last_polled_at = now(), last_error = null where id = $1", [acc.id, maxUid]);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    await q("update mail_accounts set last_polled_at = now(), last_error = $2 where id = $1", [acc.id, errText(e).slice(0, 500)]);
    log.error("imap", "poll failed", e, { account: acc.id });
    await client.logout().catch(() => {});
  }
  return stored;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const getMail = (orgId: string, mailId: string) => one<StoredMail>("select * from mail_messages where org_id = $1 and id = $2", [orgId, mailId]);

export async function searchMail(orgId: string, opts: { query?: string; from?: string; days?: number; limit?: number }): Promise<StoredMail[]> {
  const params: unknown[] = [orgId];
  let where = "org_id = $1";
  for (const w of (opts.query ?? "").split(/\s+/).filter((w) => w.length > 1).slice(0, 6)) {
    params.push(`%${w}%`);
    where += ` and (subject ilike $${params.length} or body ilike $${params.length} or from_address ilike $${params.length})`;
  }
  if (opts.from) {
    params.push(`%${opts.from}%`);
    where += ` and from_address ilike $${params.length}`;
  }
  if (opts.days) {
    params.push(opts.days);
    where += ` and received_at > now() - ($${params.length}::int || ' days')::interval`;
  }
  params.push(opts.limit ?? 10);
  return q<StoredMail>(`select * from mail_messages where ${where} order by received_at desc limit $${params.length}`, params);
}
