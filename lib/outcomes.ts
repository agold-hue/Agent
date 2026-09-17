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
const LOOKBACK_DAYS = Number(process.env.ADAPTIVE_LOOKBACK_DAYS ?? 60);
const BELOW: Record<Tier, Tier | undefined> = { hard: "task", task: "chat", chat: undefined };

/** The kind of task a request is, by the playbook it touches: money, shopping, travel, ... or general. */
export function taskClassKey(text: string): string {
  return playbooksFor(text)[0] ?? "general";
}

export async function recordOutcome(t: Tenant, sessionId: string, cls: string, tier: Tier, ok: boolean): Promise<void> {
  await q("insert into task_outcomes (user_id, class, tier, ok, session_id) values ($1,$2,$3,$4,$5)", [t.id, cls, tier, ok, sessionId]);
}

/**
 * The tier to start on: one below the router's pick when this customer's history on that lower tier
 * for this class is at least ADAPTIVE_MIN_SUCCESSES successes and no failures in the lookback window.
 */
export async function adaptiveTier(t: Tenant, text: string, tier: Tier): Promise<Tier> {
  if ((process.env.ADAPTIVE_TIERS ?? "on") === "off") return tier;
  const lower = BELOW[tier];
  if (!lower) return tier;
  const cls = taskClassKey(text);
  const r = await q<{ ok: boolean; n: string }>("select ok, count(*)::text as n from task_outcomes where user_id = $1 and class = $2 and tier = $3 and created_at > now() - ($4 || ' days')::interval group by ok", [t.id, cls, lower, String(LOOKBACK_DAYS)]).catch(() => []);
  const wins = Number(r.find((x) => x.ok)?.n ?? 0);
  const losses = Number(r.find((x) => !x.ok)?.n ?? 0);
  return wins >= ADAPTIVE_MIN_SUCCESSES && losses === 0 ? lower : tier;
}

/** Pure part of the rule, for tests. */
export function shouldStepDown(wins: number, losses: number): boolean {
  return wins >= ADAPTIVE_MIN_SUCCESSES && losses === 0;
}
