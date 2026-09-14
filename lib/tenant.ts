import Browserbase from "@browserbasehq/sdk";
import { one, q } from "./db.js";
import { env } from "./env.js";
import { decrypt, encrypt, randomToken } from "./crypto.js";

export interface TenantSettings {
  owner_name?: string;
  quiet_hours?: string; // "22-7"
  batch_times?: string; // "12:30,18:00"
  weekly_review?: string; // "Sun 18"
  daily_review_hour?: number; // -1 disables
  auto_approve_max_usd?: number;
  auto_approve_types?: string[];
  family_emails?: string[];
  cc_owner_on_outbound?: boolean;
  observe_forwarded_mail?: boolean;
  chat_session_max_age_hours?: number;
  ask_user_deadline_hours?: number;
  task_passphrase?: string;
}

export interface Tenant {
  id: string;
  email: string;
  name: string | null;
  slug: string;
  timezone: string;
  settings: TenantSettings;
  memoryStoreId: string | null;
  browserbaseContextId: string | null;
  googleRefreshToken: string | null;
  stripeCustomerId: string | null;
  subscriptionStatus: string;
  plan: string;
  currentPeriodEnd: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  slug: string;
  timezone: string;
  settings: TenantSettings;
  memory_store_id: string | null;
  browserbase_context_id: string | null;
  google_refresh_token_enc: string | null;
  stripe_customer_id: string | null;
  subscription_status: string;
  plan: string;
  current_period_end: Date | null;
}

function fromRow(r: UserRow): Tenant {
  return {
    id: r.id,
    email: r.email.toLowerCase(),
    name: r.name,
    slug: r.slug,
    timezone: r.timezone,
    settings: r.settings ?? {},
    memoryStoreId: r.memory_store_id,
    browserbaseContextId: r.browserbase_context_id,
    googleRefreshToken: r.google_refresh_token_enc ? decrypt(r.google_refresh_token_enc, r.id) : null,
    stripeCustomerId: r.stripe_customer_id,
    subscriptionStatus: r.subscription_status,
    plan: r.plan,
    currentPeriodEnd: r.current_period_end,
  };
}

export async function tenantById(id: string): Promise<Tenant | undefined> {
  const r = await one<UserRow>("select * from users where id = $1", [id]);
  return r && fromRow(r);
}
export async function tenantByEmail(email: string): Promise<Tenant | undefined> {
  const r = await one<UserRow>("select * from users where email = $1", [email.toLowerCase()]);
  return r && fromRow(r);
}
export async function tenantBySlug(slug: string): Promise<Tenant | undefined> {
  const r = await one<UserRow>("select * from users where slug = $1", [slug.toLowerCase()]);
  return r && fromRow(r);
}
export async function tenantByStripeCustomer(customerId: string): Promise<Tenant | undefined> {
  const r = await one<UserRow>("select * from users where stripe_customer_id = $1", [customerId]);
  return r && fromRow(r);
}

/** Every customer with an active subscription (for cron sweeps). */
export async function activeTenants(): Promise<Tenant[]> {
  const rows = await q<UserRow>("select * from users where subscription_status in ('active','trialing') order by created_at");
  return rows.map(fromRow);
}

export function hasAccess(t: Tenant): boolean {
  return t.subscriptionStatus === "active" || t.subscriptionStatus === "trialing";
}

export async function createTenant(email: string): Promise<Tenant> {
  const base = email.toLowerCase().split("@")[0].replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const r = await one<UserRow>(
      "insert into users (email, slug) values ($1, $2) on conflict (slug) do nothing returning *",
      [email.toLowerCase(), slug],
    );
    if (r) return fromRow(r);
  }
  throw new Error("could not allocate a slug");
}

export async function updateSettings(t: Tenant, patch: Partial<TenantSettings> & { name?: string; timezone?: string }): Promise<void> {
  const { name, timezone, ...settings } = patch;
  await q("update users set settings = settings || $2::jsonb, name = coalesce($3, name), timezone = coalesce($4, timezone) where id = $1", [
    t.id,
    JSON.stringify(settings),
    name ?? null,
    timezone ?? null,
  ]);
}

export async function setGoogleToken(t: Tenant, refreshToken: string | null): Promise<void> {
  await q("update users set google_refresh_token_enc = $2 where id = $1", [t.id, refreshToken ? encrypt(refreshToken, t.id) : null]);
}

export function agentAddress(t: Tenant, tag?: string): string {
  return `${t.slug}${tag ? `+${tag}` : ""}@${env.mail.domain()}`;
}

export function requesterAddresses(t: Tenant): string[] {
  return [t.email, ...(t.settings.family_emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)];
}

/** First-use provisioning: a persistent browser profile. Memory is seeded by lib/memory.ts. Idempotent. */
export async function ensureProvisioned(t: Tenant): Promise<Tenant> {
  if (!t.browserbaseContextId) {
    const bb = new Browserbase({ apiKey: env.browserbase.apiKey() });
    const ctx = await bb.contexts.create({ projectId: env.browserbase.projectId(), name: `tenant-${t.slug}` });
    t.browserbaseContextId = ctx.id;
    await q("update users set browserbase_context_id = $2 where id = $1", [t.id, t.browserbaseContextId]);
  }
  return t;
}
