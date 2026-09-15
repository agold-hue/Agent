import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyLoginCode } from "../../../lib/auth.js";

/** POST { email, code } -> sets the session cookie; creates the account on first login. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, code } = (req.body ?? {}) as { email?: string; code?: string };
  try {
    const { tenant, cookie } = await verifyLoginCode(String(email ?? ""), String(code ?? ""));
    res.setHeader("Set-Cookie", cookie);
    return res.status(200).json({ ok: true, subscription_status: tenant.subscriptionStatus, slug: tenant.slug });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "login failed" });
  }
}
