import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { catalog } from "../../lib/llm.js";
import { modelFor } from "../../lib/router.js";

/**
 * GET -> the tiers this account runs on and every model the provider offers (id, price per million
 * tokens, context, tool and image support). Any id here works in MODEL_CHAT / MODEL_TASK / MODEL_HARD,
 * alone or as a comma-separated fallback list. Optional ?q= filters by id or name; ?tools=1 keeps
 * only models that can call tools (the agent needs that).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const q = String(req.query.q ?? "").toLowerCase();
  const toolsOnly = String(req.query.tools ?? "") === "1";
  let models = await catalog();
  if (q) models = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  if (toolsOnly) models = models.filter((m) => m.tools);
  models.sort((a, b) => a.in + a.out - (b.in + b.out));
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).json({
    tiers: { chat: modelFor("chat", t), task: modelFor("task", t), hard: modelFor("hard", t) },
    note: "Set MODEL_CHAT / MODEL_TASK / MODEL_HARD to any id below (comma-separated for fallbacks). Only models with tools=true can drive the browser. openrouter/auto lets OpenRouter pick per request.",
    count: models.length,
    models,
  });
}
