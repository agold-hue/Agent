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

export async function listCredentials(t: Tenant): Promise<Array<{ id: string; domain: string; username: string; has_totp: boolean; notes: string | null; updated_at: Date; last_ok_at: Date | null; last_fail_at: Date | null; last_fail_reason: string | null; login_profile: LoginProfile | null }>> {
  return q(
    "select id, domain, username, (totp_secret_enc is not null) as has_totp, notes, updated_at, last_ok_at, last_fail_at, last_fail_reason, login_profile from credentials where user_id = $1 order by domain",
    [t.id],
  );
}

export async function deleteCredential(t: Tenant, id: string): Promise<void> {
  await q("delete from credentials where user_id = $1 and id = $2", [t.id, id]);
}

// ------------------------------------------------------------------ what the host learned about the sign-in

/**
 * What the host learned the last times it signed in to a site, kept on the vault row: the page that
 * showed the form, how the verification code arrives, whether the form sits in a frame, the record.
 * The next login goes straight to that page and, when the code is texted, asks the user for it at
 * once instead of waiting a minute for an email that never comes.
 */
export interface LoginProfile {
  /** The page that showed the sign-in form last time. */
  login_url?: string;
  /** How the code reached the user last time: text (the user relays it), email (read from forwarded mail), totp (the vault's seed), none (no code asked). */
  code?: "text" | "email" | "totp" | "none";
  /** The sign-in form sits inside a frame (some banks embed it). */
  framed?: boolean;
  /** Sign-ins that ended well, out of all the host attempted. */
  ok?: number;
  n?: number;
  /** Seconds the last good single-call sign-in took, from the first page to signed in. */
  seconds?: number;
  /** When it last worked (ISO). */
  at?: string;
  /** When a bot wall last stood in the way (ISO). */
  wall_at?: string;
}

export interface LoginObservation {
  login_url?: string;
  code?: LoginProfile["code"];
  framed?: boolean;
  /** The attempt's outcome; absent when the attempt did not reach a verdict (a code is pending). */
  ok?: boolean;
  seconds?: number;
  wall?: boolean;
}

/** The profile after one more attempt: the last known values and the running record. */
export function mergeLoginProfile(prev: LoginProfile | undefined, seen: LoginObservation, now = new Date()): LoginProfile {
  const p: LoginProfile = { ...(prev ?? {}) };
  if (seen.login_url) p.login_url = seen.login_url.slice(0, 500);
  if (seen.code) p.code = seen.code;
  if (seen.framed !== undefined) p.framed = seen.framed;
  if (seen.ok !== undefined) {
    p.n = (p.n ?? 0) + 1;
    if (seen.ok) {
      p.ok = (p.ok ?? 0) + 1;
      p.at = now.toISOString();
      if (seen.seconds !== undefined) p.seconds = Math.round(seen.seconds);
    }
  }
  if (seen.wall) p.wall_at = now.toISOString();
  return p;
}

export async function loginProfile(credentialId: string): Promise<LoginProfile | undefined> {
  const row = await one<{ login_profile: LoginProfile | null }>("select login_profile from credentials where id = $1", [credentialId]);
  return row?.login_profile ?? undefined;
}

/** Fold one attempt into the vault row's profile and return the result. */
export async function rememberLogin(credentialId: string, seen: LoginObservation): Promise<LoginProfile> {
  const next = mergeLoginProfile(await loginProfile(credentialId), seen);
  await q("update credentials set login_profile = $2::jsonb where id = $1", [credentialId, JSON.stringify(next)]);
  return next;
}

/** One line for the model and the site note: what the next sign-in will do on its own. */
export function describeLoginProfile(p: LoginProfile | undefined): string | undefined {
  if (!p || (!p.login_url && !p.code)) return undefined;
  const parts: string[] = [];
  if (p.login_url) parts.push(`the sign-in page is ${p.login_url}${p.framed ? " (the form is inside a frame)" : ""}`);
  if (p.code === "text") parts.push("the code is texted to the user and asked for at once");
  else if (p.code === "email") parts.push("the code is emailed and read from the forwarded mail");
  else if (p.code === "totp") parts.push("the authenticator code comes from the vault");
  else if (p.code === "none") parts.push("no code was asked last time");
  if (p.n) parts.push(`${p.ok ?? 0} of ${p.n} sign-ins worked${p.seconds ? `, the last in ${p.seconds}s` : ""}`);
  return parts.join("; ");
}
