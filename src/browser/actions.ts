import type { Locator, Page } from "playwright";
import { config } from "../config.js";
import { saveFile, getFile, readFileBytes, type FileRow } from "../files.js";
import { errText } from "../log.js";
import { findCredential } from "../vault.js";
import { closeTaskTabs, newTab, pageFor, type PageHandle } from "./pool.js";
import { diffSnapshot, findInSnapshot, pageText, snapshot } from "./snapshot.js";

/**
 * The browser tools the model calls. Every action returns text (usually a snapshot or a diff of one)
 * and sometimes an image. Errors come back as text the model can act on, never as exceptions.
 */
export interface ActionResult {
  text: string;
  image?: { base64: string; mediaType: "image/jpeg" | "image/png" };
}

export interface BrowserSession {
  orgId: string;
  taskId: string;
  timezone: string;
  locale?: string;
  /** Last full snapshot per tab url, for diffs. */
  last?: { url: string; snap: string };
}

const ACTION_TIMEOUT = 8000;

function refLocator(page: Page, ref: string): Locator {
  const r = String(ref).trim().replace(/^\[?ref=|\]$/g, "");
  if (/^d\d+$/.test(r)) return page.locator(`[data-wm-ref="${r}"]`).first();
  return page.locator(`aria-ref=${r}`);
}

async function withHandle(s: BrowserSession, fn: (h: PageHandle) => Promise<ActionResult>): Promise<ActionResult> {
  let h: PageHandle;
  try {
    h = await pageFor(s.orgId, s.taskId, { timezone: s.timezone, locale: s.locale });
  } catch (e) {
    return { text: `The browser could not start: ${errText(e)}` };
  }
  try {
    const out = await fn(h);
    if (h.tabs.notes.length) {
      out.text = `${h.tabs.notes.map((n) => `Note: ${n}`).join("\n")}\n\n${out.text}`;
      h.tabs.notes = [];
    }
    return out;
  } catch (e) {
    const msg = errText(e);
    if (/Target (page|context|browser) has been closed|has been closed/i.test(msg)) return { text: "The tab was closed. The next browser call opens a fresh one; navigate again." };
    if (/aria-ref|data-wm-ref|Timeout .*exceeded|not (found|visible|attached)|intercepts pointer events|outside of the viewport/i.test(msg)) {
      return { text: `Action failed: ${msg.split("\n")[0].slice(0, 300)}\nThe ref may be stale, hidden, or covered. Take a fresh browser_snapshot (or browser_find) and use a current ref; if an overlay covers it, close it first.` };
    }
    return { text: `Action failed: ${msg.split("\n")[0].slice(0, 400)}` };
  }
}

/** Wait for a page to be usable: load, network quiet, and controls present, within the settle budget. */
export async function settle(page: Page, maxMs = config.browser.settleMs()): Promise<void> {
  const start = Date.now();
  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(4000, maxMs) }).catch(() => {});
  await page.waitForLoadState("load", { timeout: Math.max(0, Math.min(3000, maxMs - (Date.now() - start))) }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.max(0, Math.min(2500, maxMs - (Date.now() - start))) }).catch(() => {});
  let last = -1;
  const count = `document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]').length`;
  while (Date.now() - start < maxMs) {
    const n = Number(await page.evaluate(count).catch(() => 0));
    if (n > 0 && n === last) return;
    last = n;
    await page.waitForTimeout(400);
  }
}

async function afterAction(s: BrowserSession, page: Page, prefix: string, opts: { full?: boolean; settleMs?: number } = {}): Promise<ActionResult> {
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(opts.settleMs ?? 600);
  const snap = await snapshot(page);
  const url = page.url();
  const text = opts.full ? snap : diffSnapshot(s.last, url, snap);
  s.last = { url, snap };
  return { text: prefix ? `${prefix}\n\n${text}` : text };
}

export async function runBrowserAction(s: BrowserSession, name: string, a: Record<string, unknown>): Promise<ActionResult> {
  const str = (k: string) => (a[k] == null ? "" : String(a[k]));
  const num = (k: string, d: number) => (Number.isFinite(Number(a[k])) && a[k] !== undefined && a[k] !== null ? Number(a[k]) : d);
  switch (name) {
    case "browser_navigate":
      return withHandle(s, async ({ page }) => {
        let url = str("url").trim();
        if (!url) return { text: "url is required" };
        if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => ({ error: errText(e) }));
        if (res && "error" in res) return { text: `Navigation failed: ${res.error.split("\n")[0]}` };
        await settle(page);
        const status = res && "status" in res ? res.status() : 0;
        return afterAction(s, page, status >= 400 ? `HTTP ${status}` : "", { full: true, settleMs: 100 });
      });

    case "browser_snapshot":
      return withHandle(s, async ({ page }) => {
        if (page.url() === "about:blank") return { text: "The tab is blank. Use browser_navigate to open a page." };
        if (a.interactive_only === undefined) {
          const snap = await snapshot(page);
          if (!/\[ref=/.test(snap)) {
            await settle(page, 6000);
          }
        }
        return afterAction(s, page, "", { full: true, settleMs: 0 }).then(async (r) => (a.interactive_only ? { text: await snapshot(page, { interactive: true }) } : r));
      });

    case "browser_find":
      return withHandle(s, async ({ page }) => ({ text: await findInSnapshot(page, str("text")) }));

    case "browser_click":
      return withHandle(s, async ({ page }) => {
        const ref = str("ref");
        const button = (str("button") || "left") as "left" | "right" | "middle";
        const clickCount = a.double ? 2 : 1;
        if (ref) {
          const loc = refLocator(page, ref);
          try {
            await loc.click({ timeout: ACTION_TIMEOUT, button, clickCount });
          } catch (e) {
            // Covered by an overlay or slightly off-screen: scroll it into view and click through.
            const msg = errText(e);
            if (/intercepts pointer events|outside of the viewport|not visible/i.test(msg)) {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await loc.click({ timeout: ACTION_TIMEOUT, button, clickCount, force: true });
            } else throw e;
          }
        } else if (a.x !== undefined && a.y !== undefined) {
          await page.mouse.click(num("x", 0), num("y", 0), { button, clickCount });
        } else return { text: "Give a ref (from the snapshot) or x and y coordinates (from a screenshot)." };
        return afterAction(s, page, `Clicked ${ref ? `[${ref}]` : `(${num("x", 0)}, ${num("y", 0)})`}`);
      });

    case "browser_type":
      return withHandle(s, async ({ page }) => {
        const ref = str("ref");
        const text = str("text");
        if (!ref) return { text: "ref is required" };
        const loc = refLocator(page, ref);
        await loc.click({ timeout: ACTION_TIMEOUT }).catch(() => loc.focus({ timeout: 3000 }));
        if (a.clear !== false) await loc.fill("", { timeout: ACTION_TIMEOUT }).catch(() => {});
        if (a.slowly) await loc.pressSequentially(text, { delay: 25, timeout: ACTION_TIMEOUT + text.length * 30 });
        else await loc.fill(text, { timeout: ACTION_TIMEOUT }).catch(async () => loc.pressSequentially(text, { delay: 15 }));
        if (a.submit) {
          await loc.press("Enter", { timeout: ACTION_TIMEOUT });
          await settle(page, 4000);
          return afterAction(s, page, `Typed into [${ref}] and pressed Enter`);
        }
        // Address and search boxes answer typing with a suggestion list that must be clicked; show it.
        return afterAction(s, page, `Typed into [${ref}]`, { settleMs: 700 });
      });

    case "browser_fill":
      return withHandle(s, async ({ page }) => {
        const fields = Array.isArray(a.fields) ? (a.fields as Array<{ ref: string; value: unknown }>) : [];
        if (!fields.length) return { text: "fields is required: [{ref, value}]" };
        const report: string[] = [];
        for (const f of fields) {
          const ref = String(f.ref ?? "");
          const value = f.value;
          try {
            const loc = refLocator(page, ref);
            const kind = (await loc.evaluate((el) => {
              const e = el as HTMLInputElement;
              const tag = e.tagName.toLowerCase();
              if (tag === "select") return "select";
              if (tag === "input" && (e.type === "checkbox" || e.type === "radio")) return e.type;
              if (tag === "input" && e.type === "file") return "file";
              if (e.getAttribute("role") === "checkbox" || e.getAttribute("role") === "switch") return "aria-check";
              if (e.getAttribute("role") === "combobox" && tag !== "input") return "combobox";
              return "text";
            }, { timeout: ACTION_TIMEOUT })) as string;
            if (kind === "select") {
              await loc.selectOption({ label: String(value) }, { timeout: ACTION_TIMEOUT }).catch(() => loc.selectOption(String(value), { timeout: ACTION_TIMEOUT }));
            } else if (kind === "checkbox" || kind === "radio") {
              const on = value === true || /^(true|yes|on|1|checked)$/i.test(String(value));
              if (kind === "radio" || on) await loc.check({ timeout: ACTION_TIMEOUT });
              else await loc.uncheck({ timeout: ACTION_TIMEOUT });
            } else if (kind === "aria-check") {
              const on = value === true || /^(true|yes|on|1|checked)$/i.test(String(value));
              const checked = (await loc.getAttribute("aria-checked")) === "true";
              if (checked !== on) await loc.click({ timeout: ACTION_TIMEOUT });
            } else if (kind === "file") {
              report.push(`[${ref}]: file inputs use browser_upload`);
              continue;
            } else if (kind === "combobox") {
              await loc.click({ timeout: ACTION_TIMEOUT });
              await page.keyboard.type(String(value), { delay: 20 });
            } else {
              await loc.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
              await loc.fill(String(value ?? ""), { timeout: ACTION_TIMEOUT }).catch(async () => {
                await loc.fill("", { timeout: 2000 }).catch(() => {});
                await loc.pressSequentially(String(value ?? ""), { delay: 15 });
              });
            }
            report.push(`[${ref}]: ok`);
          } catch (e) {
            report.push(`[${ref}]: FAILED (${errText(e).split("\n")[0].slice(0, 160)})`);
          }
        }
        return afterAction(s, page, `Filled ${fields.length} field(s):\n${report.join("\n")}`);
      });

    case "browser_select":
      return withHandle(s, async ({ page }) => {
        const loc = refLocator(page, str("ref"));
        const value = str("value");
        try {
          await loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT });
        } catch {
          await loc.selectOption(value, { timeout: ACTION_TIMEOUT });
        }
        return afterAction(s, page, `Selected "${value}" in [${str("ref")}]`);
      });

    case "browser_press":
      return withHandle(s, async ({ page }) => {
        const key = str("key");
        if (str("ref")) await refLocator(page, str("ref")).press(key, { timeout: ACTION_TIMEOUT });
        else await page.keyboard.press(key);
        return afterAction(s, page, `Pressed ${key}`);
      });

    case "browser_hover":
      return withHandle(s, async ({ page }) => {
        await refLocator(page, str("ref")).hover({ timeout: ACTION_TIMEOUT });
        return afterAction(s, page, `Hovered [${str("ref")}]`);
      });

    case "browser_scroll":
      return withHandle(s, async ({ page }) => {
        if (str("ref")) {
          await refLocator(page, str("ref")).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
          return afterAction(s, page, `Scrolled [${str("ref")}] into view`);
        }
        const dir = str("direction") || "down";
        const amount = num("amount", 700);
        const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
        const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
        if (dir === "top") await page.evaluate("window.scrollTo(0, 0)");
        else if (dir === "bottom") await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
        else await page.mouse.wheel(dx, dy);
        await page.waitForTimeout(400);
        return afterAction(s, page, `Scrolled ${dir}`);
      });

    case "browser_wait":
      return withHandle(s, async ({ page }) => {
        const limit = Math.min(Math.max(num("seconds", 10), 1), 180) * 1000;
        const start = Date.now();
        const text = str("text").toLowerCase();
        const urlPart = str("url_contains").toLowerCase();
        const gone = str("text_gone").toLowerCase();
        if (!text && !urlPart && !gone) {
          await page.waitForTimeout(Math.min(limit, 30_000));
          await settle(page, 3000);
          return afterAction(s, page, `Waited ${Math.round((Date.now() - start) / 1000)}s`);
        }
        while (Date.now() - start < limit) {
          const body = text || gone ? (await pageText(page).catch(() => "")).toLowerCase() : "";
          const okText = !text || body.includes(text);
          const okGone = !gone || !body.includes(gone);
          const okUrl = !urlPart || page.url().toLowerCase().includes(urlPart);
          if (okText && okGone && okUrl) return afterAction(s, page, `Condition met after ${Math.round((Date.now() - start) / 1000)}s`);
          await page.waitForTimeout(700);
        }
        return afterAction(s, page, `Condition NOT met within ${Math.round(limit / 1000)}s (text="${str("text")}" url_contains="${str("url_contains")}" text_gone="${str("text_gone")}")`);
      });

    case "browser_read":
      return withHandle(s, async ({ page }) => {
        const max = Math.min(num("max_chars", 20_000), 80_000);
        const t = await pageText(page, str("mode") === "main" ? "main" : "text");
        const offset = Math.max(0, num("offset", 0));
        const slice = t.slice(offset, offset + max);
        const more = t.length > offset + max ? `\n... (${t.length - offset - max} more characters; call again with offset=${offset + max})` : "";
        return { text: `Text of ${page.url()} (${t.length} chars${offset ? `, from ${offset}` : ""}):\n\n${slice}${more}` };
      });

    case "browser_screenshot":
      return withHandle(s, async ({ page }) => {
        const buf = await page.screenshot({ type: "jpeg", quality: 75, fullPage: !!a.full_page });
        return { text: `Screenshot of ${page.url()} (viewport ${config.browser.width()}x${config.browser.height()}; coordinates for browser_click x,y are in these pixels)`, image: { base64: buf.toString("base64"), mediaType: "image/jpeg" } };
      });

    case "browser_back":
      return withHandle(s, async ({ page }) => {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        await settle(page, 3000);
        return afterAction(s, page, "Went back", { full: true });
      });

    case "browser_tabs":
      return withHandle(s, async (h) => {
        const action = str("action") || "list";
        const list = () => h.tabs.pages.map((p, i) => `${i === h.tabs.active ? "*" : " "} [${i}] ${p.url()} ${p.isClosed() ? "(closed)" : ""}`).join("\n");
        if (action === "list") return { text: `Tabs (* = active):\n${list()}` };
        if (action === "new") {
          await newTab(h, s.orgId, s.taskId, str("url") || undefined);
          const page = h.tabs.pages[h.tabs.active];
          await settle(page, 4000);
          return afterAction(s, page, `Opened a new tab (index ${h.tabs.active})`, { full: true });
        }
        const idx = num("index", h.tabs.active);
        if (!h.tabs.pages[idx]) return { text: `No tab ${idx}.\n${list()}` };
        if (action === "close") {
          await h.tabs.pages[idx].close().catch(() => {});
          h.tabs.pages = h.tabs.pages.filter((p) => !p.isClosed());
          if (h.tabs.active >= h.tabs.pages.length) h.tabs.active = Math.max(0, h.tabs.pages.length - 1);
          return { text: `Closed tab ${idx}.\n${list()}` };
        }
        h.tabs.active = idx;
        await h.tabs.pages[idx].bringToFront().catch(() => {});
        return afterAction(s, h.tabs.pages[idx], `Switched to tab ${idx}`, { full: true });
      });

    case "browser_upload":
      return withHandle(s, async ({ page }) => {
        const f = await getFile(s.orgId, str("file_id"));
        if (!f) return { text: `No file with id ${str("file_id")}. Use file_list to see files.` };
        const data = await readFileBytes(f);
        const loc = refLocator(page, str("ref"));
        const kind = await loc.evaluate((el) => (el as HTMLInputElement).type).catch(() => "");
        if (kind === "file") await loc.setInputFiles({ name: f.name, mimeType: f.mime, buffer: data }, { timeout: ACTION_TIMEOUT });
        else {
          const chooser = page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT });
          await loc.click({ timeout: ACTION_TIMEOUT });
          await (await chooser).setFiles({ name: f.name, mimeType: f.mime, buffer: data });
        }
        return afterAction(s, page, `Uploaded "${f.name}" via [${str("ref")}]`);
      });

    case "browser_pdf":
      return withHandle(s, async ({ page }) => {
        await page.emulateMedia({ media: "print" }).catch(() => {});
        const buf = await page.pdf({ format: "Letter", printBackground: true });
        await page.emulateMedia({ media: null }).catch(() => {});
        const f = await saveFile(s.orgId, s.taskId === "manual" ? null : s.taskId, (str("name") || (await page.title()) || "page").replace(/\.pdf$/i, "") + ".pdf", "application/pdf", buf);
        return { text: `Saved the page as PDF: "${f.name}" (${f.bytes} bytes), file id ${f.id}.` };
      });

    case "browser_fill_login":
      return withHandle(s, async ({ page }) => {
        const site = str("site") || page.url();
        const cred = await findCredential(s.orgId, site, str("username_hint") || undefined);
        if (!cred) return { text: `No saved login for ${site}. Ask the user to add one under Logins (or to give the username and password in chat if they prefer), or sign in another way.` };
        const done: string[] = [];
        const secrets = [cred.password, cred.totp].filter((v): v is string => !!v);
        const redact = (r: ActionResult): ActionResult => {
          for (const sec of secrets) r.text = r.text.split(sec).join("[redacted]");
          return r;
        };
        const fillRef = async (ref: string, value: string, label: string, secret: boolean) => {
          if (!ref || !value) return;
          const loc = refLocator(page, ref);
          if (secret) {
            // The secret must land in a field the page will not echo back: a password box, or a one-time-code box.
            const type = (await loc.evaluate((el) => ((el as HTMLInputElement).type || "").toLowerCase(), { timeout: ACTION_TIMEOUT }).catch(() => "")) as string;
            const okCode = label.startsWith("authenticator") && /^(text|tel|number|password)$/.test(type);
            if (type !== "password" && !okCode) throw new Error(`refused to type the ${label} into [${ref}]: it is not a password field (type="${type || "?"}"). Point password_ref at the password box.`);
          }
          await loc.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
          await loc.fill(value, { timeout: ACTION_TIMEOUT }).catch(async () => {
            await loc.pressSequentially(value, { delay: 20 });
          });
          done.push(label);
        };
        try {
          await fillRef(str("username_ref"), cred.username, `username (${cred.username})`, false);
          await fillRef(str("password_ref"), cred.password, "password", true);
          if (str("code_ref")) {
            if (!cred.totp) return { text: `The saved login for ${cred.domain} has no authenticator seed; the code must come from the user. Ask them for it.` };
            await fillRef(str("code_ref"), cred.totp, "authenticator code", true);
          }
        } catch (e) {
          return redact({ text: `Login fill stopped: ${errText(e).split("\n")[0]}` });
        }
        if (!done.length) return { text: `A saved login exists for ${cred.domain} (username ${cred.username}). Pass username_ref and/or password_ref (refs of the sign-in fields) to fill them.${cred.notes ? ` Notes: ${cred.notes}` : ""}` };
        if (a.submit) {
          await page.keyboard.press("Enter");
          await settle(page, 5000);
        }
        return redact(await afterAction(s, page, `Filled ${done.join(", ")} from the vault for ${cred.domain}${a.submit ? " and pressed Enter" : ""}.${cred.notes ? ` Notes on this login: ${cred.notes}` : ""}`));
      });

    case "browser_close":
      await closeTaskTabs(s.orgId, s.taskId);
      s.last = undefined;
      return { text: "Browser tabs for this task closed. Sign-ins stay saved in the profile." };

    default:
      return { text: `Unknown browser tool ${name}` };
  }
}

export type { FileRow };
