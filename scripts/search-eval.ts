/**
 * Run the search golden set through the lookup pipeline and print the answer-found rate, the median
 * time and the cost per success. Records the run in search_evals (skip with --no-record).
 *
 *   DATABASE_URL=... LLM_API_KEY=... npm run eval:search -- [--limit 10] [--offset 0] [--concurrency 3] [--no-record]
 */
import { closeDb, ensureSchema } from "../lib/db.js";
import { modelFor } from "../lib/router.js";
import { runSearchEval } from "../lib/search-eval.js";
import { localeFor } from "../lib/search.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const record = !process.argv.includes("--no-record");
if (record) await ensureSchema();
const runId = `manual-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
const summary = await runSearchEval({
  runId,
  model: process.env.SEARCH_EVAL_MODEL || modelFor("chat"),
  locale: localeFor({ timezone: process.env.SEARCH_EVAL_TZ || "America/New_York", settings: {} }),
  limit: arg("limit") ? Number(arg("limit")) : undefined,
  offset: Number(arg("offset", "0")),
  concurrency: Number(arg("concurrency", "3")),
  record,
  log: (line) => console.log(line),
});
console.log(`\n${summary.run_id}: ${summary.ok}/${summary.total} answered (${Math.round(summary.rate * 100)}%), median ${(summary.median_ms / 1000).toFixed(1)}s, ${summary.pages_per_question} pages/question, ${summary.cost_cents.toFixed(2)}c total, ${summary.cost_per_success_cents.toFixed(3)}c per success`);
await closeDb().catch(() => {});
