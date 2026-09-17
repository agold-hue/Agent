import { one, q } from "./db.js";
import { decrypt, encrypt, totp } from "./crypto.js";
import type { Tenant } from "./tenant.js";

/**
 * Each customer's site logins, encrypted at rest. Only the host-side login flow ever decrypts a
 * password; the agent and the sandbox never see it.
 */
export interface SiteCredential {
  id: string;
  domain: string;
  username: string;
  password: string;
  /** Current authenticator code, if a TOTP seed is stored. */
  totp?: string;
  notes: string | null;
}

export function registrableDomain(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    /* keep as-is */
  }
  host = host.replace(/^www\./, "").split("/")[0];
  const parts = host.split(".");
  if (parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2])) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

interface Row {
  id: string;
  domain: string;
  username: string;
  secret_enc: string;
  totp_secret_enc: string | null;
  notes: string | null;
}

export async function findCredential(t: Tenant, domain: string, accountHint?: string): Promise<SiteCredential | undefined> {
  const d = registrableDomain(domain);
  let rows = await q<Row>("select * from credentials where user_id = $1 and (domain = $2 or domain like $3) order by updated_at desc", [t.id, d, `%.${d}`]);
  if (!rows.length) {
    // People type "coned", "Con Edison", "www.coned.com/login": match on the site's name, not its exact spelling.
    const base = d.split(".")[0].replace(/[^a-z0-9]/g, "");
    if (base.length >= 3) {
      const all = await q<Row>("select * from credentials where user_id = $1 order by updated_at desc", [t.id]);
      rows = all.filter((r) => {
        const rb = registrableDomain(r.domain).split(".")[0].replace(/[^a-z0-9]/g, "");
        return rb === base || rb.startsWith(base) || base.startsWith(rb);
      });
    }
  }
  if (!rows.length) return undefined;
  const pick = (accountHint && rows.find((r) => r.username.toLowerCase().includes(accountHint.toLowerCase()))) || rows[0];
  const seed = pick.totp_secret_enc ? decrypt(pick.totp_secret_enc, t.id) : undefined;
  return {
    id: pick.id,
    domain: pick.domain,
    username: pick.username,
    password: decrypt(pick.secret_enc, t.id),
    totp: seed ? totp(seed) : undefined,
    notes: pick.notes,
  };
}

export async function saveCredential(t: Tenant, c: { domain: string; username: string; password: string; totpSecret?: string; notes?: string }): Promise<string> {
  const d = registrableDomain(c.domain);
  const existing = await one<{ id: string }>("select id from credentials where user_id = $1 and domain = $2 and username = $3", [t.id, d, c.username]);
  if (existing) {
    await q("update credentials set secret_enc = $2, totp_secret_enc = coalesce($3, totp_secret_enc), notes = coalesce($4, notes), updated_at = now() where id = $1", [
      existing.id,
      encrypt(c.password, t.id),
      c.totpSecret ? encrypt(c.totpSecret, t.id) : null,
      c.notes ?? null,
    ]);
    return existing.id;
  }
  const r = await one<{ id: string }>(
    "insert into credentials (user_id, domain, username, secret_enc, totp_secret_enc, notes) values ($1,$2,$3,$4,$5,$6) returning id",
    [t.id, d, c.username, encrypt(c.password, t.id), c.totpSecret ? encrypt(c.totpSecret, t.id) : null, c.notes ?? null],
  );
  return r!.id;
}

/** For the settings page: never returns secrets. */
/** Login health: when the saved login last worked and last failed, so a broken login is visible before a task hits it. */
export async function recordLoginOutcome(t: Tenant, domain: string, ok: boolean, reason?: string): Promise<void> {
  const d = registrableDomain(domain);
  if (ok) await q("update credentials set last_ok_at = now(), last_fail_reason = null where user_id = $1 and (domain = $2 or domain like $3)", [t.id, d, `%.${d}`]);
  else await q("update credentials set last_fail_at = now(), last_fail_reason = $4 where user_id = $1 and (domain = $2 or domain like $3)", [t.id, d, `%.${d}`, (reason ?? "").slice(0, 300) || null]);
}

export async function listCredentials(t: Tenant): Promise<Array<{ id: string; domain: string; username: string; has_totp: boolean; notes: string | null; updated_at: Date; last_ok_at: Date | null; last_fail_at: Date | null; last_fail_reason: string | null }>> {
  return q(
    "select id, domain, username, (totp_secret_enc is not null) as has_totp, notes, updated_at, last_ok_at, last_fail_at, last_fail_reason from credentials where user_id = $1 order by domain",
    [t.id],
  );
}

export async function deleteCredential(t: Tenant, id: string): Promise<void> {
  await q("delete from credentials where user_id = $1 and id = $2", [t.id, id]);
}
