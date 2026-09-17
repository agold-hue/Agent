import { one, q } from "./db.js";
import { extractText, type Extracted } from "./documents.js";
import { complete, type Completion } from "./llm.js";
import { modelFor } from "./router.js";
import type { SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * The document store. A short PDF is inlined into the message as before: one hop, nothing to look
 * up. A long one (a lease, a statement, a policy) is stored page by page and the message carries an
 * outline instead, so a 60-page document costs a few hundred tokens per turn instead of a hundred
 * thousand. The `document` tool then reads pages, searches words (SQL, no model), or runs a review:
 * the pages are condensed in parallel by the fast model around the user's question, and the task
 * model writes the answer from the notes. Fast because the reads are parallel and the search is a
 * query; cheap because the strong model never sees the whole document; clear because every fact
 * comes with its page.
 */
export const INLINE_CHARS = Number(process.env.DOCUMENT_INLINE_CHARS ?? 12_000);
const READ_MAX_PAGES = Number(process.env.DOCUMENT_READ_MAX_PAGES ?? 6);
const READ_MAX_CHARS = Number(process.env.DOCUMENT_READ_MAX_CHARS ?? 24_000);
const REVIEW_CHUNK_CHARS = Number(process.env.DOCUMENT_REVIEW_CHUNK_CHARS ?? 14_000);
const REVIEW_MAX_CHUNKS = Number(process.env.DOCUMENT_REVIEW_MAX_CHUNKS ?? 16);

export interface StoredDocument {
  id: string;
  name: string;
  mime: string;
  pages: number;
  chars: number;
  source: string;
  outline: string;
  created_at: Date;
}

export async function storeDocument(t: Tenant, d: { name: string; mime: string; pages: string[]; source: string }): Promise<StoredDocument> {
  const chars = d.pages.reduce((s, p) => s + p.length, 0);
  const outline = outlineOf(d.pages);
  const row = await one<StoredDocument>("insert into documents (user_id, name, mime, pages, chars, source, outline) values ($1,$2,$3,$4,$5,$6,$7) returning id, name, mime, pages, chars, source, outline, created_at", [t.id, d.name.slice(0, 200), d.mime, d.pages.length, chars, d.source, outline]);
  for (let i = 0; i < d.pages.length; i += 200) {
    // pg's parameter limit: pages in batches
    const slice = d.pages.slice(i, i + 200);
    const ps: unknown[] = [row!.id];
    const vs = slice.map((p, j) => {
      ps.push(i + j + 1, p);
      return `($1, $${ps.length - 1}, $${ps.length})`;
    });
    await q(`insert into document_pages (doc_id, page, text) values ${vs.join(",")}`, ps);
  }
  return row!;
}

export async function listDocuments(t: Tenant, limit = 20): Promise<StoredDocument[]> {
  return q<StoredDocument>("select id, name, mime, pages, chars, source, outline, created_at from documents where user_id = $1 order by created_at desc limit $2", [t.id, limit]);
}

export async function getDocument(t: Tenant, idOrName: string): Promise<StoredDocument | undefined> {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrName) ? await one<StoredDocument>("select id, name, mime, pages, chars, source, outline, created_at from documents where user_id = $1 and id = $2", [t.id, idOrName]) : undefined;
  if (byId) return byId;
  return one<StoredDocument>("select id, name, mime, pages, chars, source, outline, created_at from documents where user_id = $1 and name ilike $2 order by created_at desc limit 1", [t.id, `%${idOrName.replace(/[%_]/g, "")}%`]);
}

export async function readPages(docId: string, from: number, to: number): Promise<Array<{ page: number; text: string }>> {
  return q<{ page: number; text: string }>("select page, text from document_pages where doc_id = $1 and page between $2 and $3 order by page", [docId, from, to]);
}

export async function allPages(docId: string): Promise<string[]> {
  const rows = await q<{ page: number; text: string }>("select page, text from document_pages where doc_id = $1 order by page", [docId]);
  return rows.map((r) => r.text);
}

// ------------------------------------------------------------------ pure helpers

const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const DATE = /\b(?:\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})\b/g;

/**
 * A deterministic outline: the first lines of page one (the title block), a heading-like line per
 * page, and the amounts and dates that recur. Enough for the model to decide what to read, at no cost.
 */
export function outlineOf(pages: string[]): string {
  const out: string[] = [];
  const first = (pages[0] ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8);
  if (first.length) out.push(`Page 1 starts: ${first.join(" / ").slice(0, 400)}`);
  const headings: string[] = [];
  pages.forEach((p, i) => {
    if (i === 0 || headings.length >= 40) return;
    const h = p.split("\n").map((l) => l.trim()).find((l) => l.length >= 4 && l.length <= 70 && !/\d{3,}/.test(l) && (l === l.toUpperCase() || /^(\d+\.|[A-Z][a-z]+( [A-Z][a-z]+){0,5}:?$|Section|Article|Schedule|Exhibit)/.test(l)));
    if (h) headings.push(`p.${i + 1} ${h}`);
  });
  if (headings.length) out.push(`Headings: ${headings.join("; ").slice(0, 900)}`);
  const all = pages.join("\n");
  const money = tally(all.match(MONEY) ?? []).slice(0, 8);
  if (money.length) out.push(`Amounts seen most: ${money.join(", ")}`);
  const dates = tally(all.match(DATE) ?? []).slice(0, 8);
  if (dates.length) out.push(`Dates seen most: ${dates.join(", ")}`);
  return out.join("\n");
}

function tally(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.replace(/\s/g, ""), (counts.get(it.replace(/\s/g, "")) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k} (${n}x)` : k));
}

/** "3-5", "7", "1,4,9" -> page numbers within bounds. */
export function parsePageRange(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, Number(m[1]));
    const b = Math.min(total, Number(m[2] ?? m[1]));
    for (let p = a; p <= b && out.size < READ_MAX_PAGES; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

/** Lines matching every word of the query, with page numbers and one line of context. */
export function searchPages(pages: string[], query: string, max = 40): string[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const hits: string[] = [];
  pages.forEach((p, i) => {
    const lines = p.split("\n");
    lines.forEach((l, j) => {
      const low = l.toLowerCase();
      if (!words.every((w) => low.includes(w))) return;
      const ctx = [lines[j - 1], l, lines[j + 1]].filter((x) => x && x.trim()).join(" ⏎ ");
      hits.push(`p.${i + 1}: ${ctx.replace(/\s+/g, " ").slice(0, 280)}`);
    });
  });
  return hits.slice(0, max);
}

/** Pages grouped into chunks under the review chunk size, each remembering its page span. */
export function chunkPages(pages: string[], maxChars = REVIEW_CHUNK_CHARS): Array<{ from: number; to: number; text: string }> {
  const chunks: Array<{ from: number; to: number; text: string }> = [];
  let cur: { from: number; to: number; parts: string[]; size: number } | undefined;
  pages.forEach((p, i) => {
    const piece = `--- page ${i + 1} ---\n${p}`;
    if (!cur || cur.size + piece.length > maxChars) {
      if (cur) chunks.push({ from: cur.from, to: cur.to, text: cur.parts.join("\n\n") });
      cur = { from: i + 1, to: i + 1, parts: [piece], size: piece.length };
    } else {
      cur.parts.push(piece);
      cur.to = i + 1;
      cur.size += piece.length;
    }
  });
  if (cur) chunks.push({ from: cur.from, to: cur.to, text: cur.parts.join("\n\n") });
  return chunks;
}

// ------------------------------------------------------------------ ingest: what goes into the message

/**
 * An attached or emailed file becomes either its full text (short) or a stored document plus its
 * outline (long). Both forms start with a header the chat page recognises.
 */
export async function ingestFile(t: Tenant, content: Buffer, mime: string, filename: string, source: "chat" | "mail"): Promise<{ text: string; readable: boolean; doc?: StoredDocument }> {
  const ex: Extracted = await extractText(content, mime, filename);
  // A voice note is a message, not a document: it never goes to the document store, it reads as talk.
  if (ex.how === "audio") {
    if (ex.text.trim()) return { text: `(Voice note: ${filename}; transcript below. This is someone speaking, so read it as talk: filler, no punctuation, names and numbers sometimes misheard.)\n\n${ex.text}`, readable: true };
    return { text: `(Voice note: ${filename}; it could not be transcribed: ${ex.why ?? "unknown error"}. Say so in one line and ask for it in writing.)`, readable: false };
  }
  const pages = ex.pageTexts ?? (ex.text ? [ex.text] : []);
  const chars = pages.reduce((s, p) => s + p.length, 0);
  const kind = ex.how === "pdf" || ex.how === "pdf-ocr" ? `PDF, ${ex.pages ?? pages.length} page${(ex.pages ?? pages.length) === 1 ? "" : "s"}${ex.how === "pdf-ocr" ? ", scanned, read by OCR" : ""}` : ex.how === "text" ? "text" : mime;
  if (!ex.text.trim()) {
    if (ex.how === "pdf") return { text: `(Attached file: ${filename}; a PDF with no text layer, probably a scan or a photo, and it could not be read. Ask the user for a screenshot of the page you need, or the figures.)`, readable: false };
    return { text: `(Attached file: ${filename}; ${mime}, ${content.length} bytes. This format cannot be read here; ask the user to paste the text, send a PDF or a photo, or email it.)`, readable: false };
  }
  if (chars <= INLINE_CHARS) return { text: `(Attached file: ${filename}; ${kind}, contents below)\n\n${ex.text}`, readable: true };
  const doc = await storeDocument(t, { name: filename, mime, pages, source });
  const head = (pages[0] ?? "").slice(0, 1500);
  return {
    readable: true,
    doc,
    text: [
      `(Attached file: ${filename}; ${kind}, ${chars.toLocaleString()} characters, stored as document ${doc.id}. Too long to inline: use the document tool. document(action "review", id, question) for what matters in it; document(action "search", id, query) for a word or an amount; document(action "read", id, pages "3-5") for exact pages. Never say you cannot open it.)`,
      ``,
      `Outline:`,
      doc.outline,
      ``,
      `Page 1 begins:`,
      head,
    ].join("\n"),
  };
}

// ------------------------------------------------------------------ the document tool

const DEFAULT_BRIEF = "what this document is; the three to five things that matter most to the person it concerns; every amount, fee, penalty, deposit, escalation and how it is calculated; every date and deadline; the obligations placed on them and what happens if they miss one; anything unusual, one-sided or missing; what to ask before signing or paying";

export async function runDocumentTool(t: Tenant, row: SessionRow, args: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(args[k] ?? "").trim();
  const action = s("action") || "list";
  if (action === "list") {
    const docs = await listDocuments(t);
    return docs.length ? docs.map((d) => `- ${d.id} ${d.name} (${d.pages} page${d.pages === 1 ? "" : "s"}, ${d.chars.toLocaleString()} chars, ${new Date(d.created_at).toISOString().slice(0, 10)}, via ${d.source})`).join("\n") : "No stored documents. Short files are inlined in the message they arrived with.";
  }
  const doc = s("id") ? await getDocument(t, s("id")) : (await listDocuments(t, 1))[0];
  if (!doc) return `No document matching "${s("id")}". document(action "list") shows what is stored.`;
  if (action === "outline") return `${doc.name} (${doc.pages} pages, ${doc.chars.toLocaleString()} chars)\n${doc.outline}`;
  if (action === "read") {
    const pages = parsePageRange(s("pages") || "1", doc.pages);
    if (!pages.length) return `Pass pages like "3-5" (the document has ${doc.pages}).`;
    const rows = await readPages(doc.id, pages[0], pages[pages.length - 1]);
    let text = rows.filter((r) => pages.includes(r.page)).map((r) => `--- page ${r.page} ---\n${r.text}`).join("\n\n");
    if (text.length > READ_MAX_CHARS) text = `${text.slice(0, READ_MAX_CHARS)}\n... (cut; read fewer pages at a time)`;
    return `${doc.name}, pages ${pages[0]}${pages.length > 1 ? `-${pages[pages.length - 1]}` : ""} of ${doc.pages}:\n\n${text}`;
  }
  if (action === "search") {
    if (!s("query")) return "Pass query: the words, name or amount to find.";
    const hits = searchPages(await allPages(doc.id), s("query"));
    return hits.length ? `${hits.length} hit${hits.length === 1 ? "" : "s"} for "${s("query")}" in ${doc.name}:\n${hits.join("\n")}` : `Nothing matching "${s("query")}" in ${doc.name}. Try one word, or a different spelling.`;
  }
  if (action === "review") {
    const question = s("question") || DEFAULT_BRIEF;
    const { chargeCompletion } = await import("./sessions.js");
    const notes = await reviewDocument(doc, await allPages(doc.id), question, modelFor("chat", t), (c) => chargeCompletion(t, row, c, "review"));
    return `Review notes for ${doc.name} (${doc.pages} pages), extracted page by page for: ${question}\n\n${notes}\n\nWrite the review for the user from these notes in prose: what it is, then the things that matter with their page numbers in words ("page 12"), money and dates exact, the risks, and what to ask. No links.`;
  }
  return "Pass action: list, outline, read, search or review.";
}

/**
 * Map, then let the caller reduce: each chunk of pages goes to the fast model in parallel with the
 * question, returning "- p.N: fact" lines; the notes are merged in page order. The strong model only
 * ever sees the notes, not the document.
 */
export async function reviewDocument(doc: StoredDocument, pages: string[], question: string, model: string, charge: (c: Completion) => Promise<unknown>): Promise<string> {
  const chunks = chunkPages(pages).slice(0, REVIEW_MAX_CHUNKS);
  const results = await Promise.all(
    chunks.map(async (ch) => {
      try {
        const c = await complete({
          model,
          temperature: 0,
          maxTokens: 900,
          messages: [
            { role: "system", content: "You read part of a document for a personal assistant. Extract every fact that bears on the brief, one per line as '- p.N: fact', with the page number the fact is on, figures and dates exactly as written, and quote the key phrase for anything unusual or one-sided. Nothing else: no summary, no advice. If this part has nothing on the brief, reply exactly: NOTHING" },
            { role: "user", content: `Brief: ${question}\n\nDocument: ${doc.name}, pages ${ch.from}-${ch.to} of ${doc.pages}\n\n${ch.text}` },
          ],
        });
        await charge(c);
        const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
        return text && !/^NOTHING\b/.test(text) ? text : "";
      } catch (err) {
        return `- p.${ch.from}-${ch.to}: (could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
      }
    }),
  );
  const notes = results.filter(Boolean).join("\n");
  const tail = chunks.length < chunkPages(pages).length ? `\n(only the first ${chunks[chunks.length - 1].to} pages were reviewed; document(action "read") for the rest)` : "";
  return (notes || "(nothing in the document bears on the brief)") + tail;
}
