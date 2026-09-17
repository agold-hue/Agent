import { one, q } from "./db.js";
import { complete } from "./llm.js";
import { appendMemory, readMemory, writeMemory } from "./memory.js";
import { modelFor } from "./router.js";
import type { ChatMessage } from "./llm.js";
import type { Tenant } from "./tenant.js";

/**
 * Getting better with every task.
 *
 * The agent used to learn only when it remembered to write itself a note, which is exactly when a
 * struggling task has no attention to spare. Learning is now the host's job and runs after every
 * finished task, win or lose:
 *
 *  1. a cheap model reads the task and writes down what would make the next one faster,
 *  2. the result is stored as small, scoped lessons (per site, per kind of task, or general),
 *  3. the lessons that match the next request are injected into its prompt before it starts,
 *  4. a lesson that was in the prompt of a task that succeeded gains confidence; one in the prompt of
 *     a task that failed loses some, and a lesson that keeps losing stops being injected,
 *  5. per-site stats (success rate, how long pages take to become usable, whether it throws bot
 *     checks) tune the browser itself on the next visit.
 *
 * All of it is per customer: one person's Con Edison quirks never leak into another's prompt.
 */

export type Outcome = "success" | "partial" | "failed" | "blocked" | "unknown";

export interface Lesson {
  id: string;
  scope: string;
  topic: string;
  lesson: string;
  keywords: string;
  confidence: number;
  uses: number;
}

const MAX_INJECTED = Number(process.env.LESSONS_IN_PROMPT ?? 6);
const MIN_CONFIDENCE = Number(process.env.LESSON_MIN_CONFIDENCE ?? 0.25);

/** Store a lesson, merging with one already held for the same scope and topic. */
export async function upsertLesson(t: Tenant, l: { scope?: string; topic: string; lesson: string; keywords?: string; sessionId?: string | null }): Promise<void> {
  const topic = l.topic.toLowerCase().trim().slice(0, 80);
  const text = l.lesson.trim().slice(0, 600);
  if (!topic || !text) return;
  await q(
    `insert into lessons (user_id, scope, topic, lesson, keywords, session_id)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (user_id, scope, topic) do update
       set lesson = excluded.lesson,
           keywords = case when length(excluded.keywords) > length(lessons.keywords) then excluded.keywords else lessons.keywords end,
           confidence = least(1.0, lessons.confidence + 0.1),
           updated_at = now()`,
    [t.id, (l.scope ?? "general").toLowerCase().slice(0, 80), topic, text, (l.keywords ?? "").toLowerCase().slice(0, 300), l.sessionId ?? null],
  );
}

/** Domains a request or a conversation touched, for scoping lessons and site stats. */
export function domainsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([\w.-]+)/g)) out.add(m[1].replace(/^www\./, "").toLowerCase());
  for (const m of text.matchAll(/\b([a-z0-9-]{2,}\.(?:com|net|org|gov|edu|co|io|us|co\.uk))\b/gi)) out.add(m[1].replace(/^www\./, "").toLowerCase());
  return [...out].slice(0, 6);
}

const STOP = new Set("the a an and or of for to in on my me i is are was it that this with from at by please can you your our their".split(" "));

function words(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9.'-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));
}

/**
 * The lessons worth spending prompt on for this request: anything scoped to a site it names, plus the
 * best keyword matches, best first. Confidence-weighted, so a rule that has been wrong twice drops out.
 */
export async function relevantLessons(t: Tenant, task: string, limit = MAX_INJECTED): Promise<Lesson[]> {
  const rows = await q<Lesson>("select id, scope, topic, lesson, keywords, confidence, uses from lessons where user_id = $1 and confidence >= $2 order by updated_at desc limit 200", [t.id, MIN_CONFIDENCE]).catch(() => [] as Lesson[]);
  if (!rows.length) return [];
  const sites = new Set(domainsIn(task));
  const w = new Set(words(task));
  const scored = rows.map((r) => {
    let score = 0;
    const scopeSite = r.scope.startsWith("site:") ? r.scope.slice(5) : "";
    if (scopeSite && [...sites].some((s) => s === scopeSite || s.endsWith(`.${scopeSite}`) || scopeSite.endsWith(`.${s}`))) score += 6;
    if (scopeSite && w.has(scopeSite.split(".")[0])) score += 4;
    for (const k of r.keywords.split(/[,\s]+/).filter(Boolean)) if (w.has(k)) score += 1.5;
    for (const k of words(r.topic)) if (w.has(k)) score += 1;
    if (r.scope === "general") score += 0.4;
    return { r, score: score * (0.5 + Number(r.confidence)) };
  });
  return scored
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.r);
}

/** The block appended to the system prompt. Kept last so the cached prefix above it never moves. */
export async function lessonsBlock(t: Tenant, task: string): Promise<string> {
  const rows = await relevantLessons(t, task).catch(() => [] as Lesson[]);
  if (!rows.length) return "";
  await q("update lessons set uses = uses + 1 where id = any($1::uuid[])", [rows.map((r) => r.id)]).catch(() => {});
  const lines = rows.map((r) => `- ${r.scope !== "general" ? `(${r.scope}) ` : ""}${r.lesson.replace(/\s+/g, " ")}`);
  return `# What you learned from earlier tasks (apply it before exploring)\n${lines.join("\n")}`;
}

/** A task finished: the lessons it was given were either vindicated or not. */
export async function reinforce(t: Tenant, task: string, outcome: Outcome): Promise<void> {
  if (outcome === "unknown") return;
  const rows = await relevantLessons(t, task).catch(() => [] as Lesson[]);
  if (!rows.length) return;
  const good = outcome === "success" || outcome === "partial";
  await q(
    `update lessons set ${good ? "wins = wins + 1, confidence = least(1.0, confidence + 0.08)" : "losses = losses + 1, confidence = greatest(0.0, confidence - 0.15)"}, updated_at = now() where id = any($1::uuid[])`,
    [rows.map((r) => r.id)],
  ).catch(() => {});
}

// ---------------------------------------------------------------- per-site stats

export interface SiteStat {
  domain: string;
  attempts: number;
  successes: number;
  captchas: number;
  settle_ms: number;
}

/** One visit's worth of evidence about a site. Settle time is a rolling average, so the wait self-tunes. */
export async function noteSiteVisit(t: Tenant, domain: string, v: { ok?: boolean; captcha?: boolean; settleMs?: number }): Promise<void> {
  const d = domain.replace(/^www\./, "").toLowerCase().slice(0, 120);
  if (!d || !d.includes(".")) return;
  await q(
    `insert into site_stats (user_id, domain, attempts, successes, captchas, settle_ms, last_ok_at, last_seen_at)
     values ($1,$2,1,$3,$4,$5,$6, now())
     on conflict (user_id, domain) do update set
       attempts = site_stats.attempts + 1,
       successes = site_stats.successes + $3,
       captchas = site_stats.captchas + $4,
       settle_ms = case when $5 > 0 then (site_stats.settle_ms * 3 + $5) / 4 else site_stats.settle_ms end,
       last_ok_at = coalesce($6, site_stats.last_ok_at),
       last_seen_at = now()`,
    [t.id, d, v.ok ? 1 : 0, v.captcha ? 1 : 0, Math.max(0, Math.round(v.settleMs ?? 0)), v.ok ? new Date() : null],
  ).catch(() => {});
}

/** What we know about a site before we open it: how long its pages take, whether it walls us. */
export async function siteStat(t: Tenant, domain: string): Promise<SiteStat | null> {
  const d = domain.replace(/^www\./, "").toLowerCase();
  return (await one<SiteStat>("select domain, attempts, successes, captchas, settle_ms from site_stats where user_id = $1 and domain = $2", [t.id, d]).catch(() => null)) ?? null;
}

// ---------------------------------------------------------------- reflection

const REFLECT_SYSTEM = `You turn one finished task into durable lessons for an assistant that will do similar work again.

Answer with JSON only, no prose, in this shape:
{"outcome":"success|partial|failed|blocked","blocker":"<one line, or empty>","lessons":[{"scope":"site:<domain>|kind:<word>|general","topic":"<3-6 word key>","lesson":"<one or two lines, imperative, concrete>","keywords":"<comma separated>"}],"site_notes":[{"domain":"<domain>","fast_path":"<the exact URLs and clicks that got the result>","quirks":"<what broke and the workaround>"}]}

Rules:
- At most three lessons, and only ones that would actually change what the next task does. No platitudes ("be careful", "check the details").
- A lesson is a rule, not a diary entry: "On coned.com the balance is on /accounts-billing/my-account/view-bill, not the dashboard" — not "I looked at the dashboard".
- If nothing durable was learned, return an empty lessons array.
- outcome "blocked" means an outside wall (a bot check, a missing login, a code that never came); "failed" means it went wrong on our side.`;

export interface ReflectInput {
  sessionId: string;
  kind: string;
  request: string;
  report: string;
  steps: number;
  seconds: number;
  costCents: number;
  /** The tail of the conversation: enough to see what was tried. */
  context: ChatMessage[];
}

interface ReflectJson {
  outcome?: string;
  blocker?: string;
  lessons?: Array<{ scope?: string; topic?: string; lesson?: string; keywords?: string }>;
  site_notes?: Array<{ domain?: string; fast_path?: string; quirks?: string }>;
}

/**
 * Called after every task, in the background. One cheap call, capped output: on a busy month this is
 * a fraction of a cent per task, and it is the only reason the tenth Con Edison bill takes five steps
 * instead of thirty.
 */
export async function reflect(t: Tenant, input: ReflectInput): Promise<Outcome> {
  const outcomeGuess = guessOutcome(input.report);
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: REFLECT_SYSTEM },
      {
        role: "user",
        content: `Request: ${input.request.slice(0, 600)}\n\nWhat the assistant did (tail of the run):\n${transcriptOf(input.context).slice(0, 6000)}\n\nWhat it finally told the user:\n${input.report.slice(0, 1200)}\n\nIt took ${input.steps} steps and ${Math.round(input.seconds)} seconds. Write the JSON now.`,
      },
    ];
    const c = await complete({ model: modelFor("chat", t), messages, maxTokens: 700, temperature: 0 });
    const text = typeof c.message.content === "string" ? c.message.content : "";
    const parsed = parseJson(text);
    const outcome = normalizeOutcome(parsed?.outcome) ?? outcomeGuess;
    await recordOutcome(t, { ...input, outcome, blocker: parsed?.blocker || undefined });
    for (const l of (parsed?.lessons ?? []).slice(0, 3)) {
      if (!l?.lesson || !l?.topic) continue;
      await upsertLesson(t, { scope: l.scope, topic: l.topic, lesson: l.lesson, keywords: l.keywords, sessionId: input.sessionId });
    }
    for (const n of (parsed?.site_notes ?? []).slice(0, 3)) {
      if (!n?.domain) continue;
      await mergeSiteNote(t, n.domain, { fastPath: n.fast_path, quirks: n.quirks, ok: outcome === "success" });
    }
    await reinforce(t, input.request, outcome);
    return outcome;
  } catch (err) {
    console.error(`[learn] ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    await recordOutcome(t, { ...input, outcome: outcomeGuess }).catch(() => {});
    return outcomeGuess;
  }
}

function transcriptOf(context: ChatMessage[]): string {
  return context
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) return `assistant → ${m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 160)})`).join(", ")}`;
      const text = typeof m.content === "string" ? m.content : "(image)";
      return `${m.role}: ${text.slice(0, 400)}`;
    })
    .join("\n");
}

function parseJson(text: string): ReflectJson | null {
  const body = text.match(/\{[\s\S]*\}/);
  if (!body) return null;
  try {
    return JSON.parse(body[0]) as ReflectJson;
  } catch {
    return null;
  }
}

function normalizeOutcome(s: string | undefined): Outcome | undefined {
  const v = (s ?? "").toLowerCase();
  return v === "success" || v === "partial" || v === "failed" || v === "blocked" ? v : undefined;
}

/** A serviceable guess when the model's own JSON is unusable, from the words of the final report. */
export function guessOutcome(report: string): Outcome {
  const r = report.toLowerCase();
  if (/\b(bot check|captcha|couldn'?t sign|could not sign|needs? (your|a) (code|sign)|blocked|won'?t let me)\b/.test(r)) return "blocked";
  if (/\b(couldn'?t|could not|unable|failed|didn'?t work|no luck|stopped)\b/.test(r)) return "failed";
  if (/\b(done|booked|paid|ordered|sent|confirmed|cancelled|scheduled|here'?s|found|it'?s|costs?)\b/.test(r)) return "success";
  return "unknown";
}

async function recordOutcome(t: Tenant, r: { sessionId: string; kind: string; request: string; outcome: Outcome; blocker?: string; steps: number; seconds: number; costCents: number }): Promise<void> {
  const domains = domainsIn(r.request);
  await q(
    "insert into task_reflections (user_id, session_id, kind, request, outcome, blocker, steps, seconds, cost_cents, domains) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [t.id, r.sessionId, r.kind, r.request.slice(0, 1000), r.outcome, r.blocker?.slice(0, 300) ?? null, r.steps, Math.round(r.seconds), Number(r.costCents).toFixed(3), domains],
  ).catch(() => {});
  for (const d of domains) await noteSiteVisit(t, d, { ok: r.outcome === "success" });
}

/**
 * The site note the next visit reads. Kept in the same shape the prompt asks for, updated in place
 * rather than appended, so it never grows into a diary.
 */
export async function mergeSiteNote(t: Tenant, domain: string, n: { fastPath?: string; quirks?: string; ok?: boolean }): Promise<void> {
  const d = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  if (!d.includes(".")) return;
  const path = `sites/${d}.md`;
  const existing = (await readMemory(t, path).catch(() => null)) ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const section = (name: string, body: string | undefined, prev: string) => {
    const kept = prev.trim();
    if (!body?.trim()) return kept ? `## ${name}\n${kept}` : "";
    const lines = [...new Set([body.trim(), ...kept.split("\n").map((l) => l.trim()).filter(Boolean)])].slice(0, 8);
    return `## ${name}\n${lines.join("\n")}`;
  };
  const prev = (name: string) => existing.split(new RegExp(`^## ${name}$`, "m"))[1]?.split(/^## /m)[0] ?? "";
  const head = existing.split(/^## /m)[0].trim() || `# ${d}`;
  const parts = [head, section("Fast path", n.fastPath, prev("Fast path")), section("Quirks", n.quirks, prev("Quirks")), prev("Sign-in").trim() ? `## Sign-in\n${prev("Sign-in").trim()}` : "", prev("Where things live").trim() ? `## Where things live\n${prev("Where things live").trim()}` : "", `## Last verified\n${today}${n.ok ? " (worked)" : ""}`].filter(Boolean);
  await writeMemory(t, path, `${parts.join("\n\n")}\n`);
}

/** "Am I getting better?" — the numbers the weekly review quotes and the morning review acts on. */
export async function learningReport(t: Tenant, days = 7): Promise<string> {
  const rows = await q<{ outcome: string; n: string; secs: string; cost: string }>(
    `select outcome, count(*)::text as n, coalesce(avg(seconds),0)::text as secs, coalesce(sum(cost_cents),0)::text as cost
       from task_reflections where user_id = $1 and created_at > now() - ($2 || ' days')::interval group by outcome`,
    [t.id, String(days)],
  ).catch(() => [] as Array<{ outcome: string; n: string; secs: string; cost: string }>);
  if (!rows.length) return "";
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const ok = rows.filter((r) => r.outcome === "success").reduce((s, r) => s + Number(r.n), 0);
  const blocked = rows.filter((r) => r.outcome === "blocked").reduce((s, r) => s + Number(r.n), 0);
  const avg = rows.reduce((s, r) => s + Number(r.secs) * Number(r.n), 0) / Math.max(1, total);
  const cost = rows.reduce((s, r) => s + Number(r.cost), 0) / 100;
  const lessons = await one<{ n: string }>("select count(*)::text as n from lessons where user_id = $1", [t.id]).catch(() => null);
  const worst = await q<{ domain: string; attempts: number; successes: number }>(
    "select domain, attempts, successes from site_stats where user_id = $1 and attempts >= 2 order by (successes::float / attempts) asc limit 3",
    [t.id],
  ).catch(() => [] as Array<{ domain: string; attempts: number; successes: number }>);
  const lines = [
    `Last ${days} days: ${total} tasks, ${ok} finished clean (${Math.round((ok / Math.max(1, total)) * 100)}%), ${blocked} blocked from outside, ${Math.round(avg)}s each on average, $${cost.toFixed(2)} of model spend.`,
    `${lessons?.n ?? 0} lessons learned and in use.`,
  ];
  if (worst.length) lines.push(`Hardest sites: ${worst.map((w) => `${w.domain} (${w.successes}/${w.attempts})`).join(", ")}.`);
  return lines.join("\n");
}

/** A lesson the model wants to keep on purpose (the record_lesson tool). */
export async function forgetLesson(t: Tenant, topic: string): Promise<boolean> {
  const r = await q("delete from lessons where user_id = $1 and topic = $2 returning id", [t.id, topic.toLowerCase().trim()]).catch(() => [] as unknown[]);
  await appendMemory(t, "history/lessons-removed.md", `\n- ${new Date().toISOString().slice(0, 10)} dropped "${topic}"\n`).catch(() => {});
  return r.length > 0;
}
