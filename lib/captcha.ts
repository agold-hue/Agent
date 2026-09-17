import type { Frame, Page } from "playwright-core";

/**
 * Bot checks, handled in the order that costs least.
 *
 * 1. Recognise what is actually in the way (Cloudflare interstitial, Turnstile, reCAPTCHA v2/v3,
 *    hCaptcha, a press-and-hold, a plain "are you human" wall) instead of guessing.
 * 2. Wait: most of them clear themselves. Cloudflare's interstitial passes in a few seconds, and the
 *    hosted browser solves many captchas on its own (Browserbase announces this on the console), so
 *    the cheapest correct move is to watch for the signal rather than click anything.
 * 3. Click the checkbox: reCAPTCHA v2 and hCaptcha anchors are in an iframe and are often all that is
 *    asked for. Turnstile's "verify you are human" box is the same.
 * 4. Hand it to a solving service if one is configured (any 2Captcha-compatible endpoint), then put
 *    the token back into the page the way the site expects and submit.
 * 5. Hold the button, when that is what is being asked: a curved approach, a few seconds of contact
 *    with a hand's tremor, one release. No service can do this one, and a second try scores against us.
 * 6. Give up honestly and hand the live view to the user: one sign-in by hand beats twenty minutes of
 *    a model fighting a wall it cannot pass.
 *
 * Every step verifies afterwards, so "solved" always means the challenge is really gone.
 */

export type CaptchaKind = "none" | "cloudflare" | "turnstile" | "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "press_hold" | "unknown";

export interface CaptchaState {
  kind: CaptchaKind;
  /** What the page says, for the user-facing line when we have to hand over. */
  evidence: string;
  /** The site key, when we found one (needed by a solving service). */
  siteKey?: string;
  frameUrl?: string;
}

const WALL_TEXT =
  /verify (you are|you're) human|are you a robot|i'?m not a robot|press (and|&) hold|checking your browser|just a moment|attention required|unusual traffic|security check|verify your browser|complete the security check|confirm you are human|hcaptcha|recaptcha/i;

/** What is in the way, read from the DOM of every frame (challenges always live in an iframe). */
export async function detectCaptcha(page: Page): Promise<CaptchaState> {
  const probe = `(() => {
    const out = { widgets: [], text: (document.body ? document.body.innerText : "").slice(0, 1500), title: document.title, url: location.href };
    const add = (kind, el) => out.widgets.push({ kind, key: (el && (el.getAttribute("data-sitekey") || el.getAttribute("data-site-key"))) || "" });
    for (const el of document.querySelectorAll(".g-recaptcha, [data-sitekey]")) add("recaptcha_v2", el);
    for (const el of document.querySelectorAll(".h-captcha")) add("hcaptcha", el);
    for (const el of document.querySelectorAll(".cf-turnstile, [data-callback][data-sitekey]")) add("turnstile", el);
    for (const f of document.querySelectorAll("iframe")) {
      const src = f.src || "";
      if (/recaptcha\\/api2\\/(anchor|bframe)/.test(src)) add("recaptcha_v2", f);
      else if (/hcaptcha\\.com/.test(src)) add("hcaptcha", f);
      else if (/challenges\\.cloudflare\\.com/.test(src)) add("turnstile", f);
    }
    if (document.querySelector('textarea[name="g-recaptcha-response"]')) add("recaptcha_v2", null);
    if (window.grecaptcha && !out.widgets.length) add("recaptcha_v3", null);
    return out;
  })()`;
  type Probe = { widgets: Array<{ kind: string; key: string }>; text: string; title: string; url: string };
  let seen: Probe | null = null;
  const keys = new Map<string, string>();
  for (const frame of page.frames()) {
    const data = (await frame.evaluate(probe).catch(() => null)) as Probe | null;
    if (!data) continue;
    if (frame === page.mainFrame()) seen = data;
    for (const w of data.widgets) if (w.key && !keys.has(w.kind)) keys.set(w.kind, w.key);
    // A frame that is itself the challenge names its kind in its URL, with the site key in the query.
    const url = frame.url();
    const m = url.match(/[?&]k=([^&]+)/) ?? url.match(/[?&]sitekey=([^&]+)/);
    if (/recaptcha\/api2\/(anchor|bframe)/.test(url)) keys.set("recaptcha_v2", decodeURIComponent(m?.[1] ?? keys.get("recaptcha_v2") ?? ""));
    else if (/hcaptcha\.com/.test(url)) keys.set("hcaptcha", decodeURIComponent(m?.[1] ?? keys.get("hcaptcha") ?? ""));
    else if (/challenges\.cloudflare\.com/.test(url)) keys.set("turnstile", decodeURIComponent(m?.[1] ?? keys.get("turnstile") ?? ""));
  }
  const text = `${seen?.title ?? ""}\n${seen?.text ?? ""}`;
  const kind = classify(text, new Set(keys.keys()));
  return {
    kind,
    evidence: (text.match(WALL_TEXT)?.[0] ?? text.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "").trim(),
    siteKey: keys.get(kind) || undefined,
    frameUrl: seen?.url,
  };
}

/**
 * What kind of wall this is, from the page's own words and the widgets found in its frames. Pure, so
 * it can be tested without a browser.
 *
 * Press-and-hold is checked BEFORE the widget kinds: PerimeterX renders its button inside a frame
 * that also carries a reCAPTCHA-shaped key, and treating that as a reCAPTCHA sent it to the solving
 * service, which has nothing to solve and charges for the attempt.
 */
export function classify(text: string, widgets: Set<string>): CaptchaKind {
  if (/press (and|&) hold/i.test(text)) return "press_hold";
  if (widgets.has("recaptcha_v2")) return "recaptcha_v2";
  if (widgets.has("hcaptcha")) return "hcaptcha";
  if (widgets.has("turnstile")) return "turnstile";
  if (/just a moment|checking your browser|attention required|cf-browser-verification|enable javascript and cookies/i.test(text)) return "cloudflare";
  if (widgets.has("recaptcha_v3")) return "recaptcha_v3";
  return WALL_TEXT.test(text) ? "unknown" : "none";
}

export interface SolveResult {
  status: "solved" | "cleared" | "needs_user" | "no_captcha";
  kind: CaptchaKind;
  how: string;
  detail?: string;
}

/**
 * Get past whatever is in the way, or say plainly that a person has to. Never loops: each strategy is
 * tried once, in cost order, and the page is re-read after each one.
 */
export async function solveCaptcha(page: Page, opts: { maxMs?: number } = {}): Promise<SolveResult> {
  const budget = opts.maxMs ?? Number(process.env.CAPTCHA_MAX_MS ?? 60_000);
  const deadline = Date.now() + budget;
  const first = await detectCaptcha(page);
  if (first.kind === "none") return { status: "no_captcha", kind: "none", how: "nothing in the way" };

  // 1. The hosted browser solves many of these itself; it announces start and finish on the console.
  const auto = await waitForHostedSolver(page, Math.min(20_000, deadline - Date.now()));
  if (auto && (await gone(page))) return { status: "solved", kind: first.kind, how: "the hosted browser solved it" };

  // 2. Cloudflare's interstitial and Turnstile clear themselves given a few seconds.
  if (first.kind === "cloudflare" || first.kind === "turnstile") {
    if (await waitUntilGone(page, Math.min(15_000, deadline - Date.now()))) return { status: "cleared", kind: first.kind, how: "waited for the interstitial to pass" };
  }

  // 3. The checkbox, wherever it lives.
  if (await clickCheckbox(page)) {
    if (await waitUntilGone(page, Math.min(12_000, deadline - Date.now()))) return { status: "solved", kind: first.kind, how: "ticked the 'I am human' box" };
  }

  // 4. A solving service, when one is configured.
  if (solverConfigured() && first.siteKey && (first.kind === "recaptcha_v2" || first.kind === "hcaptcha" || first.kind === "turnstile")) {
    try {
      const token = await solveWithService(first.kind, first.siteKey, page.url(), Math.max(20_000, deadline - Date.now()));
      if (token) {
        await injectToken(page, first.kind, token);
        if (await waitUntilGone(page, 15_000)) return { status: "solved", kind: first.kind, how: "solved by the captcha service" };
        return { status: "needs_user", kind: first.kind, how: "the service returned a token but the page did not accept it", detail: first.evidence };
      }
    } catch (err) {
      return { status: "needs_user", kind: first.kind, how: `the captcha service failed: ${err instanceof Error ? err.message : String(err)}`, detail: first.evidence };
    }
  }

  // 5. Press-and-hold. No site key exists, so no service can help: the only thing to try is to do it,
  //    the way a hand does. Works often enough to be worth ten seconds, never worth a second attempt.
  if (first.kind === "press_hold" && (await pressAndHold(page, deadline - Date.now()))) {
    if (await waitUntilGone(page, Math.min(10_000, Math.max(4000, deadline - Date.now())))) return { status: "solved", kind: first.kind, how: "held the button" };
  }

  const still = await detectCaptcha(page);
  if (still.kind === "none") return { status: "cleared", kind: first.kind, how: "it cleared while we worked" };
  return { status: "needs_user", kind: still.kind, how: "this one needs a person", detail: still.evidence || first.evidence };
}

/** Is the wall gone? */
async function gone(page: Page): Promise<boolean> {
  return (await detectCaptcha(page)).kind === "none";
}

async function waitUntilGone(page: Page, ms: number): Promise<boolean> {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {
    await page.waitForTimeout(1500);
    if (await gone(page)) return true;
  }
  return false;
}

/**
 * Browserbase's own solver posts `browserbase-solving-started` / `browserbase-solving-finished` on the
 * page console. Waiting for the finish is both faster and more reliable than polling the DOM.
 */
async function waitForHostedSolver(page: Page, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      page.off("console", onConsole);
      resolve(false);
    }, ms);
    const onConsole = (msg: { text: () => string }) => {
      if (!/browserbase-solving-finished/i.test(msg.text())) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      page.off("console", onConsole);
      resolve(true);
    };
    page.on("console", onConsole);
  });
}

const CHECKBOX_SELECTORS = ["#recaptcha-anchor", ".recaptcha-checkbox-border", "#checkbox", 'input[type="checkbox"]#checkbox', ".cb-i", 'input[type="checkbox"]'];

/** Tick the "I'm not a robot" box in whichever frame holds it. */
async function clickCheckbox(page: Page): Promise<boolean> {
  const frames: Frame[] = page.frames().filter((f) => /recaptcha\/api2\/anchor|hcaptcha\.com|challenges\.cloudflare\.com/.test(f.url()));
  for (const frame of frames.length ? frames : page.frames()) {
    for (const sel of CHECKBOX_SELECTORS) {
      const loc = frame.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      // A real pointer path: some widgets score the approach, not just the click.
      await loc.hover({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150 + Math.random() * 350);
      const ok = await loc.click({ timeout: 5000 }).then(
        () => true,
        () => false,
      );
      if (ok) {
        await page.waitForTimeout(2000);
        return true;
      }
    }
  }
  return false;
}

/** Where a press-and-hold button lives: PerimeterX/HUMAN's own container, or whatever says the words. */
const HOLD_SELECTORS = ["#px-captcha", "[id^=px-captcha]", "[class*=px-captcha]", "#challenge-container", '[aria-label*="press" i]'];

/**
 * The press-and-hold challenge (PerimeterX/HUMAN, AWS WAF). There is no token to fetch and nothing a
 * solving service can do with it: the check is whether a human hand held the button, judged from the
 * pointer trail, the hold and the release.
 *
 * So we do it properly rather than firing a synthetic click: approach the button along a curve
 * (a straight jump from 0,0 is the cheapest tell there is), press, hold for the advertised few
 * seconds with the small tremor a hand has, then release. Once. A second attempt on the same page
 * raises the score against us, so a failure goes to the user instead.
 *
 * It is genuinely unreliable — the button is only the last of many signals — which is why the
 * takeover line stays the fallback. `holdPlan` is pure so the timing can be tested.
 */
export function holdPlan(budgetMs: number, rand: () => number = Math.random): { holdMs: number; steps: number } {
  const wanted = Number(process.env.CAPTCHA_HOLD_MS ?? 0) || Math.round(7000 + rand() * 4000);
  const holdMs = Math.max(2500, Math.min(wanted, Math.max(2500, budgetMs - 4000)));
  return { holdMs, steps: Math.max(6, Math.round(holdMs / 400)) };
}

async function pressAndHold(page: Page, budgetMs: number): Promise<boolean> {
  if (process.env.CAPTCHA_HOLD === "off" || budgetMs < 6000) return false;
  const target = await holdTarget(page);
  if (!target) return false;
  const { x, y, width, height } = target;
  const cx = x + width / 2;
  const cy = y + height / 2;
  try {
    // Approach: a few points along a curve into the button, not a teleport onto its centre.
    await page.mouse.move(cx - 140 + Math.random() * 60, cy + 90 + Math.random() * 40);
    for (let i = 1; i <= 8; i++) {
      const p = i / 8;
      await page.mouse.move(cx - 140 * (1 - p) + (Math.random() - 0.5) * 6, cy + 90 * (1 - p) * (1 - p) + (Math.random() - 0.5) * 6);
      await page.waitForTimeout(20 + Math.random() * 35);
    }
    await page.waitForTimeout(120 + Math.random() * 180);
    await page.mouse.down();
    const { holdMs, steps } = holdPlan(budgetMs);
    // A held finger is not perfectly still: a pixel of drift keeps the pointer trail alive.
    for (let i = 0; i < steps; i++) {
      await page.waitForTimeout(holdMs / steps);
      await page.mouse.move(cx + (Math.random() - 0.5) * 2.5, cy + (Math.random() - 0.5) * 2.5);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);
    return true;
  } catch {
    await page.mouse.up().catch(() => {});
    return false;
  }
}

/** The button's box, in page coordinates, from whichever frame holds it. */
async function holdTarget(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (const frame of page.frames()) {
    for (const sel of HOLD_SELECTORS) {
      const loc = frame.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 20 && box.height > 10) return box;
    }
    const byText = frame.getByText(/press (and|&) hold/i).first();
    if ((await byText.count().catch(() => 0)) > 0) {
      const box = await byText.boundingBox().catch(() => null);
      if (box && box.width > 20 && box.height > 10) return box;
    }
  }
  return null;
}

export function solverConfigured(): boolean {
  return !!process.env.CAPTCHA_API_KEY;
}

const SOLVER_BASE = () => (process.env.CAPTCHA_API_URL || "https://2captcha.com").replace(/\/$/, "");

/**
 * Any 2Captcha-compatible service (2Captcha, CapSolver's compat endpoint, Anti-Captcha proxies):
 * submit the site key, poll for the answer. Configured with CAPTCHA_API_KEY (and CAPTCHA_API_URL for
 * another provider). Without a key this is skipped entirely and the user is asked instead.
 */
async function solveWithService(kind: CaptchaKind, siteKey: string, pageUrl: string, budgetMs: number): Promise<string | null> {
  const key = process.env.CAPTCHA_API_KEY!;
  const method = kind === "hcaptcha" ? "hcaptcha" : kind === "turnstile" ? "turnstile" : "userrecaptcha";
  const submit = new URL(`${SOLVER_BASE()}/in.php`);
  submit.searchParams.set("key", key);
  submit.searchParams.set("method", method);
  submit.searchParams.set(method === "userrecaptcha" ? "googlekey" : "sitekey", siteKey);
  submit.searchParams.set("pageurl", pageUrl);
  submit.searchParams.set("json", "1");
  const started = await fetch(submit, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json() as Promise<{ status: number; request: string }>);
  if (started.status !== 1) throw new Error(started.request || "submit rejected");
  const id = started.request;
  const until = Date.now() + Math.max(30_000, budgetMs);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = new URL(`${SOLVER_BASE()}/res.php`);
    res.searchParams.set("key", key);
    res.searchParams.set("action", "get");
    res.searchParams.set("id", id);
    res.searchParams.set("json", "1");
    const out = (await fetch(res, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as { status: number; request: string };
    if (out.status === 1) return out.request;
    if (out.request && out.request !== "CAPCHA_NOT_READY" && out.request !== "CAPTCHA_NOT_READY") throw new Error(out.request);
  }
  return null;
}

/** Put the solved token where the page looks for it and let the site's own callback run. */
async function injectToken(page: Page, kind: CaptchaKind, token: string): Promise<void> {
  const script = `(token, kind) => {
    const setAll = (sel) => { for (const el of document.querySelectorAll(sel)) { el.value = token; el.innerHTML = token; el.style.display = ""; } };
    if (kind === "hcaptcha") { setAll('[name="h-captcha-response"]'); setAll('[name="g-recaptcha-response"]'); }
    else if (kind === "turnstile") { setAll('[name="cf-turnstile-response"]'); setAll('[name="g-recaptcha-response"]'); }
    else setAll('[name="g-recaptcha-response"]');
    // Run the site's own callback so its form knows the challenge passed.
    try {
      const cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        for (const client of Object.values(cfg.clients)) {
          const walk = (o, depth) => {
            if (!o || depth > 5) return;
            for (const v of Object.values(o)) {
              if (typeof v === "function" && v.length === 1) { try { v(token); } catch {} }
              else if (v && typeof v === "object") walk(v, depth + 1);
            }
          };
          walk(client, 0);
        }
      }
    } catch {}
    try { if (typeof window.onCaptchaSuccess === "function") window.onCaptchaSuccess(token); } catch {}
  }`;
  await page.evaluate(`(${script})(${JSON.stringify(token)}, ${JSON.stringify(kind)})`).catch(() => {});
  // Many forms only submit once the token is in place.
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if ((await submit.count().catch(() => 0)) > 0 && (await submit.isVisible().catch(() => false))) await submit.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

/** The one line the user reads when a person really is needed. Never mentions "captcha" twice. */
export function handoverLine(state: { kind: CaptchaKind; detail?: string }): string {
  if (state.kind === "press_hold") return "The site wants a press-and-hold check and it didn't accept mine. Open the Logins tab › Watch the browser, hold the button once yourself, and tell me \"done\" — it sticks, and I'll carry on from there.";
  return "The site's bot check won't let me through. Open the Logins tab › Watch the browser, clear it once yourself (it sticks), then say \"done\" and I'll pick the task back up.";
}
