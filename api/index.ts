import type { VercelRequest, VercelResponse } from "@vercel/node";
import logout from "../server/routes/auth/logout.js";
import requestCode from "../server/routes/auth/request-code.js";
import verify from "../server/routes/auth/verify.js";
import checkout from "../server/routes/billing/checkout.js";
import portal from "../server/routes/billing/portal.js";
import history from "../server/routes/chat/history.js";
import send from "../server/routes/chat/send.js";
import upload from "../server/routes/chat/upload.js";
import cron from "../server/routes/cron.js";
import drafts from "../server/routes/drafts.js";
import googleCallback from "../server/routes/google/callback.js";
import googleConnect from "../server/routes/google/connect.js";
import googleDisconnect from "../server/routes/google/disconnect.js";
import mailInbound from "../server/routes/mail-inbound.js";
import me from "../server/routes/me.js";
import receipts from "../server/routes/receipts.js";
import run from "../server/routes/run.js";
import stats from "../server/routes/stats.js";
import stripeWebhook from "../server/routes/stripe-webhook.js";
import today from "../server/routes/today.js";
import vault from "../server/routes/vault.js";

/**
 * The whole API is one serverless function. vercel.json rewrites /api/<path> here with the path in
 * the query, and this file dispatches to the route modules under server/routes. One function means
 * one compile per deploy (about a minute instead of five) and one place to package the schema,
 * prompt and playbooks. The body is read once here, raw, and parsed for JSON routes; Stripe's
 * signature check needs the raw bytes, which it gets as req.rawBody.
 */
export const config = { maxDuration: 300, api: { bodyParser: false } };

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;
const routes: Record<string, Handler> = {
  "auth/logout": logout,
  "auth/request-code": requestCode,
  "auth/verify": verify,
  "billing/checkout": checkout,
  "billing/portal": portal,
  "chat/history": history,
  "chat/send": send,
  "chat/upload": upload,
  cron,
  drafts,
  "google/callback": googleCallback,
  "google/connect": googleConnect,
  "google/disconnect": googleDisconnect,
  "mail-inbound": mailInbound,
  me,
  receipts,
  run,
  stats,
  "stripe-webhook": stripeWebhook,
  today,
  vault,
};

const MAX_BODY = 36 * 1024 * 1024; // inbound mail with attachments is the largest caller

async function readBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
    size += b.length;
    if (size > MAX_BODY) throw new Error("payload too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function pathOf(req: VercelRequest): string {
  const q = req.query.path;
  const fromQuery = Array.isArray(q) ? q.join("/") : typeof q === "string" ? q : "";
  if (fromQuery) return fromQuery.replace(/^\/+|\/+$/g, "");
  // Direct hits without the rewrite (local dev): take it from the URL.
  const m = (req.url ?? "").match(/^\/api\/([^?]*)/);
  return (m?.[1] ?? "").replace(/\/+$/, "");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const route = routes[pathOf(req)];
  if (!route) return res.status(404).json({ error: "not found" });
  if (req.method !== "GET" && req.method !== "HEAD") {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (e) {
      return res.status(413).json({ error: (e as Error).message });
    }
    (req as VercelRequest & { rawBody: Buffer }).rawBody = raw;
    const type = String(req.headers["content-type"] ?? "");
    if (raw.length && /json/i.test(type)) {
      try {
        req.body = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "invalid JSON" });
      }
    } else if (raw.length && /application\/x-www-form-urlencoded/i.test(type)) {
      req.body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    } else {
      req.body = raw.length ? raw.toString("utf8") : undefined;
    }
  }
  return route(req, res);
}
