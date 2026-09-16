import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { q } from "../../lib/db.js";
import { appendMemory, readMemory, writeMemory } from "../../lib/memory.js";

/**
 * Standing orders. Scheduled ones ("daily 09:00", "weekly Sun 18:00", "monthly 20 09:00") are rows the
 * cron fires as their own task; event ones ("when it happens": "pay the water bill when it arrives")
 * are appended to standing_instructions.md, which every task and the mail triage read.
 */
export const SCHEDULE = /^(daily \d{1,2}:\d{2}|weekly (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}|monthly \d{1,2} \d{1,2}:\d{2})$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    const rows = await q("select id, what, schedule, last_run, active, created_at from standing_orders where user_id = $1 order by created_at", [t.id]);
    const notes = ((await readMemory(t, "standing_instructions.md")) ?? "").split("\n## Standing orders\n")[1] ?? "";
    return res.status(200).json({ scheduled: rows, when_it_happens: notes.split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean) });
  }
  if (req.method === "POST") {
    const b = (req.body ?? {}) as { what?: string; schedule?: string };
    const what = String(b.what ?? "").trim().slice(0, 500);
    const schedule = String(b.schedule ?? "").trim();
    if (!what) return res.status(400).json({ error: "what is required" });
    if (schedule === "event") {
      const existing = (await readMemory(t, "standing_instructions.md")) ?? "";
      if (existing.includes("## Standing orders")) await appendMemory(t, "standing_instructions.md", `- ${what}\n`);
      else await writeMemory(t, "standing_instructions.md", `${existing.trimEnd()}\n\n## Standing orders\n- ${what}\n`);
      return res.status(200).json({ ok: true });
    }
    if (!SCHEDULE.test(schedule)) return res.status(400).json({ error: "schedule must be 'daily HH:MM', 'weekly Day HH:MM', 'monthly D HH:MM' or 'event'" });
    const r = await q<{ id: string }>("insert into standing_orders (user_id, what, schedule) values ($1, $2, $3) returning id", [t.id, what, schedule]);
    return res.status(200).json({ ok: true, id: r[0]?.id });
  }
  if (req.method === "DELETE") {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const line = typeof req.query.line === "string" ? req.query.line : "";
    if (id) await q("delete from standing_orders where user_id = $1 and id = $2", [t.id, id]);
    if (line) {
      const existing = (await readMemory(t, "standing_instructions.md")) ?? "";
      await writeMemory(t, "standing_instructions.md", existing.split("\n").filter((l) => l.replace(/^- /, "").trim() !== line).join("\n"));
    }
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}
