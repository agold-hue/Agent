#!/usr/bin/env node
/**
 * Browser CLI used by the agent inside the Managed Agents sandbox.
 * Each invocation re-attaches over CDP to the hosted browser, does one thing, prints, exits.
 *
 *   node browser.mjs open <cdp_url>
 *   node browser.mjs goto <url>
 *   node browser.mjs snapshot            # numbered interactive elements + visible text
 *   node browser.mjs click <ref>
 *   node browser.mjs type <ref> "<text>" [--enter]
 *   node browser.mjs select <ref> "<value>"
 *   node browser.mjs press <key>         # Enter, Escape, Tab, ArrowDown ...
 *   node browser.mjs scroll down|up
 *   node browser.mjs text                # page text (trimmed)
 *   node browser.mjs screenshot [file]   # default /workspace/shot.png
 *   node browser.mjs watch [seconds]     # wait until the page text changes (live support chats), then print what's new
 *   node browser.mjs tabs | tab <n> | back | url | wait <ms> | eval "<js>"
 *
 * Requires playwright-core in /workspace/node_modules (npm i playwright-core).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// /workspace inside the Managed Agents sandbox; override for local testing.
const WORKDIR = process.env.AGENT_WORKDIR || "/workspace";
const require = createRequire(path.join(WORKDIR, "package.json"));
const STATE = path.join(WORKDIR, ".browser-state.json");
const MAX_TEXT = 6000;
const MAX_ELEMENTS = 250;

const [, , cmd, ...args] = process.argv;
if (!cmd) {
  console.log("usage: browser.mjs <command> ...  (see header comment)");
  process.exit(1);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s));
}

if (cmd === "open") {
  const url = args[0];
  if (!url) throw new Error("open <cdp_url>");
  writeState({ cdpUrl: url, tab: 0 });
  console.log("connected; next: goto <url>");
  process.exit(0);
}

const state = readState();
if (!state.cdpUrl) {
  console.error("Not connected. Run: browser.mjs open <cdp_url>");
  process.exit(2);
}

const { chromium } = require("playwright-core");
const browser = await chromium.connectOverCDP(state.cdpUrl, { timeout: 30000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
let pages = context.pages();
if (pages.length === 0) pages = [await context.newPage()];
const tabIndex = Math.min(state.tab ?? 0, pages.length - 1);
let page = pages[tabIndex];

const settle = async (ms = 1500) => {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
};
const ref = (r) => page.locator(`[data-agent-ref="${String(r).replace(/[^0-9]/g, "")}"]`).first();

async function snapshot() {
  const data = await page.evaluate((max) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const sel =
      'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [contenteditable="true"], summary, [onclick]';
    const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    const lines = [];
    let n = 0;
    for (const el of els) {
      if (n >= max) break;
      n++;
      el.setAttribute("data-agent-ref", String(n));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? `input:${el.type || "text"}` : tag);
      const label =
        el.getAttribute("aria-label") ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        (el.innerText || el.value || "").trim();
      const extra = [];
      if (tag === "input" && el.value && el.type !== "password") extra.push(`value="${el.value.slice(0, 40)}"`);
      if (tag === "select") extra.push(`selected="${el.options[el.selectedIndex]?.text ?? ""}"`);
      if (el.checked) extra.push("checked");
      if (el.disabled) extra.push("disabled");
      if (tag === "a" && el.href && !el.href.startsWith("javascript:")) extra.push(el.href.slice(0, 100));
      lines.push(`[${n}] ${role} "${String(label).replace(/\s+/g, " ").slice(0, 80)}" ${extra.join(" ")}`.trim());
    }
    const headings = Array.from(document.querySelectorAll("h1, h2"))
      .filter(isVisible)
      .slice(0, 12)
      .map((h) => `# ${h.innerText.trim().replace(/\s+/g, " ").slice(0, 100)}`);
    return { title: document.title, url: location.href, headings, lines, total: els.length };
  }, MAX_ELEMENTS);
  const out = [`${data.title}\n${data.url}`, ...data.headings, ...data.lines];
  if (data.total > MAX_ELEMENTS) out.push(`... ${data.total - MAX_ELEMENTS} more elements not shown; scroll or use 'text'`);
  console.log(out.join("\n"));
}

try {
  switch (cmd) {
    case "goto": {
      await page.goto(args[0], { waitUntil: "domcontentloaded", timeout: 45000 });
      await settle(2000);
      console.log(`${await page.title()}\n${page.url()}`);
      break;
    }
    case "snapshot":
      await snapshot();
      break;
    case "click": {
      await ref(args[0]).click({ timeout: 10000 });
      await settle();
      console.log(`clicked [${args[0]}] -> ${page.url()}`);
      break;
    }
    case "type": {
      const enter = args.includes("--enter");
      const text = args.filter((a) => a !== "--enter").slice(1).join(" ");
      const loc = ref(args[0]);
      await loc.click({ timeout: 10000 });
      await loc.fill("").catch(() => {});
      await loc.type(text, { delay: 20 });
      if (enter) {
        await loc.press("Enter");
        await settle();
      }
      console.log(`typed into [${args[0]}]${enter ? " + Enter" : ""}`);
      break;
    }
    case "select": {
      await ref(args[0]).selectOption({ label: args.slice(1).join(" ") }).catch(async () => {
        await ref(args[0]).selectOption(args.slice(1).join(" "));
      });
      console.log(`selected in [${args[0]}]`);
      break;
    }
    case "press":
      await page.keyboard.press(args[0]);
      await settle(800);
      console.log(`pressed ${args[0]}`);
      break;
    case "scroll": {
      const dy = args[0] === "up" ? -700 : 700;
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(500);
      console.log(`scrolled ${args[0] ?? "down"}`);
      break;
    }
    case "text": {
      const t = await page.evaluate(() => document.body.innerText);
      const clean = t.replace(/\n{3,}/g, "\n\n").trim();
      console.log(clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) + `\n... (${clean.length - MAX_TEXT} more chars)` : clean);
      break;
    }
    case "screenshot": {
      const file = args[0] || path.join(WORKDIR, "shot.png");
      await page.screenshot({ path: file, fullPage: false });
      console.log(`saved ${file} (use the read tool to view it)`);
      break;
    }
    case "tabs": {
      pages.forEach((p, i) => console.log(`${i === tabIndex ? "*" : " "} [${i}] ${p.url()}`));
      break;
    }
    case "tab": {
      const n = Number(args[0]);
      if (!pages[n]) throw new Error(`no tab ${n}`);
      writeState({ ...state, tab: n });
      await pages[n].bringToFront();
      console.log(`switched to tab ${n}: ${pages[n].url()}`);
      break;
    }
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await settle();
      console.log(page.url());
      break;
    case "url":
      console.log(`${await page.title()}\n${page.url()}`);
      break;
    case "wait":
      await page.waitForTimeout(Number(args[0] || 1000));
      console.log("ok");
      break;
    case "watch": {
      // Live chats reply asynchronously. Poll the page text until it changes or the time is up.
      const limit = Math.min(Number(args[0] || 60), 240) * 1000;
      const grab = () => page.evaluate(() => document.body.innerText).catch(() => "");
      const before = await grab();
      const start = Date.now();
      let after = before;
      while (Date.now() - start < limit) {
        await page.waitForTimeout(2000);
        after = await grab();
        if (after !== before) {
          await page.waitForTimeout(1500); // let a multi-line reply finish
          after = await grab();
          break;
        }
      }
      if (after === before) {
        console.log(`no change after ${Math.round(limit / 1000)}s`);
      } else {
        const oldLines = new Set(before.split("\n"));
        const fresh = after.split("\n").filter((l) => l.trim() && !oldLines.has(l));
        console.log(fresh.length ? fresh.join("\n").slice(0, MAX_TEXT) : "(page changed; run 'text' to read it)");
      }
      break;
    }
    case "eval": {
      const result = await page.evaluate(args.join(" "));
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
      break;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Detach from the hosted browser without closing it.
  await browser.close().catch(() => {});
}
