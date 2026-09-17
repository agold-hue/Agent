/**
 * Replay a recorded session against a candidate model and score how closely it would have acted.
 * Every turn of the task is re-asked with the same context the original model saw (the shared prompt,
 * the customer block, the thread up to that turn, the same tools); the candidate's choice is compared
 * with what actually happened: the same tool with the same target (URL, ref, text, domain), a text
 * reply where the original replied, and for the final reply whether the figures the original quoted
 * appear in the candidate's. Cost and latency per turn are printed alongside, so a routing or prompt
 * change can be measured on real tasks before it ships.
 *
 *   DATABASE_URL=... LLM_API_KEY=... npm run eval:replay -- --session s_abc [--model deepseek/deepseek-v4-pro] [--turns 20] [--from 0]
 *   npm run eval:replay -- --recent 5 [--model ...]      the last five finished chat/task sessions
 */
import { tools } from "../lib/agent-config.js";
import { closeDb, ensureSchema, q } from "../lib/db.js";
import { complete, estimateTokens, type ChatMessage } from "../lib/llm.js";
import { reasoningFor, tierOfModel } from "../lib/router.js";
import { compacted, withContextBlock } from "../lib/runtime.js";
import { customerContext, sharedSystem, taskStart, taskUserText, type SessionRow } from "../lib/sessions.js";
import { tenantById } from "../lib/tenant.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

type Turn = { index: number; original: ChatMessage };

function keyArgs(call: { function: { name: string; arguments: string } }): string {
  try {
    const a = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    const keys = ["url", "ref", "text", "label", "domain", "path", "query", "queries", "action", "kind", "title", "to"];
    return keys.map((k) => (a[k] !== undefined ? `${k}=${String(Array.isArray(a[k]) ? (a[k] as unknown[]).join("|") : a[k]).toLowerCase().slice(0, 60)}` : "")).filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

function figures(text: string): string[] {
  return [...new Set([...(text.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map((m) => m.replace(/[$\s,]/g, "")), ...(text.match(/\b[A-Z0-9-]{6,}\b/g) ?? []).filter((c) => /\d/.test(c))])];
}

async function replaySession(row: SessionRow, model: string, maxTurns: number, from: number): Promise<{ turns: number; agree: number; toolAgree: number; toolTurns: number; costCents: number; ms: number; finalOk?: boolean }> {
  const t = (await tenantById(row.user_id))!;
  const start = taskStart(row.messages);
  const system: ChatMessage = { role: "system", content: sharedSystem() };
  const block = await customerContext(t, { task: taskUserText(row.messages), parallel: false });
  const turns: Turn[] = [];
  for (let i = start + 1; i < row.messages.length; i++) {
    const m = row.messages[i];
    if (m.role === "assistant" && !m.ephemeral && !m.superseded) turns.push({ index: i, original: m });
  }
  const picked = turns.slice(from, from + maxTurns);
  let agree = 0;
  let toolAgree = 0;
  let toolTurns = 0;
  let costCents = 0;
  let ms = 0;
  let finalOk: boolean | undefined;
  for (const [n, turn] of picked.entries()) {
    const history = [system, ...row.messages.slice(1, turn.index).filter((m) => !m.ephemeral)];
    const context = withContextBlock(compacted(history), block);
    const started = Date.now();
    let reply: ChatMessage;
    let cost = 0;
    try {
      const c = await complete({ model, messages: context, tools, reasoning: reasoningFor(tierOfModel(model, t)), maxTokens: 1200 });
      reply = c.message;
      cost = (c.usage.cost_usd ?? 0) * 100;
    } catch (err) {
      console.log(`  turn ${n + 1}: provider error ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      continue;
    }
    ms += Date.now() - started;
    costCents += cost;
    const wantCalls = turn.original.tool_calls ?? [];
    const gotCalls = reply.tool_calls ?? [];
    let ok = false;
    let note = "";
    if (wantCalls.length) {
      toolTurns++;
      const want = wantCalls[0];
      const got = gotCalls[0];
      const sameTool = !!got && got.function.name === want.function.name;
      const sameTarget = sameTool && keyArgs(got) === keyArgs(want);
      ok = sameTarget || (sameTool && !keyArgs(want));
      if (sameTool) toolAgree++;
      note = `${want.function.name}${keyArgs(want) ? ` ${keyArgs(want)}` : ""} -> ${got ? `${got.function.name}${keyArgs(got) ? ` ${keyArgs(got)}` : ""}` : `text: ${String(reply.content ?? "").replace(/\s+/g, " ").slice(0, 80)}`}`;
    } else {
      const wantText = String(turn.original.content ?? "");
      const gotText = typeof reply.content === "string" ? reply.content : "";
      ok = !gotCalls.length && gotText.trim().length > 0;
      const wantFigs = figures(wantText);
      const covered = wantFigs.filter((f) => gotText.replace(/[$\s,]/g, "").includes(f));
      if (n === picked.length - 1 && wantFigs.length) finalOk = covered.length === wantFigs.length;
      note = `reply (${wantFigs.length ? `${covered.length}/${wantFigs.length} figures kept` : "no figures"}) -> ${gotCalls.length ? `tool ${gotCalls[0].function.name}` : gotText.replace(/\s+/g, " ").slice(0, 80)}`;
    }
    if (ok) agree++;
    console.log(`  turn ${n + 1}: ${ok ? "agree" : "DIFF "} ${note}  [${((Date.now() - started) / 1000).toFixed(1)}s, ${cost.toFixed(2)}c, ${estimateTokens(context)} tok]`);
  }
  return { turns: picked.length, agree, toolAgree, toolTurns, costCents, ms, finalOk };
}

await ensureSchema();
const model = arg("model") ?? process.env.REPLAY_MODEL ?? "";
const maxTurns = Number(arg("turns", "20"));
const from = Number(arg("from", "0"));
const ids: string[] = [];
if (arg("session")) ids.push(arg("session")!);
if (arg("recent")) ids.push(...(await q<{ id: string }>("select id from agent_sessions where kind in ('chat','task') and status in ('idle','terminated') and turns >= 3 order by updated_at desc limit $1", [Number(arg("recent"))])).map((r) => r.id));
if (!ids.length) {
  console.log("usage: npm run eval:replay -- --session <id> | --recent <n> [--model <id>] [--turns 20] [--from 0]");
  process.exit(1);
}
let sumTurns = 0;
let sumAgree = 0;
let sumCost = 0;
let sumMs = 0;
for (const id of ids) {
  const row = (await q<SessionRow>("select * from agent_sessions where id = $1", [id]))[0];
  if (!row) {
    console.log(`${id}: not found`);
    continue;
  }
  const candidate = model || row.model || "";
  console.log(`\n${row.id} (${row.kind}, ran on ${row.model}) replayed on ${candidate}: "${taskUserText(row.messages).replace(/\s+/g, " ").slice(0, 100)}"`);
  const r = await replaySession(row, candidate, maxTurns, from);
  sumTurns += r.turns;
  sumAgree += r.agree;
  sumCost += r.costCents;
  sumMs += r.ms;
  console.log(`  ${r.agree}/${r.turns} turns agree (${r.toolAgree}/${r.toolTurns} same tool)${r.finalOk !== undefined ? `, final figures ${r.finalOk ? "kept" : "LOST"}` : ""}, ${r.costCents.toFixed(2)}c, ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(`\ntotal: ${sumAgree}/${sumTurns} turns agree (${sumTurns ? Math.round((100 * sumAgree) / sumTurns) : 0}%), ${sumCost.toFixed(2)}c, ${(sumMs / 1000).toFixed(1)}s`);
await closeDb().catch(() => {});
