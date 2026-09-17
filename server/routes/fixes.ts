import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { listFixes, resolveFix } from "../../lib/proactive.js";

/** GET -> the open fix cards (a missing login, a blocked site, Google not connected). POST { id } marks one done. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  if (req.method === "GET") return res.status(200).json({ fixes: await listFixes(t) });
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { id?: unknown };
    if (typeof body.id !== "string") return res.status(400).json({ error: "id required" });
    await resolveFix(t, body.id);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}
