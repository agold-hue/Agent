import { chromium, type Browser, type Page } from "playwright-core";
import { createBrowser, reuseBrowser, type BrowserHandle } from "./browser.js";
import { env } from "./env.js";
import { updateSession, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * The agent's hands: a hosted browser driven from this process over CDP. Each call re-attaches
 * (fast) so the loop can be resumed on another worker. Snapshots number the interactive elements
 * and stamp them with data-agent-ref so click/type can target them.
 */
const MAX_TEXT = 6000;
const MAX_ELEMENTS = 250;

async function handleFor(t: Tenant, row: SessionRow): Promise<BrowserHandle> {
  if (!env.browserbase.configured()) throw new Error("The hosted browser is not set up on this server yet. Do what you can with web_search, memory, calendar and email, and tell the user browsing is not enabled.");
  const existing = row.browserbase_session_id ? await reuseBrowser(row.browserbase_session_id) : undefined;
  if (existing) return existing;
  const h = await createBrowser(t);
  row.browserbase_session_id = h.sessionId;
  await updateSession(row.id, { browserbase_session_id: h.sessionId });
  return h;
}

async function withPage<T>(t: Tenant, row: SessionRow, fn: (page: Page, browser: Browser, handle: BrowserHandle) => Promise<T>): Promise<T> {
  const handle = await handleFor(t, row);
  const browser = await chromium.connectOverCDP(handle.connectUrl, { timeout: 30_000 });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    let pages = context.pages();
    if (!pages.length) pages = [await context.newPage()];
    const page = pages[pages.length - 1];
    return await fn(page, browser, handle);
  } finally {
    await browser.close().catch(() => {});
  }
}

const ref = (page: Page, r: string) => page.locator(`[data-agent-ref="${String(r).replace(/[^0-9]/g, "")}"]`).first();
const settle = async (page: Page, ms = 1500) => {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
};

async function snapshot(page: Page): Promise<string> {
  const data = await page.evaluate((max) => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [contenteditable="true"], summary, [onclick]';
    const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    const lines: string[] = [];
    let n = 0;
    for (const el of els) {
      if (n >= max) break;
      n++;
      el.setAttribute("data-agent-ref", String(n));
      const e = el as HTMLInputElement & HTMLSelectElement & HTMLAnchorElement;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? `input:${e.type || "text"}` : tag);
      const label =
        el.getAttribute("aria-label") ||
        (e.labels && e.labels[0] && e.labels[0].innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        ((el as HTMLElement).innerText || e.value || "").trim();
      const extra: string[] = [];
      if (tag === "input" && e.value && String(e.type) !== "password") extra.push(`value="${e.value.slice(0, 40)}"`);
      if (tag === "select") extra.push(`selected="${e.options?.[e.selectedIndex]?.text ?? ""}"`);
      if (e.checked) extra.push("checked");
      if (e.disabled) extra.push("disabled");
      if (tag === "a" && e.href && !e.href.startsWith("javascript:")) extra.push(e.href.slice(0, 100));
      lines.push(`[${n}] ${role} "${String(label).replace(/\s+/g, " ").slice(0, 80)}" ${extra.join(" ")}`.trim());
    }
    const headings = Array.from(document.querySelectorAll("h1, h2")).filter(isVisible).slice(0, 12).map((h) => `# ${(h as HTMLElement).innerText.trim().replace(/\s+/g, " ").slice(0, 100)}`);
    return { title: document.title, url: location.href, headings, lines, total: els.length };
  }, MAX_ELEMENTS);
  const out = [`${data.title}\n${data.url}`, ...data.headings, ...data.lines];
  if (data.total > MAX_ELEMENTS) out.push(`... ${data.total - MAX_ELEMENTS} more elements not shown; scroll or use browser_text`);
  return out.join("\n");
}

export interface BrowserResult {
  text: string;
  imageBase64?: string;
}

export async function runBrowserTool(t: Tenant, row: SessionRow, name: string, a: Record<string, unknown>): Promise<BrowserResult> {
  const str = (k: string) => String(a[k] ?? "");
  switch (name) {
    case "browser_open":
      return withPage(t, row, async (page, _b, h) => {
        if (str("url")) await page.goto(str("url"), { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await settle(page, 2000);
        return { text: `Browser ready. Live view for the user: ${h.liveViewUrl}\n${await page.title()}\n${page.url()}` };
      });
    case "browser_goto":
      return withPage(t, row, async (page) => {
        await page.goto(str("url"), { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page, 2000);
        return { text: `${await page.title()}\n${page.url()}\n\n${await snapshot(page)}` };
      });
    case "browser_snapshot":
      return withPage(t, row, async (page) => ({ text: await snapshot(page) }));
    case "browser_click":
      return withPage(t, row, async (page) => {
        await ref(page, str("ref")).click({ timeout: 10_000 });
        await settle(page);
        return { text: `clicked [${str("ref")}] -> ${page.url()}\n\n${await snapshot(page)}` };
      });
    case "browser_type":
      return withPage(t, row, async (page) => {
        const loc = ref(page, str("ref"));
        await loc.click({ timeout: 10_000 });
        await loc.fill("").catch(() => {});
        await loc.type(str("text"), { delay: 15 });
        if (a.enter) {
          await loc.press("Enter");
          await settle(page);
          return { text: `typed + Enter\n\n${await snapshot(page)}` };
        }
        return { text: `typed into [${str("ref")}]` };
      });
    case "browser_select":
      return withPage(t, row, async (page) => {
        const loc = ref(page, str("ref"));
        await loc.selectOption({ label: str("value") }).catch(async () => {
          await loc.selectOption(str("value"));
        });
        return { text: `selected "${str("value")}" in [${str("ref")}]` };
      });
    case "browser_press":
      return withPage(t, row, async (page) => {
        await page.keyboard.press(str("key"));
        await settle(page, 800);
        return { text: `pressed ${str("key")}\n\n${await snapshot(page)}` };
      });
    case "browser_scroll":
      return withPage(t, row, async (page) => {
        await page.mouse.wheel(0, str("direction") === "up" ? -700 : 700);
        await page.waitForTimeout(500);
        return { text: await snapshot(page) };
      });
    case "browser_text":
      return withPage(t, row, async (page) => {
        const raw = await page.evaluate(() => document.body.innerText);
        const clean = raw.replace(/\n{3,}/g, "\n\n").trim();
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
        const grab = () => page.evaluate(() => document.body.innerText).catch(() => "");
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
