import assert from "node:assert/strict";
import { test } from "node:test";
import { isLookupQuestion, isQuickQuestion, tierFor } from "../lib/router.js";

/**
 * What tier a competent operator would want for each request, against what the router picks.
 * Written before looking at the regexes' behaviour, so the corpus is not curve-fitted to them.
 *   chat = answerable from memory/knowledge in seconds, no browser
 *   task = browser work, lookups, forms, bookings, orders, ordinary drafting
 *   hard = judgment against a counterparty, real money at risk, legal/financial documents
 */
export const CORPUS: Array<[string, "chat" | "task" | "hard", string]> = [
  // --- genuinely chat
  ["hey", "chat", "greeting"],
  ["thanks!", "chat", "greeting"],
  ["what's up", "chat", "greeting"],
  ["how's it going", "chat", "greeting"],
  ["good morning", "chat", "greeting"],
  ["add milk to the list", "chat", "note"],
  ["add batteries and paper towels to the grocery list", "chat", "note"],
  ["note that Sam's number is 555-0134", "chat", "note"],
  ["remind me to call Chaim at 3", "chat", "note"],
  ["remind me the lease is up in March", "chat", "note"],
  ["what's my home address again", "chat", "recall"],
  ["what did I ask you yesterday", "chat", "recall"],
  ["who is my dentist", "chat", "recall"],
  ["call me Mendy from now on", "chat", "preference"],
  ["what's on my calendar tomorrow", "chat", "recall"],

  // --- ordinary task work
  ["what's my ConEd balance", "task", "account"],
  ["pay the ConEd bill", "task", "account"],
  ["where's my package", "task", "tracking"],
  ["track the Amazon order from Tuesday", "task", "tracking"],
  ["reorder the dog food", "task", "shopping"],
  ["how much is an uber to JFK right now", "task", "lookup"],
  ["book me a table for four Friday at 7", "task", "booking"],
  ["schedule a dentist appointment for next week", "task", "booking"],
  ["cancel my Netflix subscription", "task", "account"],
  ["find the cheapest flight to Miami in March", "task", "research"],
  ["what time does the Costco on Route 9 close", "chat", "lookup (quickLookup answers it)"],
  ["is the bridge closed this weekend", "chat", "lookup (quickLookup answers it)"],
  ["return the shoes I bought last week", "task", "shopping"],
  ["sign me up for the newsletter at that site", "task", "signup"],
  ["download my last three Verizon statements", "task", "account"],
  ["check if my prescription is ready", "task", "health"],
  ["order the groceries from the list", "task", "shopping"],
  ["what did I spend on Amazon in January", "task", "spending"],
  ["renew my gym membership", "task", "account"],
  ["fill out the school form they sent", "task", "paperwork"],
  ["upload the insurance card to the portal", "task", "paperwork"],
  ["compare home insurance quotes", "task", "research"],
  ["email the plumber and ask when he can come", "task", "correspondence"],
  ["unsubscribe me from these newsletters", "task", "inbox"],
  ["what's the weather in Lakewood this weekend", "chat", "lookup (quickLookup answers it)"],

  // --- drafting, ordinary
  ["write me a letter to my landlord about the radiator", "task", "document"],
  ["draft a thank-you note to the Steins", "task", "document"],
  ["type up the meeting notes as a pdf", "task", "document"],
  ["make me a packing list for the trip", "task", "document"],
  ["summarise this month's bills in a document", "task", "document"],
  ["generate an invoice for $2,400 to Riverbend", "task", "document"],
  ["write the reference letter for Yoni", "task", "document"],

  // --- judgment / counterparty / legal
  ["get me a refund for the flight they cancelled", "hard", "counterparty"],
  ["dispute this $340 charge with Amex", "hard", "counterparty"],
  ["negotiate my Verizon bill down", "hard", "counterparty"],
  ["appeal the insurance denial", "hard", "counterparty"],
  ["file a claim for the water damage", "hard", "counterparty"],
  ["complain to the airline about the delay", "hard", "counterparty"],
  ["they overcharged me, sort it out", "hard", "counterparty"],
  ["give me the operating agreement pdf we spoke about", "hard", "legal doc"],
  ["draft an LLC operating agreement for North 15 PA", "hard", "legal doc"],
  ["write up the bylaws for the new entity", "hard", "legal doc"],
  ["prepare a promissory note for the $50k loan", "hard", "legal doc"],
  ["draft an NDA for the contractor", "hard", "legal doc"],
  ["review this lease and write me an amendment", "hard", "legal doc"],
  ["put together a power of attorney for my mother", "hard", "legal doc"],
  ["write a demand letter to the contractor", "hard", "counterparty"],
  ["log into Chase and pay the mortgage", "hard", "hard site"],
  ["check my Bank of America balance", "hard", "hard site"],
  ["move $5,000 from savings to checking at Citi", "hard", "hard site"],
  ["rebook my Delta flight for Thursday", "hard", "hard site"],
  ["renew my passport", "hard", "hard site"],
];

const RANK = { chat: 0, task: 1, hard: 2, max: 3 } as const;

/**
 * The routing golden set. Under-routing is the expensive error: a request sent to the chat tier is
 * also classed a quick question, so it gets three steps and a tool set with no browser and no
 * documents — which is how "give me the operating agreement pdf" spent eight minutes searching the
 * web and produced nothing. Over-routing merely costs a few cents.
 */
test("no request in the golden set is under-routed", () => {
  const wrong: string[] = [];
  for (const [text, want] of CORPUS) {
    const got = tierFor(text, "chat");
    if (RANK[got] < RANK[want]) wrong.push(`"${text}" wanted ${want}, got ${got}`);
  }
  assert.deepEqual(wrong, [], `under-routed:\n${wrong.join("\n")}`);
});

test("nothing that needs work is left with three steps and no tools", () => {
  const trapped = CORPUS.filter(([text, want]) => want !== "chat" && tierFor(text, "chat") === "chat" && isQuickQuestion(text)).map(([t]) => t);
  assert.deepEqual(trapped, [], `quick-question trap:\n${trapped.join("\n")}`);
});

test("a chat-tier request that still needs a fact is answered by the lookup path", () => {
  // These stay cheap on purpose: quickLookup answers them with one search on the fast model.
  for (const t of ["what time does the Costco on Route 9 close", "is the bridge closed this weekend", "what's the weather in Lakewood this weekend"]) {
    assert.ok(isLookupQuestion(t), `${t} should take the lookup fast path`);
  }
});

test("small talk and notes are not pushed up a tier by the fixes", () => {
  for (const [text, want] of CORPUS.filter(([, w]) => w === "chat")) {
    assert.equal(tierFor(text, "chat"), "chat", `"${text}" should stay on the chat tier`);
    void want;
  }
});

test("money and named banks are never small talk, whatever the tier heuristic says", () => {
  assert.ok(!isQuickQuestion("move $5,000 from savings to checking at Citi"));
  assert.ok(!isQuickQuestion("was I charged 340 dollars twice"));
  assert.ok(!isQuickQuestion("check my Chase balance"));
  assert.ok(isQuickQuestion("hey how's it going"));
  assert.ok(isQuickQuestion("thanks!"));
});
