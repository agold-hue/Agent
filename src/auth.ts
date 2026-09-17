import { config } from "./config.js";
import { one, q } from "./db.js";
import { randomToken, sha256, signToken, sixDigitCode, verifyToken } from "./crypto.js";
import { sendServiceMail } from "./mail/smtp.js";
import { createOrgWithOwner, userByEmail, type User } from "./orgs.js";

/**
 * Email-code sign-in. The first sign-in for an unknown address creates a business with that person as
 * owner. DEV_LOGIN_CODE is a shared code for test deployments without SMTP.
 */
const COOKIE = "wm_session";
const TTL = 30 * 86_400;

export async function requestCode(email: string): Promise<void> {
  const e = email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("that does not look like an email address");
  if (config.devLoginCode()) return;
  const code = sixDigitCode();
  await q("delete from login_codes where email = $1 or expires_at < now()", [e]);
  await q("insert into login_codes (email, code_hash, expires_at) values ($1, $2, now() + interval '15 minutes')", [e, sha256(code)]);
  await sendServiceMail(e, "Your sign-in code", `Your sign-in code is **${code}**. It expires in 15 minutes.`);
}

export async function verifyCode(email: string, code: string, companyName?: string): Promise<{ user: User; cookie: string }> {
  const e = email.toLowerCase().trim();
  const c = code.trim();
  const dev = config.devLoginCode();
  let ok = false;
  if (dev && c === dev) ok = true;
  else {
    const row = await one<{ code_hash: string }>("select code_hash from login_codes where email = $1 and expires_at > now() order by created_at desc limit 1", [e]);
    ok = !!row && row.code_hash === sha256(c);
    if (ok) await q("delete from login_codes where email = $1", [e]);
  }
  if (!ok) throw new Error("wrong or expired code");
  let user = await userByEmail(e);
  if (!user) user = (await createOrgWithOwner(e, companyName)).user;
  await q("update users set last_login_at = now() where id = $1", [user.id]);
  const token = signToken({ uid: user.id, n: randomToken(6) }, TTL);
  return { user, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${config.appUrl().startsWith("https") ? "; Secure" : ""}` };
}

export const logoutCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function userIdFromCookie(cookieHeader: string | undefined): string | undefined {
  const m = (cookieHeader ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return undefined;
  const p = verifyToken(m[1]);
  return p && typeof p.uid === "string" ? p.uid : undefined;
}
