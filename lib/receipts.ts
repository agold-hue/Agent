import { q } from "./db.js";
import { recordWin, upsertItem } from "./daily.js";
import { runOwnerInbox } from "./google.js";
import { complete, modelList } from "./llm.js";
import { deferToDigest } from "./notify.js";
import { modelFor } from "./router.js";
import { recordUsageEvent } from "./sessions.js";
import type { Tenant } from "./tenant.js";
import { periodAsked, type Period } from "./ledger.js";

/**
 * The receipts ledger: every order, ride, bill, refund and delivery notice in the owner's inbox,
 * parsed once by the cheapest model into a row, and kept. Spending and order questions are then
 * answered by the host from the table, exact to the cent, with no browser and no model for the
 * sums; the same feed keeps packages, bills and refunds current overnight, so the morning brief and
 * "where's my package" are proactive and free. Parsing an email costs a fraction of a cent, once.
 */
export interface Receipt {
  message_id: string;
  merchant: string;
  kind: "order" | "refund" | "shipped" | "delivered" | "bill" | "ride" | "subscription" | "payment" | "other";
  amount_cents: number;
  order_id: string | null;
  tracking: string | null;
  carrier: string | null;
  due_at: Date | null;
  occurred_at: Date;
  subject: string | null;
  items: string[];
  payment_method: string | null;
}

const MERCHANT_SENDERS = "amazon.com OR uber.com OR lyft.com OR doordash.com OR instacart.com OR grubhub.com OR walmart.com OR target.com OR costco.com OR bestbuy.com OR apple.com OR paypal.com OR venmo.com OR squareup.com OR shopify.com OR stripe.com OR coned.com OR verizon.com OR att.com OR t-mobile.com OR xfinity.com OR spectrum.com OR nationalgrid.com OR pseg.com OR ups.com OR fedex.com OR usps.com OR opentable.com OR resy.com OR airbnb.com OR delta.com OR united.com OR jetblue.com OR aa.com OR expedia.com OR booking.com OR ticketmaster.com OR netflix.com OR spotify.com OR hulu.com OR chase.com OR americanexpress.com OR discover.com OR capitalone.com OR citi.com OR wellsfargo.com OR bankofamerica.com OR geico.com OR progressive.com OR statefarm.com";
const RECEIPT_SUBJECTS = '"order confirmation" OR "your order" OR "order placed" OR "we\'ve received your order" OR receipt OR invoice OR "payment received" OR "payment confirmation" OR "payment posted" OR "thanks for your payment" OR refund OR refunded OR "has shipped" OR shipped OR "out for delivery" OR delivered OR "your trip" OR "your ride" OR "trip receipt" OR "ride receipt" OR "bill is ready" OR "statement is ready" OR "amount due" OR "is due" OR autopay OR "your subscription" OR renewal OR "order shipped" OR "arriving"';
const NOISE_SUBJECT = /\b(unsubscribe|newsletter|deal of the day|recommended for you|you might like|sale|% off|survey|rate your|review your|webinar|welcome to|verify your|security alert|sign-in|password)\b/i;

/** Sender domain -> merchant key ("amazon.com"), forgiving of subdomains and marketing senders. */
export function merchantOf(from: string): string {
  const m = from.match(/@([a-z0-9.-]+)/i);
  const host = (m?.[1] ?? from).toLowerCase().replace(/^(mail|email|no-?reply|orders?|shipment-tracking|marketplace|auto-confirm|receipts?|notifications?|update|updates|info|alerts?|billing|support|customerservice|store|news)\./, "");
  const parts = host.split(".");
  return parts.length > 2 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** "Amazon", "Con Ed", "Uber": the merchant as a person says it. */
export function merchantName(merchant: string): string {
  const known: Record<string, string> = { "amazon.com": "Amazon", "uber.com": "Uber", "lyft.com": "Lyft", "coned.com": "Con Ed", "doordash.com": "DoorDash", "instacart.com": "Instacart", "walmart.com": "Walmart", "target.com": "Target", "costco.com": "Costco", "apple.com": "Apple", "americanexpress.com": "Amex", "chase.com": "Chase", "t-mobile.com": "T-Mobile", "att.com": "AT&T", "verizon.com": "Verizon", "ups.com": "UPS", "fedex.com": "FedEx", "usps.com": "USPS", "paypal.com": "PayPal" };
  return known[merchant] ?? merchant.replace(/\.(com|net|org|co)$/, "").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The Gmail query for receipts in a window (a whole period, or the last few days), optionally one merchant. */
export function receiptsQuery(opts: { days?: number; from?: Date; to?: Date; merchant?: string }): string {
  const when = opts.from && opts.to ? `after:${fmt(new Date(opts.from.getTime() - 86_400_000))} before:${fmt(new Date(opts.to.getTime() + 2 * 86_400_000))}` : `newer_than:${Math.max(1, opts.days ?? 3)}d`;
  const who = opts.merchant ? `from:${opts.merchant}` : `(from:(${MERCHANT_SENDERS}) OR subject:(${RECEIPT_SUBJECTS}))`;
  return `${when} ${who} -category:promotions`;
}
const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

type Parsed = { kind?: string; merchant?: string; amount?: number | string; order_id?: string; tracking?: string; carrier?: string; due_date?: string; items?: string[]; payment_method?: string };

/** One email -> one row, by the cheapest model, with the sender and subject as anchors. */
async function parseReceipt(t: Tenant, mail: { from: string; subject: string; date: string; body: string }): Promise<Parsed | undefined> {
  const c = await complete({
    model: modelFor("chat", t),
    reasoning: "none",
    temperature: 0,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content:
          'You turn one email into a receipt record. Answer JSON only: {"kind": "order|refund|shipped|delivered|bill|ride|subscription|payment|other", "merchant": "<the company the money went to or came from, as the sender shows it>", "amount": <number: the total this email says was charged or, for a refund, returned; the amount due for a bill; 0 for a shipping or delivery notice; the order total for an order confirmation (not a subtotal)>, "order_id": "<order or confirmation number or null>", "tracking": "<tracking number or null>", "carrier": "<UPS|FedEx|USPS|Amazon|DHL|null>", "due_date": "<YYYY-MM-DD or null, bills only>", "items": ["<short item names, up to 6>"], "payment_method": "<card or method as written, e.g. Visa ending 4242, gift card, null>"}. A marketing email, a password or sign-in mail, a survey: {"kind": "other", "amount": 0}. Never invent a figure: if no total is in the email, amount is 0.',
      },
      { role: "user", content: `From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${mail.date}\n\n${mail.body.slice(0, 3500)}` },
    ],
  });
  await recordUsageEvent(t.id, null, "learn", c).catch(() => {});
  const text = typeof c.message.content === "string" ? c.message.content : "";
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Parsed;
  } catch {
    return undefined;
  }
}

const KINDS = new Set(["order", "refund", "shipped", "delivered", "bill", "ride", "subscription", "payment", "other"]);

/**
 * Read the receipts in a window from the inbox, parse the ones not yet in the ledger, store them,
 * and act on the notable ones (a package to track, a bill to track, a refund to celebrate). Bounded
 * per run; a second run picks up where the first stopped because parsed ids are skipped.
 */
export async function syncReceipts(t: Tenant, opts: { days?: number; from?: Date; to?: Date; merchant?: string; max?: number } = {}): Promise<{ scanned: number; parsed: number; notable: string[] }> {
  if (!t.googleRefreshToken) return { scanned: 0, parsed: 0, notable: [] };
  const max = Math.min(opts.max ?? 60, 150);
  const found = (await runOwnerInbox(t, { action: "search", query: receiptsQuery(opts), max: Math.min(max, 50) }).catch(() => [])) as Array<{ id: string; from: string; subject: string; date: string }>;
  const ids = found.map((m) => m.id);
  if (!ids.length) return { scanned: 0, parsed: 0, notable: [] };
  const have = new Set((await q<{ message_id: string }>("select message_id from receipts_ledger where user_id = $1 and message_id = any($2::text[])", [t.id, ids])).map((r) => r.message_id));
  const notable: string[] = [];
  let parsed = 0;
  for (const m of found) {
    if (have.has(m.id) || NOISE_SUBJECT.test(m.subject ?? "")) continue;
    if (parsed >= max) break;
    const mail = (await runOwnerInbox(t, { action: "read", message_id: m.id }).catch(() => undefined)) as { body?: string; new_text_only?: string; from?: string; subject?: string; date?: string } | undefined;
    if (!mail) continue;
    const p = await parseReceipt(t, { from: mail.from ?? m.from, subject: mail.subject ?? m.subject, date: mail.date ?? m.date, body: mail.new_text_only || mail.body || "" }).catch(() => undefined);
    parsed++;
    const kind = (p?.kind && KINDS.has(p.kind) ? p.kind : "other") as Receipt["kind"];
    const merchant = merchantOf(mail.from ?? m.from);
    const amount = Math.round(Math.abs(Number(String(p?.amount ?? 0).replace(/[^0-9.]/g, "")) || 0) * 100);
    const occurred = new Date(mail.date ?? m.date);
    const due = p?.due_date && !Number.isNaN(new Date(p.due_date).getTime()) ? new Date(p.due_date) : null;
    const items = Array.isArray(p?.items) ? p!.items!.map((x) => String(x).slice(0, 80)).slice(0, 6) : [];
    await q(
      "insert into receipts_ledger (user_id, message_id, merchant, kind, amount_cents, order_id, tracking, carrier, due_at, occurred_at, subject, items, payment_method) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) on conflict (user_id, message_id) do nothing",
      [t.id, m.id, merchant, kind, amount, p?.order_id ?? null, p?.tracking ?? null, p?.carrier ?? null, due, Number.isNaN(occurred.getTime()) ? new Date() : occurred, (mail.subject ?? m.subject ?? "").slice(0, 200), JSON.stringify(items), p?.payment_method ?? null],
    ).catch(() => {});
    // The proactive side: what the receipt means for the day.
    const name = merchantName(merchant);
    const label = items[0] ? `${name}: ${items[0]}` : `${name} order${p?.order_id ? ` #${p.order_id}` : ""}`;
    try {
      if (kind === "shipped" || kind === "order") await upsertItem(t, { kind: "package", title: label, due_at: null, status: "open", details: { carrier: p?.carrier ?? undefined, tracking: p?.tracking ?? undefined, order_id: p?.order_id ?? undefined, status: kind === "shipped" ? "shipped" : "ordered" }, source: `receipt:${m.id}` });
      else if (kind === "delivered") {
        await upsertItem(t, { kind: "package", title: label, status: "done", details: { status: "delivered", order_id: p?.order_id ?? undefined }, source: `receipt:${m.id}` });
        notable.push(`Delivered: ${label}.`);
      } else if (kind === "bill" && amount > 0) {
        await upsertItem(t, { kind: "bill", title: `${name} bill`, due_at: due, status: "open", amount_cents: amount, details: { autopay: /autopay/i.test(mail.subject ?? "") || undefined }, source: `receipt:${m.id}` });
        notable.push(`${name} bill: $${(amount / 100).toFixed(2)}${due ? `, due ${due.toISOString().slice(0, 10)}` : ""}.`);
      } else if (kind === "refund" && amount > 0) {
        await recordWin(t, { kind: "refund", amountCents: amount, label: `${name} refund${items[0] ? ` (${items[0]})` : ""}` });
        notable.push(`Refund landed: $${(amount / 100).toFixed(2)} from ${name}.`);
      }
    } catch {
      /* the ledger row is what matters; the item can be redone */
    }
  }
  return { scanned: found.length, parsed, notable };
}

export interface LedgerSpend {
  period: Period;
  merchant?: string;
  orders: number;
  charged: number;
  refunded: number;
  net: number;
  lines: Array<{ date: string; merchant: string; kind: string; amount: number; items: string[]; payment: string | null }>;
  emails: number;
}

/** What the ledger says was spent in a period, all merchants or one, newest first. */
export async function ledgerSpending(t: Tenant, period: Period, merchant?: string): Promise<LedgerSpend> {
  const rows = await q<{ merchant: string; kind: string; amount_cents: string; occurred_at: Date; items: string[]; payment_method: string | null }>(
    `select merchant, kind, amount_cents::text, occurred_at, items, payment_method from receipts_ledger where user_id = $1 and occurred_at >= $2 and occurred_at < $3 ${merchant ? "and merchant = $4" : ""} and kind in ('order','refund','ride','bill','subscription','payment') order by occurred_at desc`,
    merchant ? [t.id, period.from, new Date(period.to.getTime() + 86_400_000), merchant] : [t.id, period.from, new Date(period.to.getTime() + 86_400_000)],
  ).catch(() => []);
  const lines = rows.map((r) => ({ date: new Date(r.occurred_at).toISOString().slice(0, 10), merchant: r.merchant, kind: r.kind, amount: Number(r.amount_cents) / 100, items: Array.isArray(r.items) ? r.items : [], payment: r.payment_method }));
  const spent = lines.filter((l) => l.kind !== "refund" && l.amount > 0);
  const charged = Math.round(spent.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const refunded = Math.round(lines.filter((l) => l.kind === "refund").reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { period, merchant, orders: spent.length, charged, refunded, net: Math.round((charged - refunded) * 100) / 100, lines, emails: rows.length };
}

const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${SHORT_MONTH[m - 1]} ${d}`;
}

/** The answer as a person would write it, one line per order, with where it came from. */
export function formatLedgerAnswer(s: LedgerSpend): string {
  const who = s.merchant ? merchantName(s.merchant) : "all merchants";
  const label = s.period.label.replace(/^the /, "");
  if (!s.orders && !s.refunded) return `Nothing from ${who} in ${label} in your receipts.`;
  const head = `${label[0].toUpperCase()}${label.slice(1)}${s.merchant ? ` at ${who}` : ""}: ${s.orders} ${s.orders === 1 ? "order" : "orders"}, $${s.charged.toFixed(2)}${s.refunded ? ` charged, $${s.refunded.toFixed(2)} refunded, $${s.net.toFixed(2)} net` : " total"}:`;
  const lines = s.lines.slice(0, 40).map((l) => `${shortDate(l.date)} - ${l.kind === "refund" ? "refund, " : ""}${l.items.length ? l.items.join(", ") : `${merchantName(l.merchant)}${l.kind === "ride" ? " ride" : l.kind === "bill" ? " bill" : ""}`} - $${l.amount.toFixed(2)}${!s.merchant && l.items.length ? ` (${merchantName(l.merchant)})` : ""}${l.payment ? ` (${l.payment})` : ""}`);
  if (s.lines.length > 40) lines.push(`... ${s.lines.length - 40} more`);
  const payments = [...new Set(s.lines.map((l) => l.payment).filter(Boolean))];
  const foot = `From ${s.emails} receipt email${s.emails === 1 ? "" : "s"} (${shortDate(s.period.from.toISOString().slice(0, 10))} to ${shortDate(s.period.to.toISOString().slice(0, 10))}).${payments.length === 1 ? ` All on ${payments[0]}.` : ""}`;
  return `${head}\n\n${lines.join("\n")}\n\n${foot}`;
}

const MERCHANT_WORDS: Array<[RegExp, string]> = [
  [/\bamazon\b/i, "amazon.com"], [/\buber\b/i, "uber.com"], [/\blyft\b/i, "lyft.com"], [/\bdoordash\b/i, "doordash.com"], [/\binstacart\b/i, "instacart.com"], [/\bwalmart\b/i, "walmart.com"], [/\btarget\b/i, "target.com"], [/\bcostco\b/i, "costco.com"], [/\bapple\b/i, "apple.com"], [/\bcon ?ed(ison)?\b/i, "coned.com"], [/\bverizon\b/i, "verizon.com"], [/\bnetflix\b/i, "netflix.com"], [/\bairbnb\b/i, "airbnb.com"], [/\bbest ?buy\b/i, "bestbuy.com"], [/\bpaypal\b/i, "paypal.com"],
];

/** "How much did I spend on Amazon in January", "everything I spent in 2026", "my Uber rides last month": the period and, when named, the merchant. */
export function spendingQuestion(text: string, now = new Date()): { period: Period; merchant?: string } | undefined {
  const t = text.replace(/^\[[^\]]*\]\n/, "").trim();
  if (!/\b(spend|spent|spending|buy|bought|purchase[sd]?|orders?|rides?|receipts?|paid|what did i (get|order)|everything i)\b/i.test(t)) return undefined;
  if (/\b(cancel|return|refund me|dispute|track|where|status)\b/i.test(t)) return undefined;
  const period = periodAsked(t, now);
  if (!period) return undefined;
  const merchant = MERCHANT_WORDS.find(([re]) => re.test(t))?.[1];
  return { period, merchant };
}

/** The last time the ledger was synced for this customer, for on-demand refreshes. */
const lastSync = new Map<string, number>();

/**
 * Answer a spending question from the inbox: sync the period's receipts if the ledger is thin there
 * (bounded), then sum. Undefined when Google is not connected or the receipts have nothing, so the
 * caller can fall back to the site.
 */
export async function spendingFromInbox(t: Tenant, question: { period: Period; merchant?: string }): Promise<string | undefined> {
  if (!t.googleRefreshToken) return undefined;
  const key = `${t.id}:${question.merchant ?? "*"}:${question.period.from.toISOString().slice(0, 10)}`;
  if (Date.now() - (lastSync.get(key) ?? 0) > 30 * 60_000) {
    lastSync.set(key, Date.now());
    // One month at a time, so a year is twelve bounded reads; the newest months first.
    const months: Array<{ from: Date; to: Date }> = [];
    for (let d = new Date(question.period.to.getFullYear(), question.period.to.getMonth(), 1); d >= new Date(question.period.from.getFullYear(), question.period.from.getMonth(), 1); d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) months.push({ from: d < question.period.from ? question.period.from : d, to: new Date(Math.min(new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime(), question.period.to.getTime())) });
    for (const m of months.slice(0, 13)) await syncReceipts(t, { from: m.from, to: m.to, merchant: question.merchant, max: 50 }).catch(() => undefined);
  }
  const spend = await ledgerSpending(t, question.period, question.merchant);
  if (!spend.emails) return undefined;
  return formatLedgerAnswer(spend);
}

/** Which model does the parsing, for the stats line. */
export const receiptsModel = (t: Tenant) => modelList(modelFor("chat", t))[0];
