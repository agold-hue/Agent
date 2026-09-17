import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { saveFile, type FileRow } from "../files.js";
import { log, errText } from "../log.js";

/**
 * One Chromium per business with a persistent profile on disk (cookies and sign-ins survive restarts),
 * one tab per task inside it. The browser lives in this process, so a tool call is a function call,
 * not a reconnect. Idle browsers close after a while; the profile stays.
 */
interface OrgBrowser {
  orgId: string;
  context: BrowserContext;
  browser?: Browser;
  lastUsed: number;
  tabs: Map<string, TaskTabs>;
}

export interface TaskTabs {
  pages: Page[];
  active: number;
  /** Things that happened between tool calls and should be reported with the next result. */
  notes: string[];
  downloads: FileRow[];
}

const browsers = new Map<string, Promise<OrgBrowser>>();

function userAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
}

async function launch(orgId: string, timezone: string, locale: string): Promise<OrgBrowser> {
  const viewport = { width: config.browser.width(), height: config.browser.height() };
  const ws = config.browser.wsEndpoint();
  if (ws) {
    const browser = await chromium.connectOverCDP(ws, { timeout: 30_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext({ viewport, acceptDownloads: true }));
    log.info("browser", "connected to remote browser", { org: orgId });
    return { orgId, context, browser, lastUsed: Date.now(), tabs: new Map() };
  }
  const profile = path.join(config.dataDir(), "profiles", orgId);
  await fs.mkdir(profile, { recursive: true });
  const opts = {
    headless: config.browser.headless(),
    viewport,
    locale,
    timezoneId: timezone,
    userAgent: userAgent(),
    acceptDownloads: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
  };
  let context: BrowserContext;
  try {
    // The full Chromium build (new headless) looks like a normal browser to sites; the headless shell does not.
    context = await chromium.launchPersistentContext(profile, { ...opts, channel: "chromium" });
  } catch (e) {
    log.warn("browser", "full chromium unavailable, using default build", { err: errText(e) });
    context = await chromium.launchPersistentContext(profile, opts);
  }
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(45_000);
  log.info("browser", "launched", { org: orgId, profile });
  return { orgId, context, lastUsed: Date.now(), tabs: new Map() };
}

async function orgBrowser(orgId: string, timezone: string, locale: string): Promise<OrgBrowser> {
  let p = browsers.get(orgId);
  if (p) {
    const ob = await p.catch(() => undefined);
    if (ob && !ob.context.browser()?.isConnected() && ob.browser) {
      browsers.delete(orgId);
      p = undefined;
    } else if (ob) {
      try {
        // A closed context throws on use; detect it cheaply.
        ob.context.pages();
        ob.lastUsed = Date.now();
        return ob;
      } catch {
        browsers.delete(orgId);
        p = undefined;
      }
    } else {
      browsers.delete(orgId);
      p = undefined;
    }
  }
  p = launch(orgId, timezone, locale);
  browsers.set(orgId, p);
  p.catch(() => browsers.delete(orgId));
  return p;
}

function wirePage(ob: OrgBrowser, taskId: string, tabs: TaskTabs, page: Page): void {
  page.on("dialog", async (d) => {
    tabs.notes.push(`Dialog (${d.type()}): "${d.message().slice(0, 300)}" -> ${d.type() === "beforeunload" || d.type() === "prompt" ? "dismissed" : "accepted"}`);
    if (d.type() === "beforeunload" || d.type() === "prompt") await d.dismiss().catch(() => {});
    else await d.accept().catch(() => {});
  });
  page.on("download", async (dl) => {
    try {
      const tmp = await dl.path();
      if (!tmp) return;
      const data = await fs.readFile(tmp);
      const name = dl.suggestedFilename() || "download";
      const f = await saveFile(ob.orgId, taskId === "manual" ? null : taskId, name, guessMime(name), data);
      tabs.downloads.push(f);
      tabs.notes.push(`Downloaded "${f.name}" (${f.bytes} bytes) -> file id ${f.id}`);
    } catch (e) {
      tabs.notes.push(`A download failed: ${errText(e)}`);
    }
  });
  page.on("popup", (popup) => {
    tabs.pages.push(popup);
    tabs.active = tabs.pages.length - 1;
    tabs.notes.push(`A new tab opened (${popup.url() || "loading"}) and is now the active tab.`);
    wirePage(ob, taskId, tabs, popup);
  });
  page.on("close", () => {
    const i = tabs.pages.indexOf(page);
    if (i >= 0) tabs.pages.splice(i, 1);
    if (tabs.active >= tabs.pages.length) tabs.active = Math.max(0, tabs.pages.length - 1);
  });
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", csv: "text/csv", txt: "text/plain", zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] ?? "application/octet-stream";
}

export interface PageHandle {
  page: Page;
  tabs: TaskTabs;
  context: BrowserContext;
}

/** The task's active tab, opening the browser and the tab on first use. */
export async function pageFor(orgId: string, taskId: string, opts: { timezone: string; locale?: string }): Promise<PageHandle> {
  const ob = await orgBrowser(orgId, opts.timezone, opts.locale ?? "en-US");
  let tabs = ob.tabs.get(taskId);
  if (!tabs) {
    tabs = { pages: [], active: 0, notes: [], downloads: [] };
    ob.tabs.set(taskId, tabs);
  }
  tabs.pages = tabs.pages.filter((p) => !p.isClosed());
  if (!tabs.pages.length) {
    const page = await ob.context.newPage();
    tabs.pages.push(page);
    tabs.active = 0;
    wirePage(ob, taskId, tabs, page);
  }
  if (tabs.active >= tabs.pages.length) tabs.active = tabs.pages.length - 1;
  return { page: tabs.pages[tabs.active], tabs, context: ob.context };
}

/** Whether this task has a tab open right now (for the live view). */
export async function existingPage(orgId: string, taskId: string): Promise<PageHandle | undefined> {
  const p = browsers.get(orgId);
  if (!p) return undefined;
  const ob = await p.catch(() => undefined);
  const tabs = ob?.tabs.get(taskId);
  if (!ob || !tabs) return undefined;
  tabs.pages = tabs.pages.filter((pg) => !pg.isClosed());
  if (!tabs.pages.length) return undefined;
  if (tabs.active >= tabs.pages.length) tabs.active = tabs.pages.length - 1;
  return { page: tabs.pages[tabs.active], tabs, context: ob.context };
}

export async function newTab(handle: PageHandle, orgId: string, taskId: string, url?: string): Promise<Page> {
  const ob = await browsers.get(orgId)!;
  const page = await handle.context.newPage();
  handle.tabs.pages.push(page);
  handle.tabs.active = handle.tabs.pages.length - 1;
  wirePage(ob, taskId, handle.tabs, page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return page;
}

/** A finished task lets go of its tabs. The browser stays for other tasks and closes when idle. */
export async function closeTaskTabs(orgId: string, taskId: string): Promise<void> {
  const p = browsers.get(orgId);
  if (!p) return;
  const ob = await p.catch(() => undefined);
  const tabs = ob?.tabs.get(taskId);
  if (!ob || !tabs) return;
  for (const page of tabs.pages) await page.close().catch(() => {});
  ob.tabs.delete(taskId);
}

/** Close browsers nobody has used for a while. Called by the scheduler. */
export async function closeIdleBrowsers(): Promise<void> {
  const idleMs = config.browser.idleMinutes() * 60_000;
  for (const [orgId, p] of browsers) {
    const ob = await p.catch(() => undefined);
    if (!ob) {
      browsers.delete(orgId);
      continue;
    }
    const open = [...ob.tabs.values()].some((t) => t.pages.some((pg) => !pg.isClosed()));
    if (open || Date.now() - ob.lastUsed < idleMs) continue;
    browsers.delete(orgId);
    await ob.context.close().catch(() => {});
    await ob.browser?.close().catch(() => {});
    log.info("browser", "closed idle browser", { org: orgId });
  }
}

export async function shutdownBrowsers(): Promise<void> {
  for (const [orgId, p] of browsers) {
    const ob = await p.catch(() => undefined);
    browsers.delete(orgId);
    await ob?.context.close().catch(() => {});
    await ob?.browser?.close().catch(() => {});
  }
}
