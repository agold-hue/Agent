import { one, q } from "./db.js";
import { id } from "./ids.js";
import { config } from "./config.js";

/** What the business told us about itself and how it wants the worker to behave. Edited in Settings. */
export interface OrgSettings {
  /** Free text the worker reads on every task: what the business does, addresses, who is who, standing rules. */
  profile?: string;
  /** Free text: how to treat incoming mail (what to act on, what to ignore, who to escalate to). */
  inbox_instructions?: string;
  /** Approvals policy. */
  auto_approve_under_usd?: number;
  auto_approve_kinds?: string[];       // purchase | payment | email | account | cancel | agreement | other
  auto_send_email?: boolean;           // emails to outsiders go without asking
  notify_email?: boolean;              // mail the owners when a task needs them or finishes
  quiet_hours?: string;                // "22-7"
  signature?: string;                  // appended to outbound mail
  locale?: string;
}

export interface Org {
  id: string;
  name: string;
  timezone: string;
  settings: OrgSettings;
  stripe_customer_id: string | null;
  subscription_status: string;
  plan: string;
  current_period_end: Date | null;
  created_at: Date;
}

export interface User {
  id: string;
  org_id: string;
  email: string;
  name: string | null;
  role: "owner" | "member";
  created_at: Date;
  last_login_at: Date | null;
}

export const orgById = (orgId: string) => one<Org>("select * from orgs where id = $1", [orgId]);
export const userById = (userId: string) => one<User>("select * from users where id = $1", [userId]);
export const userByEmail = (email: string) => one<User>("select * from users where email = $1", [email.toLowerCase().trim()]);
export const orgUsers = (orgId: string) => q<User>("select * from users where org_id = $1 order by created_at", [orgId]);
export const orgByStripeCustomer = (customerId: string) => one<Org>("select * from orgs where stripe_customer_id = $1", [customerId]);

export async function createOrgWithOwner(email: string, name?: string): Promise<{ org: Org; user: User }> {
  const orgId = id("org");
  const org = (await one<Org>("insert into orgs (id, name) values ($1, $2) returning *", [orgId, name || email.split("@")[1] || "My business"]))!;
  const user = (await one<User>("insert into users (id, org_id, email, role) values ($1, $2, $3, 'owner') returning *", [id("usr"), orgId, email.toLowerCase().trim()]))!;
  return { org, user };
}

export async function addMember(orgId: string, email: string, role: "owner" | "member" = "member"): Promise<User> {
  return (await one<User>("insert into users (id, org_id, email, role) values ($1, $2, $3, $4) on conflict (email) do update set email = excluded.email returning *", [id("usr"), orgId, email.toLowerCase().trim(), role]))!;
}

export async function updateOrg(orgId: string, patch: { name?: string; timezone?: string; settings?: Partial<OrgSettings> }): Promise<void> {
  await q("update orgs set name = coalesce($2, name), timezone = coalesce($3, timezone), settings = settings || $4::jsonb where id = $1", [orgId, patch.name ?? null, patch.timezone ?? null, JSON.stringify(patch.settings ?? {})]);
}

/** With Stripe configured, access follows the subscription; without it everyone is in. */
export function hasAccess(org: Org): boolean {
  if (!config.stripe.configured()) return true;
  return org.subscription_status === "active" || org.subscription_status === "trialing";
}

export async function allActiveOrgs(): Promise<Org[]> {
  const rows = await q<Org>("select * from orgs order by created_at");
  return rows.filter(hasAccess);
}

export async function monthUsageCents(orgId: string): Promise<number> {
  const r = await one<{ cost_cents: string }>("select cost_cents::text from usage where org_id = $1 and month = date_trunc('month', now())::date", [orgId]);
  return Number(r?.cost_cents ?? 0);
}

export async function recordUsage(orgId: string, u: { costCents: number; input: number; output: number; cacheRead: number; tasks?: number }): Promise<void> {
  await q(
    `insert into usage (org_id, month, cost_cents, input_tokens, output_tokens, cache_read_tokens, tasks) values ($1, date_trunc('month', now())::date, $2, $3, $4, $5, $6)
     on conflict (org_id, month) do update set cost_cents = usage.cost_cents + $2, input_tokens = usage.input_tokens + $3, output_tokens = usage.output_tokens + $4, cache_read_tokens = usage.cache_read_tokens + $5, tasks = usage.tasks + $6`,
    [orgId, u.costCents.toFixed(3), u.input, u.output, u.cacheRead, u.tasks ?? 0],
  );
}
