import type { Page } from "playwright";
import { existingPage, pageFor } from "./pool.js";

/**
 * The console's "watch and take over" view: a JPEG of the task's tab every few hundred milliseconds,
 * and clicks and keys the user sends forwarded to the page. A business signs in to a site once by hand
 * here, and the profile keeps the session for every task after.
 */
export async function frame(orgId: string, taskId: string): Promise<{ jpeg: Buffer; url: string; title: string } | undefined> {
  const h = await existingPage(orgId, taskId);
  if (!h) return undefined;
  const page = h.page;
  const jpeg = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => undefined);
  if (!jpeg) return undefined;
  return { jpeg, url: page.url(), title: await page.title().catch(() => "") };
}

export interface LiveInput {
  type: "click" | "key" | "type" | "scroll" | "navigate" | "back";
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  dy?: number;
  url?: string;
}

export async function input(orgId: string, taskId: string, timezone: string, ev: LiveInput): Promise<{ ok: boolean; error?: string }> {
  let page: Page;
  const existing = await existingPage(orgId, taskId);
  if (existing) page = existing.page;
  else if (taskId === "manual") page = (await pageFor(orgId, "manual", { timezone })).page;
  else return { ok: false, error: "no open tab for this task" };
  try {
    switch (ev.type) {
      case "click":
        await page.mouse.click(ev.x ?? 0, ev.y ?? 0);
        break;
      case "key":
        await page.keyboard.press(ev.key ?? "Enter");
        break;
      case "type":
        await page.keyboard.type(ev.text ?? "", { delay: 15 });
        break;
      case "scroll":
        await page.mouse.move(ev.x ?? 400, ev.y ?? 300);
        await page.mouse.wheel(0, ev.dy ?? 400);
        break;
      case "navigate": {
        let url = (ev.url ?? "").trim();
        if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        break;
      }
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}
