import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { historyPayload, historyVersion } from "./history.js";

/**
 * GET -> text/event-stream. Pushes the chat payload the moment anything changes (a token of the
 * reply being written, a progress line, a card, a finished task) instead of the page asking every
 * second or two. The server watches the cheap fingerprint every STREAM_TICK_MS and sends a full
 * payload on change; the connection ends after STREAM_MAX_MS or a few seconds after everything
 * went quiet, and the page reconnects while something is still running. Postgres LISTEN/NOTIFY
 * would replace the fingerprint watch on a database that supports it; the wire format stays.
 */
const TICK_MS = Number(process.env.STREAM_TICK_MS ?? 350);
const MAX_MS = Number(process.env.STREAM_MAX_MS ?? 55_000);
const QUIET_MS = Number(process.env.STREAM_QUIET_MS ?? 4000);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let last = typeof req.query.v === "string" ? req.query.v : "";
  const started = Date.now();
  let quietSince = 0;
  let open = true;
  req.on("close", () => (open = false));
  try {
    while (open && Date.now() - started < MAX_MS) {
      const version = await historyVersion(t).catch(() => last);
      if (version !== last) {
        last = version;
        const payload = await historyPayload(t, version);
        send("history", payload);
        const busy = payload.status === "running" || (Array.isArray(payload.tasks) && (payload.tasks as Array<{ status: string }>).some((x) => x.status === "running")) || !!payload.draft;
        quietSince = busy ? 0 : Date.now();
      } else if (quietSince && Date.now() - quietSince > QUIET_MS) {
        break; // nothing running and nothing changed for a while: let the page fall back to its slow poll
      }
      if ((Date.now() - started) % 15_000 < TICK_MS) res.write(": ping\n\n");
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  } finally {
    if (open) send("end", { version: last });
    res.end();
  }
}
