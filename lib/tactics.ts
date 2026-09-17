import { findCredential } from "./credentials.js";
import type { ChatMessage } from "./llm.js";
import { readMemory } from "./memory.js";
import { parsePaths } from "./browser-extras.js";
import { isHardSite, RANK, tierOfModel, type Tier } from "./router.js";
import { messageText, sitesIn, taskStart, taskUserText, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * Host tactics: what the loop does around the model so a task succeeds sooner and cheaper. Each is a
 * pure-ish helper the loop calls at a specific moment: before the first browser step (pre-flight),
 * when the page stops changing (routes not yet tried), when a task is handed to a stronger model
 * (the hand-off), when a request names an amount (the value at stake), and on hard-tier tasks
 * (which turns need the judgment model and which are clicking).
 */

// ---------------------------------------------------------------- Pre-flight (B1)

export const PREFLIGHT_PREFIX = "(Before you start:";
const ACCOUNT_WORDS = /\b(log ?in|sign ?in|account|bill|balance|pay|payment|statement|order|orders|cancel|subscription|autopay|my |renew|return|refund|book|reservation|ticket|claim)\b/i;
const GOOGLE_WORDS = /\b(inbox|my email|my mail|gmail|calendar|drive|the email from|forward)\b/i;
const NEEDS_ADDRESS = /\b(deliver|delivery|ship|shipping|order|uber|lyft|ride|taxi|pickup|pick me up|send (it|them) to|mail (it|them))\b/i;
const NEEDS_CARD = /\b(pay|buy|purchase|order|book|checkout|subscribe|renew)\b/i;

/**
 * What the task will need that is not in place, found from the request before the first browser
 * step: a login the vault does not have for a named site, Google for a task that reads the inbox or
 * calendar, an address or a card the facts do not hold. Many failures are discovered twenty steps in;
 * this asks the one question up front, or tells the model to carry on when the site is likely already
 * signed in through the shared browser profile.
 */
export async function preflightNote(t: Tenant, row: SessionRow): Promise<string | undefined> {
  const text = taskUserText(row.messages);
  const facts = row.contextBlock ?? "";
  const gaps: string[] = [];
  for (const site of sitesIn(text)) {
    if (!ACCOUNT_WORDS.test(text) && !isHardSite(site)) continue;
    const cred = await findCredential(t, site).catch(() => undefined);
    if (!cred) gaps.push(`nothing is saved in the vault for ${site}`);
  }
  if (GOOGLE_WORDS.test(text) && !t.googleRefreshToken) gaps.push("Google is not connected, so the inbox, calendar and Drive tools will fail");
  if (NEEDS_ADDRESS.test(text) && !/\b(home|address)\b[^\n]{0,40}:\s*\S/i.test(facts)) gaps.push("no home address is on file");
  if (NEEDS_CARD.test(text) && !/\b(card|visa|amex|mastercard|discover)\b[^\n]{0,60}\d{4}/i.test(facts) && !/\bcard\b[^\n]{0,40}:\s*\S/i.test(facts)) gaps.push("no card is on file");
  if (!gaps.length) return undefined;
  return `${PREFLIGHT_PREFIX} ${gaps.join("; ")}. A missing login is not a blocker yet: the shared browser may already be signed in from an earlier task, and many pages read without an account, so open the site and see. If it does ask you to sign in, or a step needs the missing address or card, ask the user in one line for exactly that (or to add it under Settings > Logins) and stop; do not guess, do not try a login you do not have, and do not spend steps working around it.)`;
}

// ---------------------------------------------------------------- Routes not yet tried (B2)

export const ROUTES_PREFIX = "(The page has not changed after your last two actions.";
const BROWSER_ACTION = /^browser_(goto|click|type|select|press|scroll|back|fill_form|run_path)$/;

/** The first two lines of a browser result (title and URL): the page state, cheap to compare. */
function pageSignature(content: string): string {
  const lines = content.split("\n").filter((l) => l.trim());
  // The title with its counts blurred ("Cart (3)" and "Cart (4)" are one page); the URL without its query.
  const title = (lines[0] ?? "").replace(/\d+/g, "#").slice(0, 120);
  const url = (lines[1] ?? "").replace(/[?#].*$/, "").slice(0, 120);
  return `${title} | ${url}`;
}

/**
 * Whether the last three browser actions all came back with the same page: two attempts changed
 * nothing. Different actions on the same stuck page are not a loop (the loop guard needs identical
 * calls), but they are the moment a person would try a different route.
 */
export function pageStuck(messages: ChatMessage[]): boolean {
  const sigs: string[] = [];
  const calls = new Map<string, string>();
  for (let i = taskStart(messages); i < messages.length; i++) {
    const m = messages[i];
    for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
    if (m.role === "tool" && typeof m.content === "string" && BROWSER_ACTION.test(calls.get(m.tool_call_id ?? "") ?? "") && !/^Tool .* failed/.test(m.content)) sigs.push(pageSignature(m.content));
  }
  if (sigs.length < 3) return false;
  const last = sigs.slice(-3);
  return last.every((s) => s === last[0] && s.length > 0);
}

/** URLs already navigated to in this task. */
function visitedUrls(messages: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (let i = taskStart(messages); i < messages.length; i++) {
    for (const c of messages[i].tool_calls ?? []) {
      if (c.function.name !== "browser_goto" && c.function.name !== "browser_open") continue;
      try {
        const url = String((JSON.parse(c.function.arguments || "{}") as { url?: string }).url ?? "");
        if (url) out.add(url.replace(/\/$/, ""));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * The routes this task has not tried yet, from the site note (its URLs and recorded paths), the
 * playbook, and the tools a stuck model forgets: browser_find for the control by its label,
 * browser_fill_form, web_search for the direct page, a fresh login, escalate_model.
 */
export async function stuckRoutesNote(t: Tenant, row: SessionRow): Promise<string> {
  const text = taskUserText(row.messages);
  const visited = visitedUrls(row.messages);
  const urls = new Set<string>();
  const paths: string[] = [];
  const sites = new Set<string>(sitesIn(text));
  for (const u of visited) {
    try {
      sites.add(new URL(u).hostname.replace(/^www\./, ""));
    } catch {
      /* ignore */
    }
  }
  for (const site of sites) {
    const note = await readMemory(t, `sites/${site}.md`).catch(() => null);
    if (!note) continue;
    for (const m of note.matchAll(/https?:\/\/[^\s)>"']+/g)) if (!visited.has(m[0].replace(/\/$/, ""))) urls.add(m[0]);
    for (const p of parsePaths(note)) paths.push(`${p.name} on ${site}`);
  }
  const routes: string[] = [];
  if (urls.size) routes.push(`direct URLs from your site notes you have not opened: ${[...urls].slice(0, 5).join(", ")}`);
  if (paths.length) routes.push(`recorded paths you can replay with browser_run_path: ${paths.slice(0, 4).join("; ")}`);
  routes.push("browser_find with the label of the control you want, then click it by text (a numbered ref may be stale or hidden)", "browser_fill_form for a whole form at once", "browser_wait_for the text you expect, then a fresh browser_snapshot", "web_search for the exact page (\"site:<domain> <what you need>\") and open that URL", "a login wall means login(domain) first", "escalate_model if the page is genuinely beyond you");
  return `${ROUTES_PREFIX} Do not repeat them. Take a different route now, in this order of cost: ${routes.join("; ")}. If none works, stop and tell the user in one line exactly what the page does and what you need.)`;
}

// ---------------------------------------------------------------- Value at stake (C3)

/** The largest dollar amount the request names, in USD; undefined when it names none. */
export function valueAtStake(text: string): number | undefined {
  const amounts = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
  return amounts.length ? Math.max(...amounts) : undefined;
}

/** Below this amount a task is small: it never climbs above the task tier and its spend cap follows the amount. */
export const SMALL_VALUE_USD = Number(process.env.VALUE_SMALL_USD ?? 30);
/** A task may spend this share of the money at stake before it stops with a summary (floor: the lookup budget). */
const VALUE_BUDGET_SHARE = Number(process.env.VALUE_BUDGET_SHARE ?? 0.15);

/** The spend cap for a task that names an amount: a share of the amount, never below the floor nor above the class cap. */
export function valueBudgetCents(amountUsd: number, floorCents: number, capCents: number): number {
  const byValue = Math.round(amountUsd * 100 * VALUE_BUDGET_SHARE);
  return Math.min(capCents > 0 ? capCents : Number.MAX_SAFE_INTEGER, Math.max(floorCents, byValue));
}

/** Whether the ladder stops paying: a small amount at stake and a tier above the task tier asked for. */
export function tooDearForValue(text: string, wanted: Tier): boolean {
  const amount = valueAtStake(text);
  return amount !== undefined && amount < SMALL_VALUE_USD && RANK[wanted] > RANK.task;
}

// ---------------------------------------------------------------- Hand-off (C6, B9)

export const HANDOFF_PREFIX = "(Hand-off from the previous model:";
/** Messages kept whole just before the hand-off, so the new model sees the last page and the last steps. */
const HANDOFF_TAIL = Number(process.env.HANDOFF_TAIL ?? 6);

/** The prompt the departing model gets: ten lines, plain, everything the next model needs and nothing it does not. */
export const HANDOFF_REQUEST = "(You are handing this task to a stronger model. Write a hand-off of at most ten short lines, plain text, no tool calls: 1) the goal in the user's words, 2) what is established so far (figures, ids, confirmation numbers, what the page shows now and its URL), 3) what you tried that failed and why, 4) the next thing to try. Nothing else.)";

/**
 * After a hand-off, the new model should read the first request, the hand-off, and the last few
 * turns, not forty turns of the previous model's flailing at full price. Everything between the
 * task's first message and the tail before the hand-off is dropped; the cut is fixed by the hand-off's
 * position, so the prefix stays identical (and cached) on every later turn.
 */
export function compactAfterHandoff(messages: ChatMessage[]): ChatMessage[] {
  const start = taskStart(messages);
  let h = -1;
  for (let i = messages.length - 1; i > start; i--) if (messages[i].role === "user" && messageText(messages[i]).startsWith(HANDOFF_PREFIX)) h = i;
  if (h < 0) return messages;
  let keepFrom = Math.max(start + 1, h - HANDOFF_TAIL);
  // Never start the kept tail on a tool result without its call.
  while (keepFrom < h && messages[keepFrom].role === "tool") keepFrom++;
  if (keepFrom <= start + 1) return messages;
  return [...messages.slice(0, start + 1), { role: "user", content: "(Earlier steps on this task were dropped after the hand-off below; it says what matters.)" }, ...messages.slice(keepFrom)];
}

// ---------------------------------------------------------------- Plan on the judgment model, click on the task model (C2)

/** Turns made only of these are clicking and reading: the task model drives them on a hard-tier task. */
const MECHANICAL = new Set(["browser_open", "browser_goto", "browser_click", "browser_type", "browser_select", "browser_press", "browser_scroll", "browser_text", "browser_snapshot", "browser_screenshot", "browser_wait_for", "browser_find", "browser_fill_form", "browser_extract", "browser_run_path", "browser_tabs", "browser_tab", "browser_back", "web_search", "fetch_page", "memory_read", "memory_grep", "memory_list", "list_items", "tell_user", "login", "track_package"]);
/** Words in a tool result that mean a counterparty or the site is pushing back: judgment from here. */
const DECISION = /\b(denied|declined|refus|not eligible|ineligible|unable to|we can'?t|cannot|sorry|unfortunately|policy|dispute|chargeback|final|no longer|error|failed|captcha|verify (?:you|your identity)|representative|agent will|chat with|call us|offer|settle|counter)\b/i;
/** How many hard-tier turns open a task on the judgment model before clicking may move down. */
const PLAN_TURNS = Number(process.env.HARD_PLAN_TURNS ?? 2);

/**
 * On a hard-tier task, the judgment model plans and decides; the task model clicks. A turn runs on
 * the task model when the task is past its opening turns, the previous turn was purely mechanical,
 * its results show no push-back, and no host note is pending. Everything else (the plan, a checkpoint,
 * a message to a counterparty, a failure, a nudge, the report) is the judgment model's. Returns the
 * model for the next turn, or undefined to keep the session's own.
 */
export function splitTurnModel(row: SessionRow, taskModel: string, t?: Tenant): string | undefined {
  if ((process.env.HARD_SPLIT ?? "on") === "off") return undefined;
  if (row.kind !== "chat" && row.kind !== "task") return undefined;
  if (RANK[tierOfModel(row.model ?? "", t)] < RANK.hard) return undefined;
  const messages = row.messages;
  const start = taskStart(messages);
  let turns = 0;
  let lastAssistant = -1;
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && !m.ephemeral) {
      turns++;
      lastAssistant = i;
    }
  }
  if (turns < PLAN_TURNS || lastAssistant < 0) return undefined;
  const last = messages[messages.length - 1];
  if (last.role === "user") return undefined; // a host note, a nudge, a steer: judgment
  const calls = messages[lastAssistant].tool_calls ?? [];
  if (!calls.length || !calls.every((c) => MECHANICAL.has(c.function.name))) return undefined;
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && DECISION.test(m.content.slice(0, 3000))) return undefined;
  }
  return taskModel;
}

/** The note that sends a draft report written by the task model back to the judgment model. */
export const SPLIT_REPORT_NOTE = "(That draft was written by the assistant model that handled the clicking. You are the model in charge of this task: check the figures against what was read, keep what is right, fix what is not, and send the final report yourself as if for the first time. Never mention the draft or this note.)";
