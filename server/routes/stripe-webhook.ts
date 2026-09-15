import type { VercelRequest, VercelResponse } from "@vercel/node";
import type Stripe from "stripe";
import { env } from "../../lib/env.js";
import { applySubscription, stripe } from "../../lib/billing.js";


/** The API entry point reads the body once and keeps the raw bytes for signature checks. */
async function rawBody(req: VercelRequest): Promise<Buffer> {
  const pre = (req as VercelRequest & { rawBody?: Buffer }).rawBody;
  if (pre) return pre;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

/** Stripe -> us. Subscribe to customer.subscription.created/updated/deleted and checkout.session.completed. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const sig = req.headers["stripe-signature"];
  if (typeof sig !== "string") return res.status(400).end();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await rawBody(req), sig, env.stripe.webhookSecret());
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "bad signature" });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscription(event.data.object);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.subscription) {
        const sub = await stripe().subscriptions.retrieve(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
        await applySubscription(sub);
      }
      break;
    }
    default:
      break;
  }
  return res.status(200).json({ received: true });
}
