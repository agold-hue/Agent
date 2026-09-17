import assert from "node:assert/strict";
import { test } from "node:test";
import { describeLoginProfile, mergeLoginProfile } from "../lib/credentials.js";
import { codeChannel, KNOWN_LOGIN_URLS, loginCandidates } from "../lib/login.js";

test("the sign-in form is looked for where it was last time, then the known page, then the usual paths, once each", () => {
  assert.equal(KNOWN_LOGIN_URLS["chase.com"], "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline");
  const fresh = loginCandidates("chase.com");
  assert.equal(fresh[0], KNOWN_LOGIN_URLS["chase.com"]);
  assert.equal(fresh[1], "https://chase.com/login");
  const learned = loginCandidates("chase.com", { login_url: "https://secure07a.chase.com/web/auth/#/logon/logon/chaseOnline" });
  assert.equal(learned[0], "https://secure07a.chase.com/web/auth/#/logon/logon/chaseOnline");
  assert.equal(learned[1], KNOWN_LOGIN_URLS["chase.com"]);
  // The remembered page is the known one: listed once.
  const same = loginCandidates("chase.com", { login_url: KNOWN_LOGIN_URLS["chase.com"] });
  assert.equal(same.filter((u) => u === KNOWN_LOGIN_URLS["chase.com"]).length, 1);
  assert.equal(loginCandidates("example.org")[0], "https://example.org/login");
});

test("where the code went is read off the code screen; the memory decides when the page does not say", () => {
  assert.equal(codeChannel("We sent a code to your phone ending in 1234. Enter it below."), "text");
  assert.equal(codeChannel("Enter the code we texted to (***) ***-5678"), "text");
  assert.equal(codeChannel("We emailed a code to j***@gmail.com"), "email");
  assert.equal(codeChannel("Check your inbox: we sent a 6-digit code to your email address."), "email");
  // The chooser's options mention both; the sending sentence decides.
  assert.equal(codeChannel("Text me\nEmail me\nWe sent a code to your mobile number."), "text");
  // Nothing on the page says: the last time's channel, else unknown.
  assert.equal(codeChannel("Enter your verification code"), "unknown");
  assert.equal(codeChannel("Enter your verification code", "email"), "email");
  assert.equal(codeChannel("Enter your verification code", "text"), "text");
  assert.equal(codeChannel("Enter your verification code", "none"), "unknown");
});

test("the vault row keeps the sign-in memory: the page, the code channel, the record, the last wall", () => {
  const now = new Date("2026-09-17T10:00:00Z");
  const first = mergeLoginProfile(undefined, { login_url: "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline", framed: false, code: "text" }, now);
  assert.deepEqual(first, { login_url: "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline", framed: false, code: "text" });
  // A code pending is not an outcome; the user's code arriving is.
  assert.equal(first.n, undefined);
  const done = mergeLoginProfile(first, { ok: true, code: "text" }, now);
  assert.equal(done.ok, 1);
  assert.equal(done.n, 1);
  assert.equal(done.at, now.toISOString());
  const walled = mergeLoginProfile(done, { wall: true, ok: false }, new Date("2026-09-18T10:00:00Z"));
  assert.equal(walled.ok, 1);
  assert.equal(walled.n, 2);
  assert.equal(walled.wall_at, "2026-09-18T10:00:00.000Z");
  assert.equal(walled.login_url, first.login_url);
  const quick = mergeLoginProfile(walled, { ok: true, code: "none", seconds: 11.6 }, now);
  assert.equal(quick.seconds, 12);
  assert.equal(quick.code, "none");
  assert.match(describeLoginProfile(quick)!, /sign-in page is https:\/\/secure\.chase\.com/);
  assert.match(describeLoginProfile(quick)!, /no code was asked last time; 2 of 3 sign-ins worked, the last in 12s/);
  assert.match(describeLoginProfile(done)!, /texted to the user and asked for at once/);
  assert.equal(describeLoginProfile(undefined), undefined);
  assert.equal(describeLoginProfile({ n: 1, ok: 0 }), undefined);
});
