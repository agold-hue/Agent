import assert from "node:assert/strict";
import { test } from "node:test";
import { isSeparateTask, looksLikeAnswer, PARALLEL_PREFIX, toChatItems } from "../lib/chat.js";
import type { SessionRow } from "../lib/sessions.js";

test("a fresh request while the thread is busy runs as its own task; steers and answers do not", () => {
  assert.ok(isSeparateTask("Book the dentist for next Tuesday morning"));
  assert.ok(isSeparateTask("how much is an uber to JFK right now"));
  assert.ok(!isSeparateTask("actually use my other account"));
  assert.ok(!isSeparateTask("no, the Amex"));
  assert.ok(!isSeparateTask("any luck with ConEd?"));
  assert.ok(!isSeparateTask("how did the ConEd login go?"));
  assert.ok(!isSeparateTask("why didn't you pay it?"));
  assert.ok(!isSeparateTask("what's the status on the bill"));
  assert.ok(!isSeparateTask("Hmmm"));
  assert.ok(!isSeparateTask("905168"));
  assert.ok(!isSeparateTask("pay it", undefined)); // too short to be a separate task
  assert.ok(!isSeparateTask("pay the ConEd bill", { id: "s_1-2", who: "agent", text: "Balance is $142" })); // a reply stays in its thread
  assert.ok(PARALLEL_PREFIX.test("also: book the dentist"));
  assert.equal("also: book the dentist".replace(PARALLEL_PREFIX, ""), "book the dentist");
});

test("looksLikeAnswer: approvals, codes, short lines and chat-tier remarks answer a waiting question", () => {
  assert.ok(looksLikeAnswer("yes"));
  assert.ok(looksLikeAnswer("905168"));
  assert.ok(looksLikeAnswer("the Amex ending 4242"));
  assert.ok(!looksLikeAnswer("Find me the cheapest flight to Miami for the weekend of the 26th and compare with Amtrak"));
});

test("attachments show as their file name, and task bubbles carry the task label", () => {
  const row = {
    id: "s_9",
    kind: "task",
    title: "Check my ConEd balance",
    status: "idle",
    created_at: new Date("2026-09-15T07:00:00Z"),
    updated_at: new Date("2026-09-15T08:00:00Z"),
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "(This request runs as its own task alongside the user's chat ...)" },
      { role: "user", content: "[stamp]\n(Attached file: bill.pdf; PDF, 2 pages, contents below)\n\nAmount due $142.17\n(Handle it ...)", at: "2026-09-15T07:10:00.000Z" },
      { role: "user", content: "[stamp]\n(Attached photo: IMG_1.jpeg)\n(Read it. ...)", at: "2026-09-15T07:11:00.000Z" },
      { role: "user", content: "[stamp]\n(Attached file old.docx, application/x, 12 bytes. I cannot read this format directly)", at: "2026-09-15T07:12:00.000Z" },
      { role: "user", content: "[stamp]\n(voice note) pay it today", at: "2026-09-15T07:13:00.000Z" },
      { role: "assistant", content: "Tracked: ConEd $142.17 due 9/20.", at: "2026-09-15T07:14:00.000Z" },
    ],
  } as unknown as SessionRow;
  const items = toChatItems(row).filter((i) => i.kind !== "status");
  assert.deepEqual(items.map((i) => ("text" in i ? i.text : "")), ["📎 bill.pdf", "📎 IMG_1.jpeg", "📎 old.docx", "🎤 pay it today", "Tracked: ConEd $142.17 due 9/20."]);
  assert.ok(items.every((i) => "task" in i && i.task === "Check my ConEd balance"));
});
