import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { checkoutUrl } from "../../../lib/billing.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  return res.status(200).json({ url: await checkoutUrl(t) });
}
