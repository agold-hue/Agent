import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { deviceForToken, issueToken, postResult, relayStatus, revokeTokens, takeNext } from "../../lib/relay.js";

/**
 * The local browser relay's two faces. Logged-in customer (cookie): GET -> status and devices;
 * POST {action:"token", name} -> a fresh extension token (shown once); POST {action:"revoke"}.
 * The extension (device token in the `token` query): GET ?action=next -> the next command or {};
 * POST ?action=result {id, result} -> done. The token identifies the customer; nothing else is trusted.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = typeof req.query.action === "string" ? req.query.action : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";

  if (token) {
    const url = typeof req.query.url === "string" ? req.query.url : undefined;
    const device = await deviceForToken(token, url);
    if (!device) return res.status(401).json({ error: "unknown token" });
    if (req.method === "GET" && action === "next") {
      const next = await takeNext(device.user_id);
      return res.status(200).json(next ? { id: next.id, command: next.command } : {});
    }
    if (req.method === "POST" && action === "result") {
      const body = (req.body ?? {}) as { id?: unknown; result?: unknown };
      if (typeof body.id !== "string" || typeof body.result !== "object" || !body.result) return res.status(400).json({ error: "id and result required" });
      return res.status(200).json({ ok: await postResult(device.user_id, body.id, body.result as Record<string, unknown>) });
    }
    return res.status(405).end();
  }

  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  if (req.method === "GET") return res.status(200).json(await relayStatus(t));
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { action?: unknown; name?: unknown };
    if (body.action === "token") return res.status(200).json({ token: await issueToken(t, typeof body.name === "string" ? body.name : undefined) });
    if (body.action === "revoke") {
      await revokeTokens(t);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "action must be token or revoke" });
  }
  return res.status(405).end();
}
