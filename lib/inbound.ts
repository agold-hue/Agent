import { one, q } from "./db.js";
import { extractCodes, type InboundMail } from "./mail.js";
import type { Tenant } from "./tenant.js";

/** Store an observation mail (forwarded bill, receipt, code) for triage and code lookup. */
export async function logInbound(t: Tenant, mail: InboundMail): Promise<string> {
  const r = await one<{ id: string }>(
    "insert into inbound_log (user_id, from_address, subject, body, attachment_names) values ($1,$2,$3,$4,$5) returning id",
    [t.id, mail.fromAddress, mail.subject.slice(0, 500), mail.text.slice(0, 20_000), mail.attachments.map((a) => a.filename)],
  );
  const id = r!.id;
  for (const a of mail.attachments.slice(0, 3)) {
    if (a.content.length > 5 * 1024 * 1024) continue;
    await q("insert into inbound_attachments (inbound_id, filename, mime_type, content) values ($1,$2,$3,$4)", [id, a.filename, a.mimeType, a.content]);
  }
  return id;
}

export interface UntriagedMail {
  id: string;
  from_address: string;
  subject: string | null;
  body: string | null;
  attachment_names: string[];
  received_at: Date;
}

export async function takeUntriaged(t: Tenant, max = 15): Promise<UntriagedMail[]> {
  return q<UntriagedMail>(
    "update inbound_log set triaged_at = now() where id in (select id from inbound_log where user_id = $1 and triaged_at is null order by received_at limit $2) returning id, from_address, subject, body, attachment_names, received_at",
    [t.id, max],
  );
}

export async function attachmentsFor(ids: string[]): Promise<Array<{ inbound_id: string; filename: string; mime_type: string; content: Buffer }>> {
  if (!ids.length) return [];
  return q("select inbound_id, filename, mime_type, content from inbound_attachments where inbound_id = any($1::uuid[])", [ids]);
}

export interface EmailCode {
  from: string;
  subject: string;
  codes: string[];
  links: string[];
  receivedAt: Date;
}

/** Recent verification codes and links in this tenant's forwarded mail, newest first. */
export async function recentCodes(t: Tenant, opts: { senderHint?: string; sinceMinutes?: number }): Promise<EmailCode[]> {
  const since = Math.max(1, Math.round(opts.sinceMinutes ?? 10));
  const rows = await q<{ from_address: string; subject: string | null; body: string | null; received_at: Date }>(
    "select from_address, subject, body, received_at from inbound_log where user_id = $1 and received_at > now() - ($2 || ' minutes')::interval order by received_at desc limit 20",
    [t.id, String(since)],
  );
  const hint = opts.senderHint?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  const out: EmailCode[] = [];
  for (const r of rows) {
    if (hint && !r.from_address.includes(hint.split(".")[0]) && !(r.subject ?? "").toLowerCase().includes(hint.split(".")[0])) continue;
    const { codes, links } = extractCodes(`${r.subject ?? ""}\n${r.body ?? ""}`);
    if (codes.length || links.length) out.push({ from: r.from_address, subject: r.subject ?? "", codes, links, receivedAt: r.received_at });
  }
  return out;
}
