import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { browserbase, liveViewUrl, releaseBrowser } from "../../lib/browser.js";
import { q } from "../../lib/db.js";
import { env } from "../../lib/env.js";

/**
 * The customer's hosted browser sessions: which task used each one, its state, a live view while it
 * runs and the recording afterwards. GET lists the latest; DELETE ?id= releases a running one.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (!env.browserbase.configured()) return res.status(200).json({ configured: false, items: [] });
  if (req.method === "DELETE") {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const owned = await q<{ id: string }>("select id from agent_sessions where user_id = $1 and browserbase_session_id = $2 limit 1", [t.id, id]);
    if (!id || !owned.length) return res.status(404).json({ error: "not your session" });
    await releaseBrowser(id);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "GET") return res.status(405).end();
  const rows = await q<{ id: string; title: string | null; kind: string; status: string; browserbase_session_id: string; created_at: Date; updated_at: Date }>(
    "select id, title, kind, status, browserbase_session_id, created_at, updated_at from agent_sessions where user_id = $1 and browserbase_session_id is not null order by updated_at desc limit 12",
    [t.id],
  );
  // One browser can serve several tasks (each in its own tab): list it once, naming all of them.
  const byBrowser = new Map<string, typeof rows>();
  for (const r of rows) byBrowser.set(r.browserbase_session_id, [...(byBrowser.get(r.browserbase_session_id) ?? []), r]);
  const items = await Promise.all(
    [...byBrowser.values()].map(async (group) => {
      const r = group[0];
      let state = "unknown";
      let startedAt: string | null = null;
      let endedAt: string | null = null;
      let liveView: string | null = null;
      try {
        const s = await browserbase().sessions.retrieve(r.browserbase_session_id);
        state = s.status.toLowerCase();
        startedAt = s.startedAt ?? null;
        endedAt = s.endedAt ?? null;
        if (s.status === "RUNNING") liveView = await liveViewUrl(r.browserbase_session_id).catch(() => null);
      } catch {
        /* session no longer known to Browserbase */
      }
      return {
        browser_session_id: r.browserbase_session_id,
        task: group.map((g) => g.title || g.kind).join(" · "),
        task_status: group.some((g) => g.status === "running") ? "running" : group.some((g) => g.status === "waiting") ? "waiting" : r.status,
        state,
        started_at: startedAt,
        ended_at: endedAt,
        live_view_url: liveView,
        recording_url: `https://www.browserbase.com/sessions/${r.browserbase_session_id}`,
      };
    }),
  );
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ configured: true, items });
}
