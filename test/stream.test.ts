import assert from "node:assert/strict";
import { test } from "node:test";
import { readStream } from "../lib/llm.js";

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("a streamed text reply is assembled and reported as it arrives", async () => {
  const seen: string[] = [];
  const out = await readStream(
    sse(['data: {"model":"m","choices":[{"delta":{"content":"Bal"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"ance is $142"},"finish_reason":null}]}\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n']),
    (t) => seen.push(t),
  );
  assert.equal(out.choices?.[0].message.content, "Balance is $142");
  assert.equal(out.choices?.[0].finish_reason, "stop");
  assert.equal(out.usage?.completion_tokens, 4);
  assert.equal(seen[seen.length - 1], "Balance is $142");
});

test("tool-call fragments split across chunks are merged by index", async () => {
  const out = await readStream(
    sse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"browser_go","arguments":"{\\"ur"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"to","arguments":"l\\":\\"https://a.com\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"tell_user","arguments":"{\\"text\\":\\"On it\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    ]),
    () => {},
  );
  const calls = out.choices?.[0].message.tool_calls ?? [];
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { id: "call_1", type: "function", function: { name: "browser_goto", arguments: '{"url":"https://a.com"}' } });
  assert.equal(calls[1].function.name, "tell_user");
  assert.equal(out.choices?.[0].message.content, null);
});

test("a provider error inside the stream is surfaced", async () => {
  const out = await readStream(sse(['data: {"error":{"message":"out of credits"}}\n']), () => {});
  assert.equal(out.error?.message, "out of credits");
});
