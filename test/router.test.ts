import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeastModel, choosePoolModel, DEFAULT_POOLS, isAsk, isFreshRequest, isQuickQuestion, modelFor, nextTier, reroutedModel, tierFor, tierOfModel, visionTier } from "../lib/router.js";
import { modelList } from "../lib/llm.js";

test("only judgment work starts on the hard tier; lookups, research, bookings and cancellations are task work", () => {
  for (const h of ["get a refund for the broken blender", "dispute the $89 charge on the Amex", "negotiate the Verizon bill down", "appeal the denied insurance claim", "review the lease before I sign", "help me buy a house in Montclair"]) assert.equal(tierFor(h, "chat"), "hard", h);
  for (const t of ["compare prices for a Dyson V15", "research summer camps for Sam", "find me the best flight to Miami on the 26th", "get a quote for the roof", "cancel my Hulu subscription", "book a table for 4 at 7 on Friday", "hire a plumber for the leak", "check my ConEd balance", "how much is an uber to JFK right now"]) assert.equal(tierFor(t, "chat"), "task", t);
});

test("notes, list items and reminders stay on the chat tier even with task words in them", () => {
  for (const l of ["add milk and eggs to the list", "put paper towels on the shopping list", "remind me to pay the water bill Friday", "note that Sam's dentist is Dr. Lee", "remember the car inspection is due in October", "fyi the ConEd account number changed", "remind me the lease is up in March", "note: the Amazon refund came through"]) {
    assert.equal(tierFor(l, "chat"), "chat", l);
    assert.ok(isQuickQuestion(l), l);
  }
  for (const w of ["add the new Amex to my Amazon account", "remember my ConEd password is hunter2", "add a $50 tip to the order"]) assert.notEqual(tierFor(w, "chat"), "chat", w);
});

test("isAsk: questions about the work or what the agent knows; not requests, answers or reopens", () => {
  for (const a of ["any luck with ConEd?", "how's it going", "did you pay it?", "what did they say?", "why didn't you use the Amex", "do you have my address?", "status", "is it booked?", "you there?"]) assert.ok(isAsk(a), a);
  for (const n of ["yes", "hmm", "try again", "can you also book the dentist", "how much is an uber to JFK", "book the dentist", "where's my package", "905168", "is it possible to get a refund on the blender", "is there a cheaper flight on Saturday"]) assert.ok(!isAsk(n), n);
  assert.equal(tierFor("when is garbage collection this week", "chat"), "chat");
});

test("a thread is re-tiered per request: up at any time, down only when idle and the message is its own request", () => {
  const chat = modelFor("chat"), task = modelFor("task"), hard = modelFor("hard");
  // Up, even mid-task.
  assert.equal(reroutedModel(chat, "how much is an uber to JFK", false), task);
  assert.equal(reroutedModel(task, "dispute the charge with Amex", false), hard);
  // Down when idle and the message is a request or a quick question.
  assert.equal(reroutedModel(hard, "check my ConEd balance", true), task);
  assert.equal(reroutedModel(hard, "thanks!", true), chat);
  assert.equal(reroutedModel(task, "what's up", true), chat);
  assert.equal(reroutedModel(task, "add milk to the list", true), chat);
  // Never down mid-task, and never for a steer, a reopen, an answer or a question about the work.
  assert.equal(reroutedModel(hard, "check my ConEd balance", false), undefined);
  for (const keep of ["hmm", "try again", "no, the Amex", "actually make it Tuesday", "yes", "ok", "any luck?", "did you pay it?", "use the other card"]) assert.equal(reroutedModel(hard, keep, true), undefined, keep);
  assert.ok(isFreshRequest("check my ConEd balance"));
  assert.ok(!isFreshRequest("use the other card"));
});

test("the ladder starts on the affordable models and climbs one rung at a time to the frontier ones", () => {
  assert.equal(modelList(modelFor("chat"))[0], "deepseek/deepseek-chat");
  assert.equal(modelList(modelFor("task"))[0], "deepseek/deepseek-v4-pro");
  assert.equal(modelList(modelFor("hard"))[0], "anthropic/claude-sonnet-5");
  assert.equal(modelList(modelFor("max"))[0], "anthropic/claude-opus-5");
  // The cheap tiers are pools of affordable models from several vendors, not one model.
  assert.ok(DEFAULT_POOLS.task.some((m) => m.startsWith("qwen/")) && DEFAULT_POOLS.task.some((m) => m.startsWith("moonshotai/")) && DEFAULT_POOLS.task.some((m) => m.startsWith("z-ai/")));
  assert.ok(DEFAULT_POOLS.chat.length >= 4 && DEFAULT_POOLS.task.length >= 5);
  // A session on any pool member belongs to that tier.
  assert.equal(tierOfModel("moonshotai/kimi-k2-0905,deepseek/deepseek-v4-pro"), "task");
  assert.equal(tierOfModel("qwen/qwen3-235b-a22b-2507"), "chat");
  assert.equal(nextTier("chat"), "task");
  assert.equal(nextTier("task"), "hard");
  assert.equal(nextTier("hard"), "max");
  assert.equal(nextTier("max"), null);
  assert.equal(tierOfModel("anthropic/claude-opus-5"), "max");
  assert.equal(tierOfModel("deepseek/deepseek-v4-pro"), "task");
  // The router never starts a request on the top rung; only escalation reaches it.
  for (const t of ["dispute the charge", "negotiate the bill", "check my balance", "hi"]) assert.notEqual(tierFor(t, "chat"), "max");
  // A thread that escalated to the top comes back down for the next plain request.
  assert.equal(reroutedModel(modelFor("max"), "check my ConEd balance", true), modelFor("task"));
});

test("a photo goes to the cheapest tier whose model can see it", () => {
  // DeepSeek reads text; the first tier from task up that can look at an image is the Claude one.
  assert.equal(visionTier("task"), "hard");
  assert.equal(visionTier("hard"), "hard");
  assert.equal(atLeastModel(modelFor("chat"), "task"), modelFor("task"));
  assert.equal(atLeastModel(modelFor("hard"), "task"), undefined);
});

test("within a tier the pool member with the best record wins, the untried get a turn, and a failing primary steps aside", () => {
  const pool = ["a/one", "b/two", "c/three"];
  const price = new Map([["a/one", 1], ["b/two", 2], ["c/three", 0.5]]);
  const stats = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [ok, n]]) => [k, { ok, n }]));
  // No record: the primary, with the rest as fallbacks.
  assert.equal(choosePoolModel(pool, new Map(), price, false), "a/one,b/two,c/three");
  // A proven member beats the primary; ties go to the cheaper one.
  assert.equal(choosePoolModel(pool, stats({ "a/one": [3, 4], "c/three": [4, 4] }), price, false).split(",")[0], "c/three");
  assert.equal(choosePoolModel(pool, stats({ "b/two": [4, 4], "c/three": [4, 4] }), price, false).split(",")[0], "c/three");
  // Exploration hands an untried member its turn.
  assert.equal(choosePoolModel(pool, stats({ "a/one": [2, 2] }), price, true).split(",")[0], "b/two");
  // A primary failing half its tasks steps aside for a member with no bad record.
  assert.equal(choosePoolModel(pool, stats({ "a/one": [1, 4] }), price, false).split(",")[0], "b/two");
  // One sample proves nothing.
  assert.equal(choosePoolModel(pool, stats({ "b/two": [1, 1] }), price, false).split(",")[0], "a/one");
});
