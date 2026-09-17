import { q } from "./db.js";
import type { Tier } from "./router.js";
import { playbooksFor } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * Adaptive tiers. The static router guesses a tier from words; this remembers how each kind of task
 * actually ended for this customer and starts the next one on the cheapest tier that has a clean
 * record. Promotion still happens the usual way (escalation, the loop guard, hard sites), so a wrong
 * guess costs one failed attempt, never a lost task.
 */
export const ADAPTIVE_MIN_SUCCESSES = Number(process.env.ADAPTIVE_MIN_SUCCESSES ?? 3);
/** Failures on the router's tier for a class, in the window, that send the next task of that class up a tier. */
export const ADAPTIVE_MIN_FAILURES = Number(process.env.ADAPTIVE_MIN_FAILURES ?? 2);
const LOOKBACK_DAYS = Number(process.env.ADAPTIVE_LOOKBACK_DAYS ?? 60);
const BELOW: Record<Tier, Tier | undefined> = { max: "hard", hard: "task", task: "chat", chat: undefined };
const ABOVE: Record<Tier, Tier | undefined> = { chat: "task", task: "hard", hard: "max", max: undefined };

/** The kind of task a request is, by the playbook it touches: money, shopping, travel, ... or general. */
export function taskClassKey(text: string): string {
  return playbooksFor(text)[0] ?? "general";
}

export async function recordOutcome(t: Tenant, sessionId: string, cls: string, tier: Tier, ok: boolean): Promise<void> {
  await q("insert into task_outcomes (user_id, class, tier, ok, session_id) values ($1,$2,$3,$4,$5)", [t.id, cls, tier, ok, sessionId]);
}

/**
 * The tier to start on. One below the router's pick when this customer's history on that lower tier
 * for this class is at least ADAPTIVE_MIN_SUCCESSES successes and no failures in the lookback window;
 * one above it when the history on the router's own tier for this class is ADAPTIVE_MIN_FAILURES or
 * more failures and more failures than successes. The cheap defaults stay cheap where they work and
 * step aside where they have shown they do not, without a person tuning anything.
 */
export async function adaptiveTier(t: Tenant, text: string, tier: Tier): Promise<Tier> {
  if ((process.env.ADAPTIVE_TIERS ?? "on") === "off") return tier;
  const lower = BELOW[tier];
  const upper = ABOVE[tier];
  const cls = taskClassKey(text);
  const rows = await q<{ tier: Tier; ok: boolean; n: string }>("select tier, ok, count(*)::text as n from task_outcomes where user_id = $1 and class = $2 and tier = any($3::text[]) and created_at > now() - ($4 || ' days')::interval group by tier, ok", [t.id, cls, [tier, lower].filter(Boolean), String(LOOKBACK_DAYS)]).catch(() => []);
  const count = (which: Tier | undefined, ok: boolean) => Number(rows.find((x) => x.tier === which && x.ok === ok)?.n ?? 0);
  if (lower && shouldStepDown(count(lower, true), count(lower, false))) return lower;
  if (upper && shouldStepUp(count(tier, true), count(tier, false))) return upper;
  return tier;
}

/** Pure part of the rule, for tests. */
export function shouldStepDown(wins: number, losses: number): boolean {
  return wins >= ADAPTIVE_MIN_SUCCESSES && losses === 0;
}

/** Pure part of the step-up rule, for tests. */
export function shouldStepUp(wins: number, losses: number): boolean {
  return losses >= ADAPTIVE_MIN_FAILURES && losses > wins;
}
