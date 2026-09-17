import { q } from "./db.js";

/**
 * The track record per model, across every customer and every kind of task: how often a task it
 * ran ended well (task_outcomes, written by lib/outcomes.ts on every task end, escalation and loop
 * stop). The per-customer, per-class record in lib/outcomes.ts is the fine grain; this is the coarse
 * one that catches a pool member that fails for everyone, and it steers every routing decision that
 * names a tier's model: a new session, a thread re-routed by its next message, escalation, the loop
 * guard, a hard site, a photo, the clicking half of a split turn. A model judged poor goes to the
 * back of its pool (still an outage fallback, never the first choice) and is left out of the
 * catalog fallback chain, until its failures age out of the window and it gets tried again.
 *
 *   MODEL_HISTORY=off              routing ignores the record (it is still written)
 *   MODEL_HISTORY_DAYS=30          how far back outcomes count
 *   MODEL_HISTORY_MIN_TASKS=6      outcomes needed before a model can be judged
 *   MODEL_MIN_SUCCESS_RATE=0.5     below this share of tasks ended well the model is routed around
 */
export interface ModelStats {
  model: string;
  ok: number;
  n: number;
  /** Tasks that ended well as a share of all outcomes. */
  rate: number;
  /** Enough history to judge, and the rate is below MODEL_MIN_SUCCESS_RATE. */
  poor: boolean;
}

const HISTORY_DAYS = Number(process.env.MODEL_HISTORY_DAYS ?? 30);
const MIN_TASKS = Number(process.env.MODEL_HISTORY_MIN_TASKS ?? 6);
const MIN_RATE = Number(process.env.MODEL_MIN_SUCCESS_RATE ?? 0.5);
/** How long a worker keeps a loaded record before re-reading it; an outcome written here refreshes it at once. */
const TTL_MS = Number(process.env.MODEL_HISTORY_TTL_SECONDS ?? 300) * 1000;

let cache: { at: number; stats: Map<string, ModelStats> } | undefined;

/** The first id of a comma-separated chain. */
export function primaryOf(model: string): string {
  return model.split(",")[0]?.trim() ?? model;
}

export function judge(model: string, ok: number, n: number): ModelStats {
  const rate = n ? ok / n : 1;
  return { model, ok, n, rate, poor: n >= MIN_TASKS && rate < MIN_RATE };
}

/** Replace the in-memory record (tests, and loadModelHistory). */
export function setModelHistory(rows: Array<{ model: string; ok: boolean; n?: number }>): Map<string, ModelStats> {
  const counts = new Map<string, { ok: number; n: number }>();
  for (const r of rows) {
    const c = counts.get(r.model) ?? { ok: 0, n: 0 };
    c.n += r.n ?? 1;
    if (r.ok) c.ok += r.n ?? 1;
    counts.set(r.model, c);
  }
  const stats = new Map<string, ModelStats>();
  for (const [model, c] of counts) stats.set(model, judge(model, c.ok, c.n));
  cache = { at: Date.now(), stats };
  return stats;
}

/** Read the last MODEL_HISTORY_DAYS of outcomes into memory; cheap to call often (one query per TTL per worker). */
export async function loadModelHistory(force = false): Promise<Map<string, ModelStats>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.stats;
  try {
    const rows = await q<{ model: string; ok: boolean; n: string | number }>(
      "select model, ok, count(*)::int as n from task_outcomes where model is not null and created_at > now() - ($1 || ' days')::interval group by model, ok",
      [String(HISTORY_DAYS)],
    );
    return setModelHistory(rows.map((r) => ({ model: r.model, ok: r.ok, n: Number(r.n) })));
  } catch (err) {
    console.error(`[models] history: ${err instanceof Error ? err.message : String(err)}`);
    cache ??= { at: Date.now(), stats: new Map() };
    return cache.stats;
  }
}

/** Count one outcome in the loaded record, so the next routing decision in this worker sees it. */
export function noteOutcome(model: string, ok: boolean): void {
  if (!cache) return;
  const id = primaryOf(model);
  const s = cache.stats.get(id) ?? judge(id, 0, 0);
  cache.stats.set(id, judge(id, s.ok + (ok ? 1 : 0), s.n + 1));
}

/** The loaded record (empty until loadModelHistory or setModelHistory ran). */
export function modelHistory(): Map<string, ModelStats> {
  return cache?.stats ?? new Map();
}

export function modelStats(model: string): ModelStats | undefined {
  return modelHistory().get(primaryOf(model));
}

export function historyEnabled(): boolean {
  return process.env.MODEL_HISTORY !== "off";
}

/** True when the record says this model should not be a first choice; unknown models are trusted. */
export function isPoor(model: string): boolean {
  return historyEnabled() && (modelStats(model)?.poor ?? false);
}

export function poorModels(): string[] {
  if (!historyEnabled()) return [];
  return [...modelHistory().values()].filter((s) => s.poor).map((s) => s.model);
}

/**
 * A pool in the order routing should try it: the members with a clean or unknown record in their
 * configured order, then the poor ones, least bad first. Nothing is dropped: a poor model is still
 * better than no model when everything ahead of it is down.
 */
export function rankByRecord(pool: string[]): string[] {
  if (!historyEnabled()) return pool;
  const fine = pool.filter((m) => !isPoor(m));
  const poor = pool.filter((m) => isPoor(m)).sort((a, b) => (modelStats(b)?.rate ?? 0) - (modelStats(a)?.rate ?? 0));
  return [...fine, ...poor];
}
