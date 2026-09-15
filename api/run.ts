import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env.js";
import { kick, runSession } from "../lib/runtime.js";

export const config = { maxDuration: 300 };

/** Internal worker: runs one session's loop for up to ~4 minutes, then re-kicks itself if unfinished. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (token !== env.cronSecret() && (req.headers.authorization ?? "") !== `Bearer ${env.cronSecret()}`) return res.status(401).end();
  const sessionId = typeof req.query.session === "string" ? req.query.session : "";
  if (!sessionId) return res.status(400).json({ error: "session required" });
  // The whole loop runs before the response. Vercel ends a function once it has responded, and on
  // this project the after-response keep-alive did not hold, so nothing is sent until the slice is
  // done. Callers use kick(), which fires and forgets, so nobody waits on this.
  console.log(`[run] ${sessionId}: start`);
  const started = Date.now();
  try {
    const outcome = await runSession(sessionId, { budgetMs: 235_000 });
    console.log(`[run] ${sessionId}: ${outcome} after ${Math.round((Date.now() - started) / 1000)}s`);
    if (outcome === "continue") await kick(sessionId); // 3 s cap; the cron sweep is the backstop
    return res.status(200).json({ session: sessionId, outcome });
  } catch (err) {
    console.error(`[run] ${sessionId}:`, err);
    return res.status(500).json({ session: sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}
