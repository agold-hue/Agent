import type { Page } from "playwright-core";
import { attach } from "./browser.js";
import { pageText } from "./browser-tools.js";
import { findCredential, registrableDomain } from "./credentials.js";
import { env } from "./env.js";
import { recentCodes } from "./inbound.js";
import type { Tenant } from "./tenant.js";

export type LoginResult =
  | { status: "logged_in"; url: string; title: string; account: string }
  | { status: "already_logged_in"; url: string; title: string }
  | { status: "no_credentials"; domain: string }
  | { status: "needs_user"; reason: string; url: string }
  /** The site wants a code sent to the user's phone: ask the user, then call login again with `code`. */
  | { status: "needs_code"; ask: string; url: string };

/**
 * Field detection runs in the page: every visible input gets a data-login-role so the host can pick the
 * username box of the sign-in form, never a search bar. A "user" input is one typed as email/username,
 * named like one, or a text input that shares a form with a password field.
 */
const TAG_FIELDS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const attrs = (el) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.className].join(" ").toLowerCase();
  const inputs = Array.from(document.querySelectorAll("input")).filter(vis);
  for (const el of inputs) el.removeAttribute("data-login-role");
  const isSearch = (el) => el.type === "search" || el.getAttribute("role") === "searchbox" || /search|query|\\bq\\b|keyword|find/.test(attrs(el)) || !!el.closest('[role="search"], form[action*="search" i]');
  const pw = inputs.filter((el) => el.type === "password");
  for (const el of pw) el.setAttribute("data-login-role", "password");
  const userLike = (el) => el.type === "email" || el.type === "tel" || /^(username|email|tel)$/.test(el.getAttribute("autocomplete") || "") || /email|user|login|identifier|account|phone|customer/.test(attrs(el));
  const forms = new Set(pw.map((el) => el.form).filter(Boolean));
  let found = 0;
  for (const el of inputs) {
    if (el.type === "password" || el.type === "hidden" || el.type === "submit" || el.type === "checkbox" || el.type === "radio" || el.type === "button") continue;
    if (isSearch(el)) { el.setAttribute("data-login-role", "search"); continue; }
    const textual = el.type === "text" || el.type === "email" || el.type === "tel" || !el.type;
    if (!textual) continue;
    if (userLike(el) || (el.form && forms.has(el.form))) { el.setAttribute("data-login-role", "user"); found++; }
  }
  return { user: found, password: pw.length };
})()`;

/** Where the sign-in form usually lives when the home page does not show it. */
const LOGIN_PATHS = ["/login", "/signin", "/sign-in", "/account/login", "/auth/login", "/users/sign_in", "/ap/signin", "/en/login", "/my-account", "/account"];
const KNOWN_LOGIN_URLS: Record<string, string> = {
  "amazon.com": "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
  "coned.com": "https://www.coned.com/en/login",
  "nationalgridus.com": "https://www.nationalgridus.com/Default.aspx?login=true",
  "zillow.com": "https://www.zillow.com/user/acct/login/",
};

async function tagFields(page: Page): Promise<{ user: number; password: number }> {
  try {
    return (await page.evaluate(TAG_FIELDS)) as { user: number; password: number };
  } catch {
    return { user: 0, password: 0 };
  }
}

/** Get to a page that shows a sign-in form: the current page, a "Sign in" link, a known URL, or the usual paths. */
async function reachLoginForm(page: Page, domain: string): Promise<boolean> {
  const hasForm = async () => {
    const f = await tagFields(page);
    return f.password > 0 || f.user > 0;
  };
  if (await hasForm()) return true;
  const affordance = page.getByRole("link", { name: /sign ?in|log ?in|login|my account|hello, sign in/i }).or(page.getByRole("button", { name: /sign ?in|log ?in|login/i })).first();
  if ((await affordance.count().catch(() => 0)) > 0 && (await affordance.isVisible().catch(() => false))) {
    await affordance.click().catch(() => {});
    await settle(page);
    if (await hasForm()) return true;
  }
  const known = KNOWN_LOGIN_URLS[domain];
  const candidates = known ? [known, ...LOGIN_PATHS.map((p) => `https://${domain}${p}`)] : LOGIN_PATHS.map((p) => `https://${domain}${p}`);
  for (const url of candidates) {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
    if (!res || res.status() >= 400) continue;
    await settle(page, 1500);
    if (await hasForm()) return true;
  }
  return false;
}

const USER_SELECTORS = ['input[data-login-role="user"]'];
const PASS_SELECTORS = ['input[data-login-role="password"]', 'input[autocomplete="current-password"]', 'input[type="password"]'];
const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="verif" i]',
  'input[id*="verif" i]',
  'input[name*="token" i]',
  'input[inputmode="numeric"]',
];
const SUBMIT_TEXT = /^(sign in|log in|login|continue|next|submit|verify|confirm|sign in with password)$/i;
/** The page is asking how to deliver a second-factor code (text or email, "send code") rather than showing the code box. */
const MFA_CHOOSER = /verification code|security code|one-time (code|passcode|password)|verify (your identity|it'?s you)|two-step|two-factor|2fa|send (me |you )?(a |the )?code|text message|authentication code|confirm your identity/i;
/** Buttons that plainly send a code; generic Continue/Next only count once a delivery option was picked. */
const MFA_SEND = /^(send( the| me a)?( code)?|text me( a code)?|text|sms|send text( message)?)$/i;
const MFA_NEXT = /^(continue|next|submit|verify)$/i;
/** A bot check in the way (Browserbase solves most captchas on its own, given a few seconds). */
const BOT_WALL = /verify you are human|are you a robot|not a robot|captcha|access denied|unusual traffic|press and hold|checking your browser|attention required|request blocked|bot detection|security check|verify your browser|one more step/i;
/** How the user gets past a wall the automation cannot: they sign in once themselves in the hosted browser, the cookies stick. */
export const TAKEOVER = "Ask the user to sign in once themselves: Logins tab > Watch the browser opens the same browser, they log in there, and the sign-in sticks for next time. Then they say 'done' and you call login again (it will find the session signed in). One line, no apology, no explanation of bot walls.";
/** Signed in already: the page offers to sign out. */
const SIGNED_IN = /\b(sign out|log out|logout|my account|hello,)\b/i;
/** The site said no to the saved password (or locked the account); retrying will not help. */
const REJECTED = /incorrect|invalid (email|password|username|login|credentials)|doesn'?t match|does not match|not recognized|wrong password|couldn'?t sign you in|unable to sign in|account (is )?locked|too many attempts|try again later/i;

async function firstVisible(page: Page, selectors: string[]) {
  // Verification steps often render inside an iframe (card issuers, some banks): search every frame.
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

async function clickSubmit(page: Page, near?: ReturnType<Page["locator"]>) {
  // Prefer the form's own button (some sites wire "Continue" to script, where Enter does nothing useful);
  // fall back to Enter in the field.
  const scope = near ? near.locator("xpath=ancestor::form[1]") : page.locator("body");
  const scoped = (await scope.count().catch(() => 0)) > 0 ? scope : page.locator("body");
  for (const root of [scoped, page.locator("body")]) {
    const buttons = root.locator('button, input[type="submit"], [role="button"]');
    const n = await buttons.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      try {
        const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value")) || (await b.getAttribute("aria-label")) || "").trim();
        if (SUBMIT_TEXT.test(label) && (await b.isVisible())) {
          await b.click();
          return;
        }
      } catch {
        /* next */
      }
    }
  }
  if (near) await near.press("Enter").catch(() => {});
}

async function settle(page: Page, ms = 2500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
}

/** True when the page is a "how should we send your code" step. */
async function isMfaChooser(page: Page): Promise<boolean> {
  return MFA_CHOOSER.test(await pageText(page).catch(() => ""));
}

/**
 * On a "how should we send your code" step, choose the text-message option and send it, so the code
 * reaches the user's phone without a round of snapshots. Best effort; returns whether anything was clicked.
 */
async function requestTextCode(page: Page): Promise<boolean> {
  const option = page
    .getByRole("radio", { name: /text|sms|phone|mobile/i })
    .or(page.getByLabel(/text( message)?|sms|phone|mobile/i))
    .or(page.getByRole("button", { name: /text me|send (a )?text|sms|text message/i }))
    .first();
  let clicked = false;
  try {
    if ((await option.count()) > 0 && (await option.isVisible())) {
      await option.click({ timeout: 5000 });
      clicked = true;
      await page.waitForTimeout(800);
    }
  } catch {
    /* no such option; try the send button alone */
  }
  const buttons = page.locator('button, input[type="submit"], [role="button"]');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    try {
      const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value")) || (await b.getAttribute("aria-label")) || "").trim();
      if ((MFA_SEND.test(label) || (clicked && MFA_NEXT.test(label))) && (await b.isVisible())) {
        await b.click({ timeout: 5000 });
        return true;
      }
    } catch {
      /* next */
    }
  }
  return clicked;
}

async function isSignedIn(page: Page): Promise<boolean> {
  const link = page.getByRole("link", { name: /sign out|log out|logout/i }).or(page.getByRole("button", { name: /sign out|log out|logout/i })).first();
  if ((await link.count().catch(() => 0)) > 0 && (await link.isVisible().catch(() => false))) return true;
  return SIGNED_IN.test((await pageText(page).catch(() => "")).slice(0, 4000));
}

/** Give the captcha solver a chance: wait while a bot check is on the page, up to `ms`. */
async function waitOutBotWall(page: Page, ms = 25_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!BOT_WALL.test(await pageText(page).catch(() => ""))) return true;
    await page.waitForTimeout(2500);
  }
  return !BOT_WALL.test(await pageText(page).catch(() => ""));
}

async function fillOtp(page: Page, code: string) {
  const single = await firstVisible(page, OTP_SELECTORS);
  if (!single) return false;
  // Some sites split the code into one box per digit.
  const boxes = single.page().locator('input[maxlength="1"]');
  if ((await boxes.count()) >= code.length) {
    for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]);
  } else {
    await single.fill(code);
  }
  await clickSubmit(page, single);
  await settle(page, 3500);
  return true;
}

/**
 * Host-side login. The sandbox only ever learns the outcome; the password never leaves this process.
 */
export async function loginToSite(t: Tenant, opts: {
  connectUrl: string;
  domain: string;
  accountHint?: string;
  /** A code the user sent from their phone: typed into the verification field on the current page. */
  code?: string;
}): Promise<LoginResult> {
  const domain = registrableDomain(opts.domain);
  if (opts.code) return enterCode(opts.connectUrl, domain, opts.code);
  const cred = await findCredential(t, domain, opts.accountHint);
  if (!cred) return { status: "no_credentials", domain };

  const { browser, page } = await attach(opts.connectUrl, domain);
  try {
    if (!page.url().includes(domain)) {
      await page.goto(`https://${domain}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page);
    }

    // The user may have signed in themselves (a takeover after a bot wall) or the cookies still hold.
    if (await isSignedIn(page)) return { status: "already_logged_in", url: page.url(), title: await page.title().catch(() => "") };
    // Only ever type into a sign-in form. A home page's search bar is never a username field.
    if (!(await reachLoginForm(page, domain))) {
      const title = await page.title().catch(() => "");
      if (/account|orders|welcome|hello,/i.test(title) || (await isSignedIn(page))) return { status: "already_logged_in", url: page.url(), title };
      if (BOT_WALL.test(await pageText(page).catch(() => ""))) return { status: "needs_user", reason: `A bot check blocks the site before the sign-in form. ${TAKEOVER}`, url: page.url() };
      return { status: "needs_user", reason: "Could not find the sign-in form (no sign-in link, no password field on the usual login pages).", url: page.url() };
    }
    let user = await firstVisible(page, USER_SELECTORS);
    let pass = await firstVisible(page, PASS_SELECTORS);
    if (!user && !pass) return { status: "already_logged_in", url: page.url(), title: await page.title() };

    if (user && (await user.inputValue().catch(() => "")) === "") {
      await user.fill(cred.username);
    }
    if (!pass) {
      // Two-step forms: username first, then password on the next screen.
      await clickSubmit(page, user);
      await settle(page);
      await tagFields(page);
      pass = await firstVisible(page, PASS_SELECTORS);
    }
    if (!pass) {
      return { status: "needs_user", reason: "No password field appeared after entering the username (passwordless or passkey flow?).", url: page.url() };
    }
    await pass.fill(cred.password);
    await clickSubmit(page, pass);
    await settle(page, 4000);
    // A bot check after submit: the hosted browser solves most of them given a moment.
    if (BOT_WALL.test(await pageText(page).catch(() => ""))) {
      await waitOutBotWall(page);
      await settle(page, 1500);
    }
    await tagFields(page);

    // Second factor. Some sites first ask how to send the code: pick text message and send it.
    if (!(await firstVisible(page, OTP_SELECTORS)) && !(await firstVisible(page, PASS_SELECTORS)) && (await isMfaChooser(page))) {
      if (await requestTextCode(page)) {
        await settle(page, 3500);
        await tagFields(page);
      }
      if (!(await firstVisible(page, OTP_SELECTORS))) {
        return { status: "needs_code", ask: `${domain} wants to send a verification code but I could not pick the delivery option. Snapshot the page, click the text-message option and its send button, call request_code, and when the user sends the code call login again with code.`, url: page.url() };
      }
    }
    if (await firstVisible(page, OTP_SELECTORS)) {
      let code = cred.totp;
      if (!code && env.mail.configured()) {
        // Fall back to a code the user auto-forwards to their agent address; give the site a moment to send it.
        for (let attempt = 0; attempt < 6 && !code; attempt++) {
          await page.waitForTimeout(10_000);
          const found = await recentCodes(t, { senderHint: domain, sinceMinutes: 3 });
          code = found.find((f) => f.codes.length > 0)?.codes[0];
        }
      }
      if (!code) {
        // The code went to the user's phone: the page stays open on the code field.
        return { status: "needs_code", ask: `${domain} sent a verification code to the user's phone. Call request_code now (one line), and when the user sends it call login again with code.`, url: page.url() };
      }
      await fillOtp(page, code);
    }

    await tagFields(page);
    if (await firstVisible(page, PASS_SELECTORS)) {
      const text = await pageText(page).catch(() => "");
      if (REJECTED.test(text)) {
        return { status: "needs_user", reason: "The site rejected the saved password (it says the login is wrong or the account is locked). Do not retry; tell the user in one line to check this login under Settings > Logins.", url: page.url() };
      }
      if (BOT_WALL.test(text)) return { status: "needs_user", reason: `The site's bot check rejected the automated sign-in. Do not retry. ${TAKEOVER}`, url: page.url() };
      return { status: "needs_user", reason: `Password form is still showing after submit; the site may have shown a challenge. Take one screenshot; if it is a bot check or the same form, do not retry. ${TAKEOVER}`, url: page.url() };
    }
    return { status: "logged_in", url: page.url(), title: await page.title(), account: cred.username };
  } finally {
    // Disconnect only; the hosted browser keeps running for the sandbox.
    await browser.close().catch(() => {});
  }
}

/** Type a code the user relayed into whatever verification field is showing (sign-in or card verification). */
export async function enterCode(connectUrl: string, domain: string, code: string): Promise<LoginResult> {
  const { browser, page } = await attach(connectUrl, domain);
  try {
    const clean = code.replace(/[^0-9a-z]/gi, "");
    if (!clean) return { status: "needs_user", reason: "The code was empty after removing spaces and punctuation.", url: page.url() };
    if (!(await fillOtp(page, clean))) {
      return { status: "needs_user", reason: "No verification-code field is showing right now. Snapshot the page; the step may have expired (request a new code) or already passed.", url: page.url() };
    }
    await tagFields(page);
    if (await firstVisible(page, OTP_SELECTORS)) {
      return { status: "needs_user", reason: "The code field is still showing; the site may have rejected the code (expired or mistyped). Ask the user for a fresh one.", url: page.url() };
    }
    return { status: "logged_in", url: page.url(), title: await page.title(), account: "code accepted" };
  } finally {
    await browser.close().catch(() => {});
  }
}
