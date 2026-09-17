import assert from "node:assert/strict";
import { test } from "node:test";
import { Cron } from "croner";
import { autoApproved, isInternalEmail, normalizeKind } from "../src/agent/policy.js";
import { pruneContext } from "../src/agent/loop.js";
import { parseWhen, inQuietHours, localStamp } from "../src/time.js";
import { registrableDomain } from "../src/memory.js";
import { htmlToText } from "../src/mail/imap.js";
import { costCents, estimateTokens, type MessageParam } from "../src/llm.js";

test("approval policy", () => {
  const s = { auto_approve_kinds: ["purchase", "payment"], auto_approve_under_usd: 100 };
  assert.equal(autoApproved(s, "purchase", 50), true);
  assert.equal(autoApproved(s, "purchase", 150), false);
  assert.equal(autoApproved(s, "purchase"), true);
  assert.equal(autoApproved(s, "cancel", 0), false);
  assert.equal(autoApproved({ ...s, auto_send_email: true }, "email"), true);
  assert.equal(autoApproved(s, "email"), false);
  assert.equal(normalizeKind("Pay the bill"), "payment");
  assert.equal(normalizeKind("sign contract"), "agreement");
  assert.equal(isInternalEmail("Sam <sam@acme.test>, ops@acme.test", ["owner@acme.test"]), true);
  assert.equal(isInternalEmail("sales@vendor.test, sam@acme.test", ["owner@acme.test"]), false);
});

test("time helpers", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  assert.equal(parseWhen("30m", now)!.toISOString(), "2026-09-17T12:30:00.000Z");
  assert.equal(parseWhen("in 2 hours", now)!.toISOString(), "2026-09-17T14:00:00.000Z");
  assert.equal(parseWhen("3d", now)!.toISOString(), "2026-09-20T12:00:00.000Z");
  assert.equal(parseWhen("2026-10-01T09:00:00Z", now)!.toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(parseWhen("whenever", now), undefined);
  assert.equal(inQuietHours("22-7", "UTC", new Date("2026-09-17T23:30:00Z")), true);
  assert.equal(inQuietHours("22-7", "UTC", new Date("2026-09-17T12:30:00Z")), false);
  assert.equal(inQuietHours("", "UTC"), false);
  assert.match(localStamp("America/New_York", now), /^Thu 2026-09-17 08:00 America\/New_York$/);
});

test("cron next run is in the business's zone", () => {
  const next = new Cron("0 8 * * 1-5", { timezone: "America/New_York" }).nextRun(new Date("2026-09-18T20:00:00Z"));
  assert.equal(next!.toISOString(), "2026-09-21T12:00:00.000Z");
});

test("registrable domain and html to text", () => {
  assert.equal(registrableDomain("https://www.accounts.amazon.com/ap/signin"), "amazon.com");
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(htmlToText("<p>Hi<br>there</p><style>x{}</style><div>&amp; more</div>"), "Hi\nthere\n& more");
});

test("cost and pruning", () => {
  assert.equal(costCents("claude-opus-5", { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 }), 500);
  assert.equal(costCents("claude-haiku-4-5", { input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0 }), 500);
  const big = "x".repeat(5000);
  const conv: MessageParam[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < 120; i++) {
    conv.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "browser_read", input: {} }] });
    conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: big }] });
  }
  const before = estimateTokens(conv);
  assert.ok(before > 120_000);
  pruneContext(conv);
  const afterTokens = estimateTokens(conv);
  assert.ok(afterTokens < before / 4, `pruned ${before} -> ${afterTokens}`);
  const last = conv[conv.length - 1].content as Array<{ content: string }>;
  assert.equal(last[0].content.length, 5000, "recent results are kept whole");
  const first = conv[2].content as Array<{ content: string }>;
  assert.match(first[0].content, /older result trimmed/);
});
