import webpush from "web-push";
import { config } from "./config.js";
import { q } from "./db.js";
import { id } from "./ids.js";
import { log, errText } from "./log.js";
import { sendServiceMail } from "./mail/smtp.js";
import { orgUsers, type Org } from "./orgs.js";
import { inQuietHours } from "./time.js";

/**
 * Tell the business something: always in the console; by email and push when they asked for it.
 * "Needs you" notifications go out at once; the rest respect quiet hours.
 */
export async function notify(org: Org, n: { kind: "needs_you" | "done" | "failed" | "info"; title: string; body?: string; taskId?: string }): Promise<void> {
  await q("insert into notifications (id, org_id, task_id, kind, title, body) values ($1,$2,$3,$4,$5,$6)", [id("ntf"), org.id, n.taskId ?? null, n.kind, n.title.slice(0, 300), n.body?.slice(0, 5000) ?? null]);
  const urgent = n.kind === "needs_you" || n.kind === "failed";
  if (!urgent && inQuietHours(org.settings.quiet_hours, org.timezone)) return;
  const link = `${config.appUrl()}/${n.taskId ? `#task/${n.taskId}` : ""}`;
  if (org.settings.notify_email !== false && config.mail.configured()) {
    for (const u of await orgUsers(org.id)) {
      sendServiceMail(u.email, `[${org.name}] ${n.title}`, `${n.body ?? ""}\n\n[Open in the console](${link})`).catch((e) => log.error("notify", "email failed", e, { to: u.email }));
    }
  }
  if (config.push.configured()) {
    webpush.setVapidDetails(config.push.subject(), config.push.publicKey(), config.push.privateKey());
    const subs = await q<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } }>("select id, endpoint, keys from push_subscriptions where org_id = $1", [org.id]);
    for (const s of subs) {
      webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title: n.title, body: (n.body ?? "").slice(0, 200), url: link })).catch(async (e: { statusCode?: number }) => {
        if (e.statusCode === 404 || e.statusCode === 410) await q("delete from push_subscriptions where id = $1", [s.id]);
        else log.warn("notify", "push failed", { err: errText(e) });
      });
    }
  }
}
