import assert from "node:assert/strict";
import { test } from "node:test";
import { loopPeriod, NUDGE_PREFIX, shownSinceTaskStart, stallNudge } from "../lib/runtime.js";
import { isUserMessage, taskClockStart, taskStart, taskTurns, type SessionRow } from "../lib/sessions.js";
import type { ChatMessage } from "../lib/llm.js";

const call = (name: string, args: Record<string, unknown> = {}): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const user = (text: string, at?: string): ChatMessage => ({ role: "user", content: `[2026-09-15 Tue 03:10 America/New_York via chat]\n${text}`, ...(at ? { at } : {}) });
const row = (messages: ChatMessage[]): SessionRow => ({ messages, kind: "chat" } as unknown as SessionRow);

test("loopPeriod: the same call six times is stuck; five is not", () => {
  const same = Array(6).fill("browser_press:{\"key\":\"Enter\"}");
  assert.equal(loopPeriod(same, 6), 1);
  assert.equal(loopPeriod(same.slice(1), 6), 0);
});

test("loopPeriod: a repeating pair or triple is stuck too", () => {
  const pair: string[] = [];
  for (let i = 0; i < 6; i++) pair.push("browser_snapshot:{}", "browser_click:{\"ref\":\"12\"}");
  assert.equal(loopPeriod(pair, 6), 2);
  const triple: string[] = [];
  for (let i = 0; i < 6; i++) triple.push("a", "b", "c");
  assert.equal(loopPeriod(triple, 6), 3);
});

test("loopPeriod: varied browsing never trips it", () => {
  const varied = ["browser_goto:{\"url\":\"a\"}", "browser_snapshot:{}", "browser_click:{\"ref\":\"1\"}", "browser_type:{\"ref\":\"2\",\"text\":\"x\"}", "browser_click:{\"ref\":\"3\"}", "browser_text:{}", "browser_click:{\"ref\":\"4\"}", "browser_snapshot:{}", "browser_click:{\"ref\":\"5\"}", "browser_snapshot:{}", "browser_click:{\"ref\":\"6\"}", "browser_snapshot:{}"];
  assert.equal(loopPeriod(varied, 6), 0);
  // Filling a form: same tool, different arguments.
  const form = Array.from({ length: 8 }, (_, i) => `browser_type:{"ref":"${i}","text":"v"}`);
  assert.equal(loopPeriod(form, 6), 0);
});

test("task budgets count from the user's latest message, not the whole thread", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("first task")];
  for (let i = 0; i < 50; i++) messages.push(call("browser_snapshot"), { role: "tool", tool_call_id: "c", content: "x" });
  messages.push({ role: "assistant", content: "done" });
  messages.push({ role: "assistant", content: "On it, Boss.", ephemeral: true });
  messages.push(user("second task", "2026-09-15T07:10:00.000Z"));
  messages.push({ role: "user", content: "(Not done yet: ...)" }); // a host note does not start a task
  messages.push(call("browser_open"));
  assert.equal(taskStart(messages), messages.length - 3);
  assert.equal(taskTurns(messages), 1);
  assert.equal(taskClockStart(messages), Date.parse("2026-09-15T07:10:00.000Z"));
  assert.ok(isUserMessage(user("x")));
  assert.ok(!isUserMessage({ role: "user", content: "(screenshot)" }));
});

test("the task clock restarts when the user answers a question or sends a code", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("log in", "2026-09-15T07:00:00.000Z"), call("request_code"), { role: "tool", tool_call_id: "c", content: "The user answered: 905168", at: "2026-09-15T13:00:00.000Z" }];
  assert.equal(taskClockStart(messages), Date.parse("2026-09-15T13:00:00.000Z"));
  // The loop's own tool results are not stamped and do not restart it.
  messages.push(call("login"), { role: "tool", tool_call_id: "c", content: "logged in" });
  assert.equal(taskClockStart(messages), Date.parse("2026-09-15T13:00:00.000Z"));
});

test("stallNudge: an offer to look something up goes back to work", () => {
  const r = row([{ role: "system", content: "s" }, user("be more proactive"), { role: "assistant", content: "Here's what's open. Want me to check ConEd now so you have the balance when you wake up?" }]);
  const n = stallNudge(r, "Want me to check ConEd now so you have the balance when you wake up?");
  assert.ok(n?.startsWith(NUDGE_PREFIX) && /offered to look something up/.test(n));
  // A question that needs a yes (money, a message to an outsider) is not nudged.
  assert.equal(stallNudge(r, "Balance is $142 due 9/20. Want me to pay it?"), undefined);
  assert.equal(stallNudge(r, "Want me to ask Sam for the pre-approval letter?"), undefined);
});

test("stallNudge: each kind once, two per user message, empty replies included", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("check the fare"), { role: "assistant", content: "" }];
  const r = row(messages);
  const empty = stallNudge(r, "");
  assert.ok(empty && /empty/.test(empty));
  messages.push({ role: "user", content: empty! }, { role: "assistant", content: "" });
  assert.equal(stallNudge(r, ""), undefined); // same kind again: no
  const promise = stallNudge(r, "I'll try again now.");
  assert.ok(promise && /promised an action/.test(promise));
  messages.push({ role: "user", content: promise! }, { role: "assistant", content: "Want me to check Lyft?" });
  assert.equal(stallNudge(r, "Want me to check Lyft?"), undefined); // two given already
  // A new user message resets the count.
  messages.push(user("try lyft"), { role: "assistant", content: "Want me to check Lyft?" });
  assert.ok(stallNudge(r, "Want me to check Lyft?"));
});

test("shownSinceTaskStart: the ack does not count, a tell_user line does", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("pay the bill"), { role: "assistant", content: "On it, Boss.", ephemeral: true }, call("browser_open")];
  assert.equal(shownSinceTaskStart(messages), false);
  messages.push({ role: "tool", tool_call_id: "c", content: "ok" }, call("tell_user", { text: "Signed in, pulling up the bill" }));
  assert.equal(shownSinceTaskStart(messages), true);
});

import { unfilled } from "../lib/runtime.js";

test("closing filler is stripped from replies; real content and questions stay", () => {
  assert.equal(unfilled("Got it all locked in. Autopay takes $246.27 on Sep 21. Anything else on your mind tonight?"), "Got it all locked in. Autopay takes $246.27 on Sep 21.");
  assert.equal(unfilled("Done. Order #112. Let me know if you need anything else!"), "Done. Order #112.");
  assert.equal(unfilled("Tracked it. Hope this helps! Have a great night!"), "Tracked it.");
  assert.equal(unfilled("The bill says #6L but you're in 6A. Want me to ask Con Ed to move the account to 6A?"), "The bill says #6L but you're in 6A. Want me to ask Con Ed to move the account to 6A?");
  assert.equal(unfilled("Anything else?"), "Anything else?"); // never empty a reply
});

import { isQuickQuestion } from "../lib/router.js";

test("quick questions are greetings, thanks and status; approvals, skepticism, codes and requests are not", () => {
  for (const q of ["what's up", "[2026-09-15 Tue 03:10 America/New_York via chat]\nwhats up", "hi Pete", "thanks!", "how's it going?", "you there?", "any news?"]) assert.ok(isQuickQuestion(q), q);
  for (const n of ["yes", "ok do it", "Hmmm", "try again", "905168", "(Attached file: bill.pdf; PDF)", "check my con ed balance", "how much is an uber to JFK", 'Re: your message "Want me to ask Con Ed?"\nsure'])
    assert.ok(!isQuickQuestion(n), n);
});
