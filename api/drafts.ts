import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../lib/auth.js";
import { deleteDraft, listDrafts, sendDraft } from "../lib/google.js";

/**
 * The swipe-to-approve inbox. GET: the customer's Gmail drafts (the agent writes replies there in
 * their voice). POST { id, action: "send" | "delete" }: the customer sends or discards one.
 * The customer is the sender; the agent never gets this path.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (!t.googleRefreshToken) return res.status(409).json({ error: "Connect Google in Settings to see drafts." });
  try {
    if (req.method === "GET") return res.status(200).json({ items: await listDrafts(t) });
    if (req.method === "POST") {
      const body = (req.body ?? {}) as { id?: string; action?: string };
      if (!body.id) return res.status(400).json({ error: "id required" });
      if (body.action === "send") return res.status(200).json({ ok: true, ...(await sendDraft(t, body.id)) });
      if (body.action === "delete") {
        await deleteDraft(t, body.id);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "action must be send or delete" });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}
