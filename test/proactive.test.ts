import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../lib/llm.js";
import { autoApprove } from "../lib/policy.js";
import { detectFixes, findPromise, formatReadings, promiseTime, quickReplies } from "../lib/proactive.js";
import { scopeSections } from "../lib/sessions.js";
import type { Tenant } from "../lib/tenant.js";

const NOW = new Date("2026-09-16T14:00:00Z"); // Wed 10:00 New York
const TZ = "America/New_York";

test("promiseTime reads the time a promise names, in the user's zone, never in the past", () => {
  const at = (s: string) => promiseTime(s, NOW, TZ)?.toISOString();
  assert.equal(at("I'll check back tomorrow morning"), "2026-09-17T13:00:00.000Z");
  assert.equal(at("I'll follow up on Thursday"), "2026-09-17T13:00:00.000Z");
  assert.equal(at("I'll confirm at 3pm"), "2026-09-16T19:00:00.000Z");
  assert.equal(at("I'll check again at 9am"), "2026-09-17T13:00:00.000Z", "9am has passed today, so tomorrow");
  assert.equal(at("I'll chase them in 2 hours"), "2026-09-16T16:00:00.000Z");
  assert.equal(at("I'll let you know tonight"), "2026-09-16T23:00:00.000Z");
  assert.equal(at("Paid, all done."), undefined);
  const p = findPromise("Refund requested. I'll check back Thursday and chase if it hasn't posted.", NOW, TZ);
  assert.equal(p?.due.toISOString(), "2026-09-17T13:00:00.000Z");
  assert.match(p!.sentence, /check back Thursday/);
});

test("quickReplies come from the thread's state and the last reply", () => {
  assert.deepEqual(quickReplies("", "waiting", "checkpoint"), ["Approve", "Not now", "Change something"]);
  assert.deepEqual(quickReplies("Want me to book the Uber for 8:15am?", "idle", null), ["Yes, book it for 8:15am", "Not yet"]);
  assert.deepEqual(quickReplies("You owe Con Ed $212.10, due 9/20.", "idle", null), ["Pay it"]);
  assert.deepEqual(quickReplies("Done.", "idle", null), [], "nothing to tap means no chips, never a filler");
  assert.deepEqual(quickReplies("", "running", null), ["How's it going?", "Stop that"]);
});

test("detectFixes turns a task's blockers into fix cards, once each", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "" },
    { role: "user", content: "[2026-09-16 Wed 10:00 America/New_York via chat]\npay the con ed bill" },
    { role: "assistant", content: null, tool_calls: [{ id: "l1", type: "function", function: { name: "login", arguments: JSON.stringify({ domain: "coned.com" }) } }] },
    { role: "tool", tool_call_id: "l1", content: JSON.stringify({ status: "no_credentials", domain: "coned.com" }) },
    { role: "assistant", content: null, tool_calls: [{ id: "g1", type: "function", function: { name: "browser_goto", arguments: JSON.stringify({ url: "https://www.chase.com/" }) } }] },
    { role: "tool", tool_call_id: "g1", content: "Chase\nhttps://www.chase.com/\nverify you are human" },
    { role: "assistant", content: null, tool_calls: [{ id: "l2", type: "function", function: { name: "login", arguments: JSON.stringify({ domain: "coned.com" }) } }] },
    { role: "tool", tool_call_id: "l2", content: JSON.stringify({ status: "no_credentials", domain: "coned.com" }) },
  ];
  const fixes = detectFixes(messages, false, false);
  assert.deepEqual(fixes.map((f) => [f.kind, f.domain]), [["add_login", "coned.com"], ["enable_relay", "chase.com"]]);
  assert.equal(detectFixes(messages, false, true).length, 1, "relay online: no relay card");
});

test("learned approval rules are honoured by the policy", () => {
  const t = { settings: { auto_approve_rules: [{ action_type: "purchase", merchant: "amazon.com", max_usd: 40 }] } } as unknown as Tenant;
  assert.equal(autoApprove(t, { action_type: "purchase", merchant: "www.amazon.com", amount_usd: 24.5, summary: "", details: "" }).ok, true);
  assert.equal(autoApprove(t, { action_type: "purchase", merchant: "amazon.com", amount_usd: 120, summary: "", details: "" }).ok, false);
  assert.equal(autoApprove(t, { action_type: "purchase", merchant: "target.com", amount_usd: 10, summary: "", details: "" }).ok, false);
  assert.equal(autoApprove(t, { action_type: "payment", merchant: "amazon.com", amount_usd: 10, summary: "", details: "" }).ok, false);
});

test("scopeSections keeps the sections a task class needs and the preamble", () => {
  const md = "# Profile\nintro line\n\n## Work\n- Role: x\n\n## Travel\n- Seat: aisle\n\n## Home\n- Address: see standing\n";
  const money = scopeSections(md, /^(work|home)/i);
  assert.match(money, /## Work/);
  assert.match(money, /## Home/);
  assert.ok(!money.includes("## Travel"));
  assert.match(money, /intro line/);
});

test("formatReadings renders this morning's figures with local times", () => {
  const text = formatReadings([{ domain: "coned.com", label: "Amount due", value: "$212.10", read_at: new Date("2026-09-16T08:05:00Z") }], TZ);
  assert.match(text, /coned\.com: Amount due = \$212\.10 \(read 04:05\)/);
  assert.equal(formatReadings([], TZ), "");
});
