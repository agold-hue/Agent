import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSpending, parseOrderLine, periodAsked, periodCovered, summarizeOrders } from "../lib/ledger.js";
import { scopeNote, taskToolResults } from "../lib/tactics.js";
import { trimSections } from "../lib/sessions.js";
import { toolsFor } from "../lib/agent-config.js";
import type { ChatMessage } from "../lib/llm.js";

const now = new Date("2026-09-16T20:00:00Z");

test("periodAsked reads years, trailing windows, this year and named months", () => {
  assert.deepEqual(periodAsked("how much did I spend on Amazon in 2026", now)?.label, "2026 so far");
  assert.equal(periodAsked("show me all 2025 spending", now)?.from.toISOString().slice(0, 10), "2025-01-01");
  assert.equal(periodAsked("last 12 months at Chase", now)?.from.toISOString().slice(0, 10), "2025-09-16");
  assert.equal(periodAsked("what did I spend last year", now)?.label, "2025");
  assert.equal(periodAsked("spending this year", now)?.from.getFullYear(), 2026);
  assert.equal(periodAsked("last 3 months of Uber", now)?.label, "the last 3 months");
  assert.equal(periodAsked("Amazon orders in Aug 2026", now)?.to.toISOString().slice(0, 10), "2026-08-31");
  assert.equal(periodAsked("check my balance", now), undefined);
});

test("an Amazon order card and a bank row both parse to a dated line with a total, refunds and gift cards told apart", () => {
  const card = parseOrderLine(["ORDER PLACED September 10, 2026", "TOTAL $45.12", "SHIP TO Dan", "ORDER # 112-4471234-9988776", "Bounty paper towels"], now)!;
  assert.equal(card.date, "2026-09-10");
  assert.equal(card.amount, 45.12);
  assert.equal(card.kind, "charge");
  assert.equal(card.id, "112-4471234-9988776");
  const refund = parseOrderLine(["Sep 2, 2026", "Refund issued", "-$23.40"], now)!;
  assert.equal(refund.kind, "refund");
  assert.equal(refund.amount, 23.4);
  const gift = parseOrderLine(["Order placed August 3, 2026", "Total $18.00", "Paid with gift card balance", "Order # 112-0000000-1111111"], now)!;
  assert.equal(gift.kind, "gift");
  assert.equal(parseOrderLine(["Buy it again", "View order details"], now), undefined);
});

test("the summary de-duplicates by order id, keeps only the period, and names what it covers", () => {
  const period = periodAsked("all 2026", now)!;
  const lines = [
    parseOrderLine(["Sep 10, 2026", "Total $45.12", "Order # 112-1"], now)!,
    parseOrderLine(["Sep 10, 2026", "Total $45.12", "Order # 112-1"], now)!, // the same order on two pages
    parseOrderLine(["Aug 3, 2026", "Total $18.00", "Paid with gift card balance", "Order # 112-2"], now)!,
    parseOrderLine(["Aug 5, 2026", "Refund $10.00", "Order # 112-3"], now)!,
    parseOrderLine(["Dec 20, 2025", "Total $99.00", "Order # 112-4"], now)!, // outside the period
  ];
  const s = summarizeOrders(lines, period, 4);
  assert.equal(s.orders, 2);
  assert.equal(s.charged, 45.12);
  assert.equal(s.gift, 18);
  assert.equal(s.refunded, 10);
  assert.equal(s.net, 53.12);
  assert.deepEqual(s.covers, { first: "2026-01-01", last: "2026-09-10" });
  const text = formatSpending(s, "amazon.com");
  assert.match(text, /^SPENDING REPORT for 2026 so far \(2026-01-01 to 2026-09-16\) from amazon.com, 4 pages read/);
  assert.match(text, /COVERS 2026-01-01..2026-09-10/);
  assert.ok(periodCovered([text], period));
  assert.ok(!periodCovered(["ledger, last 45 days (x to y)"], period));
  // History that stops short is said plainly.
  const short = summarizeOrders(lines.slice(0, 1), period, 1, "the site shows nothing before 2026-08-01 (no further pages)");
  assert.match(formatSpending(short, "x"), /PARTIAL: the site shows nothing before 2026-08-01/);
});

test("a total for a period nothing read covers is sent back to the full read", () => {
  const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-15 Tue 03:10 America/New_York via chat]\n${text}` });
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, user("Request the report, and show me all 2026 spending"), { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "browser_extract", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: "ledger, last 45 days (2026-08-01 to 2026-09-15), computed by the host from the rows below:\nmoney out: $140.68" }];
  assert.match(scopeNote(messages, "Your total Amazon spending for 2026 so far is $140.68.")!, /nothing you read covers that period/);
  assert.equal(taskToolResults(messages).length, 1);
  const full = [...messages, { role: "tool", tool_call_id: "b", content: "SPENDING REPORT for 2026 so far (2026-01-01 to 2026-09-16) from amazon.com, 9 pages read. COVERS 2026-01-03..2026-09-14." } as ChatMessage];
  assert.equal(scopeNote(full, "Your 2026 Amazon spend is $4,395.45 across 94 orders."), undefined);
  assert.equal(scopeNote(messages, "Here is what I found on the page."), undefined); // no figure, no check
});

test("the prompt is trimmed by class and the tools by what the customer has", () => {
  const prompt = "intro\n\n# How you talk\nplain\n\n# Browser\nlots of browser rules\n\n# Proactive: come to the user\nwatchlist rules\n\n# Memory\nfiles";
  const task = trimSections(prompt, { "Proactive: come to the user": "one line instead" });
  assert.match(task, /# Proactive: come to the user\none line instead/);
  assert.ok(!task.includes("watchlist rules") && task.includes("lots of browser rules"));
  const proactive = trimSections(prompt, { Browser: "tasks do the browsing" });
  assert.ok(!proactive.includes("lots of browser rules") && proactive.includes("watchlist rules"));
  const names = (o: Parameters<typeof toolsFor>[1]) => toolsFor("all", o).map((t) => t.function.name);
  assert.ok(names({ google: true }).includes("calendar"));
  assert.ok(!names({ google: false }).includes("calendar") && !names({ google: false }).includes("owner_inbox"));
  assert.ok(names({ google: false, keep: new Set(["calendar"]) }).includes("calendar")); // already used in the thread: kept
  assert.ok(!names({ bank: false }).includes("bank") && names({}).includes("spending_report"));
});
