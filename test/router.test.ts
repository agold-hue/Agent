import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeastModel, choosePoolModel, DEFAULT_POOLS, isAsk, isFreshRequest, isQuickQuestion, modelFor, nextTier, reroutedModel, routeFor, tierFor, tierOfModel, visionTier } from "../lib/router.js";
import { isPoor, setModelHistory } from "../lib/model-history.js";
import { type CatalogModel, modelList, withFallbacks } from "../lib/llm.js";

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
  assert.equal(modelList(modelFor("chat"))[0], "deepseek/deepseek-v4-flash");
  assert.equal(modelList(modelFor("task"))[0], "google/gemini-3.8-flash");
  assert.equal(modelList(modelFor("hard"))[0], "anthropic/claude-sonnet-5");
  assert.equal(modelList(modelFor("max"))[0], "anthropic/claude-opus-5");
  // The cheap tiers are pools of affordable models from several vendors, not one model.
  assert.ok(DEFAULT_POOLS.task.some((m) => m.startsWith("qwen/")) && DEFAULT_POOLS.task.some((m) => m.startsWith("moonshotai/")) && DEFAULT_POOLS.task.some((m) => m.startsWith("z-ai/")));
  assert.ok(DEFAULT_POOLS.chat.length >= 4 && DEFAULT_POOLS.task.length >= 5);
  // A session on any pool member belongs to that tier.
  assert.equal(tierOfModel("deepseek/deepseek-v4.1-flash,google/gemini-3.8-flash"), "task");
  assert.equal(tierOfModel("qwen/qwen3.7-flash"), "chat");
  assert.equal(nextTier("chat"), "task");
  assert.equal(nextTier("task"), "hard");
  assert.equal(nextTier("hard"), "max");
  assert.equal(nextTier("max"), null);
  assert.equal(tierOfModel("anthropic/claude-opus-5"), "max");
  assert.equal(tierOfModel("google/gemini-3.8-flash"), "task");
  // The router never starts a request on the top rung; only escalation reaches it.
  for (const t of ["dispute the charge", "negotiate the bill", "check my balance", "hi"]) assert.notEqual(tierFor(t, "chat"), "max");
  // A thread that escalated to the top comes back down for the next plain request.
  assert.equal(reroutedModel(modelFor("max"), "check my ConEd balance", true), modelFor("task"));
});

test("a photo goes to the cheapest tier whose model can see it", () => {
  // DeepSeek V4 Flash reads text; the first tier from chat up that can look at an image is the task one (Gemini Flash).
  assert.equal(visionTier("chat"), "task");
  assert.equal(visionTier("task"), "task");
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

test("a pool member whose record across customers is poor goes to the back of every chain", () => {
  const fails = (model: string, n: number) => ({ model, ok: false, n });
  const wins = (model: string, n: number) => ({ model, ok: true, n });
  try {
    // Not enough history, or enough tasks ended well: the pool is used as set.
    setModelHistory([fails("google/gemini-3.8-flash", 5)]);
    assert.equal(modelList(modelFor("task"))[0], "google/gemini-3.8-flash");
    setModelHistory([fails("google/gemini-3.8-flash", 3), wins("google/gemini-3.8-flash", 3)]);
    assert.equal(modelList(modelFor("task"))[0], "google/gemini-3.8-flash");
    assert.deepEqual(routeFor("task").demoted, []);
    // Six tasks, one ended well: the next pool member leads everywhere the task tier is named.
    setModelHistory([fails("google/gemini-3.8-flash", 5), wins("google/gemini-3.8-flash", 1)]);
    assert.ok(isPoor("google/gemini-3.8-flash"));
    const route = routeFor("task");
    assert.equal(route.models[0], "deepseek/deepseek-v4.1-flash");
    assert.equal(route.models[route.models.length - 1], "google/gemini-3.8-flash"); // still an outage fallback
    assert.deepEqual(route.demoted, [{ model: "google/gemini-3.8-flash", ok: 1, n: 6 }]);
    assert.equal(modelList(reroutedModel(modelFor("chat"), "how much is an uber to JFK", false)!)[0], "deepseek/deepseek-v4.1-flash");
    assert.equal(modelList(atLeastModel(modelFor("chat"), "task")!)[0], "deepseek/deepseek-v4.1-flash");
    // A thread that started on the demoted model still belongs to the task tier.
    assert.equal(tierOfModel("google/gemini-3.8-flash,deepseek/deepseek-v4.1-flash"), "task");
    // Two poor members: least bad first among them, both behind the clean ones.
    setModelHistory([fails("google/gemini-3.8-flash", 6), fails("deepseek/deepseek-v4.1-flash", 4), wins("deepseek/deepseek-v4.1-flash", 2)]);
    const chain = modelList(modelFor("task"));
    assert.equal(chain[0], "deepseek/deepseek-v4-pro");
    assert.deepEqual(chain.slice(-2), ["deepseek/deepseek-v4.1-flash", "google/gemini-3.8-flash"]);
    // The catalog fallback chain never re-introduces a poor model.
    const cat = (id: string, price: number): CatalogModel => ({ id, name: id, in: price / 5, out: (price * 4) / 5, context: 200_000, tools: true, vision: true });
    const models = [cat("google/gemini-3.8-flash", 6), cat("google/gemini-2.5-pro", 11), cat("anthropic/claude-haiku-4.5", 6), cat("openai/gpt-5-mini", 5.5)];
    assert.ok(!withFallbacks(["google/gemini-2.5-pro"], models).includes("google/gemini-3.8-flash"));
    setModelHistory([]);
    assert.ok(withFallbacks(["google/gemini-2.5-pro"], models).includes("google/gemini-3.8-flash"));
    // Once the failures age out of the window the configured order is back.
    assert.equal(modelList(modelFor("task"))[0], "google/gemini-3.8-flash");
    // MODEL_HISTORY=off keeps the pools as set.
    setModelHistory([fails("google/gemini-3.8-flash", 6)]);
    process.env.MODEL_HISTORY = "off";
    assert.equal(modelList(modelFor("task"))[0], "google/gemini-3.8-flash");
  } finally {
    delete process.env.MODEL_HISTORY;
    setModelHistory([]);
  }
});

test("the per-customer pick never explores a member that is poor across customers, nor stands in with one", () => {
  const pool = ["a/one", "b/two", "c/three"];
  const price = new Map([["a/one", 1], ["b/two", 2], ["c/three", 0.5]]);
  const stats = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [ok, n]]) => [k, { ok, n }]));
  const avoid = new Set(["b/two"]);
  assert.equal(choosePoolModel(pool, stats({ "a/one": [2, 2] }), price, true, avoid).split(",")[0], "c/three");
  assert.equal(choosePoolModel(pool, stats({ "a/one": [1, 4] }), price, false, avoid).split(",")[0], "c/three");
  // This customer's own good record still wins.
  assert.equal(choosePoolModel(pool, stats({ "b/two": [4, 4] }), price, false, avoid).split(",")[0], "b/two");
});
