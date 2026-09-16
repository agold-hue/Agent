import fs from "node:fs";
import path from "node:path";
import { one, q } from "./db.js";
import { lookupAnswer } from "./research.js";
import type { Locale } from "./search.js";

/**
 * The search golden set: real questions with known, stable answers, run through the same lookup
 * pipeline customers get (one search, top pages read, one fast-model reply). Each run records one row
 * per question, so the answer-found rate, the pages read and the cost per success can be watched over
 * time. `npm run eval:search` runs it by hand; with SEARCH_EVAL_NIGHTLY=on the cron runs a rotating
 * slice every night.
 */
export interface GoldenItem {
  q: string;
  /** Regular expressions (case-insensitive); the answer passes when any of them matches. */
  expect: string[];
  note?: string;
}

export interface EvalRow {
  question: string;
  expected: string;
  answer: string | undefined;
  ok: boolean;
  ms: number;
  costCents: number;
  pages: number;
  engine: string;
}

export interface EvalSummary {
  run_id: string;
  total: number;
  ok: number;
  /** Share of questions answered correctly, 0..1. */
  rate: number;
  median_ms: number;
  cost_cents: number;
  cost_per_success_cents: number;
  pages_per_question: number;
  at: string;
}

export function loadGolden(file = path.join(process.cwd(), "eval", "search-golden.json")): GoldenItem[] {
  const items = JSON.parse(fs.readFileSync(file, "utf8")) as GoldenItem[];
  return items.filter((i) => i && typeof i.q === "string" && Array.isArray(i.expect) && i.expect.length);
}

export function passes(answer: string | undefined, expect: string[]): boolean {
  if (!answer) return false;
  const flat = answer.replace(/\s+/g, " ");
  return expect.some((re) => {
    try {
      return new RegExp(re, "i").test(flat);
    } catch {
      return flat.toLowerCase().includes(re.toLowerCase());
    }
  });
}

export function summarize(runId: string, rows: EvalRow[], at = new Date().toISOString()): EvalSummary {
  const ok = rows.filter((r) => r.ok).length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const cost = rows.reduce((s, r) => s + r.costCents, 0);
  return {
    run_id: runId,
    total: rows.length,
    ok,
    rate: rows.length ? ok / rows.length : 0,
    median_ms: ms.length ? ms[Math.floor(ms.length / 2)] : 0,
    cost_cents: Math.round(cost * 1000) / 1000,
    cost_per_success_cents: ok ? Math.round((cost / ok) * 1000) / 1000 : 0,
    pages_per_question: rows.length ? Math.round((rows.reduce((s, r) => s + r.pages, 0) / rows.length) * 10) / 10 : 0,
    at,
  };
}

export async function runSearchEval(opts: { runId: string; model: string; locale: Locale; items?: GoldenItem[]; limit?: number; offset?: number; concurrency?: number; record?: boolean; log?: (line: string) => void }): Promise<EvalSummary> {
  const all = opts.items ?? loadGolden();
  const offset = ((opts.offset ?? 0) % Math.max(1, all.length) + all.length) % Math.max(1, all.length);
  const rotated = [...all.slice(offset), ...all.slice(0, offset)];
  const items = rotated.slice(0, opts.limit ?? all.length);
  const rows: EvalRow[] = [];
  const workers = Math.max(1, Math.min(opts.concurrency ?? 3, items.length));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      let row: EvalRow;
      try {
        const r = await lookupAnswer(item.q, { locale: opts.locale, model: opts.model });
        row = { question: item.q, expected: item.expect.join(" | "), answer: r.answer, ok: passes(r.answer, item.expect), ms: r.ms, costCents: r.costCents, pages: r.outcome.pages.length, engine: r.outcome.engine };
      } catch (err) {
        row = { question: item.q, expected: item.expect.join(" | "), answer: undefined, ok: false, ms: 0, costCents: 0, pages: 0, engine: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
      }
      rows.push(row);
      opts.log?.(`${row.ok ? "PASS" : "FAIL"} ${(row.ms / 1000).toFixed(1)}s ${row.costCents.toFixed(3)}c ${row.pages}p ${row.engine}  ${item.q}\n      -> ${(row.answer ?? "(no answer)").replace(/\s+/g, " ").slice(0, 160)}`);
      if (opts.record !== false) {
        await q("insert into search_evals (run_id, question, expected, answer, ok, ms, cost_cents, pages, engine) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [opts.runId, row.question, row.expected, row.answer ?? null, row.ok, row.ms, row.costCents.toFixed(3), row.pages, row.engine]).catch((err) => opts.log?.(`(not recorded: ${err instanceof Error ? err.message : String(err)})`));
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return summarize(opts.runId, rows);
}

/** The most recent run's summary from the database, for the stats endpoint. */
export async function latestEvalSummary(): Promise<EvalSummary | undefined> {
  try {
    const last = await one<{ run_id: string; at: Date }>("select run_id, max(created_at) as at from search_evals group by run_id order by 2 desc limit 1");
    if (!last) return undefined;
    const rows = await q<{ ok: boolean; ms: number; cost_cents: string; pages: number }>("select ok, ms, cost_cents, pages from search_evals where run_id = $1", [last.run_id]);
    return summarize(
      last.run_id,
      rows.map((r) => ({ question: "", expected: "", answer: undefined, ok: r.ok, ms: Number(r.ms), costCents: Number(r.cost_cents), pages: Number(r.pages), engine: "" })),
      new Date(last.at).toISOString(),
    );
  } catch {
    return undefined;
  }
}

export async function evalRanToday(runId: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from search_evals where run_id = $1", [runId]).catch(() => undefined);
  return Number(r?.n ?? 0) > 0;
}
