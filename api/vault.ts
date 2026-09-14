import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../lib/auth.js";
import { deleteCredential, listCredentials, saveCredential } from "../lib/credentials.js";

/**
 * The customer's site logins. GET lists (no secrets). POST { domain, username, password, totp_secret?, notes? }
 * adds or updates. DELETE ?id= removes. Secrets are encrypted at rest and only ever used by the
 * host-side login flow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (req.method === "POST") {
    const b = (req.body ?? {}) as { domain?: string; username?: string; password?: string; totp_secret?: string; notes?: string };
    if (!b.domain || !b.username || !b.password) return res.status(400).json({ error: "domain, username and password are required" });
    const id = await saveCredential(t, { domain: b.domain, username: b.username, password: b.password, totpSecret: b.totp_secret || undefined, notes: b.notes });
    return res.status(200).json({ id });
  }
  if (req.method === "DELETE") {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) return res.status(400).json({ error: "id required" });
    await deleteCredential(t, id);
    return res.status(200).json({ ok: true });
  }
  return res.status(200).json({ items: await listCredentials(t) });
}
