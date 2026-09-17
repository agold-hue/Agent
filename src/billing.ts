import Stripe from "stripe";
import { config } from "./config.js";
import { q } from "./db.js";
import { orgByStripeCustomer, type Org, type User } from "./orgs.js";

let stripe: Stripe | undefined;
function client(): Stripe {
  if (!stripe) stripe = new Stripe(config.stripe.secretKey());
  return stripe;
}

export async function checkoutUrl(org: Org, user: User): Promise<string> {
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const c = await client().customers.create({ email: user.email, name: org.name, metadata: { org_id: org.id } });
    customerId = c.id;
    await q("update orgs set stripe_customer_id = $2 where id = $1", [org.id, customerId]);
  }
  const session = await client().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: config.stripe.priceId(), quantity: 1 }],
    subscription_data: config.stripe.trialDays() > 0 && org.subscription_status === "none" ? { trial_period_days: config.stripe.trialDays() } : undefined,
    success_url: `${config.appUrl()}/#settings`,
    cancel_url: `${config.appUrl()}/#settings`,
  });
  return session.url!;
}

export async function portalUrl(org: Org): Promise<string> {
  if (!org.stripe_customer_id) throw new Error("no billing account yet");
  const s = await client().billingPortal.sessions.create({ customer: org.stripe_customer_id, return_url: `${config.appUrl()}/#settings` });
  return s.url;
}

/** Stripe webhook: subscription status drives access. Verifies the signature against the raw body. */
export async function handleWebhook(raw: Buffer, signature: string): Promise<void> {
  const event = client().webhooks.constructEvent(raw, signature, config.stripe.webhookSecret());
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const org = await orgByStripeCustomer(customer);
    if (!org) return;
    const item = sub.items.data[0];
    const plan = (item?.price?.metadata?.plan as string | undefined) ?? "standard";
    const end = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
    await q("update orgs set subscription_status = $2, plan = $3, current_period_end = $4 where id = $1", [org.id, sub.status, plan, end]);
  }
}
