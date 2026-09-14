import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ensureSchema, one, q } from "./db.js";
import { env } from "./env.js";
import { sha256, signToken, sixDigitCode, verifyToken } from "./crypto.js";
import { createTenant, hasAccess, tenantByEmail, tenantById, type Tenant } from "./tenant.js";
import { sendServiceMail } from "./mail.js";

const COOKIE = "pwa_session";
const TTL = 30 * 24 * 3600;

/** Step 1: email a six-digit code. Creates the account on first login. */
export async function requestLoginCode(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid email");
  await ensureSchema();
  const dev = env.devLoginCode();
  if (!dev && !env.mail.configured()) throw new Error("login mail is not configured on this server (set POSTMARK_* or DEV_LOGIN_CODE)");
  const code = dev || sixDigitCode();
  await q("delete from login_codes where email = $1 or expires_at < now()", [e]);
  await q("insert into login_codes (email, code_hash, expires_at) values ($1, $2, now() + interval '10 minutes')", [e, sha256(`${e}:${code}`)]);
  if (dev) return;
  await sendServiceMail({
    to: e,
    subject: `Your login code: ${code}`,
    body: `Your code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
  });
}

/** Step 2: verify the code, create the account if new, return a cookie value. */
export async function verifyLoginCode(email: string, code: string): Promise<{ tenant: Tenant; cookie: string }> {
  const e = email.trim().toLowerCase();
  const row = await one<{ code_hash: string }>("select code_hash from login_codes where email = $1 and expires_at > now() order by created_at desc limit 1", [e]);
  if (!row || row.code_hash !== sha256(`${e}:${code.trim()}`)) throw new Error("wrong or expired code");
  await q("delete from login_codes where email = $1", [e]);
  const tenant = (await tenantByEmail(e)) ?? (await createTenant(e));
  await q("update users set last_login_at = now() where id = $1", [tenant.id]);
  const token = signToken({ uid: tenant.id }, TTL);
  return { tenant, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}` };
}

export function logoutCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(req: VercelRequest): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

/** The logged-in tenant, or undefined. Also accepts a Bearer token (same value as the cookie) for API clients. */
export async function currentTenant(req: VercelRequest): Promise<Tenant | undefined> {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : cookieValue(req);
  if (!token) return undefined;
  const payload = verifyToken(token);
  if (!payload || typeof payload.uid !== "string") return undefined;
  return tenantById(payload.uid);
}

/** Guard for app routes: 401 when not logged in, 402 when the subscription lapsed. */
export async function requireTenant(req: VercelRequest, res: VercelResponse, opts: { paid?: boolean } = { paid: true }): Promise<Tenant | undefined> {
  const t = await currentTenant(req);
  if (!t) {
    res.status(401).json({ error: "not logged in" });
    return undefined;
  }
  if (opts.paid !== false && !hasAccess(t)) {
    res.status(402).json({ error: "subscription required", status: t.subscriptionStatus });
    return undefined;
  }
  return t;
}
