import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logoutCookie } from "../../lib/auth.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Set-Cookie", logoutCookie());
  return res.status(200).json({ ok: true });
}
