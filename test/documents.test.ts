import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkPages, outlineOf, parsePageRange, searchPages } from "../lib/docstore.js";
import { ensureDomGlobals, extractPdfPages, joinPages, linesFromGlyphs, looksScanned } from "../lib/documents.js";
import fs from "node:fs";

test("linesFromGlyphs rebuilds lines and marks columns from glyph positions", () => {
  const g = (str: string, x: number, y: number, width = str.length * 5) => ({ str, x, y, width, height: 10 });
  const lines = linesFromGlyphs([
    g("Date", 20, 700), g("Merchant", 120, 700), g("Amount", 400, 700),
    g("09/04", 20, 686), g("Amazon", 120, 686), g(".com", 150, 686), g("$59.84", 400, 686),
    g("Total", 20, 660), g("due", 48, 660), g("$206.30", 400, 660),
  ]);
  assert.deepEqual(lines, ["Date | Merchant | Amount", "09/04 | Amazon.com | $59.84", "Total due | $206.30"]);
  assert.equal(looksScanned(["", "  ", ""]), true);
  assert.equal(looksScanned(["A real page of text with more than forty characters on it, easily."]), false);
  assert.equal(joinPages(["a", "", "c"]), "--- page 1 ---\na\n\n--- page 3 ---\nc");
});

test("outline, page ranges, search and chunking are deterministic and page-aware", () => {
  const pages = [
    "RESIDENTIAL LEASE AGREEMENT\n123 Main St, Apt 4B\nTerm: Sept 1, 2026 to Aug 31, 2027\nRent $2,450.00 per month",
    "SECURITY DEPOSIT\nTenant shall deposit $2,450.00 with Landlord.\nLate fee: $75.00 after the 5th of the month.",
    "SUBLETTING\nTenant shall not sublet without written consent.\nRent $2,450.00 is due on the 1st.",
  ];
  const outline = outlineOf(pages);
  assert.match(outline, /Page 1 starts: RESIDENTIAL LEASE AGREEMENT/);
  assert.match(outline, /p\.2 SECURITY DEPOSIT/);
  assert.match(outline, /\$2,450\.00 \(3x\)/);
  assert.match(outline, /Sept 1, 2026/);
  assert.deepEqual(parsePageRange("2-3", 3), [2, 3]);
  assert.deepEqual(parsePageRange("1,3", 3), [1, 3]);
  assert.deepEqual(parsePageRange("9", 3), []);
  const hits = searchPages(pages, "late fee");
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^p\.2: .*\$75\.00/);
  const chunks = chunkPages(pages, 120);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks[chunks.length - 1].to, 3);
  assert.match(chunks[0].text, /^--- page 1 ---/);
});

test("a PDF is read even where the runtime has no DOMMatrix, ImageData or Path2D (the serverless bundle)", async () => {
  // pdf.js runs `new DOMMatrix()` when its module loads. On Vercel the canvas package it would take
  // them from is not in the bundle, so without stand-ins every PDF failed with "DOMMatrix is not
  // defined" and the model was told the file could not be read.
  const g = globalThis as Record<string, unknown>;
  assert.equal(typeof g.DOMMatrix, "undefined");
  ensureDomGlobals();
  assert.equal(typeof g.DOMMatrix, "function");
  const M = g.DOMMatrix as new (i?: number[]) => { a: number; e: number; multiply: (o: unknown) => { e: number } };
  assert.equal(new M().a, 1);
  assert.equal(new M([2, 0, 0, 2, 5, 7]).multiply(new M([1, 0, 0, 1, 1, 1])).e, 7);
  const { pages, numPages } = await extractPdfPages(fs.readFileSync(new URL("./fixtures/bill.pdf", import.meta.url)));
  assert.equal(numPages, 1);
  assert.match(pages[0], /Amount due: \$142\.17/);
});
