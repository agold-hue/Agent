import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { warmCatalog } from "../../../lib/llm.js";
import { customerContext, rememberPrefetch } from "../../../lib/sessions.js";

/**
 * POST { text } while the user is still typing (a one-second pause): the model catalog is warmed and
 * this customer's context block for that request (facts scoped to the class, playbook, site note,
 * post-mortems) is computed and kept for a minute, so the run that follows skips that work.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim().slice(0, 2000);
  if (text.length < 12) return res.status(200).json({ ok: true });
  const [block] = await Promise.all([customerContext(t, { task: text }).catch(() => ""), warmCatalog().catch(() => {})]);
  if (block) rememberPrefetch(t.id, text, block);
  return res.status(200).json({ ok: true });
}
