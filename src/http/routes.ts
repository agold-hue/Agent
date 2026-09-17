import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { answerTask, messageTask } from "../agent/resume.js";
import { logoutCookie, requestCode, verifyCode } from "../auth.js";
import { checkoutUrl, handleWebhook, portalUrl } from "../billing.js";
import { frame, input, type LiveInput } from "../browser/liveview.js";
import { pageFor } from "../browser/pool.js";
import { config } from "../config.js";
import { encrypt } from "../crypto.js";
import { one, q } from "../db.js";
import { deleteFile, getFile, listFiles, mimeFor, readFileBytes, saveFile } from "../files.js";
import { id } from "../ids.js";
import { searchMail } from "../mail/imap.js";
import { mailAccounts } from "../mail/smtp.js";
import { deleteMemory, listMemories, saveMemory, type MemoryKind } from "../memory.js";
import { addMember, hasAccess, monthUsageCents, orgById, orgUsers, updateOrg, userById, type Org, type User } from "../orgs.js";
import { cancelTask, createTask, getTask, listTasks, taskEvents, type TaskStatus } from "../tasks.js";
import { deleteCredential, listCredentials, saveCredential } from "../vault.js";
import { HttpError, need, str, type Ctx, type Router } from "./router.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function auth(c: Ctx): Promise<{ user: User; org: Org }> {
  if (!c.userId) throw new HttpError(401, "sign in first");
  const user = await userById(c.userId);
  if (!user) throw new HttpError(401, "sign in first");
  const org = (await orgById(user.org_id))!;
  return { user, org };
}

async function authed(c: Ctx): Promise<{ user: User; org: Org }> {
  const a = await auth(c);
  if (!hasAccess(a.org)) throw new HttpError(402, "subscription required");
  return a;
}

async function ownTask(c: Ctx, org: Org) {
  const t = await getTask(c.params.id);
  if (!t || t.org_id !== org.id) throw new HttpError(404, "no such task");
  return t;
}

export function registerRoutes(r: Router): void {
  // ---- auth
  r.post("/api/auth/request-code", async (c) => {
    await requestCode(need(c.body.email, "email"));
    return { ok: true, dev: !!config.devLoginCode() };
  });
  r.post("/api/auth/verify", async (c) => {
    const { user, cookie } = await verifyCode(need(c.body.email, "email"), need(c.body.code, "code"), str(c.body.company, 120) || undefined);
    c.res.setHeader("Set-Cookie", cookie);
    return { ok: true, user_id: user.id };
  });
  r.post("/api/auth/logout", async (c) => {
    c.res.setHeader("Set-Cookie", logoutCookie());
    return { ok: true };
  });

  // ---- me / org
  r.get("/api/me", async (c) => {
    const { user, org } = await auth(c);
    return {
      user,
      org,
      access: hasAccess(org),
      usage_cents: await monthUsageCents(org.id),
      cap_usd: config.plans.monthlyCapUsd(org.plan),
      features: { mail_platform: config.mail.configured(), stripe: config.stripe.configured(), push_key: config.push.publicKey() || null, search: !!config.search.serperKey(), model: config.llm.taskModel() },
    };
  });
  r.patch("/api/org", async (c) => {
    const { org, user } = await auth(c);
    if (user.role !== "owner") throw new HttpError(403, "owners only");
    const settings = (c.body.settings && typeof c.body.settings === "object" ? c.body.settings : {}) as Record<string, unknown>;
    await updateOrg(org.id, { name: str(c.body.name, 120) || undefined, timezone: str(c.body.timezone, 80) || undefined, settings });
    return { ok: true };
  });
  r.get("/api/members", async (c) => ({ members: await orgUsers((await auth(c)).org.id) }));
  r.post("/api/members", async (c) => {
    const { org, user } = await auth(c);
    if (user.role !== "owner") throw new HttpError(403, "owners only");
    return { member: await addMember(org.id, need(c.body.email, "email")) };
  });
  r.del("/api/members/:id", async (c) => {
    const { org, user } = await auth(c);
    if (user.role !== "owner") throw new HttpError(403, "owners only");
    if (c.params.id === user.id) throw new HttpError(400, "you cannot remove yourself");
    await q("delete from users where id = $1 and org_id = $2", [c.params.id, org.id]);
  });

  // ---- tasks
  r.get("/api/tasks", async (c) => {
    const { org } = await auth(c);
    const status = c.query.get("status")?.split(",").filter(Boolean) as TaskStatus[] | undefined;
    const before = c.query.get("before") ? new Date(c.query.get("before")!) : undefined;
    return { tasks: await listTasks(org.id, { status, limit: Number(c.query.get("limit") ?? 60), before }) };
  });
  r.post("/api/tasks", async (c) => {
    const { org, user } = await authed(c);
    const cap = config.plans.monthlyCapUsd(org.plan) * 100;
    if (cap > 0 && (await monthUsageCents(org.id)) >= cap) throw new HttpError(402, `This month's usage cap ($${cap / 100}) is reached; it resets on the 1st or upgrade the plan.`);
    const instruction = need(c.body.instruction, "instruction");
    const attachments = Array.isArray(c.body.attachments) ? (c.body.attachments as Array<{ file_id: string; name: string }>).slice(0, 10) : [];
    const title = str(c.body.title, 120).trim() || instruction.split("\n")[0].slice(0, 90);
    const task = await createTask({ orgId: org.id, title, instruction, source: "chat", createdBy: user.id, attachments });
    return { task };
  });
  r.get("/api/tasks/:id", async (c) => {
    const { org } = await auth(c);
    const task = await ownTask(c, org);
    const { conversation, ...rest } = task;
    void conversation;
    return { task: rest, events: await taskEvents(task.id) };
  });
  r.post("/api/tasks/:id/message", async (c) => {
    const { org } = await authed(c);
    const task = await ownTask(c, org);
    const attachments = Array.isArray(c.body.attachments) ? (c.body.attachments as Array<{ file_id: string; name: string }>).slice(0, 10) : [];
    await messageTask(task, need(c.body.text, "text"), attachments);
  });
  r.post("/api/tasks/:id/answer", async (c) => {
    const { org, user } = await authed(c);
    const task = await ownTask(c, org);
    await answerTask(task, { text: str(c.body.text, 20_000), approved: typeof c.body.approved === "boolean" ? c.body.approved : undefined }, user.email);
  });
  r.post("/api/tasks/:id/cancel", async (c) => {
    const { org } = await auth(c);
    await cancelTask(await ownTask(c, org));
  });
  r.post("/api/tasks/:id/retry", async (c) => {
    const { org } = await authed(c);
    const task = await ownTask(c, org);
    await messageTask(task, "Try again from where you left off.");
  });

  // ---- notifications
  r.get("/api/notifications", async (c) => {
    const { org } = await auth(c);
    return { notifications: await q("select * from notifications where org_id = $1 order by created_at desc limit 50", [org.id]) };
  });
  r.post("/api/notifications/read", async (c) => {
    const { org } = await auth(c);
    await q("update notifications set read_at = now() where org_id = $1 and read_at is null", [org.id]);
  });

  // ---- schedules
  r.get("/api/schedules", async (c) => ({ schedules: await q("select * from schedules where org_id = $1 order by created_at", [(await auth(c)).org.id]) }));
  r.post("/api/schedules", async (c) => {
    const { org } = await authed(c);
    const cron = need(c.body.cron, "cron");
    let next: Date | null;
    try {
      next = new Cron(cron, { timezone: org.timezone }).nextRun();
    } catch {
      throw new HttpError(400, "invalid cron expression (5 fields: minute hour day month weekday)");
    }
    const sid = id("sch");
    await q("insert into schedules (id, org_id, title, instruction, cron, timezone, next_run_at) values ($1,$2,$3,$4,$5,$6,$7)", [sid, org.id, need(c.body.title, "title").slice(0, 120), need(c.body.instruction, "instruction"), cron, org.timezone, next]);
    return { id: sid, next_run_at: next };
  });
  r.patch("/api/schedules/:id", async (c) => {
    const { org } = await auth(c);
    if (typeof c.body.active === "boolean") await q("update schedules set active = $3 where id = $1 and org_id = $2", [c.params.id, org.id, c.body.active]);
    if (c.body.cron) {
      const cron = str(c.body.cron, 100);
      let next: Date | null;
      try {
        next = new Cron(cron, { timezone: org.timezone }).nextRun();
      } catch {
        throw new HttpError(400, "invalid cron expression");
      }
      await q("update schedules set cron = $3, next_run_at = $4 where id = $1 and org_id = $2", [c.params.id, org.id, cron, next]);
    }
    if (c.body.instruction) await q("update schedules set instruction = $3 where id = $1 and org_id = $2", [c.params.id, org.id, str(c.body.instruction)]);
    if (c.body.title) await q("update schedules set title = $3 where id = $1 and org_id = $2", [c.params.id, org.id, str(c.body.title, 120)]);
  });
  r.del("/api/schedules/:id", async (c) => {
    const { org } = await auth(c);
    await q("delete from schedules where id = $1 and org_id = $2", [c.params.id, org.id]);
  });
  r.post("/api/schedules/:id/run", async (c) => {
    const { org, user } = await authed(c);
    const s = await one<{ title: string; instruction: string }>("select title, instruction from schedules where id = $1 and org_id = $2", [c.params.id, org.id]);
    if (!s) throw new HttpError(404, "no such schedule");
    return { task: await createTask({ orgId: org.id, title: s.title, instruction: s.instruction, source: "schedule", scheduleId: c.params.id, createdBy: user.id }) };
  });

  // ---- mail
  r.get("/api/mail/accounts", async (c) => {
    const { org } = await auth(c);
    const accs = await mailAccounts(org.id);
    return { accounts: accs.map(({ imap_pass_enc, smtp_pass_enc, ...a }) => ({ ...a, has_imap: !!a.imap_host, has_smtp: !!a.smtp_host, imap_pass_set: !!imap_pass_enc, smtp_pass_set: !!smtp_pass_enc })) };
  });
  r.post("/api/mail/accounts", async (c) => {
    const { org, user } = await auth(c);
    if (user.role !== "owner") throw new HttpError(403, "owners only");
    const b = c.body;
    const address = need(b.address, "address");
    const imapHost = str(b.imap_host, 200).trim() || null;
    const smtpHost = str(b.smtp_host, 200).trim() || null;
    const aid = id("mbox");
    await q(
      "insert into mail_accounts (id, org_id, label, address, from_name, imap_host, imap_port, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_user, smtp_pass_enc) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [aid, org.id, str(b.label, 80) || address, address, str(b.from_name, 120) || org.name, imapHost, imapHost ? Number(b.imap_port ?? 993) : null, imapHost ? str(b.imap_user, 200) || address : null, imapHost && b.imap_pass ? encrypt(str(b.imap_pass, 500), org.id) : null, smtpHost, smtpHost ? Number(b.smtp_port ?? 587) : null, smtpHost ? str(b.smtp_user, 200) || address : null, smtpHost && b.smtp_pass ? encrypt(str(b.smtp_pass, 500), org.id) : null],
    );
    return { id: aid };
  });
  r.del("/api/mail/accounts/:id", async (c) => {
    const { org } = await auth(c);
    await q("delete from mail_accounts where id = $1 and org_id = $2", [c.params.id, org.id]);
  });
  r.post("/api/mail/accounts/:id/test", async (c) => {
    const { org } = await auth(c);
    const acc = (await mailAccounts(org.id)).find((a) => a.id === c.params.id);
    if (!acc) throw new HttpError(404, "no such mailbox");
    const { pollAccount } = await import("../mail/imap.js");
    const before = acc.last_uid;
    const fresh = await pollAccount(acc);
    const after = (await mailAccounts(org.id)).find((a) => a.id === c.params.id)!;
    return { ok: !after.last_error, error: after.last_error, fetched: fresh.length, last_uid_before: before, last_uid_after: after.last_uid };
  });
  r.get("/api/mail/messages", async (c) => {
    const { org } = await auth(c);
    return { messages: await searchMail(org.id, { query: c.query.get("q") ?? "", limit: Number(c.query.get("limit") ?? 40) }) };
  });

  // ---- memory
  r.get("/api/memory", async (c) => ({ memories: await listMemories((await auth(c)).org.id, (c.query.get("kind") as MemoryKind) || undefined) }));
  r.post("/api/memory", async (c) => {
    const { org } = await auth(c);
    const kind = need(c.body.kind, "kind") as MemoryKind;
    if (!["fact", "site", "contact", "procedure", "history"].includes(kind)) throw new HttpError(400, "bad kind");
    await saveMemory(org.id, kind, need(c.body.key, "key"), need(c.body.content, "content"));
  });
  r.del("/api/memory/:id", async (c) => {
    await deleteMemory((await auth(c)).org.id, c.params.id);
  });

  // ---- logins (vault)
  r.get("/api/logins", async (c) => ({ logins: await listCredentials((await auth(c)).org.id) }));
  r.post("/api/logins", async (c) => {
    const { org } = await auth(c);
    return { id: await saveCredential(org.id, { domain: need(c.body.domain, "domain"), username: need(c.body.username, "username"), password: need(c.body.password, "password"), totpSecret: str(c.body.totp_secret, 200) || undefined, notes: str(c.body.notes, 2000) || undefined }) };
  });
  r.del("/api/logins/:id", async (c) => {
    await deleteCredential((await auth(c)).org.id, c.params.id);
  });

  // ---- files
  r.get("/api/files", async (c) => ({ files: await listFiles((await auth(c)).org.id) }));
  r.post("/api/files", async (c) => {
    const { org } = await auth(c);
    const name = decodeURIComponent(String(c.req.headers["x-file-name"] ?? "upload"));
    const mime = String(c.req.headers["content-type"] ?? "").split(";")[0] || mimeFor(name);
    if (!c.raw.length) throw new HttpError(400, "empty upload");
    const f = await saveFile(org.id, null, name, mime === "application/octet-stream" ? mimeFor(name) : mime, c.raw);
    return { file: f };
  });
  r.get("/api/files/:id/download", async (c) => {
    const { org } = await auth(c);
    const f = await getFile(org.id, c.params.id);
    if (!f) throw new HttpError(404, "no such file");
    const data = await readFileBytes(f);
    c.res.writeHead(200, { "Content-Type": f.mime, "Content-Length": data.length, "Content-Disposition": `${c.query.get("inline") ? "inline" : "attachment"}; filename="${encodeURIComponent(f.name)}"` });
    c.res.end(data);
  });
  r.del("/api/files/:id", async (c) => {
    await deleteFile((await auth(c)).org.id, c.params.id);
  });

  // ---- live browser
  r.get("/api/browser/:task/frame", async (c) => {
    const { org } = await auth(c);
    if (c.params.task !== "manual") await ownTask({ ...c, params: { id: c.params.task } } as Ctx, org);
    const f = await frame(org.id, c.params.task);
    if (!f) throw new HttpError(404, "no open tab");
    c.res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Page-Url": encodeURIComponent(f.url), "X-Page-Title": encodeURIComponent(f.title) });
    c.res.end(f.jpeg);
  });
  r.post("/api/browser/:task/input", async (c) => {
    const { org } = await auth(c);
    if (c.params.task !== "manual") await ownTask({ ...c, params: { id: c.params.task } } as Ctx, org);
    return input(org.id, c.params.task, org.timezone, c.body as unknown as LiveInput);
  });
  r.post("/api/browser/manual/open", async (c) => {
    const { org } = await authed(c);
    const { page } = await pageFor(org.id, "manual", { timezone: org.timezone });
    let url = str(c.body.url, 2000).trim();
    if (url) {
      if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    }
    return { ok: true, url: page.url() };
  });
  r.post("/api/browser/manual/close", async (c) => {
    const { org } = await auth(c);
    const { closeTaskTabs } = await import("../browser/pool.js");
    await closeTaskTabs(org.id, "manual");
  });

  // ---- billing
  r.post("/api/billing/checkout", async (c) => {
    const { org, user } = await auth(c);
    if (!config.stripe.configured()) throw new HttpError(400, "billing is not configured");
    return { url: await checkoutUrl(org, user) };
  });
  r.post("/api/billing/portal", async (c) => ({ url: await portalUrl((await auth(c)).org) }));
  r.post("/api/stripe/webhook", async (c) => {
    await handleWebhook(c.raw, String(c.req.headers["stripe-signature"] ?? ""));
    return { received: true };
  });

  // ---- push
  r.post("/api/push/subscribe", async (c) => {
    const { org, user } = await auth(c);
    const sub = c.body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } } | undefined;
    if (!sub?.endpoint) throw new HttpError(400, "subscription required");
    await q("insert into push_subscriptions (id, org_id, user_id, endpoint, keys) values ($1,$2,$3,$4,$5) on conflict (endpoint) do update set keys = $5", [id("push"), org.id, user.id, sub.endpoint, JSON.stringify(sub.keys)]);
  });

  // ---- usage
  r.get("/api/usage", async (c) => {
    const { org } = await auth(c);
    return { months: await q("select month, cost_cents::float as cost_cents, input_tokens::float as input_tokens, output_tokens::float as output_tokens, cache_read_tokens::float as cache_read_tokens, tasks from usage where org_id = $1 order by month desc limit 12", [org.id]) };
  });

  r.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));
}

/** Static console files. */
export function webDir(): string {
  for (const p of [path.join(here, "..", "web"), path.join(process.cwd(), "src", "web")]) if (fs.existsSync(p)) return p;
  throw new Error("web directory not found");
}
