import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { q } from "../../lib/db.js";

/**
 * The user's data is theirs. GET ?export=1 -> everything as one JSON file (memory, conversations,
 * items, receipts without images, wins, follow-ups, standing orders, the list of saved logins without
 * secrets, the files it made, and everything it learned). POST { confirm: <email> } -> deletes the account and everything under it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;
  if (req.method === "GET") {
    const [memories, sessions, items, receipts, wins, followups, orders, logins, files, lessons, outcomes] = await Promise.all([
      q("select path, content, updated_at from memories where user_id = $1 order by path", [t.id]),
      q("select id, kind, title, status, model, messages, turns, cost_cents, created_at, updated_at from agent_sessions where user_id = $1 order by created_at", [t.id]),
      q("select * from tracked_items where user_id = $1 order by created_at", [t.id]),
      q("select id, title, confirmation, details, created_at from receipts where user_id = $1 order by created_at", [t.id]),
      q("select * from wins where user_id = $1 order by created_at", [t.id]),
      q("select * from followups where user_id = $1 order by due", [t.id]),
      q("select * from standing_orders where user_id = $1 order by created_at", [t.id]),
      q("select domain, username, notes, updated_at from credentials where user_id = $1 order by domain", [t.id]),
      q("select id, filename, mime_type, bytes, created_at from agent_files where user_id = $1 order by created_at", [t.id]),
      q("select scope, topic, lesson, keywords, uses, wins, losses, confidence, created_at from lessons where user_id = $1 order by updated_at desc", [t.id]),
      q("select kind, request, outcome, blocker, steps, seconds, cost_cents, domains, created_at from task_reflections where user_id = $1 order by created_at", [t.id]),
    ]);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="secretary-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(JSON.stringify({ exported_at: new Date().toISOString(), account: { email: t.email, name: t.name, timezone: t.timezone, settings: t.settings }, memories, sessions, items, receipts, wins, followups, standing_orders: orders, logins, files, lessons, task_reflections: outcomes }, null, 2));
  }
  if (req.method === "POST") {
    const confirm = String((req.body as { confirm?: unknown })?.confirm ?? "").trim().toLowerCase();
    if (confirm !== t.email) return res.status(400).json({ error: "type your email address to confirm" });
    await q("delete from users where id = $1", [t.id]); // everything else cascades
    res.setHeader("Set-Cookie", "session=; Path=/; Max-Age=0; HttpOnly");
    return res.status(200).json({ deleted: true });
  }
  return res.status(405).end();
}
