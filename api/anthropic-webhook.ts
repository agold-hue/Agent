import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env.js";
import { anthropic, channelOf, lastIdleEvent, latestAgentReport, listAllEvents, meta, pendingCustomToolUses, setMeta } from "../lib/anthropic.js";
import { notifyOwner } from "../lib/notify.js";
import { releaseBrowser } from "../lib/browser.js";
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
 * Anthropic -> us. Subscribe this endpoint (Console -> Manage -> Webhooks) to
 * session.status_idled and session.status_terminated. Payloads are thin, so we fetch the session
 * and its events and act on the current state. Works for both channels: tools run the same way;
 * the final report goes out by email for email sessions and is picked up by the chat stream otherwise.
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

  const session = await anthropic().beta.sessions.retrieve(data.id).catch(() => undefined);
  if (!session) return res.status(204).end();
  const m = meta(session);
  const channel = channelOf(session);
  if (!channel) return res.status(204).end(); // not one of ours

  if (data.type === "session.status_idled") {
    const events = await listAllEvents(session.id);
    const idle = lastIdleEvent(events);
    if (!idle) return res.status(204).end();

    if (idle.stop_reason.type === "requires_action") {
      for (const call of pendingCustomToolUses(events)) await handleCustomTool(session, call);
      return res.status(200).json({ handled: "tools" });
    }

    if (m.last_replied_idle_id === idle.id) return res.status(200).json({ handled: "duplicate" });
    let report = latestAgentReport(events);
    if (idle.stop_reason.type === "budget_reached") {
      report = `Hit the $${env.policy.sessionBudgetUsd()} cap for this task, so I paused. Say "continue" if you want me to keep going.\n\n${report}`;
    } else if (idle.stop_reason.type === "retries_exhausted") {
      report = `Something broke on my side and I couldn't finish. Here's where I got to:\n\n${report}`;
    }
    // The daily review says NO_REPORT when nothing needs the owner; stay silent then.
    const silent = /^NO_REPORT\b/.test(report.trim()) && !!(m.review_day || m.followup_id);
    if (report && !silent) {
      await notifyOwner(session, report, m.review_day ? `Daily review ${m.review_day}` : undefined);
      await appendTranscript({ channel, role: "agent", text: report }).catch(() => {});
    }
    await setMeta(session.id, { last_replied_idle_id: idle.id });
    return res.status(200).json({ handled: "reported" });
  }

  if (data.type === "session.status_terminated") {
    if (m.browserbase_session_id) await releaseBrowser(m.browserbase_session_id);
    return res.status(200).json({ handled: "terminated" });
  }

  return res.status(204).end();
}
