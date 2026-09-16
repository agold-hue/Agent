import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSteps, parsePaths, parseSteps, pathName, recordedSteps, RISKY_LABEL, withPath } from "../lib/browser-extras.js";
import type { ChatMessage } from "../lib/llm.js";
import { FirstTokenTimeout, readStream, type ToolCall } from "../lib/llm.js";
import { hasSubstance } from "../lib/review-work.js";
import { isHardSite, tierFor } from "../lib/router.js";
import { housekeepingTurn, previousTaskText, recapEarlier, softLandedTier, TAKEOVER_DONE, unverifiedFigures } from "../lib/runtime.js";

const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-16 Wed 10:00 America/New_York via chat]\n${text}` });
let n = 0;
const call = (name: string, args: Record<string, unknown>, result: string): ChatMessage[] => {
  const id = `c${++n}`;
  return [{ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: result }];
};
const SNAP = 'Monarch\nhttps://app.monarchmoney.com/dashboard\n[3] link "Transactions" /transactions\n[7] button "Filters"\n[9] input:text "Search transactions"\n[12] button "Pay now"\n[14] input:password "Password"';

test("recordedSteps: gotos, clicks and typing by the label the model saw; stops at risky or secret steps and at another site", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "" },
    user("gas spend last 30 days"),
    ...call("browser_goto", { url: "https://app.monarchmoney.com/dashboard" }, SNAP),
    ...call("browser_click", { ref: "3" }, SNAP),
    ...call("browser_snapshot", {}, SNAP),
    ...call("browser_type", { ref: "9", text: "gas", enter: true }, SNAP),
    ...call("browser_click", { text: "Filters" }, SNAP),
    ...call("browser_click", { ref: "12" }, SNAP), // "Pay now": the path ends before it
    ...call("browser_click", { ref: "7" }, SNAP),
  ];
  const steps = recordedSteps(messages, "monarchmoney.com");
  assert.deepEqual(steps, [
    { kind: "goto", url: "https://app.monarchmoney.com/dashboard" },
    { kind: "click", label: "Transactions" },
    { kind: "type", label: "Search transactions", value: "gas", enter: true },
    { kind: "click", label: "Filters" },
  ]);
  // A password field ends the path; a click on an unknown ref ends it; a different site ends it.
  const secret: ChatMessage[] = [{ role: "system", content: "" }, user("x"), ...call("browser_goto", { url: "https://a.com/" }, SNAP), ...call("browser_type", { ref: "14", text: "hunter2" }, SNAP), ...call("browser_click", { ref: "7" }, SNAP)];
  assert.deepEqual(recordedSteps(secret, "a.com"), []); // one goto alone is not a path
  const other: ChatMessage[] = [{ role: "system", content: "" }, user("x"), ...call("browser_goto", { url: "https://a.com/" }, SNAP), ...call("browser_click", { ref: "7" }, SNAP), ...call("browser_goto", { url: "https://b.com/" }, SNAP), ...call("browser_click", { ref: "3" }, SNAP)];
  assert.deepEqual(recordedSteps(other, "a.com").map((s) => s.kind), ["goto", "click"]);
  assert.ok(RISKY_LABEL.test("Place order") && RISKY_LABEL.test("Pay bill") && RISKY_LABEL.test("Cancel subscription") && !RISKY_LABEL.test("Transactions"));
});

test("paths round-trip through the site note; same name replaces, five kept, other sections untouched", () => {
  const steps = parseSteps(formatSteps([{ kind: "goto", url: "https://a.com/x?y=1" }, { kind: "click", label: 'Say "hi"' }, { kind: "type", label: "Search", value: "gas, please", enter: true }, { kind: "select", label: "Month", value: "August" }]));
  assert.equal(steps.length, 4);
  assert.equal((steps[1] as { label: string }).label, 'Say "hi"');
  let note = "# a.com\n\n## Sign-in\nemail + password\n\n## Quirks\nslow\n";
  for (let i = 0; i < 6; i++) note = withPath(note, { name: `task ${i}`, date: "2026-09-16", steps: steps.slice(0, 2) });
  note = withPath(note, { name: "TASK 5", date: "2026-09-17", steps });
  const paths = parsePaths(note);
  assert.equal(paths.length, 5);
  assert.equal(paths[0].name, "TASK 5");
  assert.equal(paths[0].steps.length, 4);
  assert.ok(!paths.some((p) => p.name === "task 0") && !paths.some((p) => p.name === "task 5"));
  assert.match(note, /## Sign-in\nemail \+ password/);
  assert.match(note, /## Quirks\nslow/);
  assert.equal(pathName("[2026-09-16 Wed via chat]\nHow much did I spend on gas? (last 30 days)\nmore"), "how much did i spend on gas last 30 days");
});

test("unverifiedFigures: amounts, phones and codes must appear in what the task read or was told", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Home address: 12 Main St. Auto-approve up to $50." },
    user("what did I pay Con Ed? my account is 1234-5678-90"),
    ...call("browser_text", {}, "Amount due $206.30 paid 09/02. Confirmation CE-88213X. Call 1-800-752-6633."),
  ];
  assert.deepEqual(unverifiedFigures(messages, "You paid $206.30 on 9/2 (confirmation CE-88213X). Con Ed: (800) 752-6633."), []);
  assert.deepEqual(unverifiedFigures(messages, "You paid $325.52. Reference AB12CD34. Call 212-555-0100."), ["$325.52", "212-555-0100", "AB12CD34"]);
  assert.deepEqual(unverifiedFigures(messages, "Under your $50 auto-approve limit."), [], "system prompt figures count");
  assert.deepEqual(unverifiedFigures(messages, "Total $1,206.30"), ["$1,206.30"]);
  assert.deepEqual(unverifiedFigures([...messages, ...call("browser_extract", {}, '[["09/02","$1,206.30"]]')], "Total $1,206.30 or $1206.30"), []);
});

test("recapEarlier: a deep thread collapses earlier tasks to one deterministic note; a short one is untouched", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 6; i++) messages.push(user(`task ${i}`), ...call("browser_text", {}, "page ".repeat(50)), { role: "assistant", content: `done ${i}` });
  messages.push(user("current task"));
  const out = recapEarlier(messages.map((m) => ({ ...m })));
  assert.equal(out.length, 3);
  assert.match(out[1].content as string, /^\(Earlier in this thread/);
  assert.match(out[1].content as string, /user: task 5\n  agent: done 5/);
  assert.ok(!(out[1].content as string).includes("page page"));
  assert.equal(out[2], out[out.length - 1]);
  assert.equal(recapEarlier(messages.map((m) => ({ ...m })))[1].content, out[1].content, "deterministic");
  const short: ChatMessage[] = [{ role: "system", content: "s" }, user("a"), { role: "assistant", content: "b" }, user("c")];
  assert.equal(recapEarlier(short).length, 4);
});

test("housekeepingTurn, softLandedTier, previousTaskText, TAKEOVER_DONE", () => {
  const afterReceipt: ChatMessage[] = [{ role: "system", content: "" }, user("pay the bill"), ...call("browser_click", { ref: "1" }, "ok"), ...call("record_receipt", { title: "Con Ed paid" }, '{"receipt_id":"r1"}')];
  assert.equal(housekeepingTurn(afterReceipt), true);
  const midTask: ChatMessage[] = [{ role: "system", content: "" }, user("pay the bill"), ...call("memory_append", { path: "projects/x.md", text: "log" }, "appended")];
  assert.equal(housekeepingTurn(midTask), false, "a memory note mid-task is not the wrap-up");
  assert.equal(softLandedTier(0.5, "hard"), "hard");
  assert.equal(softLandedTier(0.81, "hard"), "task");
  assert.equal(softLandedTier(0.96, "hard"), "chat");
  assert.equal(softLandedTier(0.9, "task"), "task");
  assert.equal(softLandedTier(0.96, "task"), "chat");
  assert.equal(previousTaskText([{ role: "system", content: "" }, user("pay the con ed bill"), { role: "assistant", content: "sign in via the Logins tab and say done" }, user("done")]), "pay the con ed bill");
  for (const yes of ["done", "ok done", "signed in", "I'm in", "Logged in, try now", "finished"]) assert.ok(TAKEOVER_DONE.test(yes), yes);
  for (const no of ["what's done today", "is it done", "pay the bill"]) assert.ok(!TAKEOVER_DONE.test(no), no);
});

test("hard sites route to the hard tier from the first message", () => {
  assert.ok(isHardSite("https://secure.chase.com/web/auth/dashboard"));
  assert.ok(isHardSite("pay my Bank of America card"));
  assert.ok(!isHardSite("https://app.monarchmoney.com/"));
  assert.equal(tierFor("pay my chase credit card bill", "chat"), "hard");
  assert.equal(tierFor("check in for my delta flight tomorrow", "chat"), "hard");
  assert.equal(tierFor("check my con ed bill", "chat"), "task");
});

test("hasSubstance: template files are empty, a real line counts", () => {
  assert.equal(hasSubstance("# Watchlist\n\n(Fill this in once)\n- Item: ___\n- Phone:\n"), false);
  assert.equal(hasSubstance("# Watchlist\n- Passport renewal, expires 2027-03\n"), true);
});

const sse = (chunks: string[], opts: { hang?: boolean } = {}) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        if (opts.hang) return;
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
  );
};
const delta = (d: Record<string, unknown>, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish ?? null }] })}\n\n`;

test("readStream hands each tool call over as soon as it is complete, and the assembled result matches", async () => {
  const seen: ToolCall[] = [];
  const res = sse([
    delta({ tool_calls: [{ index: 0, id: "a", function: { name: "web_search", arguments: '{"query":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"usps weight"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: "b", function: { name: "fetch_page", arguments: '{"url":"https://a.com"}' } }] }),
    delta({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]);
  const out = await readStream(res, () => {}, { onToolCall: (c) => seen.push(c) });
  assert.deepEqual(seen.map((c) => [c.id, c.function.name]), [["a", "web_search"], ["b", "fetch_page"]]);
  assert.equal(seen[0].function.arguments, '{"query":"usps weight"}');
  assert.equal(out.choices?.[0].message.tool_calls?.length, 2);
  assert.equal(out.choices?.[0].finish_reason, "tool_calls");
});

test("readStream fails fast with FirstTokenTimeout when nothing arrives", async () => {
  await assert.rejects(readStream(sse([], { hang: true }), () => {}, { firstTokenMs: 40 }), (e: unknown) => e instanceof FirstTokenTimeout);
});

import { formatLedger, parseDateCell, parseMoney, summarizeLedger } from "../lib/browser-extras.js";
test("ledger summary: charges, refunds, pending and $0 lines split by the host within the window", () => {
  const now = new Date("2026-09-16T06:00:00Z");
  assert.equal(parseMoney("$59.84"), 59.84);
  assert.equal(parseMoney("-$73.41"), -73.41);
  assert.equal(parseMoney("($20.66)"), -20.66);
  assert.equal(parseMoney("Sep 4"), undefined);
  assert.equal(parseDateCell("Sep 4", now)?.toISOString().slice(0, 10), "2026-09-04");
  assert.equal(parseDateCell("9/11/26", now)?.toISOString().slice(0, 10), "2026-09-11");
  const table = {
    source: "table", heading: "Transactions", total: 7,
    headers: ["Date", "Merchant", "Category", "Amount"],
    rows: [
      ["Sep 11", "Amazon refund", "Shopping", "-$73.41"],
      ["Sep 6", "Amazon.com", "Shopping", "$0.00"],
      ["Sep 4", "Amazon.com bamboo dispensers", "Shopping", "$59.84"],
      ["Sep 4", "Amazon.com glow pop tubes", "Shopping", "$8.68"],
      ["Sep 14", "Amazon.com (pending)", "Shopping", "$12.00"],
      ["Aug 30", "Amazon.com", "Shopping", "$146.82"],
      ["Sep 7", "Amazon order cancelled", "Shopping", "$19.99"],
    ],
  };
  const s = summarizeLedger(table, 15, now)!;
  assert.equal(s.charged, 68.52);
  assert.equal(s.refunded, 73.41);
  assert.equal(s.pending, 12);
  assert.deepEqual(s.lines.filter((l) => l.kind === "no_cash").map((l) => l.amount), [19.99, 0]);
  assert.ok(!s.lines.some((l) => l.description.includes("Aug")), "outside the window");
  const text = formatLedger(s);
  assert.match(text, /money out \(posted charges\): \$68\.52/);
  assert.match(text, /money back \(refunds, credits\): \$73\.41/);
  assert.match(text, /no cash moved/);
});
