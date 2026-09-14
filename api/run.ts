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
  // Respond immediately so the caller never waits on the loop; keep working in this invocation.
  res.status(202).json({ accepted: sessionId });
  try {
    const outcome = await runSession(sessionId, { budgetMs: 235_000 });
    if (outcome === "continue") await kick(sessionId);
  } catch (err) {
    console.error(`[run] ${sessionId}:`, err);
  }
}
