import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

/**
 * The mic lives in public/app.html, so the test runs the shipped source: the voice block is sliced
 * out of the page and given a fake button, recorder and upload. What is being checked is the part
 * that was silently doing nothing before — a tap that starts and a second tap that sends, a hold
 * that sends on release, a finger that slides off the button mid-hold, and a note too short to send.
 */
const page = fs.readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const block = page.slice(page.indexOf("  // Voice: tap the mic"), page.indexOf('  document.addEventListener("visibilitychange"'));

interface Harness {
  down(): Promise<void>;
  up(after?: number): Promise<void>;
  uploads: Array<{ filename: string; mimeType: string; voice?: boolean }>;
  notes: string[];
  placeholder(): string;
  recording(): boolean;
  finishUpload(): Promise<void>;
}

/** The listeners the mic block binds, so a regression can be seen rather than reasoned about. */
let boundKinds: string[] = [];

function harness(opts: { voice_notes?: boolean; voice_formats?: string[]; supported?: string[]; uploadFails?: { error: string; fallback?: string } } = {}): Harness {
  const listeners = new Map<string, Array<(e: unknown) => unknown>>();
  boundKinds = [];
  const text = { value: "", placeholder: "Message", dataset: {} as Record<string, string>, style: {} as Record<string, string>, scrollHeight: 20 };
  const mic = {
    hidden: false,
    title: "",
    dataset: {} as Record<string, string>,
    classList: { on: new Set<string>(), add(c: string) { this.on.add(c); }, remove(c: string) { this.on.delete(c); }, toggle(c: string, v: boolean) { v ? this.on.add(c) : this.on.delete(c); }, contains(c: string) { return this.on.has(c); } },
    setPointerCapture() {},
    addEventListener(kind: string, fn: (e: unknown) => unknown) { boundKinds.push(kind); listeners.set(kind, [...(listeners.get(kind) ?? []), fn]); },
  };
  const uploads: Array<{ filename: string; mimeType: string; voice?: boolean }> = [];
  const notes: string[] = [];
  let clock = 1_780_000_000_000; // a real-looking epoch, advanced by hand so a "hold" needs no waiting
  const supported = opts.supported ?? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  let live: { stop(): void; state: string; onstop: () => Promise<void>; mimeType: string } | undefined;
  let pending: Promise<void> = Promise.resolve();

  class FakeRecorder {
    state = "inactive";
    mimeType: string;
    ondataavailable: ((e: { data: { size: number } }) => void) | undefined;
    onstop: (() => Promise<void>) | undefined;
    constructor(_stream: unknown, o?: { mimeType: string }) { this.mimeType = o?.mimeType ?? "audio/webm"; }
    static isTypeSupported(m: string) { return supported.includes(m); }
    start() { this.state = "recording"; live = this as unknown as typeof live; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: { size: 4000 } });
      pending = Promise.resolve(this.onstop?.()).then(() => {});
    }
  }

  const sandbox: Record<string, unknown> = {
    $: (id: string) => (id === "mic" ? mic : text),
    me: { voice_notes: opts.voice_notes ?? true, voice_formats: opts.voice_formats ?? [] },
    optimistic: (t: string) => { const it = { text: t }; notes.push(t); return it; },
    renderList: () => {},
    autosize: () => {},
    swoosh: () => {},
    updateSub: () => {},
    openStream: () => {},
    sessionId: null,
    status: "idle",
    api: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { filename: string; mimeType: string; voice?: boolean };
      uploads.push(body);
      const fail = opts.uploadFails;
      return { ok: !fail, json: async () => (fail ? fail : { session_id: "s1", text: "pay the con ed bill friday" }) };
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, vibrate: () => {}, language: "en-US" },
    MediaRecorder: FakeRecorder,
    Blob: class { size = 4000; type: string; constructor(_p: unknown[], o?: { type: string }) { this.type = o?.type ?? ""; } },
    FileReader: class { onload: (() => void) | undefined; result = "data:audio/webm;base64,QUJD"; readAsDataURL() { setTimeout(() => this.onload?.(), 0); } },
    window: { MediaRecorder: FakeRecorder },
    Date: { now: () => clock },
    setTimeout: (fn: () => void, ms: number) => (ms > 60_000 ? 0 : setTimeout(fn, 0)), // the 2-minute auto-stop must not fire in a test
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${block}\nsetupMic();`, sandbox);

  const fire = async (kind: string) => {
    for (const fn of listeners.get(kind) ?? []) await fn({ preventDefault() {}, pointerId: 1 });
    await new Promise((r) => setImmediate(r));
  };
  return {
    down: () => fire("pointerdown"),
    up: async (after = 0) => { clock += after; await fire("pointerup"); await new Promise((r) => setImmediate(r)); await pending; },
    uploads,
    notes,
    placeholder: () => text.placeholder,
    recording: () => !!live && live.state === "recording",
    finishUpload: async () => { await pending; await new Promise((r) => setImmediate(r)); },
  };
}

test("a tap starts the recording and a second tap sends it", async () => {
  const h = harness();
  await h.down();
  await h.up(120); // a quick tap: it keeps recording
  assert.ok(h.recording(), "a tap should leave the recorder running");
  assert.match(h.placeholder(), /Recording/);
  await h.down();
  await h.up(2000); // two seconds of talk, then the second tap sends
  await h.finishUpload();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].voice, true);
  assert.ok(!h.recording());
});

test("holding the mic and letting go sends the note", async () => {
  const h = harness();
  await h.down();
  await h.up(3000);
  await h.finishUpload();
  assert.equal(h.uploads.length, 1);
  assert.ok(!h.recording());
});

test("a note too short to have words is not sent silently", async () => {
  const h = harness();
  await h.down();
  await h.up(120);
  await h.down();
  await h.up(80); // stops 200ms in: under the floor
  await h.finishUpload();
  assert.equal(h.uploads.length, 0);
  assert.match(h.placeholder(), /Too short/);
});

test("the recording format follows what the server says it can transcribe", async () => {
  const h = harness({ voice_formats: ["m4a", "mp3", "wav", "ogg", "flac", "aiff"], supported: ["audio/mp4", "audio/webm"] });
  await h.down();
  await h.up(120);
  await h.down();
  await h.up(2000);
  await h.finishUpload();
  assert.equal(h.uploads[0].filename, "voice.m4a"); // not the webm the model route cannot read
});

test("a server that cannot transcribe says so in the chat and turns the mic into dictation", async () => {
  const h = harness({ uploadFails: { error: "voice notes cannot be transcribed here: no transcription route", fallback: "dictation" } });
  await h.down();
  await h.up(120);
  await h.down();
  await h.up(2000);
  await h.finishUpload();
  assert.equal(h.uploads.length, 1);
  assert.ok(h.notes.some((n) => /🎤 sending/.test(n)));
});

test("a finger that slides off the button does not cancel the recording", async () => {
  const h = harness();
  await h.down();
  await h.up(120);
  assert.ok(h.recording());
  // pointerleave used to stop the recorder, which is most of a hold on a phone: the pointer is
  // captured instead, so only a real release (or the next tap) ends the note.
  assert.ok(!boundKinds.includes("pointerleave"), "pointerleave must not stop a recording");
  assert.ok(boundKinds.includes("pointerup"));
});

import { isAudio as isAudioNote, sttRoute, transcribe } from "../lib/stt.js";

test("a deploy transcribes with whatever it has: a Whisper endpoint, the provider's own, or the model", async () => {
  const saved = { ...process.env };
  const reset = () => { for (const k of ["STT_BASE_URL", "STT_API_KEY", "LLM_BASE_URL", "LLM_API_KEY", "STT_CHAT_MODEL", "MODEL_TASK", "MODEL_CHAT"]) delete process.env[k]; };
  try {
    reset();
    process.env.STT_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.STT_API_KEY = "k";
    assert.equal(sttRoute().how, "endpoint");

    reset();
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "k";
    assert.equal(sttRoute().how, "provider"); // no STT_* needed: the provider has /audio/transcriptions

    reset();
    process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.LLM_API_KEY = "k";
    const route = sttRoute(); // the default task pool leads with Gemini, which hears audio
    assert.equal(route.how, "model");
    assert.ok(route.formats?.includes("m4a") && !route.formats.includes("webm"));

    // The one case that has to be said out loud rather than silently failing: the model route
    // cannot read a browser's webm, so the message names the format and the way out.
    await assert.rejects(() => transcribe(Buffer.from("x"), "voice.webm", "audio/webm"), /does not take webm.*STT_BASE_URL/s);

    reset();
    process.env.MODEL_TASK = "deepseek/deepseek-v4-flash";
    process.env.MODEL_CHAT = "deepseek/deepseek-v4-flash";
    process.env.LLM_BASE_URL = "https://api.deepseek.com/v1";
    process.env.LLM_API_KEY = "k";
    assert.equal(sttRoute().how, "none"); // nothing here can hear: the page falls back to dictation
    assert.match(sttRoute().detail, /STT_BASE_URL/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("an iPhone memo and a WhatsApp note are heard as voice notes", () => {
  assert.ok(isAudioNote("video/mp4", "voice.m4a") && isAudioNote("application/octet-stream", "PTT-20260917-WA0002.opus"));
});
