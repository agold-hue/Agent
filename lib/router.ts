import { geminiDirect } from "./llm.js";
import type { Tenant } from "./tenant.js";

/**
 * Which model runs a session. Three tiers, each an env var holding any model id your provider
 * accepts. The router's job is to pick the cheapest tier that does the job well; the agent can
 * escalate mid-task with the escalate tool, and the loop guard escalates on its own when a task
 * is stuck.
 *
 *   MODEL_CHAT  short replies, notes, reminders, recall, digests   (default google/gemini-3.8-flash)
 *   MODEL_TASK  browser work: lookups, orders, forms, bookings, research, drafting, accounts
 *                                                                  (default anthropic/claude-sonnet-5)
 *   MODEL_HARD  judgment against a counterparty: refunds, disputes, negotiations, appeals, contracts
 *                                                                  (default anthropic/claude-opus-5)
 *
 * The defaults favour a secretary that notices things over one that is cheap: a reply that misses the
 * wrong unit number on a bill costs more than the model does. What keeps the bill down is routing:
 * every request is tiered on its own (a thread that ran a refund on the judgment model drops back to
 * the task model for the next lookup and to the chat model for a thank-you), notes and reminders never
 * leave the chat model, and only work that needs judgment starts on the judgment model.
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

/**
 * Judgment work: money to claw back, a counterparty to move, a decision with real downside. Everything
 * else that touches a site is task-tier. Comparisons, research, quotes, bookings, cancellations and
 * hires used to start here; the task model does them as well at a fraction of the price, and a site
 * or a support agent that stonewalls it triggers escalate_model, so the judgment model still arrives
 * when it is needed.
 */
const HARD = /\b(refund|dispute|chargeback|negotiat\w*|escalat\w*|complain\w*|complaint|appeal|contract|lease|mortgage|lawyer|attorney|insurance claim|denied|refus\w*|settlement|fraud|overcharg\w*|buy (me )?a (house|car|home))s?\b/i;
// Account work (bills, balances, payments, logins, utilities, banks) is task-tier: the task model is
// strong enough for logins, second factors and portals, at a fraction of the judgment model's price.
const TASK = /\b(order|reorder|buy|purchase|pay|book|schedule|reschedule|sign up|register|return|track|renew|cancel|cancellation|check|look up|search|find|send|email|draft|fill|submit|download|upload|log ?in|enter|add|update|record|website|site|amazon|zillow|con ?ed(ison)?|utility|bill|balance|statement|due date|account|autopay|bank|card|sign ?in|quickbooks|how much|price|prices|cost|costs|fare|estimate|quote|rate|uber|lyft|taxi|cab|ride|flight|train|ticket|actual|right now|current|compare|research|options|recommend|offer|hire|realtor|broker|plan (a|my) trip|find (me )?the best)\b|why (didn'?t|did not|haven'?t) you|you (forgot|never|didn'?t|still haven'?t)|still (waiting|not done)/i;
/**
 * A note, a list item or a reminder: memory and the calendar, never the browser. These match task
 * words ("add", "pay", "bill") but are one memory call on the chat model, answered in seconds with
 * no "on it" line. Anything that names a cart, an account, a card or a site is real work and stays out.
 */
const LIGHT = /^(?:please |pls |hey,? |can you |could you )?(?:(?:add|put) [^\n]{1,80}?\b(?:to|on) (?:the |my )?(?:shopping |grocery )?list\b|(?:note|jot down|fyi|for the record|reminder)\b|(?:remember|remind me)\b(?![^\n]*\b(?:log ?in|password|sign ?in)\b))/i;

/**
 * Sites that defeat the task model often enough that starting there is cheaper than failing first:
 * banks, card issuers, airlines, government portals. Names and domains; HARD_DOMAINS adds more.
 */
const HARD_SITES = new RegExp(
  `\\b(${[
    "chase", "bank ?of ?america", "bofa", "wells ?fargo", "citi(bank)?", "capital ?one", "amex", "american ?express", "discover", "us ?bank", "pnc", "td ?bank", "schwab", "fidelity", "vanguard",
    "delta", "united", "american ?airlines", "aa\\.com", "jetblue", "southwest", "spirit", "frontier", "alaska ?air",
    "irs", "ssa", "social ?security", "medicare", "healthcare\\.gov", "uscis", "dmv", "passport",
    ...(process.env.HARD_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^www\./, "").replace(/\.[a-z]+$/, "")).filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ].join("|")})\\b`,
  "i",
);
/** Whether a request or a URL names a site on the hard list. */
export function isHardSite(textOrUrl: string): boolean {
  return HARD_SITES.test(textOrUrl.replace(/^\[[^\]]*\]\n/, ""));
}

/** Pick a tier from the request text and where it came from. Cheap heuristics; wrong guesses can escalate. */
export function tierFor(text: string, kind: string): Tier {
  if (kind === "correspondence" || kind === "followup") return "task";
  if (kind === "review" || kind === "weekly" || kind === "digest" || kind === "triage") return "chat";
  // Classify the request itself, not the host's stamp ("[... via email]") or the subject label.
  const t = text.replace(/^\[[^\]]*\]\n/, "").replace(/^Subject: /m, "").replace(/^\(Request from a family member[^)]*\)\n/, "").slice(0, 2000);
  // A note is a note even when it mentions a refund or a lease: "remind me the lease is up in March".
  if (LIGHT.test(t.trim())) return "chat";
  if (HARD.test(t)) return "hard";
  if (TASK.test(t) && HARD_SITES.test(t)) return "hard";
  if (TASK.test(t)) return "task";
  return "chat";
}

/** Replies that reopen the last task rather than chat: approvals, skepticism, "again". */
const REOPENS = /^(hmm+|really|seriously|that'?s it|come on|try again|again|keep going|continue|go on|more|retry)\b/i;

/** A yes, in the words people type. */
const APPROVES = /^(yes|y|yes please|approve|approved|ok|okay|go|go ahead|do it|confirm|confirmed|proceed|send it|sure|👍)\b/i;

/** A correction or an instruction that changes the task at hand ("no, the Amex", "actually make it Tuesday"). */
const CORRECTS = /^(no|nope|wait|stop|hold on|actually|instead|never ?mind|forget it|use|try|don'?t|not that|also for|and|but)\b/i;
/**
 * A message that steers the running task rather than starting another: a correction, an instruction,
 * an acknowledgement, a skeptical grunt.
 */
export const STEERS = /^(no|nope|wait|stop|hold on|actually|instead|never ?mind|forget it|use|try|don'?t|not that|also for|and|but|ok|okay|yes|yep|sure|go|do it|go ahead|fine|thanks|thank you|hmm+)\b/i;

/**
 * A question about the work in progress or about what the agent knows: status, progress, "did you",
 * "what did they say", "do you have my address". It wants an answer now, not a task; while the thread
 * is busy the host answers it alongside from the thread's own progress (a side reply).
 */
export const ASKS =
  /^(?:(?:any|got any|is there any) (?:luck|update|news|progress|word)\b|(?:what'?s|whats|how'?s|hows|what is|how is) (?:the |it |that |this )?(?:status|progress|going|looking|happening|taking|holding|eta)\b|(?:status|update|progress|eta)\??$|(?:did|didn'?t|have|haven'?t|has|hasn'?t|do|does|don'?t) (?:you|it|that|this|they|we)\b|(?:are|aren'?t|were|is|isn'?t|was) you\b|(?:what|why|how|where|when) (?:did|didn'?t|do|does|is|are|was|were|have|haven'?t|has|come|about|far|long|much longer|many)\b|you (?:there|done|stuck|still|ok|okay|alive|back)\b|(?:is|are) (?:it|they|that|you|this) (?:done|ready|finished|paid|booked|in|working|going|ok|okay)\b|still (?:waiting|working|on it|there)\b)/i;

/** A short status or knowledge question (see ASKS) that is not a yes, a code or a reopen. */
export function isAsk(text: string): boolean {
  const t = clean(text);
  if (!t || t.startsWith("(") || REOPENS.test(t) || APPROVES.test(t)) return false;
  return ASKS.test(t) && t.split(/\s+/).length <= 16;
}

/**
 * A message that deserves a one-line answer in seconds, not a task: a greeting, "what's up", a
 * thank-you, a status question, a note for memory, small talk. It runs on the chat model with a
 * tight step budget. Approvals ("yes", "do it"), skeptical nudges ("hmmm"), codes, attachments and
 * anything with a task keyword are not quick.
 */
export function isQuickQuestion(text: string): boolean {
  const t = clean(text);
  if (!t || t.startsWith("(") || /^\d[\d\s-]{2,9}\d$/.test(t)) return false;
  // A correction ("actually make it Tuesday") continues the last task and may need the browser.
  if (REOPENS.test(t) || CORRECTS.test(t)) return false;
  const first = t.split(/\r?\n/)[0].toLowerCase();
  if (APPROVES.test(first)) return false;
  return tierFor(t, "chat") === "chat" && t.split(/\s+/).length <= 40;
}

/**
 * A request in its own right, as opposed to a steer, an answer, a question about the running work or
 * a "try again": the kind of message that starts a task and so gets that task's own tier.
 */
export function isFreshRequest(text: string): boolean {
  const t = clean(text);
  if (!t || t.startsWith("(") || /^\d[\d\s-]{2,9}\d$/.test(t)) return false;
  if (REOPENS.test(t) || APPROVES.test(t) || STEERS.test(t) || ASKS.test(t)) return false;
  return t.split(/\s+/).length >= 3;
}

function clean(text: string): string {
  return text.replace(/^\[[^\]]*\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").trim();
}

/**
 * A plain factual question the web answers in one search: a store's hours, a fare, a phone number,
 * who won, when something opens. It runs the lookup fast path (one search, one fast-model reply, no
 * tools) and falls back to the full loop when the sources do not answer. Anything about the user's
 * own accounts, orders or calendar, and anything that asks for an action, is not a lookup.
 */
const LOOKUP_LEAD = /^(what|what's|whats|when|when's|how much|how many|how long|how late|how early|how far|how old|how big|how tall|is|are|does|do|did|who|who's|where|where's|which|why)\b/i;
const NOT_LOOKUP = /\b(my|our|mine|me|i|i'm|i've|we|we're|us|you|your|yours|yet|done|status|so far|going on|order|reorder|buy|purchase|book|pay|cancel|send|email|text|call|schedule|reschedule|remind|track|return|sign|log ?in|account|password|code|refund|dispute|draft|reply|calendar|inbox|package|delivery|appointment|reservation|subscription|balance|statement|invoice|bill|receipt|renew|apply|submit|fill|upload|download|save|add|update|set|make|create|get me|for me|please)\b/i;
export function isLookupQuestion(text: string): boolean {
  let t = text.replace(/^\[[^\]]*\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").trim();
  if (!t || t.startsWith("(") || t.includes("\n")) return false;
  t = t.replace(/^(can you |could you |would you |please )?(tell me|find out|look up|check|search|google)\s*[,:]?\s*/i, "").trim();
  if (t.split(/\s+/).length > 30 || !LOOKUP_LEAD.test(t)) return false;
  if (NOT_LOOKUP.test(t) || /^(what'?s (up|new|good|happening)|how are|how'?s it)\b/i.test(t)) return false;
  // The time, the day and the date are in the message stamp; no search answers them better.
  if (/^(what|what'?s|whats) (the )?(time|day|date)( is it| today| is today| is it today| now)?[?.!\s]*$/i.test(t) || /^what'?s today'?s date/i.test(t)) return false;
  return true;
}

export function nextTier(current: Tier): Tier | null {
  return current === "chat" ? "task" : current === "task" ? "hard" : null;
}

const RANK: Record<Tier, number> = { chat: 0, task: 1, hard: 2 };

/**
 * A chat thread lives for hours and its model was picked from its first message. Each new message
 * re-routes the thread to the tier that message needs: up at any time ("update?" then "how much is
 * an uber to JFK" moves the browser work up to the task model, even mid-task), and back down when
 * the thread is idle and the message is a request of its own or a quick question (a thread that just
 * ran a refund on the judgment model does the next balance check on the task model and answers
 * "thanks" on the chat model). A steer, an answer, a "hmm" or a "try again" keeps the model it has:
 * the running work continues where it is. Returns the model to switch to, or undefined to keep it.
 */
export function reroutedModel(currentModel: string, text: string, idle: boolean, t?: Tenant): string | undefined {
  const wanted = tierFor(text, "chat");
  const current = tierOfModel(currentModel, t);
  let target: Tier | undefined;
  if (RANK[wanted] > RANK[current]) target = wanted;
  // A question about the last task ("any luck?", "did you pay it?") is answered by the model that did it.
  else if (idle && RANK[wanted] < RANK[current] && !ASKS.test(clean(text)) && (isQuickQuestion(text) || isFreshRequest(text))) target = wanted;
  if (!target) return undefined;
  const model = modelFor(target, t);
  return model === currentModel ? undefined : model;
}

export function tierOfModel(model: string, t?: Tenant): Tier {
  if (model === modelFor("hard", t)) return "hard";
  if (model === modelFor("task", t)) return "task";
  return "chat";
}
