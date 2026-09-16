import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { pushConfigured, removeSubscription, saveSubscription } from "../../lib/push.js";

/** GET -> { enabled, public_key }. POST { subscription } registers this device. DELETE { endpoint } removes it. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (req.method === "GET") return res.status(200).json({ enabled: pushConfigured(), public_key: process.env.VAPID_PUBLIC_KEY ?? null });
  if (!pushConfigured()) return res.status(501).json({ error: "push is not set up on this server (VAPID keys)" });
  if (req.method === "POST") {
    const sub = (req.body as { subscription?: { endpoint?: string; keys?: Record<string, string> } })?.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return res.status(400).json({ error: "subscription required" });
    await saveSubscription(t, { endpoint: sub.endpoint, keys: sub.keys });
    return res.status(200).json({ ok: true });
  }
  if (req.method === "DELETE") {
    const endpoint = String((req.body as { endpoint?: unknown })?.endpoint ?? "");
    if (endpoint) await removeSubscription(t, endpoint);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}
