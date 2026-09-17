import assert from "node:assert/strict";
import { test } from "node:test";
import { isAsk, isFreshRequest, isQuickQuestion, modelFor, reroutedModel, tierFor } from "../lib/router.js";

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
