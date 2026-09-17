import assert from "node:assert/strict";
import { test } from "node:test";
import { replyPrefix, toChatItems, withQuote } from "../lib/chat.js";
import { codeIn } from "../lib/policy.js";
import type { ChatMessage } from "../lib/llm.js";
import type { SessionRow } from "../lib/sessions.js";

test("codeIn finds a verification code in a short message and nothing else", () => {
  assert.equal(codeIn("Code is 905168"), "905168");
  assert.equal(codeIn("[2026-09-15 Tue 03:10 America/New_York via chat]\n905168"), "905168");
  assert.equal(codeIn("it's 12 34 56"), "123456");
  assert.equal(codeIn("the code: 4471"), "4471");
  assert.equal(codeIn("call me at 2025"), undefined);
  assert.equal(codeIn("I bought it in 2019 and the order number is 112-4471-99887766 for the record"), undefined);
  assert.equal(codeIn("yes"), undefined);
  assert.equal(codeIn("8442 is my email code"), "8442");
  assert.equal(codeIn("the text code: 4471, use that"), "4471");
  assert.equal(codeIn("Log into uber, my phone number is 7186371177"), undefined); // 10 digits: a phone, not a code
  assert.equal(codeIn("meet at 1230 and 1545"), undefined); // two runs, no "code"
  assert.equal(codeIn('Re: your message "Code needed"\n905168'), "905168");
  assert.equal(codeIn('Re: "Uber texted another code to your phone to view ride prices. Send it here."\n3054'), "3054"); // the old page's reply format
});

test("toChatItems hides host notes, shows user messages with their own times, and the progress line", () => {
  const row = {
    id: "s_1",
    status: "idle",
    created_at: new Date("2026-09-15T07:00:00Z"),
    updated_at: new Date("2026-09-15T08:00:00Z"),
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "(Earlier in this chat ...)" },
      { role: "user", content: "[2026-09-15 Tue 03:10 America/New_York via chat]\nCheck my balance", at: "2026-09-15T07:10:00.000Z", reaction: "💵" },
      { role: "assistant", content: "On it, Boss.", ephemeral: true, at: "2026-09-15T07:10:01.000Z" },
      { role: "user", content: "(Several minutes in and the user has heard nothing. ...)" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "tell_user", arguments: "{\"text\":\"Signed in\"}" } }] },
      { role: "assistant", content: "Signed in", ephemeral: true, at: "2026-09-15T07:13:00.000Z" },
      { role: "tool", tool_call_id: "c1", content: "shown" },
      { role: "user", content: [{ type: "text", text: "(screenshot)" }, { type: "image_url", image_url: { url: "data:x" } }] },
      { role: "assistant", content: "Balance is $142, due 9/20.", at: "2026-09-15T07:14:00.000Z" },
    ],
  } as unknown as SessionRow;
  const items = toChatItems(row);
  assert.deepEqual(
    items.map((i) => (i.kind === "status" ? "status" : `${i.kind}:${"text" in i ? i.text : ""}@${i.at}`)),
    ["user:Check my balance@2026-09-15T07:10:00.000Z", "agent:On it, Boss.@2026-09-15T07:10:01.000Z", "agent:Signed in@2026-09-15T07:13:00.000Z", "agent:Balance is $142, due 9/20.@2026-09-15T07:14:00.000Z", "status"],
  );
});

test("bubbles from before timestamps never sort below newer ones (the vanishing-message bug)", () => {
  const row = {
    id: "s_2",
    status: "idle",
    created_at: new Date("2026-09-14T20:00:00Z"),
    updated_at: new Date("2026-09-15T09:30:00Z"), // refreshed on every write, later than every real message time
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "[2026-09-14 Sun 16:00 America/New_York via chat]\nold question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "[2026-09-15 Mon 05:00 America/New_York via chat]\nnew question", at: "2026-09-15T09:00:00.000Z" },
      { role: "assistant", content: "new answer", at: "2026-09-15T09:01:00.000Z" },
    ],
  } as unknown as SessionRow;
  const items = toChatItems(row).filter((i) => i.kind !== "status");
  const times = items.map((i) => i.at);
  assert.deepEqual([...times].sort(), times); // sorting by time keeps the conversation order
  assert.equal(items[0].at, "2026-09-14T20:00:00.000Z");
  assert.equal(items[2].at, "2026-09-15T09:00:00.000Z");
});

test("a reply to an earlier bubble shows the quote and not the Re: line", () => {
  const quote = { id: "s_3-2", who: "agent" as const, text: "Balance is $142, due 9/20." };
  const row = {
    id: "s_3",
    status: "idle",
    created_at: new Date("2026-09-15T07:00:00Z"),
    updated_at: new Date("2026-09-15T08:00:00Z"),
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "[stamp]\nbalance?", at: "2026-09-15T07:10:00.000Z" },
      { role: "assistant", content: "Balance is $142, due 9/20.", at: "2026-09-15T07:11:00.000Z" },
      { role: "user", content: `[stamp]\n${replyPrefix(quote)}pay it`, at: "2026-09-15T07:12:00.000Z", quote },
    ],
  } as unknown as SessionRow;
  const last = toChatItems(row).filter((i) => i.kind === "user").pop()!;
  assert.equal(last.text, "pay it");
  assert.deepEqual((last as { quote?: unknown }).quote, quote);
  assert.equal(withQuote("pay it", quote), 'Re: your message "Balance is $142, due 9/20."\npay it');
});

import { matchTimes, parseTranscript, stampToDate } from "../lib/backfill.js";

test("stampToDate reads the transcript stamp in the user's zone", () => {
  assert.equal(stampToDate("2026-09-15 Tue 03:10 America/New_York")?.toISOString(), "2026-09-15T07:10:00.000Z"); // EDT, UTC-4
  assert.equal(stampToDate("2026-01-15 Thu 03:10 America/New_York")?.toISOString(), "2026-01-15T08:10:00.000Z"); // EST, UTC-5
  assert.equal(stampToDate("garbage"), undefined);
});

test("unstamped bubbles get their time from the conversation log, in order", () => {
  const log = parseTranscript(
    "# Conversation 2026-09-15\n\n### 2026-09-15 Tue 03:05 America/New_York · Owner (chat)\nhi\n\n### 2026-09-15 Tue 03:06 America/New_York · Agent (chat)\nHey.\n\n### 2026-09-15 Tue 03:10 America/New_York · Owner (chat)\nhi\n\n### 2026-09-15 Tue 03:11 America/New_York · Agent (chat)\nStill here.\n",
  );
  assert.equal(log.length, 4);
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "[2026-09-15 Tue 03:05 America/New_York via chat]\nhi" },
    { role: "assistant", content: "On it.", ephemeral: true },
    { role: "assistant", content: "Hey." },
    { role: "user", content: "[2026-09-15 Tue 03:10 America/New_York via chat]\nhi" },
    { role: "assistant", content: "Still here." },
    { role: "assistant", content: "Already stamped.", at: "2026-09-15T07:20:00.000Z" },
  ] as ChatMessage[];
  assert.deepEqual(matchTimes(messages, log), [
    [1, "2026-09-15T07:05:00.000Z"],
    [3, "2026-09-15T07:06:00.000Z"],
    [4, "2026-09-15T07:10:00.000Z"],
    [5, "2026-09-15T07:11:00.000Z"],
  ]);
});

import { describeFile } from "../lib/documents.js";
import fs from "node:fs";

test("a PDF bill is read as text for the model", async () => {
  const pdf = fs.readFileSync(new URL("./fixtures/bill.pdf", import.meta.url));
  const out = await describeFile(pdf, "application/pdf", "bill.pdf");
  assert.ok(out.readable);
  assert.match(out.text, /Amount due: \$142\.17/);
  const other = await describeFile(Buffer.from("x"), "application/octet-stream", "old.docx");
  assert.ok(!other.readable && /cannot be read/.test(other.text));
});

import { toChatItems as toChatItems2 } from "../lib/chat.js";
import { supersedeLastReply } from "../lib/runtime.js";
import type { SessionRow as SessionRow2 } from "../lib/sessions.js";
test("a draft the host sent back to the model is not a chat bubble; the final reply is", () => {
  const messages = [
    { role: "system", content: "" },
    { role: "user", content: "[2026-09-16 Wed 10:00 America/New_York via chat]\nallentown market?", at: "2026-09-16T14:00:00Z" },
    { role: "assistant", content: "Market's hot. Want me to pull what I know?", at: "2026-09-16T14:00:05Z" },
  ] as SessionRow2["messages"];
  supersedeLastReply(messages);
  messages.push({ role: "user", content: "(Not done yet: you offered...)" }, { role: "assistant", content: "Market's hot: $284K median [1]. No holdings on file.", at: "2026-09-16T14:00:20Z" });
  const row = { id: "s1", kind: "chat", status: "idle", created_at: new Date("2026-09-16T14:00:00Z"), messages } as unknown as SessionRow2;
  const agent = toChatItems2(row).filter((i) => i.kind === "agent");
  assert.equal(agent.length, 1);
  assert.match((agent[0] as { text: string }).text, /^Market's hot: \$284K/);
});

import { researchAck } from "../lib/acks.js";
test("acknowledgements are terse and carry no cheer", () => {
  for (let i = 0; i < 40; i++) {
    const a = researchAck([]);
    assert.ok(a.length <= 24, a);
    assert.ok(!/!|boss|hang tight|sure thing|you got it/i.test(a), a);
  }
});

import { isAudio } from "../lib/stt.js";

test("a voice note is recognised by mime type or by the name a phone gives it", () => {
  assert.ok(isAudio("audio/webm", "voice.webm")); // the app's hold-to-record
  assert.ok(isAudio("audio/mpeg", "memo.mp3"));
  assert.ok(isAudio("video/mp4", "voice.m4a")); // an iPhone memo
  assert.ok(isAudio("application/octet-stream", "PTT-20260917-WA0002.opus")); // WhatsApp through a mail server
  assert.ok(isAudio("", "note.amr"));
  assert.ok(!isAudio("application/pdf", "bill.pdf"));
  assert.ok(!isAudio("image/jpeg", "code.jpg"));
  assert.ok(!isAudio("application/octet-stream", "old.docx"));
});

test("an attached voice note comes back as a transcript, and says so plainly when it cannot", async () => {
  const note = Buffer.from("fake audio");
  const off = await describeFile(note, "audio/webm", "voice.webm");
  assert.ok(!off.readable && /could not be transcribed/.test(off.text)); // STT_* unset in tests

  process.env.STT_BASE_URL = "https://stt.example/v1";
  process.env.STT_API_KEY = "k";
  const realFetch = globalThis.fetch;
  let sentTo = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    sentTo = String(url);
    return new Response(JSON.stringify({ text: "pay the con ed bill friday" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await describeFile(note, "audio/webm", "voice.webm");
    assert.equal(sentTo, "https://stt.example/v1/audio/transcriptions");
    assert.ok(out.readable);
    assert.match(out.text, /Voice note: voice\.webm/);
    assert.match(out.text, /pay the con ed bill friday/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STT_BASE_URL;
    delete process.env.STT_API_KEY;
  }
});
