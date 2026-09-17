import { q } from "./db.js";
import { catalog, modelList } from "./llm.js";
import { loadModelHistory, noteOutcome, poorModels, rankByRecord } from "./model-history.js";
import { choosePoolModel, livePool, type Tier } from "./router.js";
import { playbooksFor } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * Adaptive routing. The static router guesses a tier from words; this remembers how each kind of
 * task actually ended for this customer, by tier, by model and by site, and starts the next one on
 * the cheapest tier and the pool member with a clean record. Promotion still happens the usual way
 * (escalation, the loop guard, hard sites), so a wrong guess costs one failed attempt, never a lost task.
 */
export const ADAPTIVE_MIN_SUCCESSES = Number(process.env.ADAPTIVE_MIN_SUCCESSES ?? 3);
/** Failures on the router's tier for a class, among its recent outcomes, that send the next task of that class up a tier. */
export const ADAPTIVE_MIN_FAILURES = Number(process.env.ADAPTIVE_MIN_FAILURES ?? 2);
const LOOKBACK_DAYS = Number(process.env.ADAPTIVE_LOOKBACK_DAYS ?? 60);
/** A site that beat a tier keeps the next task on that site above it for this long. */
const SITE_MEMORY_DAYS = Number(process.env.ADAPTIVE_SITE_DAYS ?? 30);
/** How many recent outcomes on a tier the step-up rule looks at: an old run of failures is forgiven. */
const RECENT_WINDOW = 6;
/** Every this-many tasks of a class, an untried pool member gets a turn so the record fills in. */
const EXPLORE_EVERY = Number(process.env.POOL_EXPLORE_EVERY ?? 4);
const BELOW: Record<Tier, Tier | undefined> = { max: "hard", hard: "task", task: "chat", chat: undefined };
const ABOVE: Record<Tier, Tier | undefined> = { chat: "task", task: "hard", hard: "max", max: undefined };

/** The kind of task a request is, by the playbook it touches: money, shopping, travel, ... or general. */
export function taskClassKey(text: string): string {
  return playbooksFor(text)[0] ?? "general";
}

export async function recordOutcome(t: Tenant, sessionId: string, cls: string, tier: Tier, ok: boolean, extra: { model?: string; site?: string } = {}): Promise<void> {
  const model = extra.model ? modelList(extra.model)[0] : null;
  await q("insert into task_outcomes (user_id, class, tier, ok, session_id, model, site) values ($1,$2,$3,$4,$5,$6,$7)", [t.id, cls, tier, ok, sessionId, model, extra.site ?? null]);
  if (model) {
    noteOutcome(model, ok);
    console.log(`[outcome] ${model} ${ok ? "ok" : "failed"} (${cls} on ${tier}, ${sessionId})`);
  }
}

type Outcome = { tier: Tier; ok: boolean; model: string | null; site: string | null; created_at: Date };

async function recentOutcomes(t: Tenant, cls: string): Promise<Outcome[]> {
  return q<Outcome>("select tier, ok, model, site, created_at from task_outcomes where user_id = $1 and class = $2 and created_at > now() - ($3 || ' days')::interval order by created_at desc limit 60", [t.id, cls, String(LOOKBACK_DAYS)]).catch(() => []);
}

/**
 * The tier to start on. One below the router's pick when the last ADAPTIVE_MIN_SUCCESSES outcomes of
 * this class on that lower tier were all successes (older failures are forgiven) and the site, when
 * known, has not beaten that tier in the last SITE_MEMORY_DAYS; one above it when the recent outcomes
 * of this class on the router's own tier hold ADAPTIVE_MIN_FAILURES failures and more failures than
 * successes, or the site has beaten this tier twice. The cheap defaults stay cheap where they work and
 * step aside where they have shown they do not, without a person tuning anything.
 */
export async function adaptiveTier(t: Tenant, text: string, tier: Tier, site?: string): Promise<Tier> {
  if ((process.env.ADAPTIVE_TIERS ?? "on") === "off") return tier;
  const lower = BELOW[tier];
  const upper = ABOVE[tier];
  const rows = await recentOutcomes(t, taskClassKey(text));
  const recentOn = (which: Tier, n: number) => rows.filter((r) => r.tier === which).slice(0, n);
  const siteRows = site ? rows.filter((r) => r.site === site && Date.now() - new Date(r.created_at).getTime() < SITE_MEMORY_DAYS * 86_400_000) : [];
  const siteFailures = (which: Tier) => siteRows.filter((r) => r.tier === which && !r.ok).length;
  if (lower) {
    const last = recentOn(lower, ADAPTIVE_MIN_SUCCESSES);
    if (shouldStepDown(last.filter((r) => r.ok).length, last.filter((r) => !r.ok).length) && siteFailures(lower) === 0) return lower;
  }
  if (upper) {
    const last = recentOn(tier, RECENT_WINDOW);
    if (shouldStepUp(last.filter((r) => r.ok).length, last.filter((r) => !r.ok).length) || siteFailures(tier) >= ADAPTIVE_MIN_FAILURES) return upper;
  }
  return tier;
}

/**
 * The model chain to start a new session on: the tier's pool member with the best record for this
 * kind of task (an untried one every EXPLORE_EVERY tasks, so the affordable models all get measured),
 * ahead of the rest of the pool as fallbacks. The two cheap tiers only; the frontier tiers run their
 * primary. The pool comes ordered by the record across customers first (lib/model-history.ts): a
 * member that fails for everyone is at the back, never explored, never the stand-in.
 */
export async function pickModel(t: Tenant, tier: Tier, text: string): Promise<string> {
  await loadModelHistory();
  const pool = rankByRecord(await livePool(tier, t));
  const avoid = new Set(poorModels());
  if (pool.length <= 1 || tier === "hard" || tier === "max" || (process.env.POOL_ROUTING ?? "on") === "off") return pool.join(",");
  const rows = (await recentOutcomes(t, taskClassKey(text))).filter((r) => r.tier === tier);
  const stats = new Map<string, { ok: number; n: number }>();
  for (const r of rows) {
    if (!r.model) continue;
    const s = stats.get(r.model) ?? { ok: 0, n: 0 };
    s.n++;
    if (r.ok) s.ok++;
    stats.set(r.model, s);
  }
  const price = new Map<string, number>();
  for (const m of await catalog().catch(() => [])) price.set(m.id, m.in + m.out);
  // Explore only once the primary has proven itself on this kind of task, and never two tasks in a row.
  const primaryOk = (stats.get(pool[0])?.ok ?? 0) >= 1;
  const explore = primaryOk && EXPLORE_EVERY > 0 && rows.length > 0 && rows.length % EXPLORE_EVERY === EXPLORE_EVERY - 1;
  return choosePoolModel(pool, stats, price, explore, avoid);
}

/** Pure part of the step-down rule, over the last ADAPTIVE_MIN_SUCCESSES outcomes on the lower tier. */
export function shouldStepDown(wins: number, losses: number): boolean {
  return wins >= ADAPTIVE_MIN_SUCCESSES && losses === 0;
}

/** Pure part of the step-up rule, over the recent outcomes on the router's own tier. */
export function shouldStepUp(wins: number, losses: number): boolean {
  return losses >= ADAPTIVE_MIN_FAILURES && losses > wins;
}
