import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { catalog } from "../../lib/llm.js";
import { loadModelHistory } from "../../lib/model-history.js";
import { routeFor, TIERS } from "../../lib/router.js";

/**
 * GET -> the tiers this account runs on and every model the provider offers (id, price per million
 * tokens, context, tool and image support). Any id here works in MODEL_CHAT / MODEL_TASK / MODEL_HARD,
 * alone or as a comma-separated fallback list. Optional ?q= filters by id or name; ?tools=1 keeps
 * only models that can call tools (the agent needs that). `tiers` is each tier's chain in routing
 * order with the pool members the track record moved to the back, and `history` is that record:
 * per model, tasks that ended well out of all, across customers, over the last MODEL_HISTORY_DAYS.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const q = String(req.query.q ?? "").toLowerCase();
  const toolsOnly = String(req.query.tools ?? "") === "1";
  const [all, history] = await Promise.all([catalog(), loadModelHistory(true)]);
  let models = all;
  if (q) models = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  if (toolsOnly) models = models.filter((m) => m.tools);
  models.sort((a, b) => a.in + a.out - (b.in + b.out));
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).json({
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, routeFor(tier, t)])),
    history: [...history.values()].sort((a, b) => b.n - a.n),
    note: "Set MODEL_CHAT / MODEL_TASK / MODEL_HARD / MODEL_MAX to any id below (comma-separated for fallbacks). Only models with tools=true can drive the browser. openrouter/auto lets OpenRouter pick per request. A pool member whose record is poor (history: poor=true) is moved to the back of its pool and left out of fallback chains until its failures age out; MODEL_HISTORY=off keeps the pools as set.",
    count: models.length,
    models,
  });
}
