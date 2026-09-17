import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLedgerAnswer, merchantName, merchantOf, receiptsQuery, spendingQuestion, type LedgerSpend } from "../lib/receipts.js";
import { periodAsked } from "../lib/ledger.js";

const now = new Date("2026-09-16T20:00:00Z");

test("the sender becomes the merchant; marketing subdomains do not matter", () => {
  assert.equal(merchantOf("Amazon.com <auto-confirm@amazon.com>"), "amazon.com");
  assert.equal(merchantOf("shipment-tracking@amazon.com"), "amazon.com");
  assert.equal(merchantOf("Uber Receipts <noreply@uber.com>"), "uber.com");
  assert.equal(merchantOf("no-reply@mail.coned.com"), "coned.com");
  assert.equal(merchantName("amazon.com"), "Amazon");
  assert.equal(merchantName("coned.com"), "Con Ed");
  assert.equal(merchantName("somestore.com"), "Somestore");
});

test("a spending question names its period and, when it does, its merchant", () => {
  const q = spendingQuestion("How much did I spend on Amazon in January of 2026?", now)!;
  assert.equal(q.merchant, "amazon.com");
  assert.equal(q.period.label, "jan 2026");
  assert.equal(spendingQuestion("Everything I spent in 2026", now)?.merchant, undefined);
  assert.equal(spendingQuestion("my Uber rides last month", now)?.merchant, "uber.com");
  assert.equal(spendingQuestion("check my balance", now), undefined);
  assert.equal(spendingQuestion("where's my Amazon order from January", now), undefined); // a tracking question, not a sum
});

test("the receipts query covers the period and the merchant", () => {
  const p = periodAsked("January 2026", now)!;
  const q = receiptsQuery({ from: p.from, to: p.to, merchant: "amazon.com" });
  assert.match(q, /after:2025\/12\/31 before:2026\/02\/02 from:amazon.com/);
  assert.match(receiptsQuery({ days: 2 }), /newer_than:2d \(from:\(amazon.com OR/);
});

test("the answer reads like a person wrote it, one line per order, with where it came from", () => {
  const s: LedgerSpend = {
    period: periodAsked("January 2026", now)!,
    merchant: "amazon.com",
    orders: 3,
    charged: 244.22,
    refunded: 0,
    net: 244.22,
    emails: 3,
    lines: [
      { date: "2026-01-27", merchant: "amazon.com", kind: "order", amount: 216.66, items: ["AirPods Pro"], payment: "Mastercard ending 4242" },
      { date: "2026-01-13", merchant: "amazon.com", kind: "order", amount: 8.58, items: ["eyeglass cases"], payment: "Discover ending 2006" },
      { date: "2026-01-05", merchant: "amazon.com", kind: "order", amount: 18.98, items: ["NESCAFE instant coffee"], payment: "Discover ending 2006" },
    ],
  };
  const text = formatLedgerAnswer(s);
  assert.match(text, /^Jan 2026 at Amazon: 3 orders, \$244.22 total:/);
  assert.match(text, /Jan 27 - AirPods Pro - \$216.66 \(Mastercard ending 4242\)/);
  assert.match(text, /From 3 receipt emails \(Jan 1 to Jan 31\)\.$/);
  assert.match(formatLedgerAnswer({ ...s, orders: 0, charged: 0, net: 0, lines: [], emails: 0 }), /^Nothing from Amazon in jan 2026 in your receipts/);
});
