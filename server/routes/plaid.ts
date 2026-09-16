import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { createLinkToken, exchangePublicToken, listItems, plaidConfigured, removeItem } from "../../lib/plaid.js";

/**
 * Bank connections (Plaid Link). GET -> { configured, items }. POST { action: "link_token" } -> a
 * token the page opens Plaid Link with; POST { action: "exchange", public_token, institution } after
 * Link succeeds; POST { action: "remove", id } to disconnect. The access token never reaches the page.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  if (req.method === "GET") return res.status(200).json({ configured: plaidConfigured(), items: await listItems(t) });
  if (req.method !== "POST") return res.status(405).end();
  if (!plaidConfigured()) return res.status(400).json({ error: "Plaid is not configured on this server" });
  const body = (req.body ?? {}) as { action?: unknown; public_token?: unknown; institution?: unknown; id?: unknown };
  try {
    if (body.action === "link_token") return res.status(200).json({ link_token: await createLinkToken(t) });
    if (body.action === "exchange" && typeof body.public_token === "string") return res.status(200).json({ item: await exchangePublicToken(t, body.public_token, typeof body.institution === "string" ? body.institution.slice(0, 120) : undefined) });
    if (body.action === "remove" && typeof body.id === "string") return res.status(200).json({ ok: await removeItem(t, body.id) });
    return res.status(400).json({ error: "action must be link_token, exchange or remove" });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
