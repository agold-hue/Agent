import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { listReceipts, receiptImage } from "../../lib/daily.js";

/** GET: done receipts (proof of completed orders, payments, bookings). GET ?image=<id>: its screenshot. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const imageId = typeof req.query.image === "string" ? req.query.image : undefined;
  if (imageId) {
    const img = await receiptImage(t, imageId);
    if (!img) return res.status(404).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).send(img);
  }
  const items = await listReceipts(t, Math.min(Number(req.query.limit ?? 30) || 30, 100));
  return res.status(200).json({ items });
}
