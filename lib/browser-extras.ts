import type { Locator, Page } from "playwright-core";
import { after, ref, settle, snapshot, waitInteractive, withPage, rememberSnapshot } from "./browser-tools.js";
import type { BrowserHandle } from "./browser.js";
import { findCredential, recordLoginOutcome, registrableDomain } from "./credentials.js";
import type { ChatMessage } from "./llm.js";
import { readMemory, writeMemory } from "./memory.js";
import { taskStart, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * The browser tools that remove model turns: click and type by visible text instead of a number
 * from a long snapshot, fill a whole form in one call, pull a table out as rows, sign in
 * automatically when a login wall appears and a login is in the vault, and replay a path the host
 * recorded from a task that worked (so a repeat visit is one call, not thirty).
 */

// ------------------------------------------------------------------ find by text

interface Match {
  ref: number;
  role: string;
  label: string;
  exact: boolean;
}

/** Runs in a frame after a snapshot stamped data-agent-ref: the stamped elements whose label contains `q`. */
const FIND_FN = `(q, limit) => {
  const needle = String(q).toLowerCase().replace(/\\s+/g, " ").trim();
  const out = [];
  for (const el of Array.from(document.querySelectorAll("[data-agent-ref]"))) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const e = el;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input:" + (e.type || "text") : tag);
    const label = String(el.getAttribute("aria-label") || (e.labels && e.labels[0] && e.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.innerText || e.value || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim();
    const low = label.toLowerCase();
    if (!low || !low.includes(needle)) continue;
    out.push({ ref: Number(el.getAttribute("data-agent-ref")), role, label: label.slice(0, 80), exact: low === needle });
    if (out.length >= limit) break;
  }
  return out;
}`;

export async function findByText(page: Page, text: string, limit = 8): Promise<Match[]> {
  await snapshot(page); // stamps data-agent-ref on every visible control, across frames
  const out: Match[] = [];
  for (const frame of page.frames()) {
    const found = (await frame.evaluate(`(${FIND_FN})(${JSON.stringify(text)}, ${limit - out.length})`).catch(() => [])) as Match[];
    out.push(...found);
    if (out.length >= limit) break;
  }
  return out;
}

const fmt = (m: Match) => `[${m.ref}] ${m.role} "${m.label}"`;

/** The element a tool call means: by `ref` from the last snapshot, or by the visible text in `text` / `label`. */
export async function resolveTarget(page: Page, a: { ref?: unknown; text?: unknown; label?: unknown }): Promise<{ loc: Locator; how: string }> {
  if (a.ref != null && String(a.ref).trim() !== "") return { loc: await ref(page, String(a.ref)), how: `[${String(a.ref)}]` };
  const q = String(a.text ?? a.label ?? "").trim();
  if (!q) throw new Error("pass ref (from the snapshot) or text (the visible label)");
  const matches = await findByText(page, q);
  if (!matches.length) throw new Error(`no visible element matching "${q}"; browser_snapshot to see what is on the page`);
  const exact = matches.filter((m) => m.exact);
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  if (!pick) throw new Error(`"${q}" matches several elements; use a ref:\n${matches.map(fmt).join("\n")}`);
  return { loc: await ref(page, String(pick.ref)), how: fmt(pick) };
}

export async function findTool(t: Tenant, row: SessionRow, text: string): Promise<string> {
  return withPage(t, row, async (page) => {
    const matches = await findByText(page, text, 10);
    return matches.length ? matches.map(fmt).join("\n") : `no visible element matching "${text}"`;
  });
}

// ------------------------------------------------------------------ fill a form in one call

export interface FormField {
  ref?: string | number;
  label?: string;
  text?: string;
  value: string;
}

export async function fillForm(t: Tenant, row: SessionRow, fields: FormField[], submit?: string | boolean): Promise<string> {
  return withPage(t, row, async (page) => {
    const done: string[] = [];
    let last: Locator | undefined;
    for (const f of fields) {
      const { loc, how } = await resolveTarget(page, f);
      const [tag, type] = (await loc.evaluate((el) => [el.tagName.toLowerCase(), (el as HTMLInputElement).type ?? ""]).catch(() => ["", ""])) as [string, string];
      const value = String(f.value ?? "");
      if (tag === "select") {
        await loc.selectOption({ label: value }).catch(async () => {
          await loc.selectOption(value);
        });
      } else if (type === "checkbox" || type === "radio") {
        await loc.setChecked(/^(true|yes|on|1|checked)$/i.test(value), { timeout: 5000 });
      } else {
        await loc.click({ timeout: 8000 }).catch(() => {});
        await loc.fill(value).catch(async () => {
          await loc.fill("").catch(() => {});
          await loc.type(value, { delay: 10 });
        });
        // React-style inputs sometimes drop a programmatic fill; type it when the value did not stick.
        const now = await loc.inputValue().catch(() => value);
        if (now !== value && type !== "password") {
          await loc.fill("").catch(() => {});
          await loc.type(value, { delay: 10 }).catch(() => {});
        }
      }
      last = loc;
      done.push(`${how} = ${type === "password" ? "••••" : JSON.stringify(value.slice(0, 60))}`);
    }
    let submitted = "";
    if (submit === true || (typeof submit === "string" && /^(enter|true)$/i.test(submit))) {
      if (last) await last.press("Enter");
      submitted = "pressed Enter";
    } else if (typeof submit === "string" && submit.trim()) {
      const { loc, how } = await resolveTarget(page, /^\d+$/.test(submit.trim()) ? { ref: submit.trim() } : { text: submit });
      await loc.click({ timeout: 10_000 });
      submitted = `clicked ${how}`;
    }
    await settle(page);
    return `filled ${done.length} field${done.length === 1 ? "" : "s"}:\n${done.join("\n")}${submitted ? `\n${submitted} -> ${page.url()}` : ""}\n\n${await after(page, row.id)}`;
  });
}

// ------------------------------------------------------------------ rows out of a page

/** Runs in the page: the visible tables (or grids, or the largest repeated row-like structure) as header + rows. */
const EXTRACT_FN = `(maxRows) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  const headingFor = (el) => { let n = el; for (let i = 0; i < 4 && n; i++) { n = n.parentElement; const h = n && n.querySelector("h1, h2, h3, h4, caption"); if (h && vis(h)) return txt(h).slice(0, 80); } return ""; };
  const out = [];
  for (const table of Array.from(document.querySelectorAll("table")).filter(vis)) {
    const headers = Array.from(table.querySelectorAll("thead th, thead td")).map(txt);
    const rows = Array.from(table.querySelectorAll("tr")).filter((r) => !r.closest("thead")).map((r) => Array.from(r.querySelectorAll("td, th")).map(txt)).filter((c) => c.some(Boolean));
    if (rows.length >= 2) out.push({ source: "table", heading: (table.caption && txt(table.caption)) || headingFor(table), headers, rows: rows.slice(0, maxRows), total: rows.length });
  }
  if (!out.length) {
    for (const grid of Array.from(document.querySelectorAll('[role="grid"], [role="table"], [role="treegrid"]')).filter(vis)) {
      const headers = Array.from(grid.querySelectorAll('[role="columnheader"]')).map(txt);
      const rows = Array.from(grid.querySelectorAll('[role="row"]')).map((r) => Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"], [role="rowheader"]')).map(txt)).filter((c) => c.some(Boolean));
      if (rows.length >= 2) out.push({ source: "grid", heading: headingFor(grid), headers, rows: rows.slice(0, maxRows), total: rows.length });
    }
  }
  if (!out.length) {
    // Transaction and order lists are usually N siblings with the same tag and class, each holding a number.
    let best = null;
    for (const el of Array.from(document.querySelectorAll("ul, ol, div, section, tbody")).filter(vis)) {
      const kids = Array.from(el.children).filter(vis);
      if (kids.length < 4) continue;
      const key = (k) => k.tagName + "." + String(k.className || "").split(/\\s+/)[0];
      const counts = {};
      for (const k of kids) counts[key(k)] = (counts[key(k)] || 0) + 1;
      const topKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      const same = kids.filter((k) => key(k) === topKey);
      const texts = same.map(txt).filter((s) => s.length >= 8 && s.length <= 400 && /\\d/.test(s));
      if (texts.length >= 4 && (!best || texts.length > best.n)) best = { el, same, n: texts.length };
    }
    if (best) {
      const rows = best.same.map((k) => String(k.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean)).filter((c) => c.length);
      out.push({ source: "repeated", heading: headingFor(best.el), headers: [], rows: rows.slice(0, maxRows), total: rows.length });
    }
  }
  return out.slice(0, 3);
}`;

type Extracted = { source: string; heading: string; headers: string[]; rows: string[][]; total: number };
const EXTRACT_MAX_CHARS = Number(process.env.EXTRACT_MAX_CHARS ?? 14_000);

export async function extractRows(t: Tenant, row: SessionRow, opts: { scroll?: boolean; maxRows?: number }): Promise<string> {
  return withPage(t, row, async (page) => {
    const maxRows = Math.max(1, Math.min(500, Number(opts.maxRows ?? 200)));
    const run = async () => ((await page.evaluate(`(${EXTRACT_FN})(${maxRows})`).catch(() => [])) as Extracted[]);
    let tables = await run();
    if (opts.scroll) {
      // Lazy lists grow as they scroll; stop when a scroll adds nothing.
      let count = tables.reduce((s, x) => s + x.total, 0);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(700);
        tables = await run();
        const n = tables.reduce((s, x) => s + x.total, 0);
        if (n <= count) break;
        count = n;
      }
    }
    if (!tables.length) return `no table, grid or repeated list on ${page.url()}; browser_text for the page as prose`;
    const text = JSON.stringify(tables.map((x) => ({ heading: x.heading || undefined, source: x.source, headers: x.headers.length ? x.headers : undefined, total_rows: x.total, rows: x.rows })));
    return text.length > EXTRACT_MAX_CHARS ? `${text.slice(0, EXTRACT_MAX_CHARS)}\n... (cut at ${EXTRACT_MAX_CHARS.toLocaleString()} characters; use max_rows or filter the page first)` : text;
  });
}

// ------------------------------------------------------------------ automatic sign-in

const NO_LOGIN = /(^|\.)(duckduckgo|google|bing|yahoo|browserbase)\.(com|org)$/i;
const LOGIN_URL = /\/(login|log-in|signin|sign-in|auth|session|account\/login|users\/sign_in)\b/i;

/** Whether the page in front of us is a sign-in wall: a visible password field, or a login URL with a submit control. */
export async function looksLikeLoginWall(page: Page): Promise<boolean> {
  const hasPassword = await page.evaluate(`Array.from(document.querySelectorAll('input[type="password"]')).some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`).catch(() => false);
  if (hasPassword) return true;
  if (!LOGIN_URL.test(page.url())) return false;
  return (await page.evaluate(`!!document.querySelector('button[type="submit"], input[type="submit"], button')`).catch(() => false)) as boolean;
}

function autoLoginTried(messages: ChatMessage[], domain: string): boolean {
  const marker = `auto-login (${domain}):`;
  for (let i = messages.length - 1; i >= taskStart(messages); i--) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.includes(marker)) return true;
  }
  return false;
}

/**
 * A login wall on a site whose login is in the vault: sign in now, once per task per site, instead
 * of handing the wall to the model for three turns. Returns a line for the tool result, or nothing
 * when there is no wall, no login saved, or it was already tried in this task.
 */
export async function maybeAutoLogin(t: Tenant, row: SessionRow, page: Page, handle: BrowserHandle): Promise<{ line: string; loggedIn: boolean } | undefined> {
  const domain = registrableDomain(page.url());
  if (!domain || NO_LOGIN.test(domain) || autoLoginTried(row.messages, domain)) return undefined;
  if (!(await looksLikeLoginWall(page))) return undefined;
  if (!(await findCredential(t, domain).catch(() => undefined))) return undefined;
  const { loginToSite } = await import("./login.js");
  const r = await loginToSite(t, { connectUrl: handle.connectUrl, domain, targetId: row.browser_target_id }).catch((err) => ({ status: "needs_user" as const, reason: err instanceof Error ? err.message : String(err), url: page.url() }));
  const ok = r.status === "logged_in" || r.status === "already_logged_in";
  await recordLoginOutcome(t, domain, ok, "reason" in r ? r.reason : "ask" in r ? r.ask : undefined).catch(() => {});
  let line = `auto-login (${domain}): ${r.status}`;
  if (r.status === "needs_code") line += `. The site sent the user a code: call request_code with one line, then login(domain, code) with what they send. Do not reload or navigate.`;
  else if (r.status === "needs_user") line += `: ${r.reason}`;
  else if (ok) line += `. Signed in with the saved login; continue.`;
  console.log(`[login] ${row.id} ${line.slice(0, 120)}`);
  return { line, loggedIn: ok };
}

// ------------------------------------------------------------------ recorded paths: the host writes what worked, the browser replays it

export type PathStep = { kind: "goto"; url: string } | { kind: "click"; label: string } | { kind: "type"; label: string; value: string; enter?: boolean } | { kind: "select"; label: string; value: string };

/** Steps that spend, send, cancel or delete are never recorded and never replayed: the model does them behind a checkpoint. */
export const RISKY_LABEL = /\b(pay|payment|place (your |the )?order|buy( now)?|purchase|check ?out|confirm( (order|payment|booking|purchase|reservation|transfer))?|book( now)?|reserve|submit( (order|payment|claim|application|request))?|send|delete|remove|cancel|unsubscribe|transfer|apply( now)?|sign ?(up|out)|log ?out|agree|accept|approve|authorize)\b/i;
const SECRET_FIELD = /pass(word)?|code|otp|one[- ]time|cvv|cvc|card|ssn|social|secur|pin\b/i;
const MAX_PATH_STEPS = 25;
const PATHS_HEADING = "## Recorded paths";
const PATHS_NOTE = "(host-written from tasks that worked; browser_run_path replays one and stops before anything that pays, sends, cancels or deletes)";

/** The label the model saw for a ref: the `[ref] role "label"` line in the last browser result before this call. */
function labelForRef(prevResult: string | undefined, r: string): string | undefined {
  if (!prevResult) return undefined;
  const m = prevResult.match(new RegExp(`^\\[${r.replace(/\\D/g, "")}\\] \\S+ "([^"]*)"`, "m"));
  return m?.[1]?.trim() || undefined;
}

/**
 * The browser steps this task took on `domain`, in a form that can be replayed by label: goto URLs,
 * clicks and typing by the visible label the model saw, selects. Recording stops at the first step
 * that cannot be replayed safely (a click by a ref whose label is unknown, a secret field, a step
 * that pays or sends) or when the task moves to another site.
 */
export function recordedSteps(messages: ChatMessage[], domain: string): PathStep[] {
  const steps: PathStep[] = [];
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id && typeof m.content === "string") results.set(m.tool_call_id, m.content);
  let prev: string | undefined;
  let onDomain = false;
  const stop = { hit: false };
  const push = (s: PathStep) => {
    if (steps.length < MAX_PATH_STEPS) steps.push(s);
    else stop.hit = true;
  };
  outer: for (let i = taskStart(messages); i < messages.length; i++) {
    for (const c of messages[i].tool_calls ?? []) {
      let a: Record<string, unknown> = {};
      try {
        a = JSON.parse(c.function.arguments || "{}");
      } catch {
        continue;
      }
      const name = c.function.name;
      const result = results.get(c.id);
      if (name === "browser_goto" || (name === "browser_open" && a.url)) {
        const url = String(a.url);
        const d = registrableDomain(url);
        if (d !== domain) {
          if (onDomain) break outer; // moved to another site: the path ends here
        } else {
          onDomain = true;
          push({ kind: "goto", url });
        }
      } else if (onDomain && name.startsWith("browser_")) {
        if (name === "browser_click") {
          const label = a.text ? String(a.text) : labelForRef(prev, String(a.ref ?? ""));
          if (!label || RISKY_LABEL.test(label)) break outer;
          push({ kind: "click", label });
        } else if (name === "browser_type") {
          const label = a.label ? String(a.label) : labelForRef(prev, String(a.ref ?? ""));
          const value = String(a.text ?? "");
          if (!label || SECRET_FIELD.test(label) || /^\d{4,8}$/.test(value.trim())) break outer;
          push({ kind: "type", label, value, enter: !!a.enter });
        } else if (name === "browser_select") {
          const label = a.label ? String(a.label) : labelForRef(prev, String(a.ref ?? ""));
          if (!label) break outer;
          push({ kind: "select", label, value: String(a.value ?? "") });
        } else if (name === "browser_fill_form") {
          const fields = (Array.isArray(a.fields) ? a.fields : []) as FormField[];
          for (const f of fields) {
            const label = f.label ?? f.text ?? labelForRef(prev, String(f.ref ?? ""));
            if (!label || SECRET_FIELD.test(label)) break outer;
            push({ kind: "type", label, value: String(f.value ?? "") });
          }
          if (typeof a.submit === "string" && !/^\d+$/.test(a.submit) && !/^(enter|true)$/i.test(a.submit)) {
            if (RISKY_LABEL.test(a.submit)) break outer;
            push({ kind: "click", label: a.submit });
          }
        } else if (name === "browser_run_path") {
          break outer; // a replay inside the task is already recorded under its own name
        }
        // snapshot, text, scroll, wait_for, back, screenshot, tabs: not part of a path
      }
      if (stop.hit) break outer;
      if (name.startsWith("browser_") && result) prev = result;
    }
  }
  // A path is worth keeping when it navigates and then does something.
  return steps.length >= 2 && steps.some((s) => s.kind === "goto") && steps.some((s) => s.kind !== "goto") ? steps : [];
}

export function formatSteps(steps: PathStep[]): string {
  return steps
    .map((s) => {
      if (s.kind === "goto") return `goto ${s.url}`;
      if (s.kind === "click") return `click ${JSON.stringify(s.label)}`;
      if (s.kind === "type") return `type ${JSON.stringify(s.label)} = ${JSON.stringify(s.value)}${s.enter ? " enter" : ""}`;
      return `select ${JSON.stringify(s.label)} = ${JSON.stringify(s.value)}`;
    })
    .join("\n");
}

export function parseSteps(text: string): PathStep[] {
  const out: PathStep[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^goto (\S+)$/))) out.push({ kind: "goto", url: m[1] });
    else if ((m = line.match(/^click ("(?:[^"\\]|\\.)*")$/))) out.push({ kind: "click", label: JSON.parse(m[1]) });
    else if ((m = line.match(/^type ("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*")( enter)?$/))) out.push({ kind: "type", label: JSON.parse(m[1]), value: JSON.parse(m[2]), enter: !!m[3] });
    else if ((m = line.match(/^select ("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*")$/))) out.push({ kind: "select", label: JSON.parse(m[1]), value: JSON.parse(m[2]) });
  }
  return out;
}

export interface RecordedPath {
  name: string;
  date: string;
  steps: PathStep[];
}

/** The recorded paths in a site note, newest first. */
export function parsePaths(note: string): RecordedPath[] {
  const start = note.indexOf(PATHS_HEADING);
  if (start < 0) return [];
  const rest = note.slice(start + PATHS_HEADING.length);
  const end = rest.search(/\n## /);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const out: RecordedPath[] = [];
  for (const block of section.split(/\n(?=### )/)) {
    const m = block.match(/^### (.+?) \((\d{4}-\d{2}-\d{2})\)\n([\s\S]*)$/);
    if (!m) continue;
    const steps = parseSteps(m[3]);
    if (steps.length) out.push({ name: m[1].trim(), date: m[2], steps });
  }
  return out;
}

/** The note with one path added or replaced (same name), newest first, at most five kept; the rest of the note is untouched. */
export function withPath(note: string, path: RecordedPath): string {
  const existing = parsePaths(note).filter((p) => p.name.toLowerCase() !== path.name.toLowerCase());
  const paths = [path, ...existing].slice(0, 5);
  const section = `${PATHS_HEADING}\n${PATHS_NOTE}\n${paths.map((p) => `### ${p.name} (${p.date})\n${formatSteps(p.steps)}`).join("\n\n")}\n`;
  const start = note.indexOf(PATHS_HEADING);
  if (start < 0) return `${note.trimEnd()}\n\n${section}`.trimStart();
  const rest = note.slice(start + PATHS_HEADING.length);
  const end = rest.search(/\n## /);
  const tail = end >= 0 ? rest.slice(end + 1) : "";
  return `${note.slice(0, start)}${section}${tail ? `\n${tail}` : ""}`;
}

/** A path name from the task: its title or first line, short and plain. */
export function pathName(title: string): string {
  return title
    .replace(/^\[[^\]]+\]\n/, "")
    .split("\n")[0]
    .replace(/[^\w\s$%.,'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .toLowerCase();
}

/**
 * After a browser task that succeeded: record what it did on each site as a replayable path in
 * sites/<domain>.md. Returns the domains written. Never records secrets or risky steps (see recordedSteps).
 */
export async function recordPaths(t: Tenant, row: SessionRow, domains: string[]): Promise<string[]> {
  const name = pathName(row.title ?? "");
  if (!name) return [];
  const written: string[] = [];
  for (const domain of domains) {
    const steps = recordedSteps(row.messages, domain);
    if (!steps.length) continue;
    const path = `sites/${domain}.md`;
    const note = (await readMemory(t, path).catch(() => null)) ?? `# ${domain}\n`;
    await writeMemory(t, path, withPath(note, { name, date: new Date().toISOString().slice(0, 10), steps }));
    written.push(domain);
  }
  return written;
}

/** Replay a recorded path from the site note: every step server-side, then the page as it stands. Stops at the first step that does not fit. */
export async function replayPath(t: Tenant, row: SessionRow, domainArg: string, nameArg?: string): Promise<string> {
  const domain = registrableDomain(domainArg);
  const note = await readMemory(t, `sites/${domain}.md`).catch(() => null);
  const paths = note ? parsePaths(note) : [];
  if (!paths.length) return `no recorded paths for ${domain}; do the task with the browser tools (a path is recorded when it works)`;
  const want = (nameArg ?? "").trim().toLowerCase();
  const path = want ? (paths.find((p) => p.name.toLowerCase() === want) ?? paths.find((p) => p.name.toLowerCase().includes(want) || want.includes(p.name.toLowerCase()))) : paths.length === 1 ? paths[0] : undefined;
  if (!path) return `which path? ${domain} has:\n${paths.map((p) => `- ${p.name} (${p.date}, ${p.steps.length} steps)`).join("\n")}`;
  return withPage(t, row, async (page, _browser, handle) => {
    const started = Date.now();
    const log: string[] = [];
    for (const [i, step] of path.steps.entries()) {
      const label = `step ${i + 1}/${path.steps.length}: ${formatSteps([step])}`;
      try {
        if (step.kind === "goto") {
          await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await waitInteractive(page);
          const auto = await maybeAutoLogin(t, row, page, handle);
          if (auto) {
            log.push(auto.line);
            if (!auto.loggedIn) return `path "${path.name}" stopped at ${label}: a sign-in wall\n${log.join("\n")}\n\n${await snapshot(page)}`;
            await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
            await waitInteractive(page);
          }
        } else if (step.kind === "click") {
          if (RISKY_LABEL.test(step.label)) return `path "${path.name}" stopped before ${label}: that step pays, sends, cancels or deletes; do it yourself behind a checkpoint\n\n${await snapshot(page)}`;
          const { loc } = await resolveTarget(page, { text: step.label });
          await loc.click({ timeout: 10_000 });
          await settle(page);
        } else if (step.kind === "type") {
          const { loc } = await resolveTarget(page, { text: step.label });
          await loc.click({ timeout: 8000 }).catch(() => {});
          await loc.fill(step.value).catch(async () => {
            await loc.type(step.value, { delay: 10 });
          });
          if (step.enter) {
            await loc.press("Enter");
            await settle(page);
          }
        } else if (step.kind === "select") {
          const { loc } = await resolveTarget(page, { text: step.label });
          await loc.selectOption({ label: step.value }).catch(async () => {
            await loc.selectOption(step.value);
          });
        }
        log.push(`ok ${label}`);
      } catch (err) {
        const snap = await snapshot(page);
        rememberSnapshot(row.id, page.url(), snap);
        return `path "${path.name}" stopped at ${label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n${log.join("\n")}\n\ncurrent page:\n${snap}`;
      }
    }
    const snap = await snapshot(page);
    rememberSnapshot(row.id, page.url(), snap);
    return `path "${path.name}" replayed (${path.steps.length} steps, ${((Date.now() - started) / 1000).toFixed(1)}s) -> ${page.url()}\n\n${snap}`;
  });
}
