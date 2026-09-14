import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env.js";
import { anthropic, lastIdleEvent, latestAgentReport, listAllEvents, pendingCustomToolUses, recordSessionCost } from "../lib/anthropic.js";
import { deferToDigest, notifyOwner, shouldDefer } from "../lib/notify.js";
import { releaseBrowser } from "../lib/browser.js";
import { getSession, updateSession } from "../lib/sessions.js";
import { tenantById } from "../lib/tenant.js";
import { handleCustomTool } from "../lib/tools.js";
import { appendTranscript } from "../lib/transcript.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

function headerMap(req: VercelRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Anthropic -> us, for every tenant's sessions. Subscribe (Console -> Manage -> Webhooks) to
 * session.status_idled, session.status_run_started and session.status_terminated. We look the
 * session up in our table to find the tenant, run tools, and deliver reports.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const body = await rawBody(req);
  let event;
  try {
    event = anthropic().beta.webhooks.unwrap(body, { headers: headerMap(req), key: env.anthropic.webhookSigningKey() });
  } catch {
    return res.status(400).json({ error: "invalid signature" });
  }
  const data = event.data as { type: string; id: string };
  if (!data.type.startsWith("session.")) return res.status(204).end();

  const row = await getSession(data.id);
  if (!row) return res.status(204).end(); // not one of ours
  const t = await tenantById(row.user_id);
  if (!t) return res.status(204).end();

  if (data.type === "session.status_idled") {
    await updateSession(row.id, { status: "idle" });
    const events = await listAllEvents(row.id);
    const idle = lastIdleEvent(events);
    if (!idle) return res.status(204).end();

    if (idle.stop_reason.type === "requires_action") {
      for (const call of pendingCustomToolUses(events)) await handleCustomTool(t, row, call);
      return res.status(200).json({ handled: "tools" });
    }

    await recordSessionCost(t, row.id).catch(() => {});
    if (row.last_replied_idle_id === idle.id) return res.status(200).json({ handled: "duplicate" });
    let report = latestAgentReport(events);
    if (idle.stop_reason.type === "budget_reached") {
      report = `Hit the per-task spend cap, so I paused. Say "continue" if you want me to keep going.\n\n${report}`;
    } else if (idle.stop_reason.type === "retries_exhausted") {
      report = `Something broke on my side and I couldn't finish. Here's where I got to:\n\n${report}`;
    }
    const proactive = ["review", "weekly", "followup", "triage", "digest"].includes(row.kind);
    const silent = /^NO_REPORT\b/.test(report.trim()) && proactive;
    if (report && !silent) {
      const holdable = ["followup", "triage"].includes(row.kind);
      if (holdable && shouldDefer(t, report)) {
        await deferToDigest(t, row.kind === "followup" ? "Follow-up" : "From your mail", report);
      } else {
        await notifyOwner(t, row, report, row.kind === "review" ? "Morning brief" : row.kind === "weekly" ? "Week ahead" : row.kind === "digest" ? "Heads-ups" : undefined);
      }
      await appendTranscript(t, { channel: row.channel, role: "agent", text: report }).catch(() => {});
    }
    await updateSession(row.id, { last_replied_idle_id: idle.id });
    return res.status(200).json({ handled: "reported" });
  }

  if (data.type === "session.status_terminated") {
    await updateSession(row.id, { status: "terminated" });
    await recordSessionCost(t, row.id).catch(() => {});
    if (row.browserbase_session_id) await releaseBrowser(row.browserbase_session_id);
    return res.status(200).json({ handled: "terminated" });
  }

  if (data.type === "session.status_run_started") await updateSession(row.id, { status: "running" });
  return res.status(204).end();
}
