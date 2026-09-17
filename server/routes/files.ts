import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { fileByToken, listFiles } from "../../lib/files.js";

/**
 * A file the agent made or downloaded (a PDF it wrote, a filled form, a statement), served by its
 * own random token so the link works from the chat, from an email on a phone, and from a printer's
 * browser, where a login cookie would not be. The token is the only way in and points at one file.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // The signed-in customer's own list, for the Documents card and for naming a link in the chat.
  if (req.query.list) {
    const t = await requireTenant(req, res);
    if (!t) return;
    res.setHeader("Cache-Control", "no-store");
    const files = await listFiles(t, Math.min(Number(req.query.limit ?? 20), 50));
    return res.status(200).json({ files: files.map((f) => ({ filename: f.filename, kb: Math.round(f.bytes / 1024), at: f.created_at, url: f.url, token: f.token })) });
  }
  const token = typeof req.query.t === "string" ? req.query.t : "";
  const file = await fileByToken(token);
  if (!file) return res.status(404).json({ error: "not found" });
  const inline = /^(application\/pdf|image\/|text\/plain)/.test(file.mime_type);
  res.setHeader("Content-Type", file.mime_type);
  res.setHeader("Content-Length", String(file.content.length));
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${file.filename.replace(/["\\]/g, "")}"`);
  // Private: a shared link should not sit in a CDN or a proxy cache.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(file.content);
}
