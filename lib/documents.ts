/**
 * Text out of the files people send: a bill as a PDF from the utility's app, a lease, a statement,
 * a receipt. PDFs are read page by page with pdf.js from the text layer, with lines rebuilt from the
 * glyph positions so columns stay columns (a statement's date | merchant | amount survives). A PDF
 * with no text layer (a scan, a photo saved as PDF) goes through OCR when the provider supports it;
 * otherwise it is reported as a scan. Text-like files are decoded; anything else is described by name.
 */
const MAX_CHARS = Number(process.env.DOCUMENT_MAX_CHARS ?? 400_000);
const OCR_MAX_PAGES = Number(process.env.PDF_OCR_MAX_PAGES ?? 30);

export interface Extracted {
  /** What the model reads (pages joined with page markers). */
  text: string;
  /** How it was read, for the note that precedes the text. */
  how: "pdf" | "pdf-ocr" | "text" | "none";
  pages?: number;
  /** Per-page text, for the document store. */
  pageTexts?: string[];
}

export function isTextLike(mime: string, filename = ""): boolean {
  return mime.startsWith("text/") || /json|csv|xml|markdown/.test(mime) || /\.(txt|md|csv|json|xml|log)$/i.test(filename);
}

export function isPdf(content: Buffer, mime: string, filename = ""): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(filename) || content.subarray(0, 5).toString() === "%PDF-";
}

interface Glyph {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Lines from positioned text items: items on the same baseline (within half a line height) form a
 * line, left to right; a horizontal gap wider than a few characters marks a column break and
 * becomes " | ", so tables read as rows of cells instead of a run of words.
 */
export function linesFromGlyphs(items: Glyph[]): string[] {
  const glyphs = items.filter((g) => g.str.trim() || g.str === " ");
  if (!glyphs.length) return [];
  const heights = glyphs.map((g) => g.height).filter((h) => h > 0).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 10;
  const rows: Glyph[][] = [];
  for (const g of [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - g.y) <= lineH * 0.5) row.push(g);
    else rows.push([g]);
  }
  const out: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let line = "";
    let prev: Glyph | undefined;
    for (const g of row) {
      if (prev) {
        const gap = g.x - (prev.x + prev.width);
        const charW = prev.width / Math.max(1, prev.str.length);
        if (gap > Math.max(lineH * 1.2, charW * 3)) line += " | ";
        else if (gap > charW * 0.3 && !line.endsWith(" ") && !g.str.startsWith(" ")) line += " ";
      }
      line += g.str;
      prev = g;
    }
    const clean = line.replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, " | ").trim();
    if (clean) out.push(clean);
  }
  return out;
}

/**
 * pdf.js expects the browser's DOMMatrix, ImageData and Path2D to exist even when nothing is
 * rendered: its module body runs `new DOMMatrix()` at load, so without them the import itself
 * throws ("DOMMatrix is not defined") and every PDF reads as unreadable. On a laptop pdf.js fills
 * them in from @napi-rs/canvas, which the serverless bundle does not carry (it is loaded by a
 * dynamic require the bundler cannot trace). Text extraction never draws, so plain stand-ins are
 * enough; they are installed only where the globals are missing.
 */
export function ensureDomGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      constructor(init?: number[] | string) {
        if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init.map(Number);
      }
      get is2D() {
        return true;
      }
      get isIdentity() {
        return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
      }
      multiply(o: { a: number; b: number; c: number; d: number; e: number; f: number }) {
        return new (g.DOMMatrix as new (i: number[]) => unknown)([this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b, this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d, this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f]);
      }
      translate(x = 0, y = 0) {
        return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
      }
      scale(x = 1, y = x) {
        return this.multiply({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
      }
      inverse() {
        const det = this.a * this.d - this.b * this.c || 1;
        return new (g.DOMMatrix as new (i: number[]) => unknown)([this.d / det, -this.b / det, -this.c / det, this.a / det, (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det]);
      }
      toString() {
        return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
      }
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
        if (typeof a === "number") {
          this.width = a;
          this.height = b;
          this.data = new Uint8ClampedArray(a * b * 4);
        } else {
          this.data = a;
          this.width = b;
          this.height = c ?? a.length / (4 * b);
        }
      }
    };
  }
  if (typeof g.Path2D === "undefined") {
    // Every drawing call is a no-op: the text layer never paths.
    const noop = () => {};
    g.Path2D = class Path2D {
      addPath = noop;
      closePath = noop;
      moveTo = noop;
      lineTo = noop;
      bezierCurveTo = noop;
      quadraticCurveTo = noop;
      arc = noop;
      arcTo = noop;
      ellipse = noop;
      rect = noop;
      roundRect = noop;
    };
  }
}

/** Every page's text from a PDF's text layer; empty strings for pages with none. */
export async function extractPdfPages(content: Buffer): Promise<{ pages: string[]; numPages: number }> {
  ensureDomGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(content), useSystemFonts: true }).promise;
  const pages: string[] = [];
  let total = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (total >= MAX_CHARS) {
        pages.push("");
        continue;
      }
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const glyphs: Glyph[] = [];
      for (const item of tc.items) {
        if (!("str" in item)) continue;
        const it = item as { str: string; transform: number[]; width: number; height: number };
        glyphs.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height || Math.abs(it.transform[3]) || 10 });
      }
      const text = linesFromGlyphs(glyphs).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      pages.push(text);
      total += text.length;
    }
    return { pages, numPages: doc.numPages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** Whether a PDF's text layer is too thin to be the document: a scan, or a form of images. */
export function looksScanned(pages: string[]): boolean {
  const chars = pages.reduce((s, p) => s + p.trim().length, 0);
  return pages.length > 0 && chars < 40 * pages.length;
}

/**
 * OCR through the model provider's PDF parser (OpenRouter's file-parser plugin): the PDF goes in as a
 * file part, the fast model transcribes it page by page. Used only for scans, capped in pages, and
 * off without a provider that supports it (PDF_OCR=off disables it).
 */
export async function ocrPdf(content: Buffer, filename: string, numPages: number): Promise<string[] | undefined> {
  if ((process.env.PDF_OCR ?? "on") === "off" || numPages > OCR_MAX_PAGES) return undefined;
  const { complete, providerIsOpenRouter } = await import("./llm.js");
  const { modelFor } = await import("./router.js");
  const model = process.env.PDF_OCR_MODEL || modelFor("chat");
  if (!providerIsOpenRouter(model)) return undefined;
  try {
    const c = await complete({
      model,
      temperature: 0,
      maxTokens: Math.min(16_000, 1200 * numPages + 500),
      plugins: [{ id: "file-parser", pdf: { engine: process.env.PDF_OCR_ENGINE ?? "mistral-ocr" } }],
      messages: [
        { role: "system", content: "Transcribe the attached document faithfully: every line of text, figures exactly as printed, tables as rows with ' | ' between cells. Start each page with a line '--- page N ---'. No commentary, no summary, nothing that is not on the page." },
        { role: "user", content: [{ type: "text", text: `Transcribe ${filename} (${numPages} page${numPages === 1 ? "" : "s"}).` }, { type: "file", file: { filename, file_data: `data:application/pdf;base64,${content.toString("base64")}` } }] },
      ],
    });
    const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
    if (!text) return undefined;
    const parts = text.split(/^--- page \d+ ---\s*$/m).map((s) => s.trim());
    const pages = parts.filter((p, i) => p || i > 0);
    return pages.length ? pages : [text];
  } catch (err) {
    console.error(`[documents] ocr ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function joinPages(pages: string[]): string {
  if (pages.length === 1) return pages[0];
  return pages.map((p, i) => (p ? `--- page ${i + 1} ---\n${p}` : "")).filter(Boolean).join("\n\n");
}

export async function extractText(content: Buffer, mime: string, filename = ""): Promise<Extracted> {
  if (isPdf(content, mime, filename)) {
    try {
      const { pages, numPages } = await extractPdfPages(content);
      if (looksScanned(pages)) {
        const ocr = await ocrPdf(content, filename, numPages);
        if (ocr) return { text: joinPages(ocr).slice(0, MAX_CHARS), how: "pdf-ocr", pages: numPages, pageTexts: ocr };
        return { text: "", how: "pdf", pages: numPages, pageTexts: pages };
      }
      return { text: joinPages(pages).slice(0, MAX_CHARS), how: "pdf", pages: numPages, pageTexts: pages };
    } catch (err) {
      console.error(`[documents] pdf ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", how: "none" };
    }
  }
  if (isTextLike(mime, filename)) {
    const text = content.toString("utf8").slice(0, MAX_CHARS);
    return { text, how: "text", pageTexts: [text] };
  }
  return { text: "", how: "none" };
}

/** The message text for an attachment when it is inlined whole: a header line the page can recognise, then the content. */
export async function describeFile(content: Buffer, mime: string, filename: string): Promise<{ text: string; readable: boolean }> {
  const ex = await extractText(content, mime, filename);
  if (ex.text.trim()) {
    const kind = ex.how === "pdf" || ex.how === "pdf-ocr" ? `PDF, ${ex.pages} page${ex.pages === 1 ? "" : "s"}${ex.how === "pdf-ocr" ? ", scanned, read by OCR" : ""}` : "text";
    return { text: `(Attached file: ${filename}; ${kind}, contents below)\n\n${ex.text}`, readable: true };
  }
  if (ex.how === "pdf") return { text: `(Attached file: ${filename}; a PDF with no text layer, probably a scan or a photo${(process.env.PDF_OCR ?? "on") === "off" ? "" : ", and OCR could not read it"}. Ask the user for a screenshot of the page you need, or the figures.)`, readable: false };
  return { text: `(Attached file: ${filename}; ${mime}, ${content.length} bytes. This format cannot be read here; ask the user to paste the text, send a PDF or a photo, or email it.)`, readable: false };
}
