import { complete, costCents, type Completion } from "./llm.js";
import { modelFor } from "./router.js";
import { condensePage, fetchPage, formatPage, formatSearch, localeFor, searchWeb, type Freshness, type Locale, type SearchOutcome } from "./search.js";
import { chargeCompletion, taskStart, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";
import type { ToolOutcome } from "./tools.js";

/**
 * Research without the browser: the web_search and fetch_page tools, the per-task fetch budget, and
 * the lookup fast path (a plain factual question answered from one search on the fast model, without
 * the agent loop). The hosted browser is only for logins and actions, and for pages that block plain
 * fetches; nothing here opens one.
 */

/** Pages one task may read (search read_top plus fetch_page) before it must answer or ask; each approved research checkpoint adds the same again. */
export const FETCH_BUDGET = Number(process.env.FETCH_BUDGET_PER_TASK ?? 12);
const BUDGET_LINE = /pages read this task: (\d+)\/(\d+)/;
const RESEARCH_CHECKPOINT = /\b(pages?|read|reading|research|search|sources?)\b/i;

/** Pages read so far in the current task (from the tools' own result headers) and the limit, raised by approved research checkpoints. */
export function fetchBudget(row: Pick<SessionRow, "messages">): { used: number; limit: number } {
  const start = taskStart(row.messages);
  let used = 0;
  let approvals = 0;
  const approvedIds = new Set<string>();
  for (let i = start; i < row.messages.length; i++) {
    const m = row.messages[i];
    if (m.role === "tool" && typeof m.content === "string") {
      const b = m.content.match(BUDGET_LINE);
      if (b) used = Math.max(used, Number(b[1]));
      if (m.tool_call_id && /^APPROVED\b/.test(m.content)) approvedIds.add(m.tool_call_id);
    }
  }
  for (let i = start; i < row.messages.length; i++) {
    const m = row.messages[i];
    for (const c of m.tool_calls ?? []) if (c.function.name === "checkpoint" && approvedIds.has(c.id) && RESEARCH_CHECKPOINT.test(c.function.arguments)) approvals++;
  }
  return { used, limit: FETCH_BUDGET * (1 + approvals) };
}

const FRESHNESS = new Set<Freshness>(["day", "week", "month", "year"]);
const readable = (how: string) => how === "html" || how === "pdf" || how === "text";

function budgetNote(used: number, limit: number): string {
  return `Fetch budget reached: ${used}/${limit} pages read this task. Answer from what you have read (results and snippets are still returned). If more reading is genuinely needed, call checkpoint(action_type "other", summary "Read up to ${FETCH_BUDGET} more pages: <why>") and continue only after APPROVED.`;
}

/**
 * web_search and fetch_page. `browserFallback` runs the old browser-driven DuckDuckGo search and is
 * used only when every HTTP engine failed and this session already has a browser (never opened for it).
 */
export async function runResearchTool(t: Tenant, row: SessionRow, name: string, args: Record<string, unknown>, browserFallback?: (query: string) => Promise<ToolOutcome>): Promise<ToolOutcome> {
  const s = (k: string) => String(args[k] ?? "").trim();
  const locale = localeFor(t);
  if (args.near) locale.near = s("near");
  const charge = (c: Completion) => chargeCompletion(t, row, c);
  const condenseModel = modelFor("chat", t);
  const budget = fetchBudget(row);

  if (name === "web_search") {
    const queries = [s("query"), ...((Array.isArray(args.queries) ? args.queries : []) as unknown[]).map((v) => String(v ?? "").trim())].filter(Boolean).map((qq) => (args.site ? `${qq} site:${s("site").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}` : qq));
    if (!queries.length) return { text: "Pass query (or queries)." };
    const since = FRESHNESS.has(s("since") as Freshness) ? (s("since") as Freshness) : undefined;
    const remaining = Math.max(0, budget.limit - budget.used);
    const wanted = args.read_top == null ? 2 : Math.max(0, Math.min(5, Number(args.read_top) || 0));
    const readTop = Math.min(wanted, remaining);
    const note = wanted > 0 && remaining === 0 ? budgetNote(budget.used, budget.limit) : undefined;
    const outcome = await searchWeb({ queries, since, locale, readTop, focus: s("focus") || queries[0], charge, condenseModel });
    if (!outcome.hits.length && browserFallback && row.browserbase_session_id) {
      const fb = await browserFallback(queries[0]).catch((err) => ({ text: `browser search failed: ${err instanceof Error ? err.message : String(err)}` }) as ToolOutcome);
      return { text: `web_search: HTTP engines returned nothing (${outcome.errors.join("; ") || "no results"}); results from the browser instead; pages read this task: ${budget.used}/${budget.limit}\n${fb.text}` };
    }
    const used = budget.used + outcome.pages.filter((p) => readable(p.how)).length;
    console.log(`[search] ${row.id} ${outcome.engine}${outcome.cached ? " cached" : ""} ${outcome.queries.length}q ${outcome.hits.length} hits ${outcome.pages.length} pages ${outcome.ms}ms${outcome.errors.length ? ` errors: ${outcome.errors.join("; ")}` : ""}`);
    return { text: formatSearch(outcome, { used, limit: budget.limit }, note) };
  }

  if (name === "fetch_page") {
    const url = s("url");
    if (!url) return { text: "Pass url." };
    if (budget.used >= budget.limit) return { text: budgetNote(budget.used, budget.limit) };
    const page = await condensePage(await fetchPage(url), { focus: s("focus") || undefined, charge, condenseModel });
    const used = budget.used + (readable(page.how) ? 1 : 0);
    return { text: formatPage(page, { used, limit: budget.limit }) };
  }
  return { text: `Unknown research tool ${name}` };
}

// ------------------------------------------------------------------ the lookup fast path

const LOOKUP_SYSTEM = [
  "You answer one factual question from the web sources given, for a busy person on their phone.",
  "Two or three short lines at most, plain words: the fact or figure first, then the source as '(source: domain, date)'.",
  "Prefer the newest and most official source; if the sources disagree, say so in half a line and give the better-supported one.",
  "Never invent a figure, a phone number, an address or an hour. If the sources do not contain the answer, or only an unreliable one, reply exactly: NEED_MORE",
].join(" ");

export interface LookupResult {
  /** The reply, or undefined when the sources did not answer it (the caller falls back to the full loop). */
  answer?: string;
  outcome: SearchOutcome;
  /** The search as the model would read it, for a fallback that should not search again. */
  formatted: string;
  costCents: number;
  ms: number;
}

/**
 * One search (top pages read and condensed in parallel), one fast-model call, no tools: the whole
 * answer to "what time does Costco close" or "how much is a Metro-North ticket to White Plains" in
 * a few seconds and a fraction of a cent, instead of the agent loop with thirty tool definitions.
 */
export async function lookupAnswer(question: string, opts: { locale: Locale; model: string; today?: string; charge?: (c: Completion) => Promise<unknown>; readTop?: number }): Promise<LookupResult> {
  const started = Date.now();
  let cost = 0;
  const charge = async (c: Completion) => {
    cost += costCents(c.model, c.usage);
    if (opts.charge) await opts.charge(c);
  };
  const cleaned = question.replace(/^\[[^\]]+\]\n/, "").replace(/^(can you |could you |please )?(tell me|find out|look up|check)\s*[,:]?\s*/i, "").trim();
  const outcome = await searchWeb({ queries: [cleaned], locale: opts.locale, readTop: opts.readTop ?? 3, focus: cleaned, charge, condenseModel: opts.model });
  const formatted = formatSearch(outcome, { used: outcome.pages.length, limit: FETCH_BUDGET });
  if (!outcome.hits.length) return { outcome, formatted, costCents: cost, ms: Date.now() - started };
  try {
    const c = await complete({
      model: opts.model,
      temperature: 0,
      maxTokens: 350,
      messages: [
        { role: "system", content: LOOKUP_SYSTEM },
        { role: "user", content: `Today: ${opts.today ?? new Date().toISOString().slice(0, 10)}${opts.locale.near ? `. The person is in ${opts.locale.near}` : ""}.\nQuestion: ${cleaned}\n\nSources:\n${formatted}` },
      ],
    });
    await charge(c);
    const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
    const answer = text && !/^NEED_MORE\b/.test(text) && !c.message.tool_calls?.length ? text : undefined;
    return { answer, outcome, formatted, costCents: cost, ms: Date.now() - started };
  } catch (err) {
    console.error(`[lookup] ${err instanceof Error ? err.message : String(err)}`);
    return { outcome, formatted, costCents: cost, ms: Date.now() - started };
  }
}

/** The lookup fast path for a session: answer, or undefined with the search left as a host note so the loop does not repeat it. */
export async function quickLookup(t: Tenant, row: SessionRow, question: string): Promise<string | undefined> {
  const r = await lookupAnswer(question, { locale: localeFor(t), model: modelFor("chat", t), charge: (c) => chargeCompletion(t, row, c) });
  console.log(`[lookup] ${row.id} ${r.answer ? "answered" : "fell through"} ${r.outcome.engine} ${r.outcome.hits.length} hits ${r.outcome.pages.length} pages ${r.ms}ms ${r.costCents.toFixed(3)}c`);
  if (r.answer) return r.answer;
  if (r.outcome.hits.length) row.messages.push({ role: "user", content: `(A web search for this question already ran; its results are below. Use them, fetch_page for details, and do not repeat the same search.)\n\n${r.formatted}` });
  return undefined;
}
