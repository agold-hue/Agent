import { listItems } from "./daily.js";
import { freshReadings } from "./proactive.js";
import type { Tenant } from "./tenant.js";
import { spendingFromInbox, spendingQuestion } from "./receipts.js";

/**
 * Answers the host writes from what it already tracks, with no model call: "what's due", "where's
 * my package", "when is the Con Ed bill due", "what did I pay Verizon". Only when the data is there
 * and fresh; otherwise the question goes to the model as before, which may go and look.
 */
const DUE = /^(?:what'?s|what is|whats|anything|what do i have) (?:due|coming up|on (?:my )?(?:plate|list|calendar|schedule))(?: (today|tomorrow|this week|soon))?\??$/i;
const PACKAGE = /^(?:where'?s|where is|any (?:news|update|word) on|status of|what'?s (?:up|happening) with) (?:my |the )?(?:package|order|delivery|parcel|shipment)s?\??$/i;
const WHEN = /^when (?:is|does|will) (?:my |the )?(.+?) (?:due|arrive|arriving|come|coming|get here|land)\??$/i;
const PAID = /^(?:what did i pay|how much (?:did i pay|was|is|do i owe)) (?:for |on |to |the |my )?(.+?)(?: (?:bill|last time|this month|last month))?\??$/i;

function when(d: Date | string | null, tz: string): string {
  if (!d) return "no date";
  const date = new Date(d);
  const today = new Date().toLocaleDateString("en-US", { timeZone: tz });
  const that = date.toLocaleDateString("en-US", { timeZone: tz });
  if (that === today) return "today";
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-US", { timeZone: tz });
  if (that === tomorrow) return "tomorrow";
  return date.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "numeric", day: "numeric" });
}
function money(cents: number | string | null | undefined): string {
  return cents != null ? ` $${(Number(cents) / 100).toFixed(2)}` : "";
}
function ago(d: Date | string, tz: string): string {
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 3_600_000) return "just now";
  if (ms < 86_400_000) return `today ${new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
  return `as of ${when(d, tz)}`;
}

/** A host-written answer, or undefined when the question is not one of these or nothing is tracked for it. */
export async function trackedAnswer(t: Tenant, text: string): Promise<string | undefined> {
  const q = text.replace(/^\[[^\]]*\]\n/, "").trim();
  const tz = t.timezone;
  let m: RegExpMatchArray | null;
  // "How much did I spend on Amazon in January", "everything I spent in 2026": the receipts in the inbox,
  // summed by the host. No browser, no model for the figures. Falls through when the inbox has nothing.
  const spend = spendingQuestion(q);
  if (spend) {
    const answer = await spendingFromInbox(t, spend).catch(() => undefined);
    if (answer) return answer;
  }
  if ((m = q.match(DUE))) {
    const days = /today/i.test(m[1] ?? "") ? 1 : /tomorrow/i.test(m[1] ?? "") ? 2 : 7;
    const items = await listItems(t, { status: "open", dueBefore: new Date(Date.now() + days * 86_400_000), limit: 12 }).catch(() => []);
    const dated = items.filter((i) => i.due_at);
    if (!dated.length) return undefined;
    return `${dated.map((i) => `${i.title}${money(i.amount_cents)}: ${when(i.due_at, tz)}`).join("\n")}\n(from what I'm tracking; I'll check anything you want live)`;
  }
  if (PACKAGE.test(q)) {
    const items = await listItems(t, { kind: "package", status: "open", limit: 6 }).catch(() => []);
    if (!items.length) return undefined;
    return items.map((i) => {
      const d = i.details as Record<string, unknown>;
      const carrier = d?.carrier ? `${String(d.carrier)}${d.tracking ? ` ${String(d.tracking)}` : ""}` : "";
      return `${i.title}${carrier ? ` (${carrier})` : ""}: ${i.due_at ? `expected ${when(i.due_at, tz)}` : "no delivery date yet"}${d?.status ? `, ${String(d.status)}` : ""} — ${ago(i.updated_at, tz)}.`;
    }).join("\n") + "\nSay \"check it\" for a fresh scan.";
  }
  if ((m = q.match(WHEN))) {
    const name = m[1].toLowerCase();
    const items = await listItems(t, { status: "open", limit: 40 }).catch(() => []);
    const hit = items.find((i) => i.title.toLowerCase().includes(name) || name.includes(i.title.toLowerCase()));
    if (!hit?.due_at) return undefined;
    return `${hit.title}${money(hit.amount_cents)}: ${when(hit.due_at, tz)} (${ago(hit.updated_at, tz)}).`;
  }
  if ((m = q.match(PAID))) {
    const name = m[1].toLowerCase();
    const readings = await freshReadings(t).catch(() => []);
    const reading = readings.find((r) => r.label.toLowerCase().includes(name) || r.domain.toLowerCase().includes(name.replace(/\s+/g, "")));
    if (reading) return `${reading.label}: ${reading.value} (read ${ago(reading.read_at, tz)}).`;
    const items = await listItems(t, { kind: "bill", limit: 40 }).catch(() => []);
    const hit = items.filter((i) => i.title.toLowerCase().includes(name)).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
    if (!hit?.amount_cents) return undefined;
    return `${hit.title}:${money(hit.amount_cents)}${hit.status === "done" ? " paid" : hit.due_at ? `, due ${when(hit.due_at, tz)}` : ""} (${ago(hit.updated_at, tz)}).`;
  }
  return undefined;
}
