import webpush from "web-push";
import { q } from "./db.js";
import type { Tenant } from "./tenant.js";

/**
 * Web push to the user's phone or desktop for the moments that need them: a code, an approval, a
 * finished task. Needs VAPID keys (npx web-push generate-vapid-keys): VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:you@example.com). Without them push is simply off.
 */
export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function setup(): boolean {
  if (!pushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return true;
}

export async function saveSubscription(t: Tenant, sub: { endpoint: string; keys: Record<string, string> }): Promise<void> {
  await q("insert into push_subscriptions (user_id, endpoint, keys) values ($1, $2, $3) on conflict (endpoint) do update set user_id = $1, keys = $3", [t.id, sub.endpoint, JSON.stringify(sub.keys)]);
}

export async function removeSubscription(t: Tenant, endpoint: string): Promise<void> {
  await q("delete from push_subscriptions where user_id = $1 and endpoint = $2", [t.id, endpoint]);
}

/** Send one notification to every device the user registered; dead subscriptions are dropped. */
export async function pushToUser(t: Tenant, n: { title: string; body: string; tag?: string; url?: string }): Promise<number> {
  if (!setup()) return 0;
  const subs = await q<{ endpoint: string; keys: Record<string, string> }>("select endpoint, keys from push_subscriptions where user_id = $1", [t.id]);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, JSON.stringify({ title: n.title, body: n.body.slice(0, 240), tag: n.tag ?? "secretary", url: n.url ?? "/app.html" }), { TTL: 3600 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await q("delete from push_subscriptions where endpoint = $1", [s.endpoint]).catch(() => {});
      else console.error(`[push] ${t.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
}
