import { geminiDirect } from "./llm.js";
import type { Tenant } from "./tenant.js";

/**
 * Which model runs a session. Three tiers, each an env var holding any model id your provider
 * accepts. Defaults are cheap-first; the agent can escalate mid-task with the escalate tool.
 *
 *   MODEL_CHAT  short replies, calendar notes, recall           (default google/gemini-3.8-flash)
 *   MODEL_TASK  routine browser work, reorders, forms, drafting (default anthropic/claude-sonnet-5)
 *   MODEL_HARD  refunds, negotiations, projects, anything with judgment (default anthropic/claude-opus-5)
 *
 * The defaults favour a secretary that notices things over one that is cheap: a reply that misses the
 * wrong unit number on a bill costs more than the model does. Monthly and per-task caps still apply.
 */
export type Tier = "chat" | "task" | "hard";

export function modelFor(tier: Tier, t?: Tenant): string {
  const plan = (t?.plan ?? "starter").toUpperCase();
  const perPlan = process.env[`MODEL_${tier.toUpperCase()}_${plan}`];
  if (perPlan) return perPlan;
  const def = geminiDirect()
    ? { chat: "gemini-2.5-flash-lite", task: "gemini-2.5-flash", hard: "gemini-2.5-pro" }[tier] // Google-only: Pro takes the hard tier
    : { chat: "google/gemini-3.8-flash", task: "anthropic/claude-sonnet-5", hard: "anthropic/claude-opus-5" }[tier];
  return process.env[`MODEL_${tier.toUpperCase()}`] || def;
}

// Anything that signs in to an account (bills, balances, payments, statements, utilities, banks) also
// takes the strong model: logins, second factors and account portals defeat the cheap tiers, and a
// task that fails costs more than the model does.
const HARD = /\b(refund|dispute|chargeback|negotiat|escalat|complain|appeal|cancel(l)?ation|contract|offer|mortgage|realtor|broker|lawyer|insurance claim|denied|refus|buy (me )?a (house|car)|find (me )?the best|compare|research|plan (a|my) trip|book (a|my) flight|hire|quote|bill|balance|statement|pay|payment|log ?in|sign ?in|account|utility|con ?ed(ison)?|national grid|pseg|peco|bank|card|autopay)s?\b/i;
const TASK = /\b(order|reorder|buy|purchase|pay|book|schedule|reschedule|sign up|register|return|track|renew|cancel|check|look up|search|find|send|email|draft|fill|submit|download|upload|log ?in|enter|add|update|record|website|site|amazon|zillow|con ?ed(ison)?|utility|bill|balance|statement|due date|quickbooks|how much|price|prices|cost|costs|fare|estimate|quote|rate|uber|lyft|taxi|cab|ride|flight|train|ticket|actual|right now|current)\b|why (didn'?t|did not|haven'?t) you|you (forgot|never|didn'?t|still haven'?t)|still (waiting|not done)/i;

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

/** Replies that reopen the last task rather than chat: approvals, skepticism, "again". */
const REOPENS = /^(hmm+|really|seriously|that'?s it|come on|try again|again|keep going|continue|go on|more|retry)\b/i;

/**
 * A message that deserves a one-line answer in seconds, not a task: a greeting, "what's up", a
 * thank-you, a status question, small talk. It runs on the chat model with a tight step budget.
 * Approvals ("yes", "do it"), skeptical nudges ("hmmm"), codes, attachments and anything with a
 * task keyword are not quick.
 */
export function isQuickQuestion(text: string): boolean {
  const t = text.replace(/^\[[^\]]*\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").trim();
  if (!t || t.startsWith("(") || /^\d[\d\s-]{2,9}\d$/.test(t)) return false;
  if (REOPENS.test(t)) return false;
  const first = t.split(/\r?\n/)[0].toLowerCase();
  if (/^(yes|y|yes please|approve|approved|ok|okay|go|go ahead|do it|confirm|confirmed|proceed|send it|sure|👍)\b/.test(first)) return false;
  return tierFor(t, "chat") === "chat" && t.split(/\s+/).length <= 40;
}

export function nextTier(current: Tier): Tier | null {
  return current === "chat" ? "task" : current === "task" ? "hard" : null;
}

const RANK: Record<Tier, number> = { chat: 0, task: 1, hard: 2 };

/**
 * A chat session lives for hours and its model was picked from its first message, so "update?"
 * followed by "how much is an uber to JFK" left the browser work on the cheapest model. Each new
 * message re-routes: the session moves up to the tier the message needs, never down mid-conversation.
 */
export function upgradedModel(currentModel: string, text: string, t?: Tenant): string | undefined {
  const wanted = tierFor(text, "chat");
  if (RANK[wanted] <= RANK[tierOfModel(currentModel, t)]) return undefined;
  const model = modelFor(wanted, t);
  return model === currentModel ? undefined : model;
}

export function tierOfModel(model: string, t?: Tenant): Tier {
  if (model === modelFor("hard", t)) return "hard";
  if (model === modelFor("task", t)) return "task";
  return "chat";
}
