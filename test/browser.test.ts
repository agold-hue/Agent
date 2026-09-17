import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.DATABASE_URL = "pglite://";
process.env.DATA_DIR = fs.mkdtempSync("/tmp/wm-test-");
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SESSION_SECRET = "test";
process.env.PAGE_SETTLE_MS = "1500";

const { migrate, closeDb, q } = await import("../src/db.js");
const { runBrowserAction } = await import("../src/browser/actions.js");
type BrowserSession = import("../src/browser/actions.js").BrowserSession;
const { shutdownBrowsers } = await import("../src/browser/pool.js");
const { diffSnapshot } = await import("../src/browser/snapshot.js");
const { saveCredential } = await import("../src/vault.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = pathToFileURL(path.join(here, "fixtures", "form.html")).href;
const s: BrowserSession = { orgId: "org_test", taskId: "task_test", timezone: "America/New_York" };
const ref = (snap: string, re: RegExp): string => {
  const line = snap.split("\n").find((l) => re.test(l));
  assert.ok(line, `no line matching ${re} in:\n${snap}`);
  return line!.match(/\[ref=([^\]]+)\]/)![1];
};

before(async () => {
  await migrate();
  await q("insert into orgs (id, name) values ('org_test', 'Test')");
});
after(async () => {
  await shutdownBrowsers();
  await closeDb();
});

test("navigate, snapshot, fill a form in one call, submit, read result", async () => {
  const nav = await runBrowserAction(s, "browser_navigate", { url: fixture });
  assert.match(nav.text, /Vendor Portal/);
  assert.match(nav.text, /textbox "Company"/);
  const company = ref(nav.text, /textbox "Company"/);
  const email = ref(nav.text, /textbox "Email"/);
  const country = ref(nav.text, /combobox "Country"/);
  const terms = ref(nav.text, /checkbox "I accept the terms"/);
  const note = ref(nav.text, /textbox "Note"/);
  const fill = await runBrowserAction(s, "browser_fill", { fields: [{ ref: company, value: "Acme LLC" }, { ref: email, value: "ops@acme.test" }, { ref: country, value: "Canada" }, { ref: terms, value: true }, { ref: note, value: "hello there" }] });
  assert.match(fill.text, /Filled 5 field/);
  assert.doesNotMatch(fill.text, /FAILED/);
  const btn = ref(nav.text, /button "Create account"/);
  const clicked = await runBrowserAction(s, "browser_click", { ref: btn });
  assert.match(clicked.text, /Submitted: ops@acme.test \/ CA \/ terms \/ hello there/);
});

test("browser_type with submit, browser_find, and stale ref handling", async () => {
  const nav = await runBrowserAction(s, "browser_navigate", { url: fixture });
  const company = ref(nav.text, /textbox "Company"/);
  const typed = await runBrowserAction(s, "browser_type", { ref: company, text: "Globex" });
  assert.match(typed.text, /Typed into/);
  const found = await runBrowserAction(s, "browser_find", { text: "Bottom button" });
  assert.match(found.text, /button "Bottom button" \[ref=/);
  const stale = await runBrowserAction(s, "browser_click", { ref: "e9999" });
  assert.match(stale.text, /stale|fresh browser_snapshot/i);
});

test("wait for text that appears later (a live chat reply)", async () => {
  const nav = await runBrowserAction(s, "browser_navigate", { url: fixture });
  const open = ref(nav.text, /button "Open chat"/);
  await runBrowserAction(s, "browser_click", { ref: open });
  const waited = await runBrowserAction(s, "browser_wait", { text: "refund has been approved", seconds: 10 });
  assert.match(waited.text, /Condition met/);
  const read = await runBrowserAction(s, "browser_read", {});
  assert.match(read.text, /RF-7781/);
});

test("iframe elements are addressable; downloads become files; pdf export", async () => {
  const nav = await runBrowserAction(s, "browser_navigate", { url: fixture });
  const card = ref(nav.text, /textbox "Card number"/);
  assert.match(card, /^f\d+e\d+$/);
  await runBrowserAction(s, "browser_type", { ref: card, text: "4111" });
  const save = ref(nav.text, /button "Save card"/);
  const saved = await runBrowserAction(s, "browser_click", { ref: save });
  assert.match(saved.text, /Card saved/);
  const dl = ref(nav.text, /link "Download statement"/);
  const clicked = await runBrowserAction(s, "browser_click", { ref: dl });
  await new Promise((r) => setTimeout(r, 800));
  const snap = await runBrowserAction(s, "browser_snapshot", {});
  assert.match(clicked.text + snap.text, /Downloaded "statement.txt"/);
  const pdf = await runBrowserAction(s, "browser_pdf", { name: "portal" });
  assert.match(pdf.text, /Saved the page as PDF: "portal.pdf"/);
  const files = await q<{ name: string; bytes: string }>("select name, bytes::text from files where org_id = 'org_test' order by created_at");
  assert.deepEqual(files.map((f) => f.name), ["statement.txt", "portal.pdf"]);
});

test("vault login fills username and password without exposing them", async () => {
  await saveCredential("org_test", { domain: "vendor.example.com", username: "ops@acme.test", password: "s3cret!" });
  const nav = await runBrowserAction(s, "browser_navigate", { url: fixture });
  const company = ref(nav.text, /textbox "Company"/);
  const email = ref(nav.text, /textbox "Email"/);
  const pw = ref(nav.text, /textbox "Password"/);
  const wrong = await runBrowserAction(s, "browser_fill_login", { site: "https://vendor.example.com/login", username_ref: company, password_ref: email });
  assert.match(wrong.text, /refused to type the password/);
  assert.doesNotMatch(wrong.text, /s3cret/);
  const r = await runBrowserAction(s, "browser_fill_login", { site: "https://vendor.example.com/login", username_ref: company, password_ref: pw });
  assert.match(r.text, /Filled username \(ops@acme.test\), password/);
  assert.doesNotMatch(r.text, /s3cret/);
  const miss = await runBrowserAction(s, "browser_fill_login", { site: "nothing.other.org", username_ref: company });
  assert.match(miss.text, /No saved login/);
});

test("tabs and scrolling", async () => {
  await runBrowserAction(s, "browser_navigate", { url: fixture });
  const tabs = await runBrowserAction(s, "browser_tabs", { action: "new", url: fixture });
  assert.match(tabs.text, /Opened a new tab \(index 1\)/);
  const list = await runBrowserAction(s, "browser_tabs", { action: "list" });
  assert.match(list.text, /\* \[1\]/);
  const scrolled = await runBrowserAction(s, "browser_scroll", { direction: "bottom" });
  assert.ok(scrolled.text.length > 0);
  await runBrowserAction(s, "browser_tabs", { action: "close", index: 1 });
  const shot = await runBrowserAction(s, "browser_screenshot", {});
  assert.ok(shot.image && shot.image.base64.length > 1000);
  await runBrowserAction(s, "browser_close", {});
});

test("diffSnapshot reports only changed lines on the same url", () => {
  const big = Array.from({ length: 300 }, (_, i) => `- button "b${i}" [ref=e${i}]`).join("\n");
  const prev = { url: "https://x", snap: `Page: x\nURL: https://x\n${big}` };
  const next = `Page: x\nURL: https://x\n${big.replace('- button "b5" [ref=e5]', '- button "b5-changed" [ref=e5]')}\n- text: New line`;
  const d = diffSnapshot(prev, "https://x", next);
  assert.match(d, /\+ - button "b5-changed"/);
  assert.match(d, /\+ - text: New line/);
  assert.match(d, /- - button "b5" \[ref=e5\]/);
  assert.ok(d.length < next.length / 4);
  assert.equal(diffSnapshot(prev, "https://y", next), next);
});
