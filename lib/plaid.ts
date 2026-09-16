import { decrypt, encrypt } from "./crypto.js";
import { one, q } from "./db.js";
import { env } from "./env.js";
import type { Tenant } from "./tenant.js";

/**
 * Bank balances and transactions through Plaid instead of a portal session: one HTTPS call, no
 * browser, no login wall. The customer connects an account once with Plaid Link (Settings); the
 * access token is envelope-encrypted with the customer id as associated data like every other
 * secret. PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV (sandbox | development | production) turn it on.
 */
const BASE: Record<string, string> = { sandbox: "https://sandbox.plaid.com", development: "https://development.plaid.com", production: "https://production.plaid.com" };

export function plaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const base = BASE[(process.env.PLAID_ENV ?? "sandbox").toLowerCase()] ?? BASE.sandbox;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error_code?: string; error_message?: string };
  if (!res.ok || data.error_code) throw new Error(`Plaid ${path}: ${data.error_code ?? res.status} ${data.error_message ?? ""}`.trim());
  return data;
}

export interface PlaidItem {
  id: string;
  item_id: string;
  institution: string | null;
  cursor: string | null;
  created_at: Date;
}

export async function listItems(t: Tenant): Promise<PlaidItem[]> {
  return q<PlaidItem>("select id, item_id, institution, cursor, created_at from plaid_items where user_id = $1 order by created_at", [t.id]);
}

/** A Link token for the Settings page to open Plaid Link with. */
export async function createLinkToken(t: Tenant): Promise<string> {
  const r = await call<{ link_token: string }>("/link/token/create", {
    user: { client_user_id: t.id },
    client_name: env.assistantName(),
    products: ["transactions"],
    country_codes: (process.env.PLAID_COUNTRY_CODES ?? "US").split(",").map((s) => s.trim().toUpperCase()),
    language: "en",
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  });
  return r.link_token;
}

/** Link succeeded in the page: trade the public token for the item's access token and store it encrypted. */
export async function exchangePublicToken(t: Tenant, publicToken: string, institution?: string): Promise<PlaidItem> {
  const r = await call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
  const row = await one<PlaidItem>(
    "insert into plaid_items (user_id, item_id, access_token_enc, institution) values ($1,$2,$3,$4) on conflict (item_id) do update set access_token_enc = $3, institution = coalesce($4, plaid_items.institution), updated_at = now() returning id, item_id, institution, cursor, created_at",
    [t.id, r.item_id, encrypt(r.access_token, t.id), institution ?? null],
  );
  return row!;
}

export async function removeItem(t: Tenant, id: string): Promise<boolean> {
  const row = await one<{ access_token_enc: string }>("select access_token_enc from plaid_items where user_id = $1 and id = $2", [t.id, id]);
  if (!row) return false;
  await call("/item/remove", { access_token: decrypt(row.access_token_enc, t.id) }).catch(() => {});
  await q("delete from plaid_items where user_id = $1 and id = $2", [t.id, id]);
  return true;
}

async function tokensFor(t: Tenant): Promise<Array<{ institution: string | null; token: string }>> {
  const rows = await q<{ institution: string | null; access_token_enc: string }>("select institution, access_token_enc from plaid_items where user_id = $1 order by created_at", [t.id]);
  return rows.map((r) => ({ institution: r.institution, token: decrypt(r.access_token_enc, t.id) }));
}

export interface Account {
  institution: string | null;
  account_id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  current: number | null;
  available: number | null;
  currency: string | null;
}

export async function balances(t: Tenant): Promise<Account[]> {
  const out: Account[] = [];
  for (const { institution, token } of await tokensFor(t)) {
    const r = await call<{ accounts: Array<{ account_id: string; name: string; official_name?: string; mask?: string; type: string; subtype?: string; balances: { current?: number; available?: number; iso_currency_code?: string } }> }>("/accounts/balance/get", { access_token: token });
    for (const a of r.accounts) out.push({ institution, account_id: a.account_id, name: a.name || a.official_name || a.type, mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null, current: a.balances.current ?? null, available: a.balances.available ?? null, currency: a.balances.iso_currency_code ?? null });
  }
  return out;
}

export interface Txn {
  date: string;
  name: string;
  merchant: string | null;
  amount: number;
  category: string | null;
  account: string;
  pending: boolean;
}

/**
 * Transactions in a date window (newest first), optionally filtered by words in the name, merchant
 * or category ("gas", "shell", "uber"). Plaid amounts are positive for money out.
 */
export async function transactions(t: Tenant, opts: { days?: number; query?: string; account?: string; limit?: number }): Promise<{ rows: Txn[]; total: number }> {
  const days = Math.max(1, Math.min(730, opts.days ?? 30));
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const words = (opts.query ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  const out: Txn[] = [];
  for (const { token } of await tokensFor(t)) {
    let offset = 0;
    for (;;) {
      const r = await call<{ transactions: Array<{ date: string; name: string; merchant_name?: string; amount: number; personal_finance_category?: { primary?: string; detailed?: string }; category?: string[]; account_id: string; pending: boolean }>; accounts: Array<{ account_id: string; name: string; mask?: string }>; total_transactions: number }>(
        "/transactions/get",
        { access_token: token, start_date: iso(start), end_date: iso(end), options: { count: 500, offset, include_personal_finance_category: true } },
      );
      const names = new Map(r.accounts.map((a) => [a.account_id, `${a.name}${a.mask ? ` ••${a.mask}` : ""}`]));
      for (const x of r.transactions) {
        const category = x.personal_finance_category?.detailed ?? x.personal_finance_category?.primary ?? x.category?.join(" > ") ?? null;
        const account = names.get(x.account_id) ?? x.account_id;
        if (opts.account && !account.toLowerCase().includes(opts.account.toLowerCase())) continue;
        const hay = `${x.name} ${x.merchant_name ?? ""} ${category ?? ""}`.toLowerCase();
        if (words.length && !words.some((w) => hay.includes(w))) continue;
        out.push({ date: x.date, name: x.name, merchant: x.merchant_name ?? null, amount: x.amount, category, account, pending: x.pending });
      }
      offset += r.transactions.length;
      if (offset >= r.total_transactions || !r.transactions.length) break;
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return { rows: out.slice(0, opts.limit ?? 200), total: out.length };
}

/** The bank tool: balances, or transactions with a filter and total. */
export async function runBankTool(t: Tenant, args: Record<string, unknown>): Promise<string> {
  if (!plaidConfigured()) return "Bank access is not set up on this server (PLAID_CLIENT_ID / PLAID_SECRET). Use the bank's site with the browser, or the inbox.";
  const items = await listItems(t);
  if (!items.length) return "No bank accounts are connected. Ask the user to connect one under Settings > Bank accounts (Plaid); meanwhile use the bank's site or the inbox.";
  const action = String(args.action ?? "balances");
  if (action === "balances") {
    const accts = await balances(t);
    return accts.map((a) => `${a.institution ? `${a.institution} ` : ""}${a.name}${a.mask ? ` ••${a.mask}` : ""} (${a.subtype ?? a.type}): current ${fmt(a.current, a.currency)}${a.available != null && a.available !== a.current ? `, available ${fmt(a.available, a.currency)}` : ""}`).join("\n") || "No accounts returned.";
  }
  const { rows, total } = await transactions(t, { days: args.days != null ? Number(args.days) : 30, query: args.query ? String(args.query) : undefined, account: args.account ? String(args.account) : undefined, limit: args.limit != null ? Number(args.limit) : 200 });
  if (!rows.length) return `No transactions matched${args.query ? ` "${String(args.query)}"` : ""} in the last ${args.days ?? 30} days.`;
  const sum = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const lines = rows.map((r) => `${r.date} | ${r.merchant ?? r.name} | ${r.amount < 0 ? "+" : ""}$${Math.abs(r.amount).toFixed(2)}${r.pending ? " (pending)" : ""} | ${r.category ?? ""} | ${r.account}`);
  return `${rows.length}${total > rows.length ? ` of ${total}` : ""} transactions${args.query ? ` matching "${String(args.query)}"` : ""}, last ${args.days ?? 30} days; money out total $${sum.toFixed(2)}\ndate | merchant | amount | category | account\n${lines.join("\n")}`;
}

const fmt = (n: number | null, cur: string | null) => (n == null ? "n/a" : `${cur && cur !== "USD" ? `${cur} ` : "$"}${n.toFixed(2)}`);
