import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropic } from "../lib/batch.js";
import { applyReaders, labelBefore, parseReaders, recordedReaders, withReaders } from "../lib/browser-extras.js";
import { toChatItems } from "../lib/chat.js";
import { isCorrection } from "../lib/learn.js";
import { withCacheMarkers, type ChatMessage } from "../lib/llm.js";
import { shouldStepDown, shouldStepUp, taskClassKey } from "../lib/outcomes.js";
import { runLocalBrowserTool } from "../lib/relay.js";
import { withContextBlock } from "../lib/runtime.js";
import { sharedSystem, type SessionRow } from "../lib/sessions.js";
import { detectCarrier } from "../lib/tracking.js";
import { excerptFor, parseEvery, stableHash } from "../lib/watches.js";

const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-16 Wed 10:00 America/New_York via chat]\n${text}` });
let n = 0;
const call = (name: string, args: Record<string, unknown>, result: string): ChatMessage[] => {
  const id = `c${++n}`;
  return [{ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: result }];
};

test("watches: intervals parse, the excerpt follows the focus words, and clocks or counters do not count as change", () => {
  assert.equal(parseEvery("30m"), 30);
  assert.equal(parseEvery("2h"), 120);
  assert.equal(parseEvery("1 day"), 1440);
  assert.equal(parseEvery("soon"), undefined);
  const page = "Header\nLast updated 10:32 am\nPrice: $1,299.00\nIn stock: no\nFooter 123 people viewing";
  assert.equal(excerptFor(page, "price, in stock"), "Price: $1,299.00\nIn stock: no");
  assert.equal(stableHash("Price $1,299 updated 10:32 am 12 people viewing"), stableHash("Price $1,299 updated 11:05 pm 40 people viewing"));
  assert.notEqual(stableHash("Price $1,299"), stableHash("Price $1,199"));
});

test("adaptive tiers: three clean wins step down, one loss does not; task classes come from the playbooks", () => {
  assert.equal(shouldStepDown(3, 0), true);
  assert.equal(shouldStepDown(2, 0), false);
  assert.equal(shouldStepDown(10, 1), false);
  // Two failures on the router's own tier, and more failures than wins, send the class up a rung.
  assert.equal(shouldStepUp(0, 2), true);
  assert.equal(shouldStepUp(1, 3), true);
  assert.equal(shouldStepUp(0, 1), false);
  assert.equal(shouldStepUp(5, 2), false);
  assert.equal(taskClassKey("pay the con ed bill"), "money");
  assert.equal(taskClassKey("book a flight to Denver"), "travel");
  assert.equal(taskClassKey("hello there"), "general");
});

test("corrections are recognised; ordinary requests are not", () => {
  for (const yes of ["no, the Brooklyn account", "I said the other card", "never before 9am", "Actually it's the office address", "wrong store"]) assert.ok(isCorrection(yes), yes);
  for (const no of ["pay the bill", "what time does costco close", "yes go ahead", "thanks!"]) assert.ok(!isCorrection(no), no);
});

test("carrier detection from the tracking number", () => {
  assert.equal(detectCarrier("1Z999AA10123456784"), "ups");
  assert.equal(detectCarrier("9400 1000 0000 0000 0000 00"), "usps");
  assert.equal(detectCarrier("794644790138"), "fedex");
  assert.equal(detectCarrier("hello"), undefined);
});

test("recorded readers: the label a figure sat next to, stored in the site note and applied to a new page", () => {
  const page = "Con Edison\nhttps://www.coned.com/en/accounts-billing\nAccount 1234\nAmount due\n$206.30\nDue date 09/20\nLast payment: $198.10";
  assert.equal(labelBefore(page, page.indexOf("$206.30")), "Amount due");
  assert.equal(labelBefore(page, page.indexOf("$198.10")), "Last payment");
  const messages: ChatMessage[] = [{ role: "system", content: "" }, user("what do I owe con ed"), ...call("browser_goto", { url: "https://www.coned.com/en/accounts-billing" }, page), ...call("browser_text", {}, page)];
  const readers = recordedReaders(messages, "coned.com", "You owe $206.30, due 9/20. Your last payment was $198.10.");
  assert.deepEqual(readers.map((r) => r.label), ["Amount due", "Last payment"]);
  const note = withReaders("# coned.com\n\n## Sign-in\nemail + password\n", readers);
  assert.deepEqual(parseReaders(note).map((r) => r.label), ["Amount due", "Last payment"]);
  assert.match(note, /## Sign-in\nemail \+ password/);
  assert.deepEqual(applyReaders("Account 1234\nAmount due\n$212.10\nDue date 10/20\nLast payment: $206.30", readers), ["Amount due: $212.10", "Last payment: $206.30"]);
});

test("batch conversion: system apart, tool traffic flattened, roles alternate, first message is the user's", () => {
  const { system, messages } = toAnthropic([
    { role: "system", content: "You write post-mortems." },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "browser_goto", arguments: '{"url":"https://x"}' } }] },
    { role: "tool", tool_call_id: "a", content: "page text" },
    { role: "assistant", content: "I could not sign in." },
    { role: "user", content: "(Write the post-mortem now.)" },
  ]);
  assert.equal(system, "You write post-mortems.");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.match(messages[0].content, /\(continue\)/);
  assert.match(messages[1].content, /called browser_goto/);
  assert.match(messages[2].content, /\(tool result\)\npage text/);
});

test("the shared system prompt carries no customer; the context block is its own cache boundary", () => {
  const shared = sharedSystem();
  assert.ok(!/@|Time zone:/.test(shared.split("# This deployment")[1] ?? ""), "no customer email or time zone in the shared prompt");
  const ctx = withContextBlock([{ role: "system", content: "S" }, user("hi")], "# This user\nUser: a@b.c");
  assert.equal(ctx.length, 3);
  assert.equal(ctx[1].cacheBoundary, true);
  const marked = withCacheMarkers(ctx, "full");
  assert.ok(Array.isArray(marked[1].content), "the context block got a cache marker");
  assert.equal(typeof withCacheMarkers([{ role: "system", content: "S" }, user("hi")], "full")[1].content, "object", "the newest user message is marked too");
});

test("local_browser validates its arguments before touching the relay", async () => {
  const row = {} as SessionRow;
  const t = { id: "u1" } as unknown as import("../lib/tenant.js").Tenant;
  assert.match(await runLocalBrowserTool(t, row, { action: "dance" }), /^Pass action/);
  assert.match(await runLocalBrowserTool(t, row, { action: "goto" }), /^Pass url/);
  assert.match(await runLocalBrowserTool(t, row, { action: "click" }), /^Pass ref/);
});

test("a checkpoint card carries its preview image when one was taken", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "" },
    user("buy the filter"),
    { role: "assistant", content: null, at: "2026-09-16T14:00:05Z", tool_calls: [{ id: "cp1", type: "function", function: { name: "checkpoint", arguments: JSON.stringify({ action_type: "purchase", summary: "Buy filter $24", details: "Amazon cart" }) } }], previews: { cp1: "rcpt-9" } },
  ];
  const row = { id: "s1", kind: "chat", status: "waiting", created_at: new Date("2026-09-16T14:00:00Z"), messages } as unknown as SessionRow;
  const card = toChatItems(row).find((i) => i.kind === "tool") as { preview?: string };
  assert.equal(card.preview, "/api/receipts?image=rcpt-9");
});
