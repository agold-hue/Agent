import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Making and filling PDFs, with no sandbox and no external service.
 *
 * Two jobs the agent could not do before:
 *  - write a document (a letter, a summary, an invoice, a claim) as a real PDF, laid out from simple
 *    markdown: headings, paragraphs, bullets, tables, a footer with page numbers;
 *  - fill a PDF the user was sent (a form from a school, a landlord, an insurer): read its fields,
 *    write the values, tick the boxes, and flatten it so nobody can change the answers afterwards.
 *
 * Everything runs in-process on Buffers, so it works on a serverless worker.
 */

export interface PdfOptions {
  title?: string;
  /** "letter" (default) or "a4". */
  size?: "letter" | "a4";
  /** Footer line under every page, before the page number. */
  footer?: string;
  author?: string;
}

const SIZES = { letter: [612, 792] as const, a4: [595.28, 841.89] as const };
const MARGIN = 56;

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  width: number;
  height: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  mono: PDFFont;
  pages: PDFPage[];
}

/** Wrap a string to a pixel width, breaking long words so a URL never runs off the page. */
function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= max) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= max) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > max) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/** Winansi-encodable text: pdf-lib's standard fonts reject anything else, and a smart quote is common. */
export function asciiSafe(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[•●]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, "");
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([ctx.width, ctx.height]);
  ctx.pages.push(ctx.page);
  ctx.y = ctx.height - MARGIN;
}

function room(ctx: Ctx, need: number): void {
  if (ctx.y - need < MARGIN + 24) newPage(ctx);
}

function line(ctx: Ctx, text: string, opts: { font?: PDFFont; size?: number; gap?: number; indent?: number; color?: [number, number, number] } = {}): void {
  const font = opts.font ?? ctx.regular;
  const size = opts.size ?? 11;
  const indent = opts.indent ?? 0;
  const max = ctx.width - MARGIN * 2 - indent;
  for (const l of wrap(asciiSafe(text), font, size, max)) {
    room(ctx, size * 1.5);
    ctx.page.drawText(l, { x: MARGIN + indent, y: ctx.y, size, font, color: opts.color ? rgb(...opts.color) : rgb(0.1, 0.1, 0.12) });
    ctx.y -= size * 1.45;
  }
  ctx.y -= opts.gap ?? 0;
}

/** A markdown table row: `| a | b |`. */
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function drawTable(ctx: Ctx, rows: string[][]): void {
  if (!rows.length) return;
  const cols = Math.max(...rows.map((r) => r.length));
  const usable = ctx.width - MARGIN * 2;
  const colWidth = usable / cols;
  const size = 9.5;
  rows.forEach((row, i) => {
    const font = i === 0 ? ctx.bold : ctx.regular;
    const lines = row.map((c) => wrap(asciiSafe(c), font, size, colWidth - 8));
    const tall = Math.max(...lines.map((l) => l.length));
    room(ctx, tall * size * 1.4 + 8);
    const top = ctx.y;
    if (i === 0) ctx.page.drawRectangle({ x: MARGIN, y: top - tall * size * 1.4 + 2, width: usable, height: tall * size * 1.4 + 4, color: rgb(0.95, 0.96, 0.98) });
    lines.forEach((cellLines, c) => {
      cellLines.forEach((l, n) => {
        ctx.page.drawText(l, { x: MARGIN + c * colWidth + 4, y: top - n * size * 1.4, size, font, color: rgb(0.1, 0.1, 0.12) });
      });
    });
    ctx.y = top - tall * size * 1.4 - 6;
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 3 }, end: { x: MARGIN + usable, y: ctx.y + 3 }, thickness: 0.4, color: rgb(0.82, 0.84, 0.88) });
  });
  ctx.y -= 6;
}

/**
 * Markdown (the shape a model writes naturally) laid out as a PDF: `#`/`##`/`###` headings, `-`/`*`
 * and numbered bullets, `|` tables, `---` rules, ``` blocks in a mono font, everything else a
 * paragraph. Blank lines are spacing. Unknown syntax degrades to plain text rather than failing.
 */
export async function makePdf(markdown: string, opts: PdfOptions = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const [width, height] = SIZES[opts.size ?? "letter"];
  const ctx: Ctx = {
    doc,
    page: doc.addPage([width, height]),
    y: height - MARGIN,
    width,
    height,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    pages: [],
  };
  ctx.pages.push(ctx.page);
  doc.setTitle(asciiSafe(opts.title ?? "Document"));
  if (opts.author) doc.setAuthor(asciiSafe(opts.author));
  doc.setCreationDate(new Date());

  if (opts.title) {
    line(ctx, opts.title, { font: ctx.bold, size: 20, gap: 6 });
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 8 }, end: { x: width - MARGIN, y: ctx.y + 8 }, thickness: 1, color: rgb(0.78, 0.8, 0.85) });
    ctx.y -= 10;
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let code = false;
  let table: string[][] = [];
  const flushTable = () => {
    if (table.length) drawTable(ctx, table);
    table = [];
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^```/.test(l.trim())) {
      flushTable();
      code = !code;
      continue;
    }
    if (code) {
      line(ctx, l || " ", { font: ctx.mono, size: 9 });
      continue;
    }
    if (isTableRow(l)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; // the --- separator row
      table.push(cells(l));
      continue;
    }
    flushTable();
    if (!l.trim()) {
      ctx.y -= 6;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())) {
      room(ctx, 14);
      ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 4 }, end: { x: width - MARGIN, y: ctx.y + 4 }, thickness: 0.6, color: rgb(0.8, 0.82, 0.86) });
      ctx.y -= 12;
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      ctx.y -= level === 1 ? 10 : 8;
      line(ctx, strip(h[2]), { font: ctx.bold, size: level === 1 ? 17 : level === 2 ? 13.5 : 11.5, gap: 4 });
      continue;
    }
    const bullet = l.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      line(ctx, `• ${strip(bullet[1])}`, { indent: 12 });
      continue;
    }
    const numbered = l.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      line(ctx, `${numbered[1]}. ${strip(numbered[2])}`, { indent: 12 });
      continue;
    }
    if (/^>\s?/.test(l)) {
      line(ctx, strip(l.replace(/^>\s?/, "")), { font: ctx.italic, indent: 14, color: [0.35, 0.36, 0.4] });
      continue;
    }
    line(ctx, strip(l));
  }
  flushTable();

  const foot = opts.footer ? asciiSafe(opts.footer) : "";
  ctx.pages.forEach((p, i) => {
    const label = `${foot ? `${foot}  ·  ` : ""}Page ${i + 1} of ${ctx.pages.length}`;
    p.drawText(label, { x: MARGIN, y: MARGIN - 24, size: 8, font: ctx.regular, color: rgb(0.5, 0.52, 0.56) });
  });
  return Buffer.from(await doc.save());
}

/** `**bold**`, `*em*`, `` `code` `` and links reduced to their text: the layout is plain-font. */
function strip(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export interface PdfField {
  name: string;
  type: "text" | "checkbox" | "radio" | "dropdown" | "option" | "button" | "other";
  value?: string;
  options?: string[];
}

/** Every fillable field of a PDF, so the agent can ask the right questions before it fills anything. */
export async function pdfFormFields(pdf: Buffer): Promise<PdfField[]> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const form = doc.getForm();
  return form.getFields().map((f) => {
    const name = f.getName();
    const kind = f.constructor.name;
    if (kind === "PDFTextField") {
      const tf = form.getTextField(name);
      return { name, type: "text" as const, value: tf.getText() ?? "" };
    }
    if (kind === "PDFCheckBox") return { name, type: "checkbox" as const, value: form.getCheckBox(name).isChecked() ? "on" : "off" };
    if (kind === "PDFRadioGroup") {
      const g = form.getRadioGroup(name);
      return { name, type: "radio" as const, value: g.getSelected() ?? "", options: g.getOptions() };
    }
    if (kind === "PDFDropdown") {
      const d = form.getDropdown(name);
      return { name, type: "dropdown" as const, value: d.getSelected()[0] ?? "", options: d.getOptions() };
    }
    if (kind === "PDFOptionList") {
      const o = form.getOptionList(name);
      return { name, type: "option" as const, value: o.getSelected()[0] ?? "", options: o.getOptions() };
    }
    if (kind === "PDFButton") return { name, type: "button" as const };
    return { name, type: "other" as const };
  });
}

export interface FillReport {
  filled: string[];
  skipped: Array<{ field: string; why: string }>;
  pdf: Buffer;
}

/**
 * Fill a form. Field names are matched exactly first, then case- and punctuation-insensitively, so a
 * value keyed "first name" still lands in "Topmostsubform[0].Page1[0].f1_01[0] First Name". Checkboxes
 * take yes/true/on/x; radios and dropdowns take the option label (or its closest match).
 * `flatten` bakes the answers in so the recipient cannot edit them.
 */
export async function fillPdfForm(pdf: Buffer, values: Record<string, string | boolean>, flatten = true): Promise<FillReport> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields();
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byKey = new Map<string, string>();
  for (const f of fields) byKey.set(key(f.getName()), f.getName());
  const filled: string[] = [];
  const skipped: Array<{ field: string; why: string }> = [];

  for (const [wanted, rawValue] of Object.entries(values)) {
    let name = fields.find((f) => f.getName() === wanted)?.getName() ?? byKey.get(key(wanted));
    if (!name) {
      const k = key(wanted);
      name = [...byKey.entries()].find(([fk]) => fk.includes(k) || k.includes(fk))?.[1];
    }
    if (!name) {
      skipped.push({ field: wanted, why: "no field with that name" });
      continue;
    }
    const value = typeof rawValue === "boolean" ? (rawValue ? "yes" : "no") : String(rawValue);
    try {
      const f = fields.find((x) => x.getName() === name)!;
      switch (f.constructor.name) {
        case "PDFTextField":
          form.getTextField(name).setText(asciiSafe(value));
          break;
        case "PDFCheckBox": {
          const on = /^(1|y|yes|true|on|x|checked)$/i.test(value.trim());
          const box = form.getCheckBox(name);
          if (on) box.check();
          else box.uncheck();
          break;
        }
        case "PDFRadioGroup": {
          const g = form.getRadioGroup(name);
          const opt = closest(value, g.getOptions());
          if (!opt) {
            skipped.push({ field: name, why: `options are ${g.getOptions().join(", ")}` });
            continue;
          }
          g.select(opt);
          break;
        }
        case "PDFDropdown": {
          const d = form.getDropdown(name);
          const opt = closest(value, d.getOptions());
          if (!opt) {
            skipped.push({ field: name, why: `options are ${d.getOptions().join(", ")}` });
            continue;
          }
          d.select(opt);
          break;
        }
        case "PDFOptionList": {
          const o = form.getOptionList(name);
          const opt = closest(value, o.getOptions());
          if (!opt) {
            skipped.push({ field: name, why: `options are ${o.getOptions().join(", ")}` });
            continue;
          }
          o.select(opt);
          break;
        }
        default:
          skipped.push({ field: name, why: "not a fillable field" });
          continue;
      }
      filled.push(name);
    } catch (err) {
      skipped.push({ field: name, why: err instanceof Error ? err.message : String(err) });
    }
  }
  if (flatten) {
    try {
      form.flatten();
    } catch {
      /* some generators produce forms pdf-lib cannot flatten; the values are still set */
    }
  }
  return { filled, skipped, pdf: Buffer.from(await doc.save()) };
}

function closest(value: string, options: string[]): string | undefined {
  const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return options.find((o) => o === value) ?? options.find((o) => k(o) === k(value)) ?? options.find((o) => k(o).includes(k(value)) || k(value).includes(k(o)));
}

/** Several PDFs into one (a filled form plus its attachments, a month of statements). */
export async function mergePdfs(parts: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

/** How many pages, and whether it has a fillable form: the cheap look before any real work. */
export async function pdfInfo(pdf: Buffer): Promise<{ pages: number; fields: number; title?: string }> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  let fields = 0;
  try {
    fields = doc.getForm().getFields().length;
  } catch {
    fields = 0;
  }
  return { pages: doc.getPageCount(), fields, title: doc.getTitle() ?? undefined };
}
