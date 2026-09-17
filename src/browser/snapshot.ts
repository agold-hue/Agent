import type { Frame, Page } from "playwright";
import { config } from "../config.js";

/**
 * What the model sees of a page: the accessibility tree with a ref on every element it can act on
 * ("button "Sign in" [ref=e12]"). Refs stay stable while the element exists, so an action can return
 * only what changed since the last snapshot of the same page.
 */
type SnapshotForAI = (opts?: { timeout?: number }) => Promise<string>;

export async function rawSnapshot(page: Page): Promise<string> {
  const fn = (page as unknown as { _snapshotForAI?: SnapshotForAI })._snapshotForAI;
  if (fn) {
    try {
      return await fn.call(page, { timeout: 8000 });
    } catch (e) {
      // fall through to the DOM walk
      void e;
    }
  }
  return fallbackSnapshot(page);
}

/** Only lines with a ref, plus headings and short text: a page's controls at a glance. */
export function interactiveOnly(snap: string): string {
  return snap
    .split("\n")
    .filter((l) => /\[ref=/.test(l) || /^\s*- (heading|text:|link|button|textbox|combobox|checkbox|radio|option|tab|menuitem|dialog|alert|status|img "|region|navigation|main|form|table|row|cell)/.test(l))
    .join("\n");
}

export interface SnapshotOptions {
  maxChars?: number;
  interactive?: boolean;
}

export async function snapshot(page: Page, opts: SnapshotOptions = {}): Promise<string> {
  const max = opts.maxChars ?? config.browser.snapshotMaxChars();
  let snap = await rawSnapshot(page);
  if (opts.interactive) snap = interactiveOnly(snap);
  const header = `Page: ${safeTitle(await page.title().catch(() => ""))}\nURL: ${page.url()}\n`;
  if (snap.length > max) {
    const cut = snap.slice(0, max);
    const lastNl = cut.lastIndexOf("\n");
    snap = cut.slice(0, lastNl > 0 ? lastNl : max) + `\n... (${snap.length - max} more characters not shown: use browser_find to locate an element by text, browser_read for the page text, or scroll and snapshot again)`;
  }
  return header + snap;
}

function safeTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim().slice(0, 150);
}

/** Lines of the snapshot whose text matches (case-insensitive), with their refs. */
export async function findInSnapshot(page: Page, needle: string, limit = 40): Promise<string> {
  const snap = await rawSnapshot(page);
  const n = needle.toLowerCase();
  const hits = snap.split("\n").filter((l) => l.toLowerCase().includes(n));
  if (!hits.length) return `No element or text matching "${needle}" on the current page (${page.url()}). It may be further down (scroll), inside a closed menu, or worded differently.`;
  return `${hits.length} match(es) for "${needle}":\n${hits.slice(0, limit).map((l) => l.trim()).join("\n")}${hits.length > limit ? `\n... ${hits.length - limit} more` : ""}`;
}

/**
 * The snapshot that comes back with an action: the whole page if the URL changed or the page is small,
 * otherwise the lines that appeared or disappeared. Refs are part of each line, so an unchanged
 * control keeps the number the model already knows.
 */
export function diffSnapshot(prev: { url: string; snap: string } | undefined, url: string, snap: string): string {
  if (!prev || prev.url !== url || snap.length < 3500) return snap;
  const before = prev.snap.split("\n");
  const after = snap.split("\n");
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((l) => !beforeSet.has(l));
  const removed = before.filter((l) => !afterSet.has(l) && /\[ref=/.test(l));
  if (added.length + removed.length > after.length * 0.5) return snap;
  const header = after.slice(0, 2).join("\n");
  if (!added.length && !removed.length) return `${header}\n(page unchanged since the last snapshot; same refs)`;
  const lines = [header, `(same page; ${after.length - added.length} lines unchanged with the same refs. Changes:)`];
  if (added.length) lines.push(...added.map((l) => `+ ${l.trim()}`).slice(0, 200));
  if (removed.length) lines.push(...removed.map((l) => `- ${l.trim()}`).slice(0, 60));
  return lines.join("\n");
}

/** Visible text of the page and its frames, for reading. */
export async function pageText(page: Page, mode: "text" | "main" = "text"): Promise<string> {
  const parts: string[] = [];
  const grab = async (frame: Frame) => {
    const script = mode === "main" ? `(() => { const m = document.querySelector('main, article, [role="main"]') || document.body; return m ? m.innerText : ""; })()` : `document.body ? document.body.innerText : ""`;
    const t = (await frame.evaluate(script).catch(() => "")) as string;
    return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  for (const frame of page.frames()) {
    const t = await grab(frame);
    if (!t) continue;
    if (frame === page.mainFrame()) parts.unshift(t);
    else if (t.length > 20) parts.push(`--- inside frame (${hostOf(frame.url())}) ---\n${t}`);
  }
  return parts.join("\n\n");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "embedded";
  } catch {
    return "embedded";
  }
}

/** DOM walk used only when the accessibility snapshot is unavailable: numbers visible controls as [ref=dN]. */
const FALLBACK = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [contenteditable="true"], summary';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    n++;
    el.setAttribute("data-wm-ref", "d" + n);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? (el.type || "text") + " textbox" : tag);
    const label = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || (el.innerText || el.value || "").trim();
    out.push('- ' + role + ' "' + String(label).replace(/\\s+/g, " ").slice(0, 80) + '" [ref=d' + n + ']');
  }
  const heads = Array.from(document.querySelectorAll("h1, h2, h3")).filter(vis).slice(0, 15).map((h) => '- heading "' + h.innerText.trim().replace(/\\s+/g, " ").slice(0, 100) + '"');
  return heads.concat(out).join("\\n");
})()`;

async function fallbackSnapshot(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    const t = (await frame.evaluate(FALLBACK).catch(() => "")) as string;
    if (t) parts.push(frame === page.mainFrame() ? t : `- iframe (${hostOf(frame.url())}):\n${t}`);
  }
  return parts.join("\n");
}
