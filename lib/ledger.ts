import type { Page } from "playwright-core";
import { CANCEL_WORDS, EXTRACT_FN, parseDateCell, parseMoney, REFUND_WORDS, resolveTarget, type Extracted } from "./browser-extras.js";
import { waitInteractive, withPage } from "./browser-tools.js";
import { registrableDomain } from "./credentials.js";
import { appendMemory, readMemory } from "./memory.js";
import { appendAssistantMessage, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * Full-period accounting, done by the host. "How much did I spend on Amazon in 2026" is not a
 * question a model answers from one screen: it is every page of the year's order history, each
 * order's total, the refunds, the gift-card and points lines, and the sums. spending_report walks
 * the pages (in parallel where the site pages by URL, by the Next button otherwise), parses the
 * rows, does the arithmetic, and says exactly which dates it covered. The model only phrases it.
 */

export interface Period {
  from: Date;
  to: Date;
  label: string;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

/** The period a request names: a year, "last 12 months", "this year", "last month", "last 90 days". */
export function periodAsked(text: string, now = new Date()): Period | undefined {
  const t = text.toLowerCase();
  const y = now.getFullYear();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(last|past|previous|trailing)\s+(12|twelve)\s+months?\b|\b(last|past) year\b(?! to date)/)) && !/\bcalendar year\b/.test(t) && !/\b(last|past) year\b/.test(m[0])) {
    return { from: new Date(y - 1, now.getMonth(), now.getDate()), to: day(now), label: "the last 12 months" };
  }
  if (/\b(last|past) year\b/.test(t) && !/\bmonths?\b/.test(t)) {
    // "last year" means the previous calendar year to most people; "past year" the trailing twelve months.
    if (/\bpast year\b/.test(t)) return { from: new Date(y - 1, now.getMonth(), now.getDate()), to: day(now), label: "the past year" };
    return { from: new Date(y - 1, 0, 1), to: new Date(y - 1, 11, 31), label: String(y - 1) };
  }
  if (/\b(this year|year to date|ytd|so far this year)\b/.test(t)) return { from: new Date(y, 0, 1), to: day(now), label: `${y} so far` };
  if ((m = t.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?(?:\\s+of)?\\s+(20\\d{2})\\b`)))) {
    const mi = MONTHS.split("|").indexOf(m[1]);
    const yy = Number(m[2]);
    return { from: new Date(yy, mi, 1), to: new Date(yy, mi + 1, 0), label: `${m[1]} ${yy}` };
  }
  if ((m = t.match(new RegExp(`\\b(${MONTHS})(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\\b`))) && !/\b20\d{2}\b/.test(t)) {
    // A month with no year: this year's, or last year's when it has not come yet.
    const mi = MONTHS.split("|").indexOf(m[1]);
    const yy = mi > now.getMonth() ? y - 1 : y;
    return { from: new Date(yy, mi, 1), to: mi === now.getMonth() && yy === y ? day(now) : new Date(yy, mi + 1, 0), label: `${m[1]} ${yy}` };
  }
  if ((m = t.match(/\b(20\d{2})\b/)) && Number(m[1]) <= y) {
    const yy = Number(m[1]);
    return { from: new Date(yy, 0, 1), to: yy === y ? day(now) : new Date(yy, 11, 31), label: yy === y ? `${yy} so far` : String(yy) };
  }
  if ((m = t.match(/\b(last|past)\s+(\d{1,2})\s+months?\b/))) {
    const n = Number(m[2]);
    return { from: new Date(y, now.getMonth() - n, now.getDate()), to: day(now), label: `the last ${n} months` };
  }
  if ((m = t.match(/\b(last|past)\s+(\d{1,3})\s+days?\b/))) {
    const n = Number(m[2]);
    return { from: new Date(now.getTime() - n * 86_400_000), to: day(now), label: `the last ${n} days` };
  }
  if (/\blast month\b/.test(t)) return { from: new Date(y, now.getMonth() - 1, 1), to: new Date(y, now.getMonth(), 0), label: "last month" };
  if (/\bthis month\b/.test(t)) return { from: new Date(y, now.getMonth(), 1), to: day(now), label: "this month" };
  return undefined;
}

export interface OrderLine {
  date: string;
  description: string;
  amount: number;
  kind: "charge" | "refund" | "gift" | "points" | "no_cash";
  id?: string;
}

const GIFT_WORDS = /\b(gift card|gift certificate|gc balance)\b/i;
const POINTS_WORDS = /\b(points|rewards? (?:points|balance)|miles)\b/i;
const ORDER_ID = /\b\d{3}-\d{7}-\d{7}\b|\border\s*(?:#|number|no\.?)\s*:?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{6,})/i;
const LONG_DATE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}|\d{1,2}\/\d{1,2}\/(?:20)?\d{2}|20\d{2}-\d{2}-\d{2})\b/i;

/** One order or transaction from a row of cells (a table row, or one order card flattened to cells). */
export function parseOrderLine(cells: string[], now = new Date()): OrderLine | undefined {
  const joined = cells.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return undefined;
  let date: Date | undefined;
  for (const c of cells) if ((date = parseDateCell(c, now))) break;
  if (!date) {
    const m = joined.match(LONG_DATE);
    if (m) date = parseDateCell(m[0].replace(/\bsept\b/i, "Sep"), now);
  }
  if (!date) return undefined;
  // The order's total: the amount after "Total" when there is one, else the largest amount on the line.
  let amount: number | undefined;
  const totalMatch = joined.match(/\btotal\b[^$\d-]{0,20}(-?\$?\s?\d[\d,]*\.\d{2})/i);
  if (totalMatch) amount = parseMoney(totalMatch[1]);
  if (amount === undefined) {
    const all = [...joined.matchAll(/-?\$\s?\d[\d,]*\.\d{2}/g)].map((x) => parseMoney(x[0])).filter((v): v is number => v !== undefined);
    if (all.length) amount = all.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  }
  if (amount === undefined) return undefined;
  const idm = joined.match(ORDER_ID);
  const id = idm ? (idm[1] ?? idm[0]) : undefined;
  const kind: OrderLine["kind"] = GIFT_WORDS.test(joined) && !/\bbought a gift card\b/i.test(joined) ? "gift" : POINTS_WORDS.test(joined) ? "points" : amount === 0 || CANCEL_WORDS.test(joined) ? "no_cash" : amount < 0 || REFUND_WORDS.test(joined) ? "refund" : "charge";
  const description = joined.replace(LONG_DATE, "").replace(/-?\$\s?\d[\d,]*\.\d{2}/g, "").replace(/\b(order placed|total|ship to|order #|view order details|view invoice|track package|buy it again|order details)\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  return { date: date.toISOString().slice(0, 10), description, amount: Math.abs(amount), kind, id };
}

/**
 * Orders from a page's visible text, for sites whose order list is cards rather than a table
 * (Amazon): each "Order placed <date> ... Total $x ... Order # id ... <items>" block is one order,
 * with the item titles that follow it until the next order.
 */
const ORDER_START = /order placed\s*:?\s*([A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/gi;
const UI_NOISE = /^(order placed|total|ship to|order #|view order details|view invoice|track package|buy it again|view your item|write a product review|get product support|return or replace items|leave seller feedback|archive order|problem with order|ask product question|delivered|arriving|return window|return started|refund issued|share gift receipt|cancel items?|view return\/refund status|get help|see all buying options|not yet shipped|shipped|invoice)\b/i;
export function parseOrdersFromText(text: string, now = new Date()): OrderLine[] {
  const starts = [...text.matchAll(ORDER_START)];
  const out: OrderLine[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = text.slice(starts[i].index!, i + 1 < starts.length ? starts[i + 1].index : undefined);
    const date = parseDateCell(starts[i][1].replace(/\bsept\b/i, "Sep"), now);
    if (!date) continue;
    const total = block.match(/\btotal\b\s*:?\s*(-?\$?\s?\d[\d,]*\.\d{2})/i);
    const amount = total ? parseMoney(total[1]) : undefined;
    if (amount === undefined) continue;
    const id = block.match(ORDER_ID)?.[1] ?? block.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0];
    const afterId = id ? block.slice(block.indexOf(id) + id.length) : block;
    const items = afterId
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 6 && l.length < 140 && !UI_NOISE.test(l) && !/^\$?\d[\d,.]*$/.test(l) && !/^(delivered|arriving|return)/i.test(l) && !/\b(sold by|ship to|order #|placed|total)\b/i.test(l))
      .slice(0, 4);
    const joined = block.slice(0, 400);
    const kind: OrderLine["kind"] = GIFT_WORDS.test(joined) ? "gift" : POINTS_WORDS.test(joined) ? "points" : amount === 0 || CANCEL_WORDS.test(joined) ? "no_cash" : amount < 0 || /\brefund(ed)?\b/i.test(joined) ? "refund" : "charge";
    out.push({ date: date.toISOString().slice(0, 10), description: (items.join(", ") || "(order)").slice(0, 120), amount: Math.abs(amount), kind, id });
  }
  return out;
}

export interface SpendingSummary {
  label: string;
  from: string;
  to: string;
  covers: { first: string; last: string } | undefined;
  pages: number;
  orders: number;
  charged: number;
  refunded: number;
  gift: number;
  points: number;
  net: number;
  lines: OrderLine[];
  partial: string | undefined;
}

/** The sums over every parsed line inside the period, de-duplicated by order id. */
export function summarizeOrders(lines: OrderLine[], period: Period, pages: number, historyStops?: string): SpendingSummary {
  const from = period.from.toISOString().slice(0, 10);
  const to = period.to.toISOString().slice(0, 10);
  const seen = new Set<string>();
  const inside: OrderLine[] = [];
  let first = "";
  let last = "";
  for (const l of lines) {
    const key = l.id ?? `${l.date}|${l.amount}|${l.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!first || l.date < first) first = l.date;
    if (!last || l.date > last) last = l.date;
    if (l.date >= from && l.date <= to) inside.push(l);
  }
  inside.sort((a, b) => b.date.localeCompare(a.date));
  const sum = (k: OrderLine["kind"]) => Math.round(inside.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const charged = sum("charge");
  const refunded = sum("refund");
  const gift = sum("gift");
  const points = sum("points");
  const covers = first ? { first: first < from ? from : first, last: last > to ? to : last } : undefined;
  let partial: string | undefined;
  if (historyStops) partial = historyStops;
  else if (covers && covers.first > new Date(period.from.getTime() + 8 * 86_400_000).toISOString().slice(0, 10)) partial = `the site shows nothing before ${covers.first}; the period starts ${from}`;
  return { label: period.label, from, to, covers, pages, orders: inside.filter((l) => l.kind === "charge" || l.kind === "gift").length, charged, refunded, gift, points, net: Math.round((charged + gift - refunded) * 100) / 100, lines: inside, partial };
}

export function formatSpending(s: SpendingSummary, host: string): string {
  const head = [`SPENDING REPORT for ${s.label} (${s.from} to ${s.to}) from ${host}, ${s.pages} page${s.pages === 1 ? "" : "s"} read, computed by the host. COVERS ${s.covers ? `${s.covers.first}..${s.covers.last}` : "nothing"}.`];
  if (s.partial) head.push(`PARTIAL: ${s.partial}. Say so in the reply.`);
  head.push(`charged to cards: $${s.charged.toFixed(2)} across ${s.orders} orders`);
  if (s.gift) head.push(`paid from gift card balance: $${s.gift.toFixed(2)}`);
  if (s.points) head.push(`covered by points or rewards: $${s.points.toFixed(2)} (not cash)`);
  if (s.refunded) head.push(`refunds and credits back: $${s.refunded.toFixed(2)}`);
  head.push(`net cash spend: $${s.net.toFixed(2)}${s.gift ? ` (cards + gift card, minus refunds)` : " (charges minus refunds)"}`);
  const lines = s.lines.slice(0, 80).map((l) => `  ${l.date} ${l.kind === "charge" ? "" : `[${l.kind}] `}${l.description || "(order)"} $${l.amount.toFixed(2)}${l.id ? ` #${l.id}` : ""}`);
  if (s.lines.length > 80) lines.push(`  ... ${s.lines.length - 80} more lines`);
  return `${head.join("\n")}\n${lines.join("\n")}`;
}

/** Sites whose history pages by URL, so the pages can be read side by side. */
const URL_PAGERS: Array<{ host: RegExp; url: (year: number, index: number) => string; step: number }> = [
  { host: /(^|\.)amazon\.[a-z.]+$/i, url: (year, index) => `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=${index}`, step: 10 },
];
const NEXT_LABELS = ["Next", "Next page", "Next →", "Older", "Load more", "Show more", "See more", "View more", "›", ">"];
const MAX_PAGES = Number(process.env.LEDGER_MAX_PAGES ?? 40);
const PARALLEL = Number(process.env.LEDGER_PARALLEL_PAGES ?? 3);

async function extract(page: Page): Promise<string[][]> {
  const tables = (await page.evaluate(`(${EXTRACT_FN})(400)`).catch(() => [])) as Extracted[];
  return tables.flatMap((x) => x.rows);
}

/** The orders on a page: parsed rows when the page has a table or list, else the "Order placed ..." blocks of its text. */
async function ordersOn(page: Page): Promise<{ lines: OrderLine[]; wall: boolean }> {
  const text = await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "") as string;
  if (/ap\/signin|\/signin\b|login/i.test(page.url()) || (/\b(sign in|sign-in)\b/i.test(text.slice(0, 3000)) && /\b(email or mobile phone number|password)\b/i.test(text.slice(0, 3000)) && !/order placed/i.test(text))) return { lines: [], wall: true };
  const fromRows = (await extract(page)).map((cells) => parseOrderLine(cells)).filter((l): l is OrderLine => !!l);
  const fromText = parseOrdersFromText(text);
  // The text parser sees whole orders (date, total, id, items); rows win only when the text found nothing.
  return { lines: fromText.length >= fromRows.length ? fromText : fromRows, wall: false };
}

/** Which years the period touches, newest first. */
function yearsOf(p: Period): number[] {
  const out: number[] = [];
  for (let y = p.to.getFullYear(); y >= p.from.getFullYear(); y--) out.push(y);
  return out;
}

/**
 * The tool. On a site that pages by URL (Amazon), every page of each year in the period is fetched,
 * three at a time in their own tabs; elsewhere the current page is read and Next is clicked until the
 * rows are older than the period or the button is gone. A progress line every few pages, and the
 * template that worked is written to the site note so the next report replays it.
 */
export async function spendingReport(t: Tenant, row: SessionRow, args: { period?: string; site?: string; next_label?: string }): Promise<string> {
  const period = periodAsked(String(args.period ?? ""));
  if (!period) return `period not understood ("${args.period ?? ""}"); use a year ("2026"), "last 12 months", "this year", "last 3 months", "last month" or "Sep 2026"`;
  return withPage(t, row, async (page, browser) => {
    const site = args.site ? registrableDomain(String(args.site)) : registrableDomain(page.url() || "");
    const pager = URL_PAGERS.find((p) => p.host.test(site));
    const lines: OrderLine[] = [];
    let pages = 0;
    let historyStops: string | undefined;
    const progress = async (n: number) => appendAssistantMessage(row, `Reading your orders, page ${n}…`, true).catch(() => {});
    if (pager) {
      const context = browser.contexts()[0];
      for (const year of yearsOf(period)) {
        let index = 0;
        let stop = false;
        while (!stop && pages < MAX_PAGES) {
          const batch = Array.from({ length: PARALLEL }, (_, i) => index + i * pager.step);
          const results = await Promise.all(
            batch.map(async (start) => {
              const tab = await context.newPage();
              try {
                await tab.goto(pager.url(year, start), { waitUntil: "domcontentloaded", timeout: 45_000 });
                await waitInteractive(tab, 6000);
                return await ordersOn(tab);
              } catch {
                return { lines: [] as OrderLine[], wall: false };
              } finally {
                await tab.close().catch(() => {});
              }
            }),
          );
          if (results.some((r) => r.wall)) return `stopped: the site asked for a sign-in on the orders pages. Sign in (login) on the current tab, then call spending_report again.`;
          for (const r of results) {
            pages++;
            if (!r.lines.length) {
              stop = true;
              break;
            }
            lines.push(...r.lines);
          }
          index += pager.step * PARALLEL;
          if (pages % 3 === 0) await progress(pages);
        }
      }
    } else {
      // The page the model is on, then Next until the rows are older than the period or Next is gone.
      const labels = args.next_label ? [String(args.next_label), ...NEXT_LABELS] : NEXT_LABELS;
      for (; pages < MAX_PAGES; ) {
        pages++;
        const here = await ordersOn(page);
        if (here.wall) return `stopped: this page is a sign-in wall. Sign in (login) first, open the order or transaction history, then call spending_report again.`;
        const parsed = here.lines;
        if (!parsed.length && pages === 1) return `READ NOTHING: no orders or dated rows with amounts on ${page.url()}. This is not a zero; it is a page that could not be read. Open the site's order or transaction history for ${period.label} first (filter to the period where the site offers it, and make sure orders are showing), then call spending_report again.`;
        lines.push(...parsed);
        const oldest = parsed.map((l) => l.date).sort()[0];
        if (oldest && oldest < period.from.toISOString().slice(0, 10)) break;
        let clicked = false;
        for (const label of labels) {
          try {
            const { loc } = await resolveTarget(page, { text: label });
            const before = page.url();
            await loc.click({ timeout: 4000 });
            await waitInteractive(page, 6000);
            if (page.url() === before) await page.waitForTimeout(800);
            clicked = true;
            break;
          } catch {
            /* try the next label */
          }
        }
        if (!clicked) {
          if (oldest && oldest > period.from.toISOString().slice(0, 10)) historyStops = `the site shows nothing before ${oldest} (no further pages)`;
          break;
        }
        if (pages % 3 === 0) await progress(pages);
      }
    }
    if (!lines.length) return `READ NOTHING: ${pages} page${pages === 1 ? "" : "s"} of ${site || "the site"} came back without a single order for ${period.label}. This is not a zero; it is a read that failed (a sign-in wall, a page that did not load, or a filter showing the wrong period). Open the orders page in the current tab with browser_goto, confirm it shows orders for the period, then call spending_report again with next_label set to the site's next-page button; if the site truly lists no orders for the period, say so as "the orders page shows none", never as "$0 spent".`;
    const summary = summarizeOrders(lines, period, pages, historyStops);
    const text = formatSpending(summary, site || "the site");
    // The route that worked becomes a recorded reader in the site note, so the next report replays it.
    if (summary.lines.length && site) {
      const note = (await readMemory(t, `sites/${site}.md`).catch(() => null)) ?? "";
      if (!/## Spending report/.test(note)) await appendMemory(t, `sites/${site}.md`, `\n## Spending report\n- ${pager ? `pages by URL: ${pager.url(period.to.getFullYear(), 0)} (startIndex steps of ${pager.step})` : `from the order history page, Next button "${args.next_label ?? "Next"}"`}\n- use spending_report with the period; it reads every page and does the sums\n- last verified ${new Date().toISOString().slice(0, 10)}\n`).catch(() => {});
    }
    return text;
  });
}

/** Whether a task's tool results include a full-period read (a spending report, or a ledger window covering the period). */
export function periodCovered(results: string[], period: Period): boolean {
  const days = Math.round((period.to.getTime() - period.from.getTime()) / 86_400_000);
  for (const r of results) {
    if (/^SPENDING REPORT for /.test(r) && !/COVERS nothing/.test(r)) return true;
    const m = r.match(/^ledger, last (\d+) days/m);
    if (m && Number(m[1]) >= days - 2) return true;
  }
  return false;
}
