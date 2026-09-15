import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { one, q } from "../../../lib/db.js";
import type { ChatMessage } from "../../../lib/llm.js";

/**
 * POST { id, emoji } -> the user's reaction on one of the agent's messages (toggle). The id is the
 * chat item id "<session>-<index>". Stored on the message as `reaction`, which the provider never sees.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const { id, emoji } = (req.body ?? {}) as { id?: string; emoji?: string };
  const m = typeof id === "string" ? id.match(/^(s_[a-z0-9]+)-(\d+)$/) : null;
  if (!m || typeof emoji !== "string" || emoji.length > 16) return res.status(400).json({ error: "id and emoji required" });
  const [, sessionId, idxStr] = m;
  const idx = Number(idxStr);
  const row = await one<{ messages: ChatMessage[] }>("select messages from agent_sessions where id = $1 and user_id = $2", [sessionId, t.id]);
  if (!row || !row.messages[idx] || row.messages[idx].role !== "assistant") return res.status(404).json({ error: "message not found" });
  const current = row.messages[idx].reaction;
  const next = current === emoji ? undefined : emoji;
  if (next) row.messages[idx].reaction = next;
  else delete row.messages[idx].reaction;
  await q("update agent_sessions set messages = $2::jsonb where id = $1", [sessionId, JSON.stringify(row.messages)]);
  return res.status(200).json({ id, reaction: next ?? null });
}
