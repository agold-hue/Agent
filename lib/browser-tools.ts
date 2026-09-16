import { chromium, type Browser, type Page } from "playwright-core";
import { createBrowser, pageByTarget, reuseBrowser, targetIdOf, type BrowserHandle } from "./browser.js";
import { env } from "./env.js";
import { otherActiveBrowsers, updateSession, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * The agent's hands: a hosted browser driven from this process over CDP. Each call re-attaches
 * (fast) so the loop can be resumed on another worker. Snapshots number the interactive elements
 * and stamp them with data-agent-ref so click/type can target them.
 */
const MAX_TEXT = 6000;
const MAX_ELEMENTS = 250;
/** A click or a keystroke returns a shorter snapshot; browser_snapshot gives the whole page. */
const ACTION_ELEMENTS = Number(process.env.ACTION_SNAPSHOT_ELEMENTS ?? 140);

/**
 * One hosted browser per customer at a time. A session reuses its own browser, else joins the browser
 * another of the customer's sessions is using (same cookies, so one sign-in serves every task, and a
 * site never sees a "new device"), and only opens a fresh one when none is running.
 */
async function handleFor(t: Tenant, row: SessionRow): Promise<BrowserHandle> {
  if (!env.browserbase.configured()) throw new Error("The hosted browser is not set up on this server yet. Do what you can with web_search, memory, calendar and email, and tell the user browsing is not enabled.");
  const own = row.browserbase_session_id ? await reuseBrowser(row.browserbase_session_id) : undefined;
  if (own) return own;
  for (const id of await otherActiveBrowsers(row.user_id, row.id).catch(() => [] as string[])) {
    const shared = await reuseBrowser(id);
    if (!shared) continue;
    row.browserbase_session_id = id;
    row.browser_target_id = null; // a tab of its own in the shared browser, opened on first use
    await updateSession(row.id, { browserbase_session_id: id, browser_target_id: null });
    return shared;
  }
  const h = await createBrowser(t);
  row.browserbase_session_id = h.sessionId;
  row.browser_target_id = null;
  await updateSession(row.id, { browserbase_session_id: h.sessionId, browser_target_id: null });
  return h;
}

/**
 * The session's own tab: found by target id on every call; opened when the session has none yet.
 * The browser's first blank page is claimed by whichever session gets there first, so a single task
 * still works in one tab like before; later sessions get a new tab each.
 */
async function pageFor(row: SessionRow, context: ReturnType<Browser["contexts"]>[number]): Promise<Page> {
  let pages = context.pages();
  const own = await pageByTarget(pages, row.browser_target_id);
  if (own) return own;
  let page: Page;
  const blank = pages.find((p) => p.url() === "about:blank" || p.url() === "");
  if (!row.browser_target_id && blank && pages.length === 1) page = blank;
  else page = await context.newPage();
  const id = await targetIdOf(page);
  if (id) {
    row.browser_target_id = id;
    await updateSession(row.id, { browser_target_id: id });
  }
  return page;
}

/** Close the session's tab (a finished task); the browser stays for whoever else uses it. */
export async function closeTab(row: SessionRow): Promise<void> {
  if (!row.browserbase_session_id || !row.browser_target_id) return;
  try {
    const handle = await reuseBrowser(row.browserbase_session_id);
    if (!handle) return;
    const browser = await connect(handle);
    const context = browser.contexts()[0];
    const page = context ? await pageByTarget(context.pages(), row.browser_target_id) : undefined;
    if (page && context && context.pages().length > 1) await page.close().catch(() => {});
  } catch {
    /* the browser is gone; nothing to close */
  }
}

/**
 * One CDP connection per hosted browser, kept open between tool calls within this worker: connecting
 * to the hosted browser costs one to two seconds, and a task makes dozens of calls. A connection that
 * died (the worker was frozen, the session ended) is replaced on the next call.
 */
const connections = new Map<string, Browser>();

async function connect(handle: BrowserHandle): Promise<Browser> {
  const cached = connections.get(handle.sessionId);
  if (cached?.isConnected()) return cached;
  connections.delete(handle.sessionId);
  const browser = await chromium.connectOverCDP(handle.connectUrl, { timeout: 30_000 });
  connections.set(handle.sessionId, browser);
  browser.on("disconnected", () => {
    if (connections.get(handle.sessionId) === browser) connections.delete(handle.sessionId);
  });
  return browser;
}

/** Drop the cached connection for a session (the hosted browser was released). */
export async function disconnectBrowser(sessionId: string): Promise<void> {
  const b = connections.get(sessionId);
  connections.delete(sessionId);
  await b?.close().catch(() => {});
}

async function withPage<T>(t: Tenant, row: SessionRow, fn: (page: Page, browser: Browser, handle: BrowserHandle) => Promise<T>): Promise<T> {
  const handle = await handleFor(t, row);
  const run = async () => {
    const browser = await connect(handle);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await pageFor(row, context);
    return await fn(page, browser, handle);
  };
  try {
    return await run();
  } catch (err) {
    // A stale connection fails on first use; reconnect once and repeat the call.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/closed|disconnected|Target|has been destroyed|WebSocket/i.test(msg)) throw err;
    await disconnectBrowser(handle.sessionId);
    return await run();
  }
}

/**
 * Locate a snapshot ref in whichever frame holds it. Card verification (3-D Secure), payment forms and
 * some sign-in dialogs render inside iframes; refs are numbered across every frame, so the agent
 * clicks them like anything else.
 */
async function ref(page: Page, r: string) {
  const sel = `[data-agent-ref="${String(r).replace(/[^0-9]/g, "")}"]`;
  for (const frame of page.frames()) {
    const loc = frame.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return page.locator(sel).first();
}

/** Visible text of the page and of every child frame that shows something. */
export async function pageText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    const text = (await frame.evaluate(`document.body ? document.body.innerText : ""`).catch(() => "")) as string;
    const clean = text.replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) continue;
    if (frame === page.mainFrame()) parts.unshift(clean);
    else if (clean.length > 20) parts.push(`--- inside a popup/frame (${frameHost(frame.url())}) ---\n${clean}`);
  }
  return parts.join("\n\n");
}

function frameHost(url: string): string {
  try {
    return new URL(url).hostname || "embedded";
  } catch {
    return "embedded";
  }
}
const settle = async (page: Page, ms = 1000) => {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
};

/** Visible controls in the main frame; the snapshot's own selector, so "interactive" means the same thing in both. */
const COUNT_CONTROLS = `(() => { const v = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; }; return Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="combobox"], [role="option"], [contenteditable="true"]')).filter(v).length; })()`;

/**
 * After a navigation, wait until the page is actually usable: single-page apps (Uber's fare estimator,
 * airline sites) answer domcontentloaded with an empty shell and draw the form seconds later once their
 * scripts arrive, slower still through the hosted browser's proxy. Waits for the network to go quiet
 * and for the count of visible controls to appear and stop growing, within `maxMs`.
 */
export async function waitInteractive(page: Page, maxMs = 12_000): Promise<void> {
  const start = Date.now();
  await page.waitForLoadState("load", { timeout: Math.min(5000, maxMs) }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.max(0, Math.min(6000, maxMs - (Date.now() - start))) }).catch(() => {});
  let last = -1;
  while (Date.now() - start < maxMs) {
    const n = Number(await page.evaluate(COUNT_CONTROLS).catch(() => 0));
    if (n > 0 && n === last) return;
    last = n;
    await page.waitForTimeout(600);
  }
}

/** Text of every frame, lowercased, for "wait until the page says X". */
const lowerText = async (page: Page) => (await pageText(page).catch(() => "")).toLowerCase();

/**
 * Runs inside a frame. Kept as source text (not a closure) so no bundler helper such as __name leaks
 * into the page, where it does not exist. Numbers every visible control from `offset + 1`.
 */
const SNAPSHOT_FN = `(max, offset) => {
  const isVisible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="listbox"] li, [contenteditable="true"], summary, [onclick]';
  const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
  const lines = [];
  let n = 0;
  for (const el of els) {
    if (n >= max) break;
    n++;
    const id = offset + n;
    el.setAttribute("data-agent-ref", String(id));
    const e = el;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input:" + (e.type || "text") : tag);
    const label = el.getAttribute("aria-label") || (e.labels && e.labels[0] && e.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (el.innerText || e.value || "").trim();
    const extra = [];
    if (tag === "input" && e.value && String(e.type) !== "password") extra.push('value="' + e.value.slice(0, 40) + '"');
    if (tag === "select") extra.push('selected="' + ((e.options && e.options[e.selectedIndex] && e.options[e.selectedIndex].text) || "") + '"');
    if (e.checked) extra.push("checked");
    if (e.disabled) extra.push("disabled");
    if (tag === "a" && e.href && !e.href.startsWith("javascript:")) extra.push(e.href.slice(0, 100));
    lines.push(("[" + id + "] " + role + ' "' + String(label).replace(/\\s+/g, " ").slice(0, 80) + '" ' + extra.join(" ")).trim());
  }
  const headings = Array.from(document.querySelectorAll("h1, h2")).filter(isVisible).slice(0, 12).map((h) => "# " + h.innerText.trim().replace(/\\s+/g, " ").slice(0, 100));
  return { title: document.title, url: location.href, headings, lines, total: els.length };
}`;

type FrameSnapshot = { title: string; url: string; headings: string[]; lines: string[]; total: number };

export async function snapshot(page: Page, max = MAX_ELEMENTS): Promise<string> {
  const out: string[] = [];
  let offset = 0;
  let total = 0;
  let title = "";
  let url = "";
  for (const frame of page.frames()) {
    if (offset >= max) break;
    const data = (await frame.evaluate(`(${SNAPSHOT_FN})(${max - offset}, ${offset})`).catch((e: unknown) => {
      console.error(`[browser] snapshot of frame ${frameHost(frame.url())} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    })) as FrameSnapshot | null;
    if (!data) continue;
    if (frame === page.mainFrame()) {
      title = data.title;
      url = data.url;
      out.push(...data.headings, ...data.lines);
    } else if (data.lines.length) {
      // A frame with controls is usually a dialog the user must deal with (card verification, payment, sign-in).
      out.push(`--- inside a popup/frame (${frameHost(data.url)}) ---`, ...data.headings, ...data.lines);
    }
    offset += data.lines.length;
    total += data.total;
  }
  out.unshift(`${title}\n${url}`);
  if (total > max) out.push(`... ${total - max} more elements not shown; browser_snapshot lists up to ${MAX_ELEMENTS}, or scroll, or browser_text`);
  return out.join("\n");
}
/** The snapshot that comes back with an action: enough to take the next step, not the whole page. */
const after = (page: Page) => snapshot(page, ACTION_ELEMENTS);

export interface BrowserResult {
  text: string;
  imageBase64?: string;
}

export async function runBrowserTool(t: Tenant, row: SessionRow, name: string, a: Record<string, unknown>): Promise<BrowserResult> {
  const str = (k: string) => String(a[k] ?? "");
  switch (name) {
    case "browser_open":
      return withPage(t, row, async (page, _b, h) => {
        if (str("url")) {
          await page.goto(str("url"), { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
          await waitInteractive(page);
        }
        return { text: `Browser ready. Live view for the user: ${h.liveViewUrl}\n${await page.title()}\n${page.url()}` };
      });
    case "browser_goto":
      return withPage(t, row, async (page) => {
        await page.goto(str("url"), { waitUntil: "domcontentloaded", timeout: 45_000 });
        await waitInteractive(page);
        return { text: `${await page.title()}\n${page.url()}\n\n${await snapshot(page)}` };
      });
    case "browser_snapshot":
      return withPage(t, row, async (page) => {
        let snap = await snapshot(page);
        // Nothing to click yet: the page is still drawing itself. Give it a moment rather than reporting an empty page.
        if (!/^\[\d+\]/m.test(snap)) {
          await waitInteractive(page, 8000);
          snap = await snapshot(page);
        }
        return { text: snap };
      });
    case "browser_wait_for":
      return withPage(t, row, async (page) => {
        const want = str("text").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(a.seconds ?? 15), 1), 120) * 1000;
        const start = Date.now();
        if (!want) {
          await waitInteractive(page, limit);
          return { text: `page settled after ${Math.round((Date.now() - start) / 1000)}s\n\n${await snapshot(page)}` };
        }
        while (Date.now() - start < limit) {
          if ((await lowerText(page)).includes(want)) return { text: `"${str("text")}" is on the page after ${Math.round((Date.now() - start) / 1000)}s\n\n${await snapshot(page)}` };
          await page.waitForTimeout(700);
        }
        return { text: `"${str("text")}" did not appear within ${Math.round(limit / 1000)}s\n\n${await snapshot(page)}` };
      });
    case "browser_click":
      return withPage(t, row, async (page) => {
        await (await ref(page, str("ref"))).click({ timeout: 10_000 });
        await settle(page);
        return { text: `clicked [${str("ref")}] -> ${page.url()}\n\n${await after(page)}` };
      });
    case "browser_type":
      return withPage(t, row, async (page) => {
        const loc = await ref(page, str("ref"));
        await loc.click({ timeout: 10_000 });
        await loc.fill("").catch(() => {});
        await loc.type(str("text"), { delay: 15 });
        if (a.enter) {
          await loc.press("Enter");
          await settle(page);
          return { text: `typed + Enter\n\n${await after(page)}` };
        }
        // Address and search boxes answer typing with a suggestion list that must be clicked; show it.
        await page.waitForTimeout(800);
        return { text: `typed into [${str("ref")}]\n\n${await after(page)}` };
      });
    case "browser_select":
      return withPage(t, row, async (page) => {
        const loc = await ref(page, str("ref"));
        await loc.selectOption({ label: str("value") }).catch(async () => {
          await loc.selectOption(str("value"));
        });
        return { text: `selected "${str("value")}" in [${str("ref")}]` };
      });
    case "browser_press":
      return withPage(t, row, async (page) => {
        await page.keyboard.press(str("key"));
        await settle(page, 800);
        return { text: `pressed ${str("key")}\n\n${await after(page)}` };
      });
    case "browser_scroll":
      return withPage(t, row, async (page) => {
        await page.mouse.wheel(0, str("direction") === "up" ? -700 : 700);
        await page.waitForTimeout(500);
        return { text: await after(page) };
      });
    case "browser_text":
      return withPage(t, row, async (page) => {
        const clean = await pageText(page);
        return { text: clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) + `\n... (${clean.length - MAX_TEXT} more chars)` : clean };
      });
    case "browser_screenshot":
      return withPage(t, row, async (page) => {
        const buf = await page.screenshot({ fullPage: false, type: "jpeg", quality: 70 });
        return { text: `screenshot of ${page.url()}`, imageBase64: buf.toString("base64") };
      });
    case "browser_watch":
      return withPage(t, row, async (page) => {
        const limit = Math.min(Number(a.seconds ?? 60), 180) * 1000;
        const grab = () => pageText(page).catch(() => "");
        const before = await grab();
        const start = Date.now();
        let after = before;
        while (Date.now() - start < limit) {
          await page.waitForTimeout(2000);
          after = await grab();
          if (after !== before) {
            await page.waitForTimeout(1500);
            after = await grab();
            break;
          }
        }
        if (after === before) return { text: `no change after ${Math.round(limit / 1000)}s` };
        const oldLines = new Set(before.split("\n"));
        const fresh = after.split("\n").filter((l) => l.trim() && !oldLines.has(l));
        return { text: fresh.length ? fresh.join("\n").slice(0, MAX_TEXT) : "(page changed; use browser_text to read it)" };
      });
    case "browser_tabs":
      return withPage(t, row, async (page, browser) => {
        const pages = browser.contexts()[0]?.pages() ?? [page];
        return { text: pages.map((p, i) => `[${i}] ${p.url()}`).join("\n") };
      });
    case "browser_tab":
      return withPage(t, row, async (_page, browser) => {
        const pages = browser.contexts()[0]?.pages() ?? [];
        const n = Number(a.index ?? 0);
        if (!pages[n]) return { text: `no tab ${n}` };
        await pages[n].bringToFront();
        return { text: `switched to tab ${n}: ${pages[n].url()}` };
      });
    case "browser_back":
      return withPage(t, row, async (page) => {
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle(page);
        return { text: `${page.url()}\n\n${await snapshot(page)}` };
      });
    case "web_search":
      return withPage(t, row, async (page) => {
        await page.goto(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(str("query"))}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settle(page, 1000);
        const results = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a.result-link"))
            .slice(0, 8)
            .map((a) => {
              const row = a.closest("tr");
              const snippet = row?.nextElementSibling?.querySelector(".result-snippet")?.textContent?.trim() ?? "";
              return `- ${(a as HTMLElement).innerText.trim()} | ${(a as HTMLAnchorElement).href}\n  ${snippet.slice(0, 200)}`;
            }),
        );
        return { text: results.length ? results.join("\n") : (await page.evaluate(() => document.body.innerText)).slice(0, 3000) };
      });
    default:
      return { text: `unknown browser tool ${name}` };
  }
}
