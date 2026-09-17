import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";

process.env.DATABASE_URL = "pglite://";
process.env.DATA_DIR = fs.mkdtempSync("/tmp/wm-api-");
process.env.MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.SESSION_SECRET = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DEV_LOGIN_CODE = "424242";
process.env.PORT = "38921";
process.env.APP_URL = "http://localhost:38921";

import type { Message, MessageParam, ToolUseBlock } from "../src/llm.js";
const { migrate, closeDb, q } = await import("../src/db.js");
const llm = await import("../src/llm.js");
const { startHttp } = await import("../src/http/server.js");
const { startWorkers, stopWorkers } = await import("../src/agent/worker.js");
const { startScheduler, stopScheduler, fireSchedules } = await import("../src/scheduler.js");
const { shutdownBrowsers } = await import("../src/browser/pool.js");
const { triageMail } = await import("../src/mail/triage.js");
const { orgById } = await import("../src/orgs.js");

const base = "http://localhost:38921";
let cookie = "";
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
}
const waitFor = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/** The model answers every task the same way: one memory lookup, then finish. Email tasks reply in thread. */
llm.setCompleteImpl(async (o) => {
  const last = o.messages[o.messages.length - 1];
  const opening = JSON.stringify(o.messages[0].content);
  const content: Message["content"] = [];
  const isResult = typeof last.content !== "string" && last.content.some((b) => b.type === "tool_result");
  if (!isResult) content.push({ type: "tool_use", id: `tu_${Date.now()}`, name: "memory_search", input: { query: "anything" } });
  else if (/incoming email/.test(opening) && !JSON.stringify(o.messages).includes("email_send")) content.push({ type: "tool_use", id: `tu_${Date.now()}`, name: "email_send", input: { to: "customer@example.org", subject: "Re: hours", body: "We are open 9-5.", reply_to_message_id: "mail_in1" } });
  else content.push({ type: "tool_use", id: `tu_${Date.now()}`, name: "finish_task", input: { outcome: "done", result: `Finished: ${opening.slice(0, 60)}` } });
  const message = { id: "m", type: "message", role: "assistant", model: o.model, content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as unknown as Message;
  return { message, usage: { input: 100, output: 10, cacheWrite: 0, cacheRead: 0 }, costCents: 0.1, model: o.model, text: "", toolUses: content.filter((b): b is ToolUseBlock => b.type === "tool_use") };
});
void (0 as unknown as MessageParam);

let server: ReturnType<typeof startHttp>;
before(async () => {
  await migrate();
  server = startHttp();
  await startWorkers();
  startScheduler();
});
after(async () => {
  stopScheduler();
  await stopWorkers();
  server.close();
  await shutdownBrowsers();
  await closeDb();
});

test("health, sign-in, and the first sign-in creates the business", async () => {
  assert.equal((await call("GET", "/api/health")).status, 200);
  assert.equal((await call("GET", "/api/me")).status, 401);
  const rc = await call("POST", "/api/auth/request-code", { email: "owner@acme.test" });
  assert.equal(rc.json.dev, true);
  assert.equal((await call("POST", "/api/auth/verify", { email: "owner@acme.test", code: "000000" })).status, 500);
  const v = await call("POST", "/api/auth/verify", { email: "owner@acme.test", code: "424242", company: "Acme" });
  assert.equal(v.status, 200);
  const me = await call("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal((me.json.org as { name: string }).name, "Acme");
  assert.equal((me.json.user as { role: string }).role, "owner");
});

test("a task created through the API is picked up by a worker and finished", async () => {
  const c = await call("POST", "/api/tasks", { instruction: "Find out our vendor's hours" });
  assert.equal(c.status, 200, c.json.error);
  const id = (c.json.task as { id: string }).id;
  const done = await waitFor(async () => ((await call("GET", `/api/tasks/${id}`)).json.task as { status: string }).status === "done");
  assert.ok(done, "worker finished the task");
  const d = await call("GET", `/api/tasks/${id}`);
  const task = d.json.task as { result: string; steps: number };
  assert.match(task.result, /Finished/);
  assert.equal(task.steps, 2);
  const events = d.json.events as Array<{ kind: string }>;
  assert.deepEqual(events.map((e) => e.kind), ["user", "tool", "result"]);
  const list = await call("GET", "/api/tasks");
  assert.equal((list.json.tasks as unknown[]).length, 1);
});

test("settings, memory, logins, files and schedules round-trip; a due schedule creates a task", async () => {
  assert.equal((await call("PATCH", "/api/org", { timezone: "Europe/Berlin", settings: { profile: "We sell widgets", auto_approve_kinds: ["purchase"], auto_approve_under_usd: 25 } })).status, 200);
  const me = await call("GET", "/api/me");
  assert.equal((me.json.org as { timezone: string }).timezone, "Europe/Berlin");
  assert.equal((await call("POST", "/api/memory", { kind: "fact", key: "office", content: "12 Main St" })).status, 200);
  assert.equal(((await call("GET", "/api/memory?kind=fact")).json.memories as unknown[]).length, 1);
  assert.equal((await call("POST", "/api/logins", { domain: "staples.com", username: "buyer@acme.test", password: "pw" })).status, 200);
  const logins = (await call("GET", "/api/logins")).json.logins as Array<{ domain: string; password?: string }>;
  assert.equal(logins[0].domain, "staples.com");
  assert.equal(logins[0].password, undefined);
  const up = await call("POST", "/api/files", "hello,world\n", { "Content-Type": "text/csv", "X-File-Name": "prices.csv" });
  assert.equal(up.status, 200);
  const fid = (up.json.file as { id: string }).id;
  const dl = await fetch(`${base}/api/files/${fid}/download`, { headers: { Cookie: cookie } });
  assert.equal(await dl.text(), "hello,world\n");
  const bad = await call("POST", "/api/schedules", { title: "x", cron: "not a cron", instruction: "y" });
  assert.equal(bad.status, 400);
  const sch = await call("POST", "/api/schedules", { title: "Daily sweep", cron: "0 8 * * *", instruction: "Sweep the inbox" });
  assert.equal(sch.status, 200);
  // Pretend the next run came due: the scheduler turns it into a task.
  await q("update schedules set next_run_at = now() - interval '1 minute' where id = $1", [sch.json.id]);
  assert.equal(await fireSchedules(), 1);
  const list = (await call("GET", "/api/tasks")).json.tasks as Array<{ source: string; title: string }>;
  assert.ok(list.some((t) => t.source === "schedule" && t.title === "Daily sweep"));
  const next = (await q<{ next_run_at: Date }>("select next_run_at from schedules where id = $1", [sch.json.id]))[0].next_run_at;
  assert.ok(next.getTime() > Date.now());
});

test("an incoming email becomes a task; the worker replies in thread; a reply to that mail is routed back", async () => {
  const smtp = await import("../src/mail/smtp.js");
  const sent: Array<{ to: string; inReplyTo?: string }> = [];
  smtp.setMailSender(async (orgId, _n, m) => {
    sent.push(m);
    await q("insert into mail_messages (id, org_id, direction, message_id, in_reply_to, from_address, to_address, subject, body, task_id) values ($1,$2,'out','<out1@acme>',$3,'ops@acme.test',$4,$5,$6,$7)", [`mail_out1`, orgId, m.inReplyTo ?? null, m.to, m.subject, m.markdown, m.taskId ?? null]);
    return { messageId: "<out1@acme>", from: "ops@acme.test" };
  });
  const orgId = ((await call("GET", "/api/me")).json.org as { id: string }).id;
  const org = (await orgById(orgId))!;
  await q("update orgs set settings = settings || '{\"auto_send_email\": true}'::jsonb where id = $1", [orgId]);
  const stored = (await q("insert into mail_messages (id, org_id, direction, uid, message_id, from_address, to_address, subject, body) values ('mail_in1', $1, 'in', 5, '<in1@example.org>', 'customer@example.org', 'ops@acme.test', 'hours?', 'What are your hours?') returning *", [orgId]))[0];
  // Triage runs on the fast model; the scripted model above answers everything as tool calls, so classify() finds no JSON and triage falls back to fyi. Force "action" by faking the classification path.
  const origImpl = llm.completeImpl;
  llm.setCompleteImpl(async (o) => {
    if (o.model === "claude-haiku-4-5") {
      const message = { id: "m", type: "message", role: "assistant", model: o.model, content: [{ type: "text", text: '{"category":"action","summary":"asks for hours","priority":"normal","task_title":"Answer hours question","task_instruction":"Reply with our hours."}', citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } as unknown as Message;
      return { message, usage: { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 }, costCents: 0.01, model: o.model, text: (message.content[0] as { text: string }).text, toolUses: [] };
    }
    return origImpl!(o);
  });
  await triageMail({ ...org, settings: { ...org.settings, auto_send_email: true } }, stored as never);
  const tasks = (await call("GET", "/api/tasks?status=queued,running,done")).json.tasks as Array<{ id: string; source: string; title: string; status: string }>;
  const mailTask = tasks.find((t) => t.source === "email");
  assert.ok(mailTask, "triage created a task");
  assert.equal(mailTask!.title, "Answer hours question");
  assert.ok(await waitFor(async () => ((await call("GET", `/api/tasks/${mailTask!.id}`)).json.task as { status: string }).status === "done"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "customer@example.org");
  assert.equal(sent[0].inReplyTo, "<in1@example.org>");
  // The customer replies: it must reach the task that wrote to them, restarting it.
  const reply = (await q("insert into mail_messages (id, org_id, direction, uid, message_id, in_reply_to, from_address, to_address, subject, body) values ('mail_in2', $1, 'in', 6, '<in2@example.org>', '<out1@acme>', 'customer@example.org', 'ops@acme.test', 'Re: hours', 'Thanks!') returning *", [orgId]))[0];
  await triageMail(org, reply as never);
  const t = (await call("GET", `/api/tasks/${mailTask!.id}`)).json.task as { status: string };
  assert.ok(["queued", "running", "done"].includes(t.status));
  const routed = (await q<{ task_id: string }>("select task_id from mail_messages where id = 'mail_in2'"))[0];
  assert.equal(routed.task_id, mailTask!.id);
  assert.ok(await waitFor(async () => ((await call("GET", `/api/tasks/${mailTask!.id}`)).json.task as { status: string }).status === "done"));
  const events = (await call("GET", `/api/tasks/${mailTask!.id}`)).json.events as Array<{ kind: string; summary: string }>;
  assert.ok(events.some((e) => e.kind === "user" && /A reply arrived/.test(e.summary)));
  smtp.setMailSender(undefined);
  llm.setCompleteImpl(origImpl);
});

test("a task waiting on a question can be answered from the API, and cancelled", async () => {
  const origImpl = llm.completeImpl;
  llm.setCompleteImpl(async (o) => {
    const asked = JSON.stringify(o.messages).includes("ask_user");
    const content: Message["content"] = asked ? [{ type: "tool_use", id: "tu_f", name: "finish_task", input: { outcome: "done", result: "ok" } }] : [{ type: "tool_use", id: "tu_q", name: "ask_user", input: { question: "Which color?", options: ["red", "blue"] } }];
    const message = { id: "m", type: "message", role: "assistant", model: o.model, content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } as unknown as Message;
    return { message, usage: { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 }, costCents: 0.01, model: o.model, text: "", toolUses: content.filter((b): b is ToolUseBlock => b.type === "tool_use") };
  });
  const c = await call("POST", "/api/tasks", { instruction: "Buy a mug" });
  const id = (c.json.task as { id: string }).id;
  assert.ok(await waitFor(async () => ((await call("GET", `/api/tasks/${id}`)).json.task as { status: string }).status === "waiting_user"));
  const t = (await call("GET", `/api/tasks/${id}`)).json.task as { waiting: { question: string; options: string[] } };
  assert.equal(t.waiting.question, "Which color?");
  assert.equal((await call("GET", "/api/notifications")).status, 200);
  assert.equal((await call("POST", `/api/tasks/${id}/answer`, { text: "blue" })).status, 200);
  assert.ok(await waitFor(async () => ((await call("GET", `/api/tasks/${id}`)).json.task as { status: string }).status === "done"));
  const c2 = await call("POST", "/api/tasks", { instruction: "Buy a plate" });
  const id2 = (c2.json.task as { id: string }).id;
  assert.ok(await waitFor(async () => ((await call("GET", `/api/tasks/${id2}`)).json.task as { status: string }).status === "waiting_user"));
  assert.equal((await call("POST", `/api/tasks/${id2}/cancel`)).status, 200);
  assert.equal(((await call("GET", `/api/tasks/${id2}`)).json.task as { status: string }).status, "cancelled");
  llm.setCompleteImpl(origImpl);
});

test("static console and unknown api paths", async () => {
  const r = await fetch(`${base}/`);
  assert.match(await r.text(), /<title>Workmate<\/title>/);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
});
