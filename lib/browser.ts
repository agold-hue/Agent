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
    proxies: true,
    browserSettings: {
      context: { id: t.browserbaseContextId, persist: true },
      solveCaptchas: true,
      viewport: { width: 1366, height: 900 },
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

/** Connect over CDP and return the page whose host matches `domain`, or the most recent page. */
export async function attach(connectUrl: string, domain?: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  let page: Page | undefined;
  if (domain) {
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
