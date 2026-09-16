import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { one, q } from "../../lib/db.js";
import type { ChatMessage } from "../../lib/llm.js";
import { messageText, type SessionRow } from "../../lib/sessions.js";

/**
 * The task board. GET -> every session of the last day plus anything still running or waiting, with a
 * result line, step count and cost. GET ?id= -> one task with its step log (what it called, when, how
 * long) so a task can be audited after the fact.
 */
const LABEL: Record<string, string> = { chat: "Chat", task: "Task", review: "Morning brief", weekly: "Week ahead", followup: "Follow-up", triage: "Mail", digest: "Heads-ups", correspondence: "Reply", inbox: "Inbox sweep" };

function resultOf(row: SessionRow): string {
  for (let i = row.messages.length - 1; i >= 0; i--) {
    const m = row.messages[i];
    if (m.role === "assistant" && !m.ephemeral && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) return m.content.trim().slice(0, 300);
  }
  return (row.last_report ?? "").slice(0, 300);
}

function requestOf(row: SessionRow): string {
  for (const m of row.messages) if (m.role === "user" && !m.ephemeral && messageText(m).startsWith("[")) return messageText(m).replace(/^\[[^\]]+\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").slice(0, 200);
  return row.title ?? "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (req.method !== "GET") return res.status(405).end();
  res.setHeader("Cache-Control", "no-store");
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (id) {
    const row = await one<SessionRow>("select * from agent_sessions where id = $1 and user_id = $2", [id, t.id]);
    if (!row) return res.status(404).json({ error: "not found" });
    const steps: Array<{ at: string | null; tool: string; args: string; result: string }> = [];
    const results = new Map<string, string>();
    for (const m of row.messages) if (m.role === "tool" && m.tool_call_id && typeof m.content === "string") results.set(m.tool_call_id, m.content);
    for (const m of row.messages as ChatMessage[]) {
      if (m.role !== "assistant") continue;
      for (const c of m.tool_calls ?? []) steps.push({ at: m.at ?? null, tool: c.function.name, args: c.function.arguments.slice(0, 300), result: (results.get(c.id) ?? "").slice(0, 300) });
    }
    return res.status(200).json({ id: row.id, kind: row.kind, label: LABEL[row.kind] ?? row.kind, title: row.title, status: row.status, request: requestOf(row), result: resultOf(row), steps, turns: row.turns, cost_usd: Number(row.cost_cents) / 100, model: row.model, created_at: row.created_at, updated_at: row.updated_at });
  }
  const rows = await q<SessionRow>(
    "select * from agent_sessions where user_id = $1 and (status in ('running', 'waiting') or updated_at > now() - interval '1 day') order by (status in ('running','waiting')) desc, updated_at desc limit 80",
    [t.id],
  );
  const items = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: LABEL[row.kind] ?? row.kind,
    title: row.title,
    request: requestOf(row),
    status: row.status,
    pending: row.pending_kind,
    result: resultOf(row),
    turns: row.turns,
    cost_usd: Math.round(Number(row.cost_cents)) / 100,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return res.status(200).json({ items });
}
