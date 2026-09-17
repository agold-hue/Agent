import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";

process.env.DATABASE_URL = "pglite://";
process.env.DATA_DIR = fs.mkdtempSync("/tmp/wm-loop-");
process.env.MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.SESSION_SECRET = "test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.TASK_MAX_STEPS = "6";

import type { Message, MessageParam, ToolUseBlock } from "../src/llm.js";
const { migrate, closeDb, q } = await import("../src/db.js");
const llm = await import("../src/llm.js");
const { createTask, getTask, taskEvents } = await import("../src/tasks.js");
const { runTask } = await import("../src/agent/loop.js");
const { answerTask, wakeTask, messageTask } = await import("../src/agent/resume.js");
const { shutdownBrowsers } = await import("../src/browser/pool.js");
const { saveMemory, searchMemory } = await import("../src/memory.js");

type Turn = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
/** A scripted model: each call pops the next turn. Records what it was sent. */
function script(turns: Turn[]) {
  const calls: MessageParam[][] = [];
  let n = 0;
  llm.setCompleteImpl(async (o) => {
    calls.push(structuredClone(o.messages));
    const t = turns[n++] ?? { text: "(script exhausted)" };
    const content: Message["content"] = [];
    if (t.text) content.push({ type: "text", text: t.text, citations: null });
    for (const [i, tu] of (t.tools ?? []).entries()) content.push({ type: "tool_use", id: `tu_${n}_${i}`, name: tu.name, input: tu.input });
    const message = { id: `msg_${n}`, type: "message", role: "assistant", model: o.model, content, stop_reason: t.tools?.length ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 } } as unknown as Message;
    return { message, usage: { input: 1000, output: 50, cacheWrite: 0, cacheRead: 800 }, costCents: 0.6, model: o.model, text: t.text ?? "", toolUses: content.filter((b): b is ToolUseBlock => b.type === "tool_use") };
  });
  return calls;
}
const lastToolResults = (calls: MessageParam[][]) => {
  const conv = calls[calls.length - 1];
  const last = conv[conv.length - 1];
  return typeof last.content === "string" ? [] : last.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
};
const resultText = (r: { content?: unknown }) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

before(async () => {
  await migrate();
  await q("insert into orgs (id, name, settings) values ('org1', 'Acme', $1)", [JSON.stringify({ auto_approve_kinds: ["purchase"], auto_approve_under_usd: 50, profile: "We sell widgets." })]);
  await q("insert into users (id, org_id, email, role) values ('u1', 'org1', 'owner@acme.test', 'owner')");
});
after(async () => {
  await shutdownBrowsers();
  await closeDb();
});

test("a task runs tools, saves memory, and finishes with a result and history", async () => {
  await saveMemory("org1", "site", "vendor.test", "Sign-in is at /login; orders under Account > Orders.");
  const calls = script([
    { text: "Checking memory first.", tools: [{ name: "memory_search", input: { query: "vendor.test" } }] },
    { tools: [{ name: "memory_save", input: { kind: "fact", key: "po prefix", content: "POs start with ACME-" } }, { name: "report_progress", input: { text: "Found the vendor notes." } }] },
    { tools: [{ name: "finish_task", input: { outcome: "done", result: "Order placed, confirmation ACME-1234." } }] },
  ]);
  const task = await createTask({ orgId: "org1", title: "Order widgets", instruction: "Order 10 widgets from vendor.test", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  const end = await runTask(task.id, { worker: "t" });
  assert.equal(end, "done");
  const t = (await getTask(task.id))!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "done");
  assert.match(t.result!, /ACME-1234/);
  assert.equal(t.steps, 3);
  assert.ok(Number(t.cost_cents) > 0);
  // The first call carried the opening message with the company's task; the second carried the memory hit.
  assert.match(JSON.stringify(calls[0][0].content), /Order 10 widgets/);
  assert.match(resultText(lastToolResults(calls.slice(0, 2))[0]), /Sign-in is at \/login/);
  const hist = await searchMemory("org1", "Order widgets", "history");
  assert.equal(hist.length, 1);
  assert.match(hist[0].content, /ACME-1234/);
  const kinds = (await taskEvents(task.id)).map((e) => e.kind);
  assert.deepEqual(kinds, ["user", "step", "tool", "tool", "progress", "tool", "result"]);
  const usage = await q<{ tasks: number; cost_cents: string }>("select tasks, cost_cents::text from usage where org_id = 'org1'");
  assert.equal(usage[0].tasks, 1);
});

test("ask_user pauses the task; the answer resumes it with the other tool results intact", async () => {
  const calls = script([
    { tools: [{ name: "memory_search", input: { query: "shipping" } }, { name: "ask_user", input: { question: "Ship to the office or the warehouse? (default: office)", options: ["office", "warehouse"] } }] },
    { tools: [{ name: "finish_task", input: { outcome: "done", result: "Shipped to the warehouse." } }] },
  ]);
  const task = await createTask({ orgId: "org1", title: "Ship", instruction: "Ship the order", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "waiting");
  let t = (await getTask(task.id))!;
  assert.equal(t.status, "waiting_user");
  assert.equal(t.waiting!.kind, "question");
  assert.deepEqual(t.waiting!.options, ["office", "warehouse"]);
  const n = await q("select * from notifications where task_id = $1", [task.id]);
  assert.equal(n.length, 1);
  await answerTask(t, { text: "warehouse" });
  t = (await getTask(task.id))!;
  assert.equal(t.status, "queued");
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "done");
  const results = lastToolResults(calls);
  assert.equal(results.length, 2, "memory_search result and the answer travel in one message");
  assert.match(resultText(results[1]), /User replied: warehouse/);
  assert.equal((await getTask(task.id))!.result, "Shipped to the warehouse.");
});

test("approvals follow the policy; an approved email is sent by the host", async () => {
  const smtp = await import("../src/mail/smtp.js");
  const sent: unknown[] = [];
  smtp.setMailSender(async (_o, _n, m) => {
    sent.push(m);
    return { messageId: "<m1@test>", from: "Acme <ops@acme.test>" };
  });
  const calls = script([
    { tools: [{ name: "request_approval", input: { kind: "purchase", action: "Buy 10 widgets", details: "From vendor.test", amount_usd: 42 } }] },
    { tools: [{ name: "request_approval", input: { kind: "purchase", action: "Buy 100 widgets", details: "From vendor.test", amount_usd: 420 } }] },
    { tools: [{ name: "email_send", input: { to: "sales@vendor.test", subject: "PO ACME-9", body: "Please confirm." } }] },
    { tools: [{ name: "finish_task", input: { outcome: "done", result: "PO sent." } }] },
  ]);
  const task = await createTask({ orgId: "org1", title: "PO", instruction: "Send the PO", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "waiting");
  let t = (await getTask(task.id))!;
  assert.equal(t.waiting!.kind, "approval");
  assert.equal(t.waiting!.amount_usd, 420);
  assert.match(resultText(lastToolResults(calls)[0]), /Approved automatically/);
  await answerTask(t, { approved: false, text: "too many" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "waiting");
  t = (await getTask(task.id))!;
  assert.match(t.waiting!.action!, /Send email to sales@vendor.test/);
  assert.match(resultText(lastToolResults(calls)[0]), /Declined by the user: too many/);
  await answerTask(t, { approved: true });
  assert.equal(sent.length, 1, "the host sent the mail on approval");
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "done");
  assert.match(resultText(lastToolResults(calls)[0]), /Approved by the user\. Sent to sales@vendor.test/);
  smtp.setMailSender(undefined);
});

test("wait_until sleeps the task and wakeTask resumes it; a user message reaches a running task", async () => {
  const calls = script([
    { tools: [{ name: "wait_until", input: { when: "2h", reason: "vendor reply" } }] },
    { tools: [{ name: "report_progress", input: { text: "Checking again." } }] },
    { tools: [{ name: "finish_task", input: { outcome: "blocked", result: "No reply yet; need the vendor's phone number." } }] },
  ]);
  const task = await createTask({ orgId: "org1", title: "Chase", instruction: "Chase the vendor", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "sleeping");
  let t = (await getTask(task.id))!;
  assert.equal(t.status, "waiting_time");
  assert.ok(t.wake_at && t.wake_at.getTime() > Date.now() + 100 * 60_000);
  await wakeTask(task.id);
  t = (await getTask(task.id))!;
  assert.equal(t.status, "queued");
  await messageTask(t, "The vendor is Bob, bob@vendor.test");
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "done");
  const conv = calls[calls.length - 1];
  const texts = conv.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b: { type: string; text?: string; content?: unknown }) => (b.type === "text" ? b.text : b.type === "tool_result" ? resultText(b) : "")).join(" "))).join("\n");
  assert.match(texts, /The wait is over/);
  assert.match(texts, /Message from the user while you work: The vendor is Bob/);
  t = (await getTask(task.id))!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "blocked");
  const n = await q<{ kind: string }>("select kind from notifications where task_id = $1 order by created_at desc limit 1", [task.id]);
  assert.equal(n[0].kind, "needs_you");
});

test("a text-only reply is nudged once, then accepted; the step budget ends with a wrap-up", async () => {
  script([{ text: "Working on it." }, { text: "All done: the invoice is paid, ref 77." }]);
  const task = await createTask({ orgId: "org1", title: "Pay", instruction: "Pay the invoice", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task.id]);
  assert.equal(await runTask(task.id, { worker: "t" }), "done");
  assert.match((await getTask(task.id))!.result!, /ref 77/);

  const many = Array.from({ length: 6 }, () => ({ tools: [{ name: "memory_search", input: { query: "x" } }] }));
  const calls = script([...many, { text: "Got as far as the login page; the site needs a code." }]);
  const task2 = await createTask({ orgId: "org1", title: "Loop", instruction: "Do a thing", createdBy: "u1" });
  await q("update tasks set status = 'running' where id = $1", [task2.id]);
  assert.equal(await runTask(task2.id, { worker: "t" }), "done");
  const t2 = (await getTask(task2.id))!;
  assert.equal(t2.outcome, "blocked");
  assert.match(t2.result!, /needs a code/);
  assert.match(t2.result!, /Stopped by the host/);
  assert.equal(t2.steps, 6);
  const stuckNote = calls.some((c) => JSON.stringify(c).includes("Host note: you have made the same call"));
  assert.ok(stuckNote, "the loop guard spoke up");
});

test("a sub-task's result is delivered to its parent", async () => {
  script([{ tools: [{ name: "finish_task", input: { outcome: "done", result: "Price at vendor B: $12." } }] }]);
  const parent = await createTask({ orgId: "org1", title: "Compare", instruction: "Compare prices", createdBy: "u1" });
  await q("update tasks set status = 'waiting_time', wake_at = now() + interval '1 hour' where id = $1", [parent.id]);
  const child = await createTask({ orgId: "org1", title: "Vendor B", instruction: "Check vendor B", parentId: parent.id, source: "agent" });
  await q("update tasks set status = 'running' where id = $1", [child.id]);
  await runTask(child.id, { worker: "t" });
  const p = (await getTask(parent.id))!;
  assert.equal(p.status, "queued");
  const inbox = await q<{ text: string }>("select text from task_inbox where task_id = $1", [parent.id]);
  assert.match(inbox[0].text, /Sub-task "Vendor B".*finished with outcome done/);
});
