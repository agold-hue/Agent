import type { Page } from "playwright-core";
import { attach } from "./browser.js";
import { findCredential, registrableDomain } from "./credentials.js";
import { recentCodes } from "./inbound.js";
import type { Tenant } from "./tenant.js";

export type LoginResult =
  | { status: "logged_in"; url: string; title: string; account: string }
  | { status: "already_logged_in"; url: string; title: string }
  | { status: "no_credentials"; domain: string }
  | { status: "needs_user"; reason: string; url: string };

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

async function firstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      /* try next */
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

async function fillOtp(page: Page, code: string) {
  const single = await firstVisible(page, OTP_SELECTORS);
  if (!single) return false;
  // Some sites split the code into one box per digit.
  const boxes = page.locator('input[maxlength="1"]');
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
}): Promise<LoginResult> {
  const domain = registrableDomain(opts.domain);
  const cred = await findCredential(t, domain, opts.accountHint);
  if (!cred) return { status: "no_credentials", domain };

  const { browser, page } = await attach(opts.connectUrl, domain);
  try {
    if (!page.url().includes(domain)) {
      await page.goto(`https://${domain}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page);
    }

    // Only ever type into a sign-in form. A home page's search bar is never a username field.
    if (!(await reachLoginForm(page, domain))) {
      const title = await page.title().catch(() => "");
      if (/account|orders|welcome|hello,/i.test(title)) return { status: "already_logged_in", url: page.url(), title };
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
    await tagFields(page);

    // Second factor.
    if (await firstVisible(page, OTP_SELECTORS)) {
      let code = cred.totp;
      if (!code) {
        // Fall back to a code the user auto-forwards to their agent address; give the site a moment to send it.
        for (let attempt = 0; attempt < 6 && !code; attempt++) {
          await page.waitForTimeout(10_000);
          const found = await recentCodes(t, { senderHint: domain, sinceMinutes: 3 });
          code = found.find((f) => f.codes.length > 0)?.codes[0];
        }
      }
      if (!code) {
        return { status: "needs_user", reason: "Site asked for a verification code that is not in the vault (add the authenticator seed) or in forwarded mail (SMS?).", url: page.url() };
      }
      await fillOtp(page, code);
    }

    await tagFields(page);
    if (await firstVisible(page, PASS_SELECTORS)) {
      return { status: "needs_user", reason: "Password form is still showing after submit; the site may have rejected the login or shown a challenge.", url: page.url() };
    }
    return { status: "logged_in", url: page.url(), title: await page.title(), account: cred.username };
  } finally {
    // Disconnect only; the hosted browser keeps running for the sandbox.
    await browser.close().catch(() => {});
  }
}
