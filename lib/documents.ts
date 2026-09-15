/**
 * Text out of the files people send: a bill as a PDF from the utility's app, a receipt, a statement.
 * PDFs are read with pdf.js (text layer only, no rendering); text-like files are decoded; anything
 * else is described by name so the model can ask for it another way. Scanned PDFs (images only)
 * come back empty and are reported as such.
 */
const MAX_CHARS = Number(process.env.DOCUMENT_MAX_CHARS ?? 30_000);

export interface Extracted {
  /** What the model reads. */
  text: string;
  /** How it was read, for the note that precedes the text. */
  how: "pdf" | "text" | "none";
  pages?: number;
}

export function isTextLike(mime: string, filename = ""): boolean {
  return mime.startsWith("text/") || /json|csv|xml|markdown/.test(mime) || /\.(txt|md|csv|json|xml|log)$/i.test(filename);
}

export async function extractText(content: Buffer, mime: string, filename = ""): Promise<Extracted> {
  if (mime === "application/pdf" || /\.pdf$/i.test(filename) || content.subarray(0, 5).toString() === "%PDF-") {
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdfjs.getDocument({ data: new Uint8Array(content), useSystemFonts: true }).promise;
      const parts: string[] = [];
      let total = 0;
      for (let p = 1; p <= doc.numPages && total < MAX_CHARS; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        let line = "";
        const lines: string[] = [];
        for (const item of tc.items) {
          if (!("str" in item)) continue;
          line += item.str;
          if (item.hasEOL) {
            lines.push(line.trimEnd());
            line = "";
          } else if (item.str && !item.str.endsWith(" ")) line += " ";
        }
        if (line.trim()) lines.push(line.trimEnd());
        const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (text) parts.push(doc.numPages > 1 ? `--- page ${p} ---\n${text}` : text);
        total += text.length;
      }
      await doc.destroy().catch(() => {});
      return { text: parts.join("\n\n").slice(0, MAX_CHARS), how: "pdf", pages: doc.numPages };
    } catch (err) {
      console.error(`[documents] pdf ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", how: "none" };
    }
  }
  if (isTextLike(mime, filename)) return { text: content.toString("utf8").slice(0, MAX_CHARS), how: "text" };
  return { text: "", how: "none" };
}

/** The message text for an attachment: a header line the page can recognise, then the content for the model. */
export async function describeFile(content: Buffer, mime: string, filename: string): Promise<{ text: string; readable: boolean }> {
  const ex = await extractText(content, mime, filename);
  if (ex.text.trim()) {
    const kind = ex.how === "pdf" ? `PDF, ${ex.pages} page${ex.pages === 1 ? "" : "s"}` : "text";
    return { text: `(Attached file: ${filename}; ${kind}, contents below)\n\n${ex.text}`, readable: true };
  }
  if (ex.how === "pdf") return { text: `(Attached file: ${filename}; a PDF with no text layer, probably a scan or a photo. Ask the user for a screenshot of the page you need, or the figures.)`, readable: false };
  return { text: `(Attached file: ${filename}; ${mime}, ${content.length} bytes. This format cannot be read here; ask the user to paste the text, send a PDF or a photo, or email it.)`, readable: false };
}
