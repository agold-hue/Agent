import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requestLoginCode } from "../../../lib/auth.js";
import { env } from "../../../lib/env.js";

/** POST { email } -> emails a six-digit code. Same response whether or not the account exists. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const email = String((req.body as { email?: unknown })?.email ?? "");
  try {
    await requestLoginCode(email);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "could not send code" });
  }
  return res.status(200).json({ ok: true, dev: !!env.devLoginCode() });
}
