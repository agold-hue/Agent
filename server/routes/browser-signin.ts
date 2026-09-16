import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { attach, browserbase, createBrowser, reuseBrowser } from "../../lib/browser.js";
import { registrableDomain } from "../../lib/credentials.js";
import { env } from "../../lib/env.js";
import { KNOWN_LOGIN_URLS } from "../../lib/login.js";
import { otherActiveBrowsers } from "../../lib/sessions.js";

/**
 * "Sign in to a site": POST { domain } opens the site's sign-in page in a tab of the customer's hosted
 * browser (the one every task shares) and returns the live view for that tab. The user signs in there
 * once, by hand, with their own phone for any code; the cookies persist in the browser profile, so
 * from then on every task finds the site signed in and no code is ever asked of the agent. This is
 * the route past bot checks and device codes that block automated sign-ins.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  if (!env.browserbase.configured()) return res.status(501).json({ error: "the hosted browser is not set up on this server" });
  const raw = String((req.body as { domain?: unknown })?.domain ?? "").trim();
  if (!raw) return res.status(400).json({ error: "domain required" });
  const domain = registrableDomain(raw.includes(".") ? raw : `${raw}.com`);
  const url = KNOWN_LOGIN_URLS[domain] ?? `https://${domain}`;

  // The browser every task shares, or a fresh one that they will share from now on.
  let handle;
  for (const id of await otherActiveBrowsers(t.id, "").catch(() => [] as string[])) {
    handle = await reuseBrowser(id);
    if (handle) break;
  }
  handle ??= await createBrowser(t);

  const { browser, page } = await attach(handle.connectUrl);
  try {
    const tab = page.url() === "about:blank" ? page : await page.context().newPage();
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await tab.bringToFront().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  // The live view of that tab, so the user lands on the sign-in page rather than another task's page.
  let liveView = handle.liveViewUrl;
  try {
    const dbg = (await browserbase().sessions.debug(handle.sessionId)) as { debuggerFullscreenUrl?: string; pages?: Array<{ url?: string; debuggerFullscreenUrl?: string }> };
    const own = dbg.pages?.find((p) => (p.url ?? "").includes(domain));
    liveView = own?.debuggerFullscreenUrl ?? dbg.debuggerFullscreenUrl ?? liveView;
  } catch {
    /* the session-level view still works */
  }
  return res.status(200).json({ domain, live_view_url: liveView, browser_session_id: handle.sessionId });
}
