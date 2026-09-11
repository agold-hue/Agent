import type { Page } from "playwright-core";
import { attach } from "./browser.js";
import { findCredential, registrableDomain } from "./onepassword.js";
import { findRecentCodes } from "./gmail.js";

export type LoginResult =
  | { status: "logged_in"; url: string; title: string; account: string }
  | { status: "already_logged_in"; url: string; title: string }
  | { status: "no_credentials"; domain: string }
  | { status: "needs_user"; reason: string; url: string };

const USER_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[id*="login" i]',
  'input[name="identifier"]',
  'input[type="text"]',
];
const PASS_SELECTORS = ['input[autocomplete="current-password"]', 'input[type="password"]'];
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
  if (near) {
    try {
      await near.press("Enter");
      return;
    } catch {
      /* fall through */
    }
  }
  const buttons = page.locator('button, input[type="submit"], [role="button"]');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    try {
      const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value")) || "").trim();
      if (SUBMIT_TEXT.test(label) && (await b.isVisible())) {
        await b.click();
        return;
      }
    } catch {
      /* next */
    }
  }
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
export async function loginToSite(opts: {
  connectUrl: string;
  domain: string;
  accountHint?: string;
}): Promise<LoginResult> {
  const domain = registrableDomain(opts.domain);
  const cred = await findCredential(domain, opts.accountHint);
  if (!cred) return { status: "no_credentials", domain };

  const { browser, page } = await attach(opts.connectUrl, domain);
  try {
    if (!page.url().includes(domain)) {
      await page.goto(`https://${domain}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page);
    }

    let user = await firstVisible(page, USER_SELECTORS);
    let pass = await firstVisible(page, PASS_SELECTORS);
    if (!user && !pass) {
      // Try the obvious "sign in" affordance once before giving up.
      const signIn = page.getByRole("link", { name: /sign in|log in|login/i }).first();
      if ((await signIn.count()) > 0 && (await signIn.isVisible().catch(() => false))) {
        await signIn.click();
        await settle(page);
        user = await firstVisible(page, USER_SELECTORS);
        pass = await firstVisible(page, PASS_SELECTORS);
      }
    }
    if (!user && !pass) return { status: "already_logged_in", url: page.url(), title: await page.title() };

    if (user && (await user.inputValue().catch(() => "")) === "") {
      await user.fill(cred.username);
    }
    if (!pass) {
      // Two-step forms: username first, then password on the next screen.
      await clickSubmit(page, user);
      await settle(page);
      pass = await firstVisible(page, PASS_SELECTORS);
    }
    if (!pass) {
      return { status: "needs_user", reason: "No password field appeared after entering the username (passwordless or passkey flow?).", url: page.url() };
    }
    await pass.fill(cred.password);
    await clickSubmit(page, pass);
    await settle(page, 4000);

    // Second factor.
    if (await firstVisible(page, OTP_SELECTORS)) {
      let code = cred.totp;
      if (!code) {
        // Fall back to a code emailed to the user; give the site a moment to send it.
        for (let attempt = 0; attempt < 6 && !code; attempt++) {
          await page.waitForTimeout(10_000);
          const found = await findRecentCodes({ senderHint: domain, sinceMinutes: 3 });
          code = found.find((f) => f.codes.length > 0)?.codes[0];
        }
      }
      if (!code) {
        return { status: "needs_user", reason: "Site asked for a verification code that is not in the password manager or email (SMS?).", url: page.url() };
      }
      await fillOtp(page, code);
    }

    if (await firstVisible(page, PASS_SELECTORS)) {
      return { status: "needs_user", reason: "Password form is still showing after submit; the site may have rejected the login or shown a challenge.", url: page.url() };
    }
    return { status: "logged_in", url: page.url(), title: await page.title(), account: cred.username };
  } finally {
    // Disconnect only; the hosted browser keeps running for the sandbox.
    await browser.close().catch(() => {});
  }
}
