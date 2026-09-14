import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../lib/auth.js";
import { monthUsageCents } from "../lib/sessions.js";
import { env } from "../lib/env.js";
import { one } from "../lib/db.js";
import { sttConfigured } from "../lib/stt.js";
import { agentAddress, updateSettings, type TenantSettings } from "../lib/tenant.js";

const SETTABLE: Array<keyof TenantSettings> = [
  "owner_name",
  "quiet_hours",
  "batch_times",
  "weekly_review",
  "daily_review_hour",
  "auto_approve_max_usd",
  "auto_approve_types",
  "family_emails",
  "cc_owner_on_outbound",
  "observe_forwarded_mail",
  "chat_session_max_age_hours",
  "ask_user_deadline_hours",
  "task_passphrase",
];

/** GET -> the account, its settings and usage. POST { ...settings, name?, timezone? } -> update. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res, { paid: false });
  if (!t) return;

  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of SETTABLE) if (k in body) patch[k] = body[k];
    if (typeof body.name === "string") patch.name = body.name.slice(0, 120);
    if (typeof body.timezone === "string") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
        patch.timezone = body.timezone;
      } catch {
        return res.status(400).json({ error: "invalid timezone" });
      }
    }
    await updateSettings(t, patch as Partial<TenantSettings> & { name?: string; timezone?: string });
  }

  const used = await monthUsageCents(t).catch(() => 0);
  const tok = await one<{ prompt_tokens: string; cached_tokens: string }>("select prompt_tokens::text, cached_tokens::text from usage where user_id = $1 and month = date_trunc('month', now())::date", [t.id]).catch(() => undefined);
  const cacheRate = tok && Number(tok.prompt_tokens) > 0 ? Number(tok.cached_tokens) / Number(tok.prompt_tokens) : 0;
  return res.status(200).json({
    email: t.email,
    name: t.name,
    slug: t.slug,
    agent_email: agentAddress(t),
    timezone: t.timezone,
    settings: t.settings,
    subscription_status: t.subscriptionStatus,
    plan: t.plan,
    current_period_end: t.currentPeriodEnd,
    google_connected: !!t.googleRefreshToken,
    voice_notes: sttConfigured(),
    usage: { month_cents: used, cap_cents: env.plans.monthlyCapUsd(t.plan) * 100, cache_hit_rate: Math.round(cacheRate * 100) / 100 },
  });
}
