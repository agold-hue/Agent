import type { VercelRequest } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";

/** Single-owner chat: a shared password sent as a Bearer token (or ?token= for streams). */
export function chatAuthorized(req: VercelRequest): boolean {
  const expected = process.env.CHAT_PASSWORD ?? "";
  if (!expected) return false;
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : typeof req.query.token === "string" ? req.query.token : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
