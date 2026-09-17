import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { one, q } from "./db.js";
import { id } from "./ids.js";

/** Files the worker produces or receives (PDFs, downloads, attachments): bytes on disk under DATA_DIR, a row in the DB. */
export interface FileRow {
  id: string;
  org_id: string;
  task_id: string | null;
  name: string;
  mime: string;
  bytes: number;
  path: string;
  created_at: Date;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

export async function saveFile(orgId: string, taskId: string | null, name: string, mime: string, data: Buffer): Promise<FileRow> {
  const fid = id("file");
  const dir = path.join(config.dataDir(), "files", orgId);
  await fs.mkdir(dir, { recursive: true });
  const clean = safeName(name);
  const rel = path.join("files", orgId, `${fid}-${clean}`);
  await fs.writeFile(path.join(config.dataDir(), rel), data);
  return (await one<FileRow>("insert into files (id, org_id, task_id, name, mime, bytes, path) values ($1,$2,$3,$4,$5,$6,$7) returning *", [fid, orgId, taskId, clean, mime, data.length, rel]))!;
}

export const getFile = (orgId: string, fileId: string) => one<FileRow>("select * from files where org_id = $1 and id = $2", [orgId, fileId]);
export const listFiles = (orgId: string, limit = 100) => q<FileRow>("select * from files where org_id = $1 order by created_at desc limit $2", [orgId, limit]);

export async function readFileBytes(f: FileRow): Promise<Buffer> {
  return fs.readFile(path.join(config.dataDir(), f.path));
}

export async function deleteFile(orgId: string, fileId: string): Promise<void> {
  const f = await getFile(orgId, fileId);
  if (!f) return;
  await fs.rm(path.join(config.dataDir(), f.path), { force: true });
  await q("delete from files where id = $1", [fileId]);
}

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip" };
  return map[ext] ?? "application/octet-stream";
}

/** Text of a file the model can read: PDFs through pdf.js, text-like files as-is, everything else a description. */
export async function fileText(f: FileRow, maxChars = 60_000): Promise<string> {
  const data = await readFileBytes(f);
  if (f.mime === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
    const text = await pdfText(data);
    return text.length > maxChars ? text.slice(0, maxChars) + `\n... (${text.length - maxChars} more characters)` : text || "(the PDF has no text layer; it may be a scan)";
  }
  if (/^text\/|json|xml|csv|markdown/.test(f.mime) || /\.(txt|md|csv|json|html?|xml|log)$/i.test(f.name)) {
    const s = data.toString("utf8");
    return s.length > maxChars ? s.slice(0, maxChars) + `\n... (${s.length - maxChars} more characters)` : s;
  }
  return `(binary file ${f.name}, ${f.mime}, ${f.bytes} bytes; not readable as text)`;
}

export async function pdfText(data: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = (content.items as Array<{ str?: string; hasEOL?: boolean }>).map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " ")).join("");
    pages.push(`--- page ${i} ---\n${line.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim()}`);
  }
  await doc.destroy();
  return pages.join("\n\n").trim();
}
