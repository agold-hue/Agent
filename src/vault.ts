import { one, q } from "./db.js";
import { decrypt, encrypt, totp } from "./crypto.js";
import { id } from "./ids.js";
import { registrableDomain } from "./memory.js";

/** Site logins, encrypted at rest. Only the browser layer decrypts, to type a secret into a field the model pointed at. */
export interface Credential {
  id: string;
  domain: string;
  username: string;
  password: string;
  totp?: string;
  notes: string | null;
}

interface Row {
  id: string;
  domain: string;
  username: string;
  secret_enc: string;
  totp_enc: string | null;
  notes: string | null;
}

export async function findCredential(orgId: string, domainOrUrl: string, usernameHint?: string): Promise<Credential | undefined> {
  const d = registrableDomain(domainOrUrl);
  let rows = await q<Row>("select * from credentials where org_id = $1 and (domain = $2 or domain like $3) order by updated_at desc", [orgId, d, `%.${d}`]);
  if (!rows.length) {
    const base = d.split(".")[0];
    if (base.length >= 3) {
      const all = await q<Row>("select * from credentials where org_id = $1 order by updated_at desc", [orgId]);
      rows = all.filter((r) => {
        const rb = registrableDomain(r.domain).split(".")[0];
        return rb === base || rb.startsWith(base) || base.startsWith(rb);
      });
    }
  }
  if (!rows.length) return undefined;
  const pick = (usernameHint && rows.find((r) => r.username.toLowerCase().includes(usernameHint.toLowerCase()))) || rows[0];
  const seed = pick.totp_enc ? decrypt(pick.totp_enc, orgId) : undefined;
  return { id: pick.id, domain: pick.domain, username: pick.username, password: decrypt(pick.secret_enc, orgId), totp: seed ? totp(seed) : undefined, notes: pick.notes };
}

export async function saveCredential(orgId: string, c: { domain: string; username: string; password: string; totpSecret?: string; notes?: string }): Promise<string> {
  const d = registrableDomain(c.domain);
  const existing = await one<{ id: string }>("select id from credentials where org_id = $1 and domain = $2 and username = $3", [orgId, d, c.username]);
  if (existing) {
    await q("update credentials set secret_enc = $2, totp_enc = coalesce($3, totp_enc), notes = coalesce($4, notes), updated_at = now() where id = $1", [existing.id, encrypt(c.password, orgId), c.totpSecret ? encrypt(c.totpSecret, orgId) : null, c.notes ?? null]);
    return existing.id;
  }
  const cid = id("cred");
  await q("insert into credentials (id, org_id, domain, username, secret_enc, totp_enc, notes) values ($1,$2,$3,$4,$5,$6,$7)", [cid, orgId, d, c.username, encrypt(c.password, orgId), c.totpSecret ? encrypt(c.totpSecret, orgId) : null, c.notes ?? null]);
  return cid;
}

/** For the console: never returns secrets. */
export const listCredentials = (orgId: string) =>
  q<{ id: string; domain: string; username: string; has_totp: boolean; notes: string | null; updated_at: Date }>("select id, domain, username, (totp_enc is not null) as has_totp, notes, updated_at from credentials where org_id = $1 order by domain", [orgId]);

export const deleteCredential = (orgId: string, credId: string) => q("delete from credentials where org_id = $1 and id = $2", [orgId, credId]);
