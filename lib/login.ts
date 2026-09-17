import type { Page } from "playwright-core";
import { attach } from "./browser.js";
import { pageText } from "./browser-tools.js";
import { describeLoginProfile, findCredential, type LoginObservation, type LoginProfile, loginProfile, registrableDomain, rememberLogin } from "./credentials.js";
import { env } from "./env.js";
import { recentCodes } from "./inbound.js";
import type { Tenant } from "./tenant.js";

export type LoginResult =
  | { status: "logged_in"; url: string; title: string; account: string; remembered?: string }
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
export const KNOWN_LOGIN_URLS: Record<string, string> = {
  "chase.com": "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline",
  "amazon.com": "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
  "coned.com": "https://www.coned.com/en/login",
  "nationalgridus.com": "https://www.nationalgridus.com/Default.aspx?login=true",
  "zillow.com": "https://www.zillow.com/user/acct/login/",
};

/** Tag the sign-in fields in every frame (some banks embed the form) and say whether the form sits in one. */
async function tagFields(page: Page): Promise<{ user: number; password: number; framed: boolean }> {
  let user = 0;
  let password = 0;
  let framed = false;
  for (const frame of page.frames()) {
    const f = (await frame.evaluate(TAG_FIELDS).catch(() => undefined)) as { user: number; password: number } | undefined;
    if (!f) continue;
    if (frame !== page.mainFrame() && (f.user > 0 || f.password > 0)) framed = true;
    user += f.user;
    password += f.password;
  }
  return { user, password, framed };
}

/** How long the hunt for a sign-in form may take across the usual paths before it gives up. */
const SCAN_BUDGET_MS = Number(process.env.LOGIN_SCAN_MS ?? 30_000);
const SCAN_GOTO_MS = 8_000;

/** The pages to try for the sign-in form, best first: where it was last time, the known URL, the usual paths. */
export function loginCandidates(domain: string, profile?: LoginProfile): string[] {
  const out = [profile?.login_url, KNOWN_LOGIN_URLS[domain], ...LOGIN_PATHS.map((p) => `https://${domain}${p}`)].filter((u): u is string => !!u);
  return [...new Set(out)];
}

/**
 * Get to a page that shows a sign-in form: the current page, the page that had it last time, a
 * "Sign in" link, a known URL, or the usual paths, within a time budget. A bot wall on any of them
 * ends the hunt: every further path would hit the same wall.
 */
async function reachLoginForm(page: Page, domain: string, profile?: LoginProfile): Promise<{ found: boolean; wall?: boolean; framed?: boolean }> {
  let framed = false;
  const hasForm = async () => {
    const f = await tagFields(page);
    framed = f.framed;
    return f.password > 0 || f.user > 0;
  };
  const walled = async () => BOT_WALL.test(await pageText(page).catch(() => ""));
  if (await hasForm()) return { found: true, framed };
  const started = Date.now();
  const tryUrl = async (url: string): Promise<{ found: boolean; wall?: boolean; framed?: boolean } | undefined> => {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: SCAN_GOTO_MS }).catch(() => null);
    if (!res || res.status() >= 400) return undefined;
    await settle(page, 1500);
    if (await hasForm()) return { found: true, framed };
    if (await walled()) return { found: false, wall: true };
    return undefined;
  };
  // Where the form was last time, before anything else (unless that is the page already showing).
  if (profile?.login_url && page.url() !== profile.login_url) {
    const r = await tryUrl(profile.login_url);
    if (r) return r;
  }
  const affordance = page.getByRole("link", { name: /sign ?in|log ?in|login|my account|hello, sign in/i }).or(page.getByRole("button", { name: /sign ?in|log ?in|login/i })).first();
  if ((await affordance.count().catch(() => 0)) > 0 && (await affordance.isVisible().catch(() => false))) {
    await affordance.click().catch(() => {});
    await settle(page);
    if (await hasForm()) return { found: true, framed };
    if (await walled()) return { found: false, wall: true };
  }
  for (const url of loginCandidates(domain, profile)) {
    if (url === profile?.login_url) continue;
    if (Date.now() - started > SCAN_BUDGET_MS) break;
    const r = await tryUrl(url);
    if (r) return r;
  }
  return { found: false, wall: await walled() };
}

/** A masked phone number or address on the page: "(***) ***-1234", "ending in 1234", "j***@gmail.com". */
const MASKED_PHONE = /\(?[*x]{3}\)?[ -]?[*x]{3}[ -]?\d{4}|\b(ending|ends) (in|with) \d{4}\b|\b\d{3}[ -]?[*x]{3}[ -]?\d{4}\b/i;
const MASKED_EMAIL = /\S[*x]{2,}\S*@|@[*x]{2,}/i;

/**
 * Where the site says the code went, from its own words on the code screen; the profile's memory
 * when the page does not say. A texted code never reaches the forwarded mail, so knowing this is
 * the difference between asking the user at once and waiting a minute for nothing.
 */
export function codeChannel(text: string, remembered?: LoginProfile["code"]): "text" | "email" | "unknown" {
  const t = text.slice(0, 6000);
  const sentence = t.match(/\b(sent|texted|emailed|text(ed)? you|e-?mailed you)\b[^.\n]{0,120}/i)?.[0] ?? "";
  const phoneWords = /\b(text(ed)?( message)?|sms|phone|mobile|cell)\b/i;
  const emailWords = /\b(e-?mail(ed)?|inbox)\b/i;
  const phone = (sentence && phoneWords.test(sentence)) || MASKED_PHONE.test(t);
  const email = (sentence && emailWords.test(sentence)) || MASKED_EMAIL.test(t);
  if (phone && !email) return "text";
  if (email && !phone) return "email";
  if (!phone && !email) {
    // No sentence about the sending: the words on the screen, when only one kind is there.
    const p = phoneWords.test(t);
    const e = emailWords.test(t);
    if (p && !e) return "text";
    if (e && !p) return "email";
  }
  return remembered === "text" || remembered === "email" ? remembered : "unknown";
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
/** After a code, the site asks for another one (Uber: a texted code, then an emailed one). */
const NEXT_CODE = /(sent|emailed|texted|check)\b[^.\n]{0,60}\b(email|e-mail|inbox|phone|text|sms)\b|enter the (\d-digit )?code (we |that was )?(sent|emailed|texted)|verify your (email|phone)/i;
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
  /** The email or phone the user gave in chat for a site with nothing in the vault: a passwordless (texted code) sign-in is attempted. */
  username?: string;
  /** A code the user sent from their phone: typed into the verification field on the current page. */
  code?: string;
  /** The session's own tab in the shared browser. */
  targetId?: string | null;
}): Promise<LoginResult> {
  const domain = registrableDomain(opts.domain);
  // A vault record, or the identifier the user just gave (Uber, Lyft and most apps sign in with a phone
  // number and a texted code; no password exists). An empty password means passwordless.
  const cred = (await findCredential(t, domain, opts.accountHint)) ?? (opts.username ? { id: undefined, username: opts.username.trim(), password: "", totp: undefined } : undefined);
  // What the host learned the last times: kept on the vault row, so a login from chat alone has none.
  const profile = cred?.id ? await loginProfile(cred.id).catch(() => undefined) : undefined;
  const remember = async (seen: LoginObservation): Promise<string | undefined> => (cred?.id ? describeLoginProfile(await rememberLogin(cred.id, seen).catch(() => undefined)) : undefined);
  if (opts.code) {
    const r = await enterCode(opts.connectUrl, domain, opts.code, opts.targetId);
    // The user relayed the code, so next time it is asked for at once (unless the host knows it is emailed).
    if (r.status === "logged_in") return { ...r, remembered: await remember({ ok: true, code: profile?.code === "email" || profile?.code === "totp" ? profile.code : "text" }) };
    return r;
  }
  if (!cred) return { status: "no_credentials", domain };

  const started = Date.now();
  const { browser, page } = await attach(opts.connectUrl, domain, opts.targetId);
  try {
    if (!page.url().includes(domain)) {
      // Straight to the page that showed the form last time (or the known one): the home page and its "Sign in" click are skipped.
      await page.goto(profile?.login_url ?? KNOWN_LOGIN_URLS[domain] ?? `https://${domain}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page);
    }

    // The user may have signed in themselves (a takeover after a bot wall) or the cookies still hold.
    if (await isSignedIn(page)) return { status: "already_logged_in", url: page.url(), title: await page.title().catch(() => "") };
    // Only ever type into a sign-in form. A home page's search bar is never a username field.
    const reached = await reachLoginForm(page, domain, profile);
    if (!reached.found) {
      const title = await page.title().catch(() => "");
      if (/account|orders|welcome|hello,/i.test(title) || (await isSignedIn(page))) return { status: "already_logged_in", url: page.url(), title };
      if (reached.wall) {
        await remember({ wall: true, ok: false });
        return { status: "needs_user", reason: `A bot check blocks the site before the sign-in form. ${TAKEOVER}`, url: page.url() };
      }
      await remember({ ok: false });
      return { status: "needs_user", reason: "Could not find the sign-in form (no sign-in link, no password field on the usual login pages).", url: page.url() };
    }
    const formUrl = page.url();
    const framed = reached.framed;
    let user = await firstVisible(page, USER_SELECTORS);
    let pass = await firstVisible(page, PASS_SELECTORS);
    if (!user && !pass) return { status: "already_logged_in", url: page.url(), title: await page.title() };

    if (user && (await user.inputValue().catch(() => "")) === "") {
      await user.fill(cred.username);
    }
    if (!pass) {
      // Two-step forms: username first, then password (or a texted code) on the next screen.
      await clickSubmit(page, user);
      await settle(page);
      await tagFields(page);
      pass = await firstVisible(page, PASS_SELECTORS);
    }
    if (pass && !cred.password) {
      return { status: "needs_user", reason: `${domain} asks for a password after the ${/^\+?[\d\s()-]{7,}$/.test(cred.username) ? "phone number" : "email"}, and none is saved. Look for a "text me a code" or "sign in with code" option on the page and use it (then request_code); otherwise ask the user in one line to add the password under Settings > Logins, or use Forgot password with get_email_code.`, url: page.url() };
    }
    if (!pass && !(await firstVisible(page, OTP_SELECTORS)) && !(await isMfaChooser(page)) && !(await isSignedIn(page))) {
      return { status: "needs_user", reason: cred.password ? "No password field appeared after entering the username (passwordless or passkey flow?). Snapshot the page and look for a code or sign-in option." : "Nothing asked for a code after the identifier. Snapshot the page: look for a \"text me a code\" or \"continue with phone\" option, click it, then request_code.", url: page.url() };
    }
    if (pass) {
      await pass.fill(cred.password);
      await clickSubmit(page, pass);
    }
    await settle(page, 4000);
    // A bot check after submit: the hosted browser solves most of them given a moment.
    if (BOT_WALL.test(await pageText(page).catch(() => ""))) {
      await remember({ wall: true });
      await waitOutBotWall(page);
      await settle(page, 1500);
    }
    await tagFields(page);
    let channel: LoginProfile["code"] = "none";

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
      channel = code ? "totp" : undefined;
      if (!code) {
        const where = codeChannel(await pageText(page).catch(() => ""), profile?.code);
        // A code the user auto-forwards to their agent address arrives by mail; a texted one never does,
        // so that case asks the user at once. Unknown: a short look at the mail, then the user.
        if (where !== "text" && env.mail.configured()) {
          const rounds = where === "email" ? 5 : 2;
          for (let attempt = 0; attempt < rounds && !code; attempt++) {
            await page.waitForTimeout(8_000);
            const found = await recentCodes(t, { senderHint: domain, sinceMinutes: 3 });
            code = found.find((f) => f.codes.length > 0)?.codes[0];
          }
          if (code) channel = "email";
        }
        if (!code) {
          // The code went to the user: the page stays open on the code field; the next call brings the code.
          await remember({ login_url: formUrl, framed, code: where === "email" ? "email" : where === "text" ? "text" : undefined });
          return { status: "needs_code", ask: `${domain} sent a verification code to the user's ${where === "email" ? "email" : "phone"}. Call request_code now (one line), and when the user sends it call login again with code.`, url: page.url() };
        }
      }
      await fillOtp(page, code);
    }

    await tagFields(page);
    if (await firstVisible(page, PASS_SELECTORS)) {
      const text = await pageText(page).catch(() => "");
      if (REJECTED.test(text)) {
        await remember({ login_url: formUrl, framed, ok: false });
        return { status: "needs_user", reason: "The site rejected the saved password (it says the login is wrong or the account is locked). Do not retry; tell the user in one line to check this login under Settings > Logins.", url: page.url() };
      }
      await remember({ login_url: formUrl, framed, ok: false, wall: BOT_WALL.test(text) });
      if (BOT_WALL.test(text)) return { status: "needs_user", reason: `The site's bot check rejected the automated sign-in. Do not retry. ${TAKEOVER}`, url: page.url() };
      return { status: "needs_user", reason: `Password form is still showing after submit; the site may have shown a challenge. Take one screenshot; if it is a bot check or the same form, do not retry. ${TAKEOVER}`, url: page.url() };
    }
    if (!cred.password && !(await isSignedIn(page)) && (await firstVisible(page, OTP_SELECTORS))) {
      return { status: "needs_user", reason: "The code field is still showing after the code; the site may have rejected it. Ask the user for a fresh one.", url: page.url() };
    }
    const remembered = await remember({ login_url: formUrl, framed, code: channel, ok: true, seconds: (Date.now() - started) / 1000 });
    return { status: "logged_in", url: page.url(), title: await page.title(), account: cred.username, remembered };
  } finally {
    // Disconnect only; the hosted browser keeps running for the sandbox.
    await browser.close().catch(() => {});
  }
}

/** Type a code the user relayed into whatever verification field is showing (sign-in or card verification). */
export async function enterCode(connectUrl: string, domain: string, code: string, targetId?: string | null): Promise<LoginResult> {
  const { browser, page } = await attach(connectUrl, domain, targetId);
  try {
    const clean = code.replace(/[^0-9a-z]/gi, "");
    if (!clean) return { status: "needs_user", reason: "The code was empty after removing spaces and punctuation.", url: page.url() };
    if (!(await fillOtp(page, clean))) {
      return { status: "needs_user", reason: "No verification-code field is showing right now. Snapshot the page; the step may have expired (request a new code) or already passed.", url: page.url() };
    }
    await tagFields(page);
    if (await firstVisible(page, OTP_SELECTORS)) {
      const text = await pageText(page).catch(() => "");
      if (REJECTED.test(text) || /(invalid|incorrect|wrong|expired)\b[^.\n]{0,30}\bcode|code[^.\n]{0,30}\b(invalid|incorrect|wrong|expired)/i.test(text)) {
        return { status: "needs_user", reason: "The site rejected that code (expired or mistyped). Ask the user for a fresh one with request_code.", url: page.url() };
      }
      const where = /email|e-mail|inbox/i.test(text.match(NEXT_CODE)?.[0] ?? "") ? "email" : "phone";
      return { status: "needs_code", ask: `The code was accepted and the site now asks for a second code, sent to the user's ${where}. Call request_code now saying so (or get_email_code if their mail is forwarded), then login again with the new code.`, url: page.url() };
    }
    if (!(await isSignedIn(page)) && NEXT_CODE.test(await pageText(page).catch(() => ""))) {
      return { status: "needs_code", ask: "The site says another code was sent (email or phone). Snapshot the page to see where, click any 'send' option it shows, then request_code and login again with that code.", url: page.url() };
    }
    return { status: "logged_in", url: page.url(), title: await page.title(), account: "code accepted" };
  } finally {
    await browser.close().catch(() => {});
  }
}
