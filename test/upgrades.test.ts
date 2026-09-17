import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiSafe, fillPdfForm, makePdf, mergePdfs, pdfFormFields, pdfInfo } from "../lib/pdf.js";
import { domainsIn, guessOutcome } from "../lib/learning.js";
import { normalizeUrl } from "../lib/browser-tools.js";
import { handoverLine } from "../lib/captcha.js";

test("a document written as markdown comes out as a real, multi-page PDF", async () => {
  const body = ["# Claim", "", "Dear Sir or Madam,", "", "- policy 1234", "- loss on 2026-04-02", "", "| Item | Value |", "| --- | --- |", "| Bike | $900 |", "", "x".repeat(40_000)].join("\n");
  const pdf = await makePdf(body, { title: "Insurance claim", footer: "Prepared by Pete" });
  assert.ok(pdf.length > 1000);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  const info = await pdfInfo(pdf);
  assert.ok(info.pages > 1, "a long body paginates");
  assert.equal(info.title, "Insurance claim");
});

test("a smart quote or an em dash does not break the standard fonts", async () => {
  assert.equal(asciiSafe("He said “no” — twice…"), 'He said "no" - twice...');
  const pdf = await makePdf("A line with “curly quotes”, an em—dash and an emoji \u{1F600}.", { title: "Smoke" });
  assert.ok(pdf.length > 500);
});

test("a PDF form is read, filled by near-matching name, and flattened", async () => {
  // Build a form with pdf-lib itself so the test needs no fixture on disk.
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  const name = form.createTextField("First Name");
  name.addToPage(page, { x: 20, y: 240, width: 200, height: 20 });
  const consent = form.createCheckBox("I consent");
  consent.addToPage(page, { x: 20, y: 200, width: 14, height: 14 });
  const colour = form.createDropdown("Colour");
  colour.setOptions(["Red", "Blue"]);
  colour.addToPage(page, { x: 20, y: 160, width: 100, height: 20 });
  const blank = Buffer.from(await doc.save());

  const fields = await pdfFormFields(blank);
  assert.deepEqual(
    fields.map((f) => f.type).sort(),
    ["checkbox", "dropdown", "text"],
  );

  const out = await fillPdfForm(blank, { "first name": "Sam", "i consent": "yes", Colour: "blue", Nonsense: "x" }, true);
  assert.deepEqual(out.filled.sort(), ["Colour", "First Name", "I consent"]);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].field, "Nonsense");
  // Flattened: the fields are gone, the answers are drawn on the page.
  assert.equal((await pdfInfo(out.pdf)).fields, 0);
});

test("two PDFs merge into one with every page kept", async () => {
  const a = await makePdf("# One", { title: "a" });
  const b = await makePdf("# Two", { title: "b" });
  const merged = await mergePdfs([a, b]);
  assert.equal((await pdfInfo(merged)).pages, (await pdfInfo(a)).pages + (await pdfInfo(b)).pages);
});

test("a bare host is a URL; a path or a full URL is left alone", () => {
  assert.equal(normalizeUrl("coned.com"), "https://coned.com");
  assert.equal(normalizeUrl("www.amazon.com/orders"), "https://www.amazon.com/orders");
  assert.equal(normalizeUrl("https://uber.com"), "https://uber.com");
  assert.equal(normalizeUrl("http://x.test/a"), "http://x.test/a");
  assert.equal(normalizeUrl("just some words"), "just some words");
});

test("the sites a request touches are picked out for scoping what was learned", () => {
  assert.deepEqual(domainsIn("pay the bill at https://www.coned.com/en/accounts").sort(), ["coned.com"]);
  assert.deepEqual(domainsIn("compare amazon.com and walmart.com").sort(), ["amazon.com", "walmart.com"]);
  assert.deepEqual(domainsIn("book a table for four"), []);
});

test("the outcome of a task is read from the report when the model's own JSON is unusable", () => {
  assert.equal(guessOutcome("Paid it. Confirmation 88213."), "success");
  assert.equal(guessOutcome("I couldn't get the balance."), "failed");
  assert.equal(guessOutcome("The site's bot check won't let me sign in."), "blocked");
  assert.equal(guessOutcome("mm"), "unknown");
});

test("the hand-over line tells the user what to do, without jargon", () => {
  assert.match(handoverLine({ kind: "press_hold" }), /press-and-hold/i);
  assert.match(handoverLine({ kind: "recaptcha_v2" }), /Watch the browser/i);
});

test("a site note keeps every section the host and the model wrote", async () => {
  // browser_run_path replays from "Recorded paths" and opens pages from "Pages seen": a reflection
  // pass that dropped either would cost real capability, so unknown headings are passed through.
  const { mergeSections } = await import("../lib/learning.js");
  const before = "# coned.com\n\n## Sign-in\nhttps://www.coned.com/en/login, texts a code\n\n## Recorded paths\n- bill: goto /login -> click Pay bill\n\n## Pages seen\n- My account https://coned.com/accounts\n\n## Fast path\nbalance: /accounts-billing\n";
  const after = mergeSections(before, { fastPath: "statements: /accounts-billing/statements", quirks: "the dashboard total lags a day", ok: true, today: "2026-09-17" });
  for (const heading of ["Sign-in", "Recorded paths", "Pages seen", "Fast path", "Quirks", "Last verified"]) assert.ok(after.includes(`## ${heading}`), `lost ${heading}`);
  assert.ok(after.includes("- bill: goto /login -> click Pay bill"));
  // The newest fast path goes first, the old one is kept under it, and nothing is duplicated.
  assert.match(after, /## Fast path\nstatements: \/accounts-billing\/statements\nbalance: \/accounts-billing/);
  assert.equal(after.match(/## Fast path/g)!.length, 1);
  assert.ok(after.includes("## Last verified\n2026-09-17 (worked)"));
  // Running it twice changes nothing more.
  assert.equal(mergeSections(after, { fastPath: "statements: /accounts-billing/statements", ok: true, today: "2026-09-17" }), after);
});

test("press-and-hold is recognised even when the frame also carries a reCAPTCHA key", async () => {
  // PerimeterX renders its button in a frame with a reCAPTCHA-shaped key. Classing that as a
  // reCAPTCHA sent it to the paid solver, which has nothing to solve and bills for the attempt.
  const { classify } = await import("../lib/captcha.js");
  assert.equal(classify("Press & Hold to confirm you are human", new Set(["recaptcha_v2"])), "press_hold");
  assert.equal(classify("Press and Hold", new Set()), "press_hold");
  assert.equal(classify("I'm not a robot", new Set(["recaptcha_v2"])), "recaptcha_v2");
  assert.equal(classify("Just a moment...", new Set()), "cloudflare");
  assert.equal(classify("Your order shipped", new Set()), "none");
});

test("the hold lasts a human few seconds and always fits inside the budget", async () => {
  const { holdPlan } = await import("../lib/captcha.js");
  for (const r of [0, 0.5, 0.999]) {
    const { holdMs, steps } = holdPlan(60_000, () => r);
    assert.ok(holdMs >= 7000 && holdMs <= 11_000, `${holdMs} is not a human hold`);
    assert.ok(steps >= 6, "the pointer must keep moving while held");
  }
  // A budget nearly spent shortens the hold rather than overrunning it.
  assert.ok(holdPlan(9000, () => 0.999).holdMs <= 5000);
  // And never goes below something a hand could do.
  assert.equal(holdPlan(1000, () => 0).holdMs, 2500);
});

test("asking for a document routes to a model that can write one", async () => {
  const { tierFor } = await import("../lib/router.js");
  // The real failure: this ran on the chat tier and never reached for make_pdf.
  assert.equal(tierFor("Give me now the operating agreement pdf we spoke about", "chat"), "hard");
  assert.equal(tierFor("write me a letter to my landlord about the radiator", "chat"), "task");
  assert.equal(tierFor("draft a memo summarising the month's bills", "chat"), "task");
  assert.equal(tierFor("fill out the school form they sent", "chat"), "task");
  assert.equal(tierFor("put together the LLC bylaws", "chat"), "hard");
  // Small talk and notes are untouched.
  assert.equal(tierFor("hey how's it going", "chat"), "chat");
  assert.equal(tierFor("add milk to the list", "chat"), "chat");
  assert.equal(tierFor("remind me the lease is up in March", "chat"), "chat");
});

test("a progress line that says nothing, or says it twice, is refused", async () => {
  const { emptyProgress, sameProgress } = await import("../lib/tools.js");
  for (const noise of ["Still working...", "still working…", "Working on it", "one moment", "On it", "almost there"]) {
    assert.notEqual(emptyProgress(noise), "", `"${noise}" should be refused`);
  }
  assert.equal(emptyProgress("Signed in, pulling the bill up now"), "");
  assert.equal(emptyProgress("Drafting the North 15 PA LLC operating agreement now"), "");
  assert.ok(sameProgress("Still working...", "still working…"));
  assert.ok(!sameProgress("Signed in", "Bill is $142"));
});
