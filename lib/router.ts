import { catalog, geminiDirect, modelList, supportsVision } from "./llm.js";
import { isPoor, modelStats, rankByRecord } from "./model-history.js";
import type { Tenant } from "./tenant.js";

/**
 * Which model runs a session. A ladder of four tiers, cheapest first; each tier is a POOL of models
 * (any ids your provider accepts, comma-separated in MODEL_<TIER>), not one model. The router's job
 * is to start every request on the cheapest tier that does that kind of work, and within the tier on
 * the pool member with the best record for that kind of task for this customer (lib/outcomes.ts),
 * trying the untried ones now and then so the record fills in. Across customers, a pool member
 * whose track record is poor (lib/model-history.ts) goes to the back of its pool in every decision
 * that names a tier's model, so a model that fails for everyone stops being anyone's first choice.
 * The ladder is climbed on evidence, never by default: the agent's own escalate_model, the loop
 * guard, a site on the hard list, a photo the current model cannot see, or this customer's record
 * of failures on a tier for that kind of task.
 *
 *   MODEL_CHAT  greetings, status, notes, reminders, recall, digests, side replies
 *   MODEL_TASK  browser work: lookups, orders, forms, bookings, research, drafting, accounts
 *   MODEL_HARD  judgment against a counterparty: refunds, disputes, negotiations, appeals, contracts
 *   MODEL_MAX   the strongest model there is, reached only by escalation from the hard tier
 *
 * The default pools are the current generation of affordable, capable agentic models on OpenRouter
 * (Gemini 3.8 Flash, DeepSeek V4.1 Flash and V4 Pro, Qwen 3.8 Flash, GLM 5.3 Flash, Grok 4.3,
 * MiniMax M3, Kimi K2.6 for browser work; DeepSeek V4 Flash, Qwen 3.7 Flash, Gemini 3.5 Flash-Lite,
 * GPT-5.6 Luna, Mistral Small 4 for chat, lookups and page condensing) and the frontier models above
 * them. Browser work starts on Gemini 3.8 Flash: the newest Flash, a fast first-party tool caller that
 * reads screenshots, at a fifth of Sonnet's price per token, with the cheaper members behind it.
 * Ids the live catalog does not know are skipped, so a renamed model never breaks a tier.
 * GET /api/models lists every id with live prices and tool support.
 */
export type Tier = "chat" | "task" | "hard" | "max";
export const TIERS: Tier[] = ["chat", "task", "hard", "max"];

/** The affordable, capable pools. Order is preference among equals; the outcome record and price decide otherwise. */
export const DEFAULT_POOLS: Record<Tier, string[]> = {
  chat: ["deepseek/deepseek-v4-flash", "qwen/qwen3.7-flash", "google/gemini-3.5-flash-lite", "openai/gpt-5.6-luna", "mistralai/mistral-small-2603"],
  task: ["google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-flash", "z-ai/glm-5.3-flash", "x-ai/grok-4.3", "minimax/minimax-m3", "moonshotai/kimi-k2.6"],
  hard: ["anthropic/claude-sonnet-5", "google/gemini-2.5-pro", "openai/gpt-5"],
  max: ["anthropic/claude-opus-5"],
};

/** The tier's pool: MODEL_<TIER>_<PLAN>, else MODEL_<TIER>, else the default pool; always at least one id. */
export function poolFor(tier: Tier, t?: Tenant): string[] {
  const plan = (t?.plan ?? "starter").toUpperCase();
  const configured = process.env[`MODEL_${tier.toUpperCase()}_${plan}`] || process.env[`MODEL_${tier.toUpperCase()}`];
  if (configured) return modelList(configured);
  if (geminiDirect()) return [{ chat: "gemini-3.5-flash-lite", task: "gemini-3.8-flash", hard: "gemini-2.5-pro", max: "gemini-2.5-pro" }[tier]]; // Google-only: Pro takes the top
  return DEFAULT_POOLS[tier];
}

/**
 * The tier's model chain: the pool with the members the track record marks poor moved to the back,
 * the first as primary and the rest as fallbacks. Every re-route, escalation, hard-site jump, photo
 * and split turn goes through here, so a failing model stops being the first choice everywhere at once.
 */
export function modelFor(tier: Tier, t?: Tenant): string {
  return routeFor(tier, t).models.join(",");
}

export interface Route {
  tier: Tier;
  /** The chain in routing order. */
  models: string[];
  /** Pool members the track record moved to the back, with their record; empty when the pool is used as set. */
  demoted: Array<{ model: string; ok: number; n: number }>;
}

const logged = new Map<string, string>();

/** The tier's route with the reasons, for GET /api/models and the log; logged once per change. */
export function routeFor(tier: Tier, t?: Tenant): Route {
  const pool = poolFor(tier, t);
  const models = rankByRecord(pool);
  const demoted = pool.filter((m) => isPoor(m)).map((m) => ({ model: m, ok: modelStats(m)?.ok ?? 0, n: modelStats(m)?.n ?? 0 }));
  const key = `${tier}:${pool.join(",")}`;
  const line = demoted.length ? `${models[0]} first; ${demoted.map((d) => `${d.model} (${d.ok}/${d.n} ended well)`).join(", ")} moved back` : "";
  const prev = logged.get(key);
  if (prev !== line) {
    logged.set(key, line);
    if (line) console.log(`[route] ${tier} tier: ${line}`);
    else if (prev) console.log(`[route] ${tier} tier: back on ${pool[0]}`);
  }
  return { tier, models, demoted };
}

/** The pool with only the ids the live catalog knows (all of them when the catalog is unreachable). */
export async function livePool(tier: Tier, t?: Tenant): Promise<string[]> {
  const pool = poolFor(tier, t);
  const known = await catalog().catch(() => []);
  if (!known.length) return pool;
  const live = pool.filter((id) => known.some((m) => m.id === id) || id.includes(":") || !id.includes("/"));
  return live.length ? live : pool;
}

/**
 * The pool member to start a new session on, given the record for this kind of task: the best
 * success rate among members with enough outcomes (ties to the cheaper), an untried member now and
 * then so every affordable model gets its chance, else the primary. Returns the chain with the pick
 * first and the rest as fallbacks. Members in `avoid` (poor across customers) are never explored and
 * never the stand-in for a failing primary; only this customer's own good record can still pick one.
 */
export function choosePoolModel(pool: string[], stats: Map<string, { ok: number; n: number }>, price: Map<string, number>, explore: boolean, avoid: Set<string> = new Set()): string {
  const MIN_SAMPLES = 2;
  const GOOD = 0.75;
  const rate = (id: string) => {
    const s = stats.get(id);
    return s && s.n >= MIN_SAMPLES ? s.ok / s.n : undefined;
  };
  const proven = pool.filter((id) => (rate(id) ?? 0) >= GOOD).sort((a, b) => rate(b)! - rate(a)! || (price.get(a) ?? 99) - (price.get(b) ?? 99) || pool.indexOf(a) - pool.indexOf(b));
  const untried = pool.filter((id) => !stats.has(id) && !avoid.has(id));
  let pick = pool[0];
  if (explore && untried.length) pick = untried[0];
  else if (proven.length) pick = proven[0];
  else if ((rate(pool[0]) ?? 1) < 0.5) {
    // The primary keeps failing this kind of task: the next member with no bad record.
    const other = pool.find((id) => id !== pool[0] && !avoid.has(id) && (rate(id) ?? 1) >= 0.5);
    if (other) pick = other;
  }
  return [pick, ...pool.filter((id) => id !== pick)].join(",");
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
 * Writing something: a document the user will print, sign, send or file. None of these words were in
 * either list, so "give me the operating agreement pdf" scored as small talk and ran on the cheapest
 * chat model, which does not reach for make_pdf at all — it searched the web and narrated for eight
 * minutes. Drafting needs the task model at least.
 */
const DOCUMENT = /\b(pdf|document|letter|memo|agreement|contract|invoice|receipt letter|affidavit|addendum|amendment|resolution|bylaws|deed|waiver|nda|disclosure|notice|form|application|report|summary|write (me )?(a|an|the)|draft (me )?(a|an|the)|type up|put (it|that) in writing|generate|produce)\b/i;
/**
 * A document with legal or financial consequence: worth the judgment model. Getting an operating
 * agreement's clauses wrong costs more than every model call the customer makes in a month.
 */
const LEGAL_DOCUMENT = /\b(operating agreement|llc|partnership|shareholder|bylaws|articles of (organization|incorporation)|deed|promissory|lease|nda|non-?disclosure|affidavit|power of attorney|settlement|indemnit\w*|covenant|easement|will and testament|trust agreement|employment agreement|severance)\b/i;

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
  if (DOCUMENT.test(t) && LEGAL_DOCUMENT.test(t)) return "hard";
  if (TASK.test(t) && HARD_SITES.test(t)) return "hard";
  if (TASK.test(t) || DOCUMENT.test(t)) return "task";
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

/** One rung up the ladder, or null at the top. */
export function nextTier(current: Tier): Tier | null {
  const i = TIERS.indexOf(current);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

export const RANK: Record<Tier, number> = { chat: 0, task: 1, hard: 2, max: 3 };

/** The cheapest tier at or above `atLeast` whose primary model can look at a photo; the top tier when none can. */
export function visionTier(atLeast: Tier, t?: Tenant): Tier {
  for (const tier of TIERS) if (RANK[tier] >= RANK[atLeast] && supportsVision(modelFor(tier, t))) return tier;
  return "max";
}

/** Reasoning effort per tier (REASONING_<TIER>): none | low | medium | high | default. Thinking tokens are billed as output at the top rate, so mechanical tiers think little. */
export function reasoningFor(tier: Tier): "none" | "low" | "medium" | "high" | undefined {
  const v = (process.env[`REASONING_${tier.toUpperCase()}`] ?? { chat: "none", task: "low", hard: "medium", max: "default" }[tier]).toLowerCase();
  return v === "none" || v === "low" || v === "medium" || v === "high" ? v : undefined;
}

/** The model to move a session to so it runs on at least this tier, or undefined when it already does. */
export function atLeastModel(currentModel: string, tier: Tier, t?: Tenant): string | undefined {
  if (RANK[tierOfModel(currentModel, t)] >= RANK[tier]) return undefined;
  const model = modelFor(tier, t);
  return model === currentModel ? undefined : model;
}

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

/** The tier a session's model belongs to: the pool that holds its primary id (the top tier wins a tie). */
export function tierOfModel(model: string, t?: Tenant): Tier {
  const primary = modelList(model)[0] ?? model;
  for (const tier of [...TIERS].reverse()) if (poolFor(tier, t).includes(primary)) return tier;
  return "chat";
}
