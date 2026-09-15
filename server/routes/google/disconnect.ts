import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { setGoogleToken } from "../../../lib/tenant.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  await setGoogleToken(t, null);
  return res.status(200).json({ ok: true });
}
