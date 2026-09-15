import { geminiDirect } from "./llm.js";
import type { Tenant } from "./tenant.js";

/**
 * Which model runs a session. Three tiers, each an env var holding any model id your provider
 * accepts. Defaults are cheap-first; the agent can escalate mid-task with the escalate tool.
 *
 *   MODEL_CHAT  short replies, calendar notes, recall           (default google/gemini-2.5-flash-lite)
 *   MODEL_TASK  routine browser work, reorders, forms, drafting (default google/gemini-3.8-flash)
 *   MODEL_HARD  refunds, negotiations, projects, anything with judgment (default anthropic/claude-sonnet-5)
 */
export type Tier = "chat" | "task" | "hard";

export function modelFor(tier: Tier, t?: Tenant): string {
  const plan = (t?.plan ?? "starter").toUpperCase();
  const perPlan = process.env[`MODEL_${tier.toUpperCase()}_${plan}`];
  if (perPlan) return perPlan;
  const def = geminiDirect()
    ? { chat: "gemini-2.5-flash-lite", task: "gemini-2.5-flash", hard: "gemini-2.5-pro" }[tier] // Google-only: Pro takes the hard tier
    : { chat: "google/gemini-2.5-flash-lite", task: "google/gemini-3.8-flash", hard: "anthropic/claude-sonnet-5" }[tier];
  return process.env[`MODEL_${tier.toUpperCase()}`] || def;
}

const HARD = /\b(refund|dispute|chargeback|negotiat|escalat|complain|appeal|cancel(l)?ation|contract|offer|mortgage|realtor|broker|lawyer|insurance claim|denied|refus|buy (me )?a (house|car)|find (me )?the best|compare|research|plan (a|my) trip|book (a|my) flight|hire|quote)s?\b/i;
const TASK = /\b(order|reorder|buy|purchase|pay|book|schedule|reschedule|sign up|register|return|track|renew|cancel|check|look up|search|find|send|email|draft|fill|submit|download|upload|log ?in|enter|add|update|record|website|site|amazon|zillow|coned|utility|bill|quickbooks|how much|price|prices|cost|costs|fare|estimate|quote|rate|uber|lyft|taxi|cab|ride|flight|train|ticket|actual|right now|current)\b|why (didn'?t|did not|haven'?t) you|you (forgot|never|didn'?t|still haven'?t)|still (waiting|not done)/i;

/** Pick a tier from the request text and where it came from. Cheap heuristics; wrong guesses can escalate. */
export function tierFor(text: string, kind: string): Tier {
  if (kind === "correspondence" || kind === "followup") return "task";
  if (kind === "review" || kind === "weekly" || kind === "digest" || kind === "triage") return "chat";
  // Classify the request itself, not the host's stamp ("[... via email]") or the subject label.
  const t = text.replace(/^\[[^\]]*\]\n/, "").replace(/^Subject: /m, "").replace(/^\(Request from a family member[^)]*\)\n/, "").slice(0, 2000);
  if (HARD.test(t)) return "hard";
  if (TASK.test(t)) return "task";
  return "chat";
}

export function nextTier(current: Tier): Tier | null {
  return current === "chat" ? "task" : current === "task" ? "hard" : null;
}

export function tierOfModel(model: string, t?: Tenant): Tier {
  if (model === modelFor("hard", t)) return "hard";
  if (model === modelFor("task", t)) return "task";
  return "chat";
}
