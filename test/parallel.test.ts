import assert from "node:assert/strict";
import { test } from "node:test";
import { isSeparateTask, looksLikeAnswer, PARALLEL_PREFIX, progressBrief, sessionProgress, toChatItems, wantsSideReply } from "../lib/chat.js";
import type { SessionRow } from "../lib/sessions.js";

test("a fresh request while the thread is busy runs as its own task; steers and answers do not", () => {
  assert.ok(isSeparateTask("Book the dentist for next Tuesday morning"));
  assert.ok(isSeparateTask("how much is an uber to JFK right now"));
  assert.ok(!isSeparateTask("actually use my other account"));
  assert.ok(!isSeparateTask("no, the Amex"));
  assert.ok(!isSeparateTask("any luck with ConEd?"));
  assert.ok(!isSeparateTask("how did the ConEd login go?"));
  assert.ok(!isSeparateTask("why didn't you pay it?"));
  assert.ok(!isSeparateTask("what's the status on the bill"));
  assert.ok(!isSeparateTask("Hmmm"));
  assert.ok(!isSeparateTask("did you use the Amex card?"));
  assert.ok(!isSeparateTask("what did Con Ed say about the bill?"));
  assert.ok(!isSeparateTask("905168"));
  assert.ok(!isSeparateTask('Re: "Uber texted another code to your phone to view ride prices. Send it here."\n3054'));
  assert.ok(!isSeparateTask("pay it", undefined)); // too short to be a separate task
  assert.ok(!isSeparateTask("pay the ConEd bill", { id: "s_1-2", who: "agent", text: "Balance is $142" })); // a reply stays in its thread
  assert.ok(PARALLEL_PREFIX.test("also: book the dentist"));
  assert.equal("also: book the dentist".replace(PARALLEL_PREFIX, ""), "book the dentist");
});

test("looksLikeAnswer: approvals, codes, short lines and chat-tier remarks answer a waiting question", () => {
  assert.ok(looksLikeAnswer("yes"));
  assert.ok(looksLikeAnswer("905168"));
  assert.ok(looksLikeAnswer("the Amex ending 4242"));
  assert.ok(!looksLikeAnswer("Find me the cheapest flight to Miami for the weekend of the 26th and compare with Amtrak"));
});

test("attachments show as their file name, and task bubbles carry the task label", () => {
  const row = {
    id: "s_9",
    kind: "task",
    title: "Check my ConEd balance",
    status: "idle",
    created_at: new Date("2026-09-15T07:00:00Z"),
    updated_at: new Date("2026-09-15T08:00:00Z"),
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "(This request runs as its own task alongside the user's chat ...)" },
      { role: "user", content: "[stamp]\n(Attached file: bill.pdf; PDF, 2 pages, contents below)\n\nAmount due $142.17\n(Handle it ...)", at: "2026-09-15T07:10:00.000Z" },
      { role: "user", content: "[stamp]\n(Attached photo: IMG_1.jpeg)\n(Read it. ...)", at: "2026-09-15T07:11:00.000Z" },
      { role: "user", content: "[stamp]\n(Attached file old.docx, application/x, 12 bytes. I cannot read this format directly)", at: "2026-09-15T07:12:00.000Z" },
      { role: "user", content: "[stamp]\n(voice note) pay it today", at: "2026-09-15T07:13:00.000Z" },
      { role: "assistant", content: "Tracked: ConEd $142.17 due 9/20.", at: "2026-09-15T07:14:00.000Z" },
    ],
  } as unknown as SessionRow;
  const items = toChatItems(row).filter((i) => i.kind !== "status");
  assert.deepEqual(items.map((i) => ("text" in i ? i.text : "")), ["📎 bill.pdf", "📎 IMG_1.jpeg", "📎 old.docx", "🎤 pay it today", "Tracked: ConEd $142.17 due 9/20."]);
  assert.ok(items.every((i) => "task" in i && i.task === "Check my ConEd balance"));
});

import { scheduleMatches } from "../server/routes/cron.js";
import { SCHEDULE } from "../server/routes/orders.js";

test("standing-order schedules match the local clock", () => {
  const clock = { day: "2026-09-20", weekday: "Sun", h: 18, m: 0 };
  assert.ok(scheduleMatches("weekly Sun 18:00", clock));
  assert.ok(scheduleMatches("daily 18:00", clock));
  assert.ok(scheduleMatches("monthly 20 18:00", clock));
  assert.ok(!scheduleMatches("weekly Mon 18:00", clock));
  assert.ok(!scheduleMatches("daily 18:01", clock));
  assert.ok(!scheduleMatches("monthly 21 18:00", clock));
  for (const ok of ["daily 9:00", "weekly Sun 18:00", "monthly 20 09:00"]) assert.ok(SCHEDULE.test(ok), ok);
  for (const bad of ["weekly Someday 18:00", "hourly", "monthly 40 09:00 extra"]) assert.ok(!SCHEDULE.test(bad), bad);
});

test("questions and greetings sent while the thread is busy get a side reply; steers, answers and requests do not", () => {
  for (const q of ["any luck with ConEd?", "how's it going?", "did you use the Amex card?", "what did they say about the bill", "do you have my address?", "hi Pete", "you there?", "status", "why didn't you pay it?", "is it paid yet?"]) assert.ok(wantsSideReply(q), q);
  for (const n of ["yes", "ok do it", "thanks!", "905168", "no, use the other card", "actually make it Tuesday", "wait", "Hmmm", "try again", "book the dentist for next Tuesday morning", "how much is an uber to JFK right now", "can you also book the dentist"]) assert.ok(!wantsSideReply(n), n);
  assert.ok(!wantsSideReply("any luck?", { id: "s_1-2", who: "agent", text: "Balance is $142" })); // a reply to a bubble goes to its thread
});

test("the side reply's brief says what the thread is doing, what it said, its last steps and what it waits for", () => {
  const main = {
    id: "s_m",
    kind: "chat",
    status: "waiting",
    pending_kind: "checkpoint",
    pending_event_id: "c3",
    created_at: new Date(Date.now() - 20 * 60_000),
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "[stamp]\nwhat's up", at: new Date(Date.now() - 15 * 60_000).toISOString() },
      { role: "assistant", content: "Quiet day. Con Ed is due Friday.", at: new Date(Date.now() - 14 * 60_000).toISOString() },
      { role: "user", content: "[stamp]\npay the Con Ed bill at https://coned.com", at: new Date(Date.now() - 4 * 60_000).toISOString() },
      { role: "assistant", content: "On it, Boss.", ephemeral: true },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browser_goto", arguments: "{\"url\":\"https://coned.com\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "page" },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "login", arguments: "{\"domain\":\"coned.com\"}" } }] },
      { role: "tool", tool_call_id: "c2", content: "logged in" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "tell_user", arguments: "{\"text\":\"Signed in, pulling up the bill\"}" } }] },
      { role: "assistant", content: "Signed in, pulling up the bill", ephemeral: true },
      { role: "tool", tool_call_id: "t1", content: "shown" },
      { role: "assistant", content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "checkpoint", arguments: "{\"action_type\":\"payment\",\"summary\":\"Pay $142.17 to Con Ed from the Visa\",\"details\":\"x\"}" } }] },
    ],
  } as unknown as SessionRow;
  const one = sessionProgress(main);
  assert.match(one, /Asked: "pay the Con Ed bill at https:\/\/coned.com" \(the chat thread, waiting on the user, 4 min in, 4 steps\)/);
  assert.match(one, /Told the user so far: "On it, Boss." · "Signed in, pulling up the bill"/);
  assert.match(one, /Last steps: opened a page, signed in, posted a progress line, asked for your ok/);
  assert.match(one, /Waiting for: your ok on: Pay \$142.17 to Con Ed from the Visa/);
  const brief = progressBrief(main, [{ id: "s_t", kind: "task", status: "running", title: "Book the dentist", created_at: new Date(), messages: [{ role: "system", content: "s" }, { role: "user", content: "[stamp]\nBook the dentist", at: new Date().toISOString() }] } as unknown as SessionRow]);
  assert.match(brief, /# In progress right now/);
  assert.match(brief, /Asked: "Book the dentist" \(a task alongside the chat, running, 0 min in, 0 steps\)/);
  assert.match(brief, /# The chat so far \(newest last\)\nUser: what's up\nYou: Quiet day. Con Ed is due Friday.\nUser: pay the Con Ed bill/);
  // A side reply's bubbles show as plain replies, never tagged as a task.
  const aside = { id: "s_a", kind: "aside", title: "any luck?", status: "idle", created_at: new Date(), updated_at: new Date(), messages: [{ role: "system", content: "s" }, { role: "user", content: "(The user sent the message below ...)" }, { role: "user", content: "[stamp]\nany luck?", at: new Date().toISOString() }, { role: "assistant", content: "Signed in and on the bill; waiting on your ok to pay $142.17.", at: new Date().toISOString() }] } as unknown as SessionRow;
  const items = toChatItems(aside).filter((i) => i.kind !== "status");
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => !("task" in i)));
});
