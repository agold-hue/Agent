import Stripe from "stripe";
import { env } from "./env.js";
import { q } from "./db.js";
import { tenantByStripeCustomer, type Tenant } from "./tenant.js";

let client: Stripe | undefined;
export function stripe(): Stripe {
  if (!client) client = new Stripe(env.stripe.secretKey());
  return client;
}

async function customerFor(t: Tenant): Promise<string> {
  if (t.stripeCustomerId) return t.stripeCustomerId;
  const c = await stripe().customers.create({ email: t.email, name: t.name ?? undefined, metadata: { user_id: t.id } });
  await q("update users set stripe_customer_id = $2 where id = $1", [t.id, c.id]);
  return c.id;
}

/** Hosted Checkout for the subscription. Returns the URL to send the browser to. */
export async function checkoutUrl(t: Tenant): Promise<string> {
  const customer = await customerFor(t);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: env.stripe.priceId(), quantity: 1 }],
    subscription_data: env.stripe.trialDays() > 0 ? { trial_period_days: env.stripe.trialDays() } : undefined,
    allow_promotion_codes: true,
    success_url: `${env.appUrl()}/app.html?billing=success`,
    cancel_url: `${env.appUrl()}/app.html?billing=cancel`,
  });
  return session.url!;
}

/** Stripe's customer portal: change card, cancel, invoices. */
export async function portalUrl(t: Tenant): Promise<string> {
  const customer = await customerFor(t);
  const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${env.appUrl()}/app.html` });
  return session.url;
}

/** Map a Stripe subscription onto our access flag. */
export async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const t = await tenantByStripeCustomer(customerId);
  if (!t) return;
  const status = sub.status; // trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused
  const mapped = status === "active" || status === "trialing" ? status : status === "past_due" ? "past_due" : "canceled";
  const priceId = sub.items.data[0]?.price?.id ?? "";
  const plan = (sub.items.data[0]?.price?.metadata?.plan as string | undefined) || (priceId === env.stripe.priceId() ? "starter" : t.plan);
  const periodEnd = sub.items.data[0]?.current_period_end;
  await q("update users set subscription_status = $2, plan = $3, current_period_end = $4 where id = $1", [
    t.id,
    mapped,
    plan,
    periodEnd ? new Date(periodEnd * 1000) : null,
  ]);
}
