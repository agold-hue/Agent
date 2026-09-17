import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { env } from "./env.js";
import { ensureProvisioned, type Tenant } from "./tenant.js";

let bb: Browserbase | undefined;
export function browserbase(): Browserbase {
  if (!bb) bb = new Browserbase({ apiKey: env.browserbase.apiKey() });
  return bb;
}

export interface BrowserHandle {
  sessionId: string;
  connectUrl: string;
  liveViewUrl: string;
}

/** Create a hosted browser on this tenant's persistent profile (cookies and logins survive between tasks). */
export async function createBrowser(t: Tenant): Promise<BrowserHandle> {
  // Accounts created before Browserbase was configured get their profile on first use.
  if (!t.browserbaseContextId) await ensureProvisioned(t);
  if (!t.browserbaseContextId) throw new Error("The hosted browser is not set up on this server yet (BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID).");
  const session = await browserbase().sessions.create({
    projectId: env.browserbase.projectId(),
    keepAlive: true,
    // Long enough to wait for a code from the user's phone mid-checkout; released when a proactive task ends.
    api_timeout: Number(process.env.BROWSER_SESSION_MINUTES ?? 30) * 60,
    // A residential proxy slows every page load; off unless BROWSER_PROXY=1 (for sites that block data-center IPs).
    proxies: process.env.BROWSER_PROXY === "1",
    browserSettings: {
      context: { id: t.browserbaseContextId, persist: true },
      solveCaptchas: true,
      // Ads and trackers are a third of the bytes on a retail or news page and nothing the agent reads.
      ...(process.env.BROWSER_BLOCK_ADS === "0" ? {} : { blockAds: true }),
      viewport: { width: 1366, height: 900 },
      // Browserbase's advanced stealth (Scale plan) gets past more bot walls; BROWSER_STEALTH=1 turns it on.
      ...(process.env.BROWSER_STEALTH === "1" ? { advancedStealth: true } : {}),
    },
  });
  const live = await browserbase().sessions.debug(session.id);
  return { sessionId: session.id, connectUrl: session.connectUrl, liveViewUrl: live.debuggerFullscreenUrl };
}

/** Re-attach to a browser that is still alive; returns undefined if it has ended. */
export async function reuseBrowser(sessionId: string): Promise<BrowserHandle | undefined> {
  try {
    const s = await browserbase().sessions.retrieve(sessionId);
    if (s.status !== "RUNNING" || !s.connectUrl) return undefined;
    const live = await browserbase().sessions.debug(sessionId);
    return { sessionId, connectUrl: s.connectUrl, liveViewUrl: live.debuggerFullscreenUrl };
  } catch {
    return undefined;
  }
}

export async function releaseBrowser(sessionId: string): Promise<void> {
  try {
    await browserbase().sessions.update(sessionId, { projectId: env.browserbase.projectId(), status: "REQUEST_RELEASE" });
  } catch {
    /* already gone */
  }
}

export async function liveViewUrl(sessionId: string): Promise<string> {
  const live = await browserbase().sessions.debug(sessionId);
  return live.debuggerFullscreenUrl;
}

const liveCache = new Map<string, { at: number; url: string | null }>();

/** Live-view link for a hosted browser that is still running, cached a minute per worker (the page polls often). */
export async function liveViewIfRunning(sessionId: string): Promise<string | null> {
  const hit = liveCache.get(sessionId);
  if (hit && Date.now() - hit.at < 60_000) return hit.url;
  let url: string | null = null;
  try {
    const s = await browserbase().sessions.retrieve(sessionId);
    if (s.status === "RUNNING") url = await liveViewUrl(sessionId);
  } catch {
    url = null;
  }
  liveCache.set(sessionId, { at: Date.now(), url });
  return url;
}

/** The CDP target id of a page: stable for the life of the tab, so a session finds its own tab on every reconnect. */
export async function targetIdOf(page: Page): Promise<string | undefined> {
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const info = (await cdp.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
      return info.targetInfo?.targetId;
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

/** The page with this target id, if it is still open. */
export async function pageByTarget(pages: Page[], targetId: string | null | undefined): Promise<Page | undefined> {
  if (!targetId) return undefined;
  for (const p of pages) if ((await targetIdOf(p)) === targetId) return p;
  return undefined;
}

/** Connect over CDP and return the session's own tab, else the page whose host matches `domain`, else the most recent page. */
export async function attach(connectUrl: string, domain?: string, targetId?: string | null): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  let page: Page | undefined = await pageByTarget(pages, targetId);
  if (!page && domain) {
    const d = domain.toLowerCase();
    page = pages.find((p) => {
      try {
        const host = new URL(p.url()).hostname.toLowerCase();
        return host === d || host.endsWith(`.${d}`);
      } catch {
        return false;
      }
    });
  }
  page ??= pages[pages.length - 1] ?? (await context.newPage());
  return { browser, page };
}
