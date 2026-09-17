import assert from "node:assert/strict";
import { test } from "node:test";
import { loopPeriod, NUDGE_PREFIX, promisesAction, shownSinceTaskStart, stallNudge } from "../lib/runtime.js";
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

import { compacted, wholeResultCount } from "../lib/runtime.js";

test("old tool output is stubbed in batches, so the cached prefix holds for a run of turns; the newest stay whole", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("do the thing")];
  for (let i = 0; i < 13; i++) messages.push(call("browser_snapshot"), { role: "tool", tool_call_id: "c", content: `page ${i} ` + "x".repeat(1000) });
  const out = compacted(messages);
  const tools = out.filter((m) => m.role === "tool").map((m) => m.content as string);
  assert.equal(tools.length, 13);
  // 13 results: six stubbed, seven whole (the boundary moves once every six turns, not every turn).
  assert.ok(tools.slice(0, 6).every((c) => c.includes("[older output trimmed")));
  assert.ok(tools.slice(6).every((c) => c.length > 1000));
  // The stored conversation is untouched.
  assert.ok((messages[3].content as string).length > 1000);
  // The boundary: between six and eleven results stay whole, and it only moves at multiples of six.
  assert.deepEqual([6, 7, 11, 12, 13, 17, 18].map((n) => wholeResultCount(n, 6)), [6, 7, 11, 6, 7, 11, 6]);
  assert.equal(wholeResultCount(3, 6), 3);
});

import { siteActivity, SITE_NOTE_PREFIX } from "../lib/runtime.js";
import { taskCostCents } from "../lib/sessions.js";

test("stallNudge: 'say the word', 'need me to' and 'I'll grab it' are offers or promises, not replies", () => {
  const r = row([user("give me the breakdown"), call("memory_grep"), { role: "tool", tool_call_id: "c", content: "..." }]);
  assert.ok(stallNudge(r, "I've only got the total saved, not the itemized list—need to open Monarch's transactions to pull dates. Say the word and I'll grab it."));
  assert.ok(stallNudge(r, "Need me to pull the itemized list?"));
  assert.ok(stallNudge(r, "Let me know if you want the full list and I'll pull it up."));
  assert.ok(stallNudge(r, "Happy to grab the transactions if that helps."));
  assert.equal(stallNudge(r, "You spent $325.52 on gas in the last 30 days: 9/02 Shell Brooklyn $48.10, 9/09 BP Queens $52.00."), undefined);
  assert.equal(stallNudge(r, "Done. I'll check back tomorrow at 9 when the refund should post."), undefined);
});

test("taskCostCents sums the cost stamped on this task's assistant messages only", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "" }, user("first"), { role: "assistant", content: "a", cost: 40 }, user("second"), { role: "assistant", content: null, tool_calls: [], cost: 12.5 }, { role: "assistant", content: "b", cost: 7.5 }];
  assert.equal(taskCostCents(messages), 20);
});

test("siteActivity: domains driven in the task and the site notes written; search engines and one-step visits ignored", () => {
  const goto = (url: string): ChatMessage => call("browser_goto", { url });
  const messages: ChatMessage[] = [{ role: "system", content: "" }, user("gas spend"), goto("https://app.monarchmoney.com/dashboard"), call("browser_click", { ref: "3" }), call("browser_snapshot"), call("browser_click", { ref: "9" }), call("browser_text"), goto("https://duckduckgo.com/?q=x"), call("browser_click", { ref: "1" }), call("memory_write", { path: "sites/monarchmoney.com.md", content: "## Sign-in" })];
  const a = siteActivity(messages);
  assert.equal(a.visited.get("monarchmoney.com"), 5);
  assert.equal(a.visited.has("duckduckgo.com"), false);
  assert.ok(a.noted.has("monarchmoney.com"));
  assert.ok(SITE_NOTE_PREFIX.startsWith("("));
});

import { stripCitations } from "../lib/runtime.js";
test("stripCitations: link trails, markers and source blocks go; the words stay; links stay when asked for", () => {
  const reply = "Ukraine's 3rd Corps cleared about 75 km² near Lyman [[2]](https://theguardian.com/world/2026/sep/16/briefing). Poland scrambled jets [[8]](https://news.sky.com/story/x-12541713).\nLavrov said fighting will not pause [2] (source: https://example.com/a).\n\nSources:\n- https://theguardian.com/a\n- https://news.sky.com/b";
  const out = stripCitations(reply, "what's up in Ukraine last 24 hrs?");
  assert.equal(out, "Ukraine's 3rd Corps cleared about 75 km² near Lyman. Poland scrambled jets.\nLavrov said fighting will not pause.");
  assert.equal(stripCitations("See [the form](https://a.com/form) for details.", "how do I file"), "See the form for details.");
  assert.equal(stripCitations("Here: https://a.com/form", "send me the link"), "Here: https://a.com/form");
  assert.equal(stripCitations("Paid $84.20 on 9/2.", "pay the bill"), "Paid $84.20 on 9/2.");
});

import { calm } from "../lib/runtime.js";
import { isPleasantryCloser, reactionFor } from "../lib/reaction.js";
import { isStableFactQuestion } from "../lib/research.js";
test("calm: exclamation marks become periods outside quotes", () => {
  assert.equal(calm("President Donald Trump was born on June 14, 1946!"), "President Donald Trump was born on June 14, 1946.");
  assert.equal(calm("Done!! Paid $84.20."), "Done. Paid $84.20.");
  assert.equal(calm('Draft: "Congrats on the new place!" Want me to send it?'), 'Draft: "Congrats on the new place!" Want me to send it?');
  assert.equal(calm("Really!?"), "Really?");
});

test("isPleasantryCloser: a bare thanks/praise/ack is a closer; a request or a longer line is not", () => {
  for (const y of ["thanks", "Thanks!", "thank you so much", "thank you", "thx", "ty", "perfect", "got it", "cheers", "🙏", "👍", "❤️", "no worries", "ok thanks", "appreciate it", "great job", "will do", "noted", "sounds good", "thanks a lot", "thanks again", "[2026-09-15 Tue 03:10 America/New_York via chat]\nthanks"]) {
    assert.ok(isPleasantryCloser(y), y);
  }
  for (const n of ["thanks, now book the table", "great, order it", "can you check my bill", "what time is it", "yes", "no", "order milk", "thanks for booking the flight tomorrow please", "thank you for checking my con ed bill now"]) {
    assert.ok(!isPleasantryCloser(n), n);
  }
});

test("reactions: a heart for thanks, a thumb for yes, nothing for questions, codes or complaints, and 'seen' only sometimes", () => {
  assert.equal(reactionFor("Thanks!"), "❤️");
  assert.equal(reactionFor("thank you so much", ["❤️"]), "🙌");
  assert.equal(reactionFor("yes do it"), "👍");
  assert.equal(reactionFor("What's president trump's birthday?"), undefined);
  assert.equal(reactionFor("482913"), undefined);
  assert.equal(reactionFor("why didn't you pay the bill"), undefined);
  assert.equal(reactionFor("I'm very tired"), "❤️");
  assert.equal(reactionFor("lol that's perfect"), "❤️", "thanks-like praise wins over the laugh");
  assert.equal(reactionFor("haha ok"), "😂", "a laugh gets a laugh");
  const requests = Array.from({ length: 40 }, (_, i) => `pay the con ed bill number ${i}`);
  const seen = requests.filter((r) => reactionFor(r) === "👍").length;
  assert.ok(seen > 5 && seen < 25, `seen ${seen} of 40`);
  assert.equal(reactionFor("order more paper towels please", ["👍", "👍"]), undefined, "never three in a row");
  for (const r of requests) assert.ok(reactionFor(r) === reactionFor(r), "deterministic");
});

test("stable facts skip the search; anything that moves does not", () => {
  assert.ok(isStableFactQuestion("what's president trump's birthday?"));
  assert.ok(isStableFactQuestion("what is the capital of Australia"));
  assert.ok(isStableFactQuestion("how many ounces in a gallon"));
  assert.ok(!isStableFactQuestion("what time does Costco close today"));
  assert.ok(!isStableFactQuestion("how much is a Metro-North ticket to White Plains"));
  assert.ok(!isStableFactQuestion("who is the current mayor of New York"));
});

test("promisesAction: a reply that announces the step instead of taking it, in the words the cheap models use", () => {
  for (const p of [
    "I'll check your TaskRabbit account for completed transactions. One moment.",
    "Checking TaskRabbit transactions now.",
    "I'll check TaskRabbit again for completed transactions. One moment.",
    "Sure! Let me look into that for you.",
    "On it.",
    "One moment while I pull up your orders.",
    "I'm going to sign in and read the statement.",
    "Got it, I'll take a quick look at the balance.",
  ]) assert.ok(promisesAction(p), p);
  for (const fine of [
    "Balance is $142.18, due 9/20.",
    "Chris J. isn't accepting task invitations right now, so he can't be booked for Sep 23.",
    "The returned faucets moved: new scan in Middletown, PA at 9:07pm. I'll keep watching every 30 minutes.",
    "I'll check back Thursday once it ships.",
    "The card has $40 on it.",
    "Done: the order is placed, confirmation 112-4471998.",
    "Looking at the tasker list, Chris isn't available and nobody else takes Wednesdays.",
    "Chris isn't available. Let me know if you want another tasker.",
    "",
  ]) assert.ok(!promisesAction(fine), fine || "(empty)");
  // The strict form (escalation, a stop) never fires on a reply that carries a result.
  assert.ok(promisesAction("I'll check your account now. One moment.", true));
  assert.ok(!promisesAction("I found 3 results at $12; I'll open the first one now.", true));
  assert.ok(promisesAction("I found 3 results at $12; I'll open the first one now."));
});

test("stallNudge: 'I'll check your account, one moment' goes back to work", () => {
  const r = row([{ role: "system", content: "s" }, user("list my completed transactions on task rabbit"), { role: "assistant", content: "I'll check your TaskRabbit account for completed transactions. One moment." }]);
  const n = stallNudge(r, "I'll check your TaskRabbit account for completed transactions. One moment.");
  assert.ok(n?.startsWith(NUDGE_PREFIX) && /promised an action/.test(n));
});
