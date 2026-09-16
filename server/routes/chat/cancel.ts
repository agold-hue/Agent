import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { closeTab } from "../../../lib/browser-tools.js";
import { cancelSession, ownSession } from "../../../lib/sessions.js";

/**
 * POST { id } -> stops a parallel task (terminated) or the chat thread's current work (idle). The
 * worker drops the session at its next step; a task's browser tab is closed; the browser itself
 * stays for whatever else is using it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const id = String((req.body as { id?: unknown })?.id ?? "");
  const row = id ? await ownSession(t.id, id) : undefined;
  if (!row) return res.status(404).json({ error: "not your session" });
  if (row.status !== "running" && row.status !== "waiting") return res.status(200).json({ ok: true, status: row.status });
  await cancelSession(row, row.kind === "task" ? "Stopped that task." : "Stopped.");
  if (row.kind === "task") await closeTab(row).catch(() => {});
  return res.status(200).json({ ok: true, status: row.kind === "task" ? "terminated" : "idle" });
}
