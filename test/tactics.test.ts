import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAfterHandoff, HANDOFF_PREFIX, pageStuck, splitTurnModel, tooDearForValue, valueAtStake, valueBudgetCents } from "../lib/tactics.js";
import { taskStateNote, threadReplies, type ChatItem } from "../lib/chat.js";
import { relevantFailures, type SessionRow } from "../lib/sessions.js";
import { modelFor } from "../lib/router.js";
import type { ChatMessage } from "../lib/llm.js";

const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-15 Tue 03:10 America/New_York via chat]\n${text}`, at: "2026-09-15T07:10:00.000Z" });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const result = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content });

test("pageStuck: three actions that all come back with the same page; different pages or too few actions do not", () => {
  const same = [{ role: "system", content: "s" } as ChatMessage, user("pay the bill")];
  for (let i = 0; i < 3; i++) same.push(call(`c${i}`, "browser_click", { ref: String(i) }), result(`c${i}`, "Billing\nhttps://x.com/billing\n[1] button \"Pay\""));
  assert.ok(pageStuck(same));
  const moving = [{ role: "system", content: "s" } as ChatMessage, user("pay the bill")];
  for (let i = 0; i < 3; i++) moving.push(call(`c${i}`, "browser_click", { ref: String(i) }), result(`c${i}`, `Step ${i}\nhttps://x.com/step${i}\n[1] button`));
  assert.ok(!pageStuck(moving));
  assert.ok(!pageStuck(same.slice(0, 6)));
  // Reads between actions do not count; the actions still do.
  const withReads = [...same.slice(0, 4), call("r", "browser_text"), result("r", "lots of text"), ...same.slice(4)];
  assert.ok(pageStuck(withReads));
});

test("value at stake: the amount named caps the spend and keeps a small matter off the dear models", () => {
  assert.equal(valueAtStake("get the $9.99 Hulu charge refunded"), 9.99);
  assert.equal(valueAtStake("dispute the $1,200 and the $89 charges"), 1200);
  assert.equal(valueAtStake("check my balance"), undefined);
  assert.equal(valueBudgetCents(9.99, 50, 300), 150); // 15% of $9.99 is $1.50
  assert.equal(valueBudgetCents(2, 50, 300), 50); // never below the floor
  assert.equal(valueBudgetCents(5000, 50, 300), 300); // never above the class cap
  assert.ok(tooDearForValue("refund the $9 charge", "hard"));
  assert.ok(!tooDearForValue("refund the $9 charge", "task"));
  assert.ok(!tooDearForValue("dispute the $450 charge", "hard"));
  assert.ok(!tooDearForValue("dispute the charge", "max"));
});

test("after a hand-off the new model reads the request, the hand-off and the last turns; the flailing in between is gone", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("get the refund")];
  for (let i = 0; i < 20; i++) messages.push(call(`c${i}`, "browser_click", { ref: String(i) }), result(`c${i}`, `page ${i}`));
  messages.push({ role: "user", content: `${HANDOFF_PREFIX}\nGoal: refund. Tried: chat widget, denied.)` });
  messages.push({ role: "user", content: "(You are now running on a more capable model.)" });
  const out = compactAfterHandoff(messages);
  assert.equal(out[1], messages[1]);
  assert.match(String(out[2].content), /dropped after the hand-off/);
  assert.ok(out.length < messages.length - 20);
  assert.ok(out[3].role !== "tool"); // the kept tail never starts on a dangling tool result
  assert.ok(out.some((m) => typeof m.content === "string" && m.content.startsWith(HANDOFF_PREFIX)));
  // Stable: the same cut every turn.
  assert.equal(compactAfterHandoff([...messages, call("z", "browser_text"), result("z", "t")]).length, out.length + 2);
  // No hand-off: untouched.
  assert.equal(compactAfterHandoff(messages.slice(0, 10)).length, 10);
});

test("hard-tier tasks: the judgment model plans and decides, the task model clicks", () => {
  const taskModel = modelFor("task");
  const row = (messages: ChatMessage[]) => ({ kind: "chat", model: modelFor("hard"), messages } as unknown as SessionRow);
  const base: ChatMessage[] = [{ role: "system", content: "s" }, user("dispute the $450 charge with Amex")];
  // The opening turns are the judgment model's.
  assert.equal(splitTurnModel(row(base), taskModel), undefined);
  const planned = [...base, call("a", "memory_read", { path: "playbooks/money.md" }), result("a", "notes"), call("b", "browser_goto", { url: "https://amex.com" }), result("b", "Amex\nhttps://amex.com\n[1] link")];
  // Two turns in, after a purely mechanical turn with a calm result: clicking moves to the task model.
  assert.equal(splitTurnModel(row(planned), taskModel), taskModel);
  // Push-back in the result brings judgment back.
  const pushback = [...planned.slice(0, -1), result("b", "Sorry, this charge is not eligible for dispute")];
  assert.equal(splitTurnModel(row(pushback), taskModel), undefined);
  // A checkpoint or a message to a counterparty is never mechanical.
  const decision = [...planned, call("c", "checkpoint", { summary: "x" }), result("c", "APPROVED")];
  assert.equal(splitTurnModel(row(decision), taskModel), undefined);
  // A host note pending (a nudge, a steer) is answered by the judgment model.
  assert.equal(splitTurnModel(row([...planned, { role: "user", content: "(Not done yet: ...)" }]), taskModel), undefined);
  // A task-tier session has nothing to split.
  assert.equal(splitTurnModel({ kind: "chat", model: taskModel, messages: planned } as unknown as SessionRow, taskModel), undefined);
});

test("the task state note keeps the goal, the steps, what was said and the last problem", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("pay the Con Ed bill"), call("a", "browser_goto", { url: "https://coned.com/billing" }), result("a", "Billing\nhttps://coned.com/billing"), { role: "assistant", content: "Signed in, on the bill", ephemeral: true }, call("b", "login", { domain: "coned.com" }), result("b", "Tool login failed: needs_user (captcha)")];
  const note = taskStateNote(messages)!;
  assert.match(note, /Goal: pay the Con Ed bill/);
  assert.match(note, /Done: opened a page, signed in/);
  assert.match(note, /Told the user: "Signed in, on the bill"/);
  assert.match(note, /Last page: https:\/\/coned.com\/billing/);
  assert.match(note, /Last problem: login: Tool login failed/);
});

test("threading: a reply not right under its request quotes it; one right under it does not", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "s1-1", text: "check ConEd", at: "1" },
    { kind: "agent", id: "s1-2", text: "On it", at: "2", replyTo: "s1-1", replyText: "check ConEd" },
    { kind: "user", id: "s2-1", text: "book the dentist", at: "3", task: "book the dentist" },
    { kind: "agent", id: "s2-2", text: "Booked Tue 9am", at: "4", replyTo: "s2-1", replyText: "book the dentist", task: "book the dentist" },
    { kind: "agent", id: "s1-3", text: "Balance $142", at: "5", replyTo: "s1-1", replyText: "check ConEd" },
  ];
  const out = threadReplies(items) as Array<{ quote?: { id: string } ; replyTo?: string }>;
  assert.equal(out[1].quote, undefined); // right under its request
  assert.equal(out[3].quote, undefined); // right under its own request (a task)
  assert.equal(out[4].quote?.id, "s1-1"); // the ConEd answer came after the dentist exchange: quoted
  assert.ok(out.every((i) => !("replyTo" in i)));
});

test("post-mortems for the task's site or class ride along, newest first, at most two", () => {
  const failures = ["### 2026-09-01 10:00 · pay water · water.com\nold water one", "### 2026-09-10 10:00 · con ed bill · coned.com\ncode screen expired after a reload", "### 2026-09-12 10:00 · pay water · water.com\nnewer water one", "### 2026-09-14 10:00 · uber fare · uber.com\nprefilled address"].join("\n\n");
  const bySite = relevantFailures(failures, ["coned.com"], ["money"]);
  assert.equal(bySite.length, 1);
  assert.match(bySite[0], /code screen expired/);
  const byClass = relevantFailures(failures, [], ["water"]);
  assert.equal(byClass.length, 2);
  assert.match(byClass[0], /newer water one/);
  assert.equal(relevantFailures(failures, ["chase.com"], ["travel"]).length, 0);
});

import { looksCut, stripNoReport, unfinishedEarlierTask } from "../lib/runtime.js";
import { STATUS_PING, statusLine } from "../lib/chat.js";
import { reactionFor } from "../lib/reaction.js";

test("a reply cut mid-sentence is caught; one that ends on purpose is not", () => {
  assert.ok(looksCut("It's a solid asset with thin cash flow: bought for"));
  assert.ok(looksCut("You have $302,760 in debt at 7% and"));
  assert.ok(looksCut("Two things to check:"));
  assert.ok(!looksCut("Balance is $142, due 9/20."));
  assert.ok(!looksCut("Booked Tue 9am. Want a reminder?"));
  assert.ok(!looksCut("Balance is $142")); // a figure can end a reply
});

test("NO_REPORT is stripped from the end of a real report and stands alone only when alone", () => {
  assert.equal(stripNoReport("No new scan since 4:10pm. Same status as last check.\n\nNO_REPORT"), "No new scan since 4:10pm. Same status as last check.");
  assert.equal(stripNoReport("NO_REPORT"), "");
  assert.equal(stripNoReport("NO_REPORT\nStill nothing."), "Still nothing.");
});

test("an earlier task interrupted by a question is resumed after the answer; a finished one is not", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("Check for uber ride home now"), call("a", "browser_goto", { url: "https://uber.com" }), result("a", "Uber\nhttps://uber.com"), user("More news from ukraine"), { role: "user", content: "(That message arrived while you are mid-task ...)" }, { role: "assistant", content: "Ukraine news from the last two hours: ..." }];
  assert.equal(unfinishedEarlierTask(messages), "Check for uber ride home now");
  const finished: ChatMessage[] = [{ role: "system", content: "s" }, user("Check for uber ride home now"), call("a", "browser_goto", { url: "https://uber.com" }), result("a", "Uber"), { role: "assistant", content: "UberX $110, 14 min away." }, user("More news from ukraine"), { role: "assistant", content: "news" }];
  assert.equal(unfinishedEarlierTask(finished), undefined);
});

test("a status ping gets a host-written line on where things stand", () => {
  for (const p of ["?", "status", "any luck?", "you there?", "well?"]) assert.ok(STATUS_PING.test(p), p);
  for (const n of ["any luck with ConEd?", "what's the status of the bill", "cancel the ride"]) assert.ok(!STATUS_PING.test(n), n);
  const main = { id: "m", kind: "chat", status: "running", created_at: new Date(Date.now() - 4 * 60_000), messages: [{ role: "system", content: "s" }, { role: "user", content: "[stamp]\nCheck for uber ride home now", at: new Date(Date.now() - 4 * 60_000).toISOString() }, { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "login", arguments: "{}" } }] }, { role: "assistant", content: "Signed in, checking fares", ephemeral: true }] } as unknown as SessionRow;
  const line = statusLine(main, [{ id: "t", kind: "task", status: "running", created_at: new Date(), messages: [{ role: "system", content: "s" }, { role: "user", content: "[stamp]\nBook the dentist", at: new Date().toISOString() }] } as unknown as SessionRow]);
  assert.equal(line, 'Still on "Check for uber ride home now" (4 min): Signed in, checking fares. Alongside, "Book the dentist" (1 min): getting started.');
});

test("a message sent as a reply gets its answer as a reply even when adjacent", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "a-1", text: "Are you crazy?", at: "1", quote: { id: "a-0", who: "agent", text: "bought for $3" } },
    { kind: "agent", id: "a-2", text: "My message cut off; not three dollars.", at: "2", replyTo: "a-1", replyText: "Are you crazy?", replyQuoted: true },
  ];
  const out = threadReplies(items) as Array<{ quote?: { id: string } }>;
  assert.equal(out[1].quote?.id, "a-1");
});

test("reactions read like a person: none on a cancel, a long request or a question; a thumbs up on a yes", () => {
  assert.equal(reactionFor("Cancel the ride"), undefined);
  assert.equal(reactionFor("Check for uber ride home now and tell me the cheapest option please, then book it"), undefined);
  assert.equal(reactionFor("Are you crazy?"), undefined);
  assert.equal(reactionFor("yes"), "👍");
  assert.equal(reactionFor("thanks!"), "❤️");
  assert.equal(reactionFor("ok", ["👍"]), "👍"); // a yes is always a yes
});
