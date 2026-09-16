import { parsePaths, parseReaders } from "./browser-extras.js";
import { one, q } from "./db.js";
import { addFollowUp } from "./followups.js";
import { complete, type ChatMessage } from "./llm.js";
import { appendMemory, readMemory } from "./memory.js";
import { pushToUser } from "./push.js";
import { modelFor } from "./router.js";
import { chargeCompletion, messageText, taskStart, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";
import { localClock } from "./transcript.js";

/**
 * The host's own initiative: promises the agent made become follow-ups, pending approvals get one
 * reminder before they expire, failures become fix cards, repeated approvals become a proposed rule,
 * replies are graded on a sample and the recurring flaw becomes a playbook line, and the figures a
 * customer keeps asking for are refreshed overnight so the morning answer is instant.
 */

// ------------------------------------------------------------------ 2. promises become follow-ups

const PROMISE = /\b(?:i(?:'|’)?ll|i will|will)\s+(?:check|follow up|look|chase|ping|report|update|come back|confirm|circle back|let you know|watch|re-?check|try again)\b[^.!?\n]{0,80}/i;
const TIME_PHRASE = /\b(tomorrow(?: morning| afternoon| evening| night)?|tonight|this (?:afternoon|evening)|in (\d+) (minutes?|mins?|hours?|hrs?|days?)|(?:on |by |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: morning| afternoon| evening)?|(?:at |by )(\d{1,2})(?::(\d{2}))?\s?(am|pm)|next week|end of (?:the )?(day|week)|(?:on |by )?the (\d{1,2})(?:st|nd|rd|th))\b/i;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The time a promise names, as an instant, in the user's zone. Undefined when there is no time or it is in the past. */
export function promiseTime(sentence: string, now: Date, tz: string): Date | undefined {
  const m = sentence.match(TIME_PHRASE);
  if (!m) return undefined;
  const clock = localClock(tz, now);
  const local = (dayOffset: number, h: number, min = 0) => {
    // Build the instant from the user's local date: shift by the zone's current offset.
    const base = new Date(`${clock.day}T00:00:00Z`);
    const offsetMin = zoneOffsetMinutes(tz, now);
    return new Date(base.getTime() + dayOffset * 86_400_000 + (h * 60 + min - offsetMin) * 60_000);
  };
  const phrase = m[1].toLowerCase();
  let due: Date | undefined;
  if (phrase.startsWith("tomorrow")) due = local(1, /afternoon/.test(phrase) ? 14 : /evening|night/.test(phrase) ? 19 : 9);
  else if (phrase === "tonight" || phrase === "this evening") due = local(0, 19);
  else if (phrase === "this afternoon") due = local(0, 14);
  else if (m[2]) {
    const n = Number(m[2]);
    const u = m[3].toLowerCase();
    due = new Date(now.getTime() + n * (u.startsWith("min") ? 60_000 : u.startsWith("h") ? 3_600_000 : 86_400_000));
  } else if (m[4]) {
    const target = DAYS.indexOf(m[4].toLowerCase());
    const today = DAYS.indexOf(clock.weekday.toLowerCase().slice(0, 3) === "sun" ? "sunday" : DAYS.find((d) => d.startsWith(clock.weekday.toLowerCase().slice(0, 3))) ?? "monday");
    let offset = (target - today + 7) % 7;
    if (offset === 0) offset = 7;
    due = local(offset, /afternoon/.test(phrase) ? 14 : /evening/.test(phrase) ? 19 : 9);
  } else if (m[5]) {
    let h = Number(m[5]);
    const min = Number(m[6] ?? 0);
    const ap = m[7]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    due = local(0, h, min);
    if (due.getTime() <= now.getTime()) due = local(1, h, min);
  } else if (phrase === "next week") due = local(7, 9);
  else if (m[8]) due = m[8] === "day" ? local(0, 17) : local(((5 - DAYS.indexOf(DAYS.find((d) => d.startsWith(clock.weekday.toLowerCase().slice(0, 3))) ?? "monday") + 7) % 7) || 7, 17);
  else if (m[9]) {
    const day = Number(m[9]);
    const [y, mo] = clock.day.split("-").map(Number);
    const thisMonth = new Date(Date.UTC(y, mo - 1, day, 9 - Math.round(zoneOffsetMinutes(tz, now) / 60)));
    due = thisMonth.getTime() > now.getTime() ? thisMonth : new Date(Date.UTC(y, mo, day, 9 - Math.round(zoneOffsetMinutes(tz, now) / 60)));
  }
  if (!due || Number.isNaN(due.getTime()) || due.getTime() < now.getTime() + 60_000) return undefined;
  return due;
}

function zoneOffsetMinutes(tz: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** The first promise with a time in a reply: the sentence and when. */
export function findPromise(reply: string, now: Date, tz: string): { sentence: string; due: Date } | undefined {
  for (const sentence of reply.split(/(?<=[.!?])\s+|\n/)) {
    if (!PROMISE.test(sentence)) continue;
    const due = promiseTime(sentence, now, tz);
    if (due) return { sentence: sentence.trim(), due };
  }
  return undefined;
}

/** Did the task already schedule a follow-up itself? */
function scheduledFollowUp(messages: ChatMessage[]): boolean {
  for (let i = taskStart(messages); i < messages.length; i++) if (messages[i].tool_calls?.some((c) => c.function.name === "schedule_follow_up" && !/cancel_id/.test(c.function.arguments))) return true;
  return false;
}

/** After a reply: the promise it made becomes a follow-up unless the model set one. Returns the follow-up's due time if created. */
export async function keepPromise(t: Tenant, row: SessionRow, reply: string): Promise<Date | undefined> {
  if (scheduledFollowUp(row.messages)) return undefined;
  const found = findPromise(reply, new Date(), t.timezone);
  if (!found) return undefined;
  await addFollowUp(t.id, { due: found.due, what: `You told the user: "${found.sentence.slice(0, 200)}". Do it now (check, chase, confirm) and report the result in one or two lines.`, channel: row.channel === "email" ? "email" : "chat" });
  return found.due;
}

// ------------------------------------------------------------------ 5. one reminder before a pending approval or question expires

const REMIND_BEFORE_MS = Number(process.env.PENDING_REMIND_BEFORE_MINUTES ?? 60) * 60_000;
const REMIND_AFTER_MS = Number(process.env.PENDING_REMIND_AFTER_HOURS ?? 2) * 3_600_000;

/** Sessions waiting on the user that deserve their one reminder now. */
export async function remindPending(): Promise<number> {
  const rows = await q<SessionRow>(
    `select * from agent_sessions where status = 'waiting' and pending_kind is not null and reminded_at is null
       and ((pending_deadline is not null and pending_deadline < now() + ($1 || ' milliseconds')::interval and pending_deadline > now())
         or (pending_deadline is null and updated_at < now() - ($2 || ' milliseconds')::interval)) limit 20`,
    [String(REMIND_BEFORE_MS), String(REMIND_AFTER_MS)],
  );
  let sent = 0;
  for (const row of rows) {
    const { tenantById } = await import("./tenant.js");
    const t = await tenantById(row.user_id);
    if (!t) continue;
    const call = [...row.messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === row.pending_event_id));
    const tc = call?.tool_calls?.find((c) => c.id === row.pending_event_id);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc?.function.arguments ?? "{}");
    } catch {
      /* no summary */
    }
    const what = row.pending_kind === "checkpoint" ? `Still waiting on your ok: ${String(args.summary ?? row.title ?? "an action").slice(0, 120)}. Reply "yes" to approve or "no" to skip.` : row.pending_kind === "send_email" ? `Still waiting on your ok to send an email${args.to ? ` to ${String(args.to)}` : ""}. Reply "send it" or "no".` : `Still waiting on your answer${row.title ? ` for: ${row.title.slice(0, 100)}` : ""}. A word back keeps it moving.`;
    await pushToUser(t, { title: "Waiting on you", body: what, tag: row.id }).catch(() => {});
    await q("update agent_sessions set reminded_at = now() where id = $1", [row.id]);
    sent++;
  }
  return sent;
}

// ------------------------------------------------------------------ 8. a failure becomes a fix card

export type FixKind = "add_login" | "connect_google" | "enable_relay" | "add_bank" | "check_login";
export interface Fix {
  id: string;
  kind: FixKind;
  domain: string | null;
  message: string;
  created_at: Date;
}

/** What blocked this task, from its tool results: a missing login, a rejected login, a blocked site, no Google. */
export function detectFixes(messages: ChatMessage[], hasGoogle: boolean, relayOnline: boolean): Array<{ kind: FixKind; domain?: string; message: string }> {
  const out: Array<{ kind: FixKind; domain?: string; message: string }> = [];
  const seen = new Set<string>();
  const add = (kind: FixKind, message: string, domain?: string) => {
    const key = `${kind}:${domain ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, domain, message });
  };
  const start = taskStart(messages);
  const calls = new Map<string, Record<string, unknown>>();
  for (let i = start; i < messages.length; i++) {
    for (const c of messages[i].tool_calls ?? []) {
      try {
        calls.set(c.id, { name: c.function.name, ...JSON.parse(c.function.arguments || "{}") });
      } catch {
        /* ignore */
      }
    }
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const call = calls.get(m.tool_call_id ?? "");
    const domain = typeof call?.domain === "string" ? String(call.domain).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : undefined;
    if (/"status":"no_credentials"|\bno_credentials\b/.test(m.content) && domain) add("add_login", `Add your ${domain} login so this can be done without you.`, domain);
    else if (/"status":"needs_user"/.test(m.content) && /rejected|wrong password|incorrect|invalid credentials|could not sign in/i.test(m.content) && domain) add("check_login", `The saved ${domain} login was rejected. Check the username and password.`, domain);
    if (/bot check|blocked the plain fetch|access denied|verify you are human/i.test(m.content) && !relayOnline) {
      const site = (m.content.match(/https?:\/\/([\w.-]+)/) ?? [])[1]?.replace(/^www\./, "");
      if (site) add("enable_relay", `${site} blocks hosted browsers. Set up the local browser (Settings) and it will work from your computer.`, site);
    }
    if (!hasGoogle && /Google is NOT connected|google not connected|connect google/i.test(m.content)) add("connect_google", "Connect Google (Settings) for your calendar, inbox and Drive.");
  }
  return out;
}

export async function recordFixes(t: Tenant, fixes: Array<{ kind: FixKind; domain?: string; message: string }>): Promise<number> {
  let n = 0;
  for (const f of fixes) {
    const exists = await one("select 1 from fixes where user_id = $1 and kind = $2 and coalesce(domain, '') = $3 and done_at is null", [t.id, f.kind, f.domain ?? ""]);
    if (exists) continue;
    await q("insert into fixes (user_id, kind, domain, message) values ($1,$2,$3,$4)", [t.id, f.kind, f.domain ?? null, f.message]);
    n++;
  }
  if (n) await pushToUser(t, { title: "One thing would unblock this", body: fixes[0].message, tag: `fix-${fixes[0].kind}` }).catch(() => {});
  return n;
}

export async function listFixes(t: Tenant): Promise<Fix[]> {
  return q<Fix>("select id, kind, domain, message, created_at from fixes where user_id = $1 and done_at is null order by created_at desc limit 10", [t.id]);
}

export async function resolveFix(t: Tenant, id: string): Promise<void> {
  await q("update fixes set done_at = now() where user_id = $1 and id = $2", [t.id, id]);
}

/** A login saved for a domain clears its fix cards. */
export async function resolveFixesFor(t: Tenant, kind: FixKind, domain?: string): Promise<void> {
  await q("update fixes set done_at = now() where user_id = $1 and kind = $2 and ($3::text is null or domain = $3) and done_at is null", [t.id, kind, domain ?? null]);
}

// ------------------------------------------------------------------ 4. repeated approvals become a proposed rule

export const PROPOSAL_THRESHOLD = Number(process.env.APPROVAL_PROPOSAL_AFTER ?? 3);

export interface ApprovalRule {
  action_type: string;
  merchant?: string;
  max_usd?: number;
}

export async function logApproval(t: Tenant, row: SessionRow, decision: "approved" | "denied" | "auto"): Promise<{ action_type: string; merchant: string | null; amount_usd: number | null } | undefined> {
  const call = [...row.messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === row.pending_event_id));
  const tc = call?.tool_calls?.find((c) => c.id === row.pending_event_id && c.function.name === "checkpoint");
  if (!tc) return undefined;
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(tc.function.arguments || "{}");
  } catch {
    return undefined;
  }
  const action_type = String(a.action_type ?? "other").toLowerCase();
  const merchant = a.merchant ? String(a.merchant).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").slice(0, 80) : null;
  const amount_usd = a.amount_usd != null ? Number(a.amount_usd) : null;
  await q("insert into approval_log (user_id, action_type, merchant, amount_usd, summary, decision, session_id) values ($1,$2,$3,$4,$5,$6,$7)", [t.id, action_type, merchant, amount_usd, String(a.summary ?? "").slice(0, 200), decision, row.id]);
  return { action_type, merchant, amount_usd };
}

/**
 * After an approval: if this customer has approved the same kind of action at the same merchant
 * PROPOSAL_THRESHOLD times with no denial, and no rule covers it, a note the model turns into an offer.
 */
export async function approvalProposal(t: Tenant, last: { action_type: string; merchant: string | null; amount_usd: number | null }): Promise<string | undefined> {
  const rules = (t.settings.auto_approve_rules ?? []) as ApprovalRule[];
  if (rules.some((r) => r.action_type === last.action_type && (r.merchant ?? null) === last.merchant)) return undefined;
  const key = `proposal:${last.action_type}:${last.merchant ?? ""}`;
  if (await one("select 1 from daily_marks where user_id = $1 and kind = $2", [t.id, key])) return undefined;
  const r = await q<{ decision: string; n: string; max: string | null }>("select decision, count(*)::text as n, max(amount_usd)::text as max from approval_log where user_id = $1 and action_type = $2 and coalesce(merchant, '') = $3 and created_at > now() - interval '90 days' group by decision", [t.id, last.action_type, last.merchant ?? ""]);
  const approved = Number(r.find((x) => x.decision === "approved")?.n ?? 0);
  const denied = Number(r.find((x) => x.decision === "denied")?.n ?? 0);
  if (approved < PROPOSAL_THRESHOLD || denied > 0) return undefined;
  const max = Number(r.find((x) => x.decision === "approved")?.max ?? 0);
  const cap = max > 0 ? Math.ceil((max * 1.25) / 5) * 5 : undefined;
  await q("insert into daily_marks (user_id, kind, day) values ($1, $2, current_date) on conflict do nothing", [t.id, key]);
  return `(Host: the user has approved ${approved} ${last.action_type}${last.merchant ? ` at ${last.merchant}` : ""} actions${cap ? `, all under $${cap}` : ""} and never declined one. When this task is done, add ONE line to your reply offering to stop asking for these${cap ? ` under $${cap}` : ""}. If they say yes, call approval_rule(action "add", action_type "${last.action_type}"${last.merchant ? `, merchant "${last.merchant}"` : ""}${cap ? `, max_usd ${cap}` : ""}) and confirm in one line.)`;
}

// ------------------------------------------------------------------ 10. a self-grading loop that feeds the playbooks

const GRADE_SAMPLE = Number(process.env.GRADE_SAMPLE ?? 0.34);
const ISSUES = ["filler", "offered_instead_of_acting", "no_figure", "links_or_markers", "too_long", "restated_request", "generic_advice", "wrong_window", "none"];

export async function gradeReply(t: Tenant, row: SessionRow, reply: string): Promise<void> {
  if (Math.random() > GRADE_SAMPLE) return;
  const request = messageText(row.messages[taskStart(row.messages)] ?? { role: "user", content: "" }).replace(/^\[[^\]]+\]\n/, "");
  const c = await complete({
    model: modelFor("chat", t),
    temperature: 0,
    maxTokens: 60,
    messages: [
      { role: "system", content: `Grade a personal assistant's reply to its boss. Reply with JSON only: {"score": 0-3, "issue": one of ${JSON.stringify(ISSUES)}}. 3 = the answer first, exact figures, plain words, ends on the next move. Issue = the single worst flaw, or "none".` },
      { role: "user", content: `Request: ${request.slice(0, 500)}\n\nReply: ${reply.slice(0, 1200)}` },
    ],
  });
  await chargeCompletion(t, row, c, "grade").catch(() => {});
  const text = typeof c.message.content === "string" ? c.message.content : "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const g = JSON.parse(m[0]) as { score?: number; issue?: string };
    const issue = ISSUES.includes(String(g.issue)) ? String(g.issue) : "none";
    await q("insert into reply_grades (user_id, session_id, score, issue) values ($1,$2,$3,$4)", [t.id, row.id, Math.max(0, Math.min(3, Number(g.score ?? 0))), issue]);
  } catch {
    /* an ungradable grade is no grade */
  }
}

const ISSUE_LINE: Record<string, string> = {
  filler: "Replies carried filler this week (\"hang tight\", \"you're welcome!\", openers): cut every line that carries no information.",
  offered_instead_of_acting: "Replies offered to check instead of checking this week: do the lookup, then reply with the result.",
  no_figure: "Replies lacked the exact figure this week: every report carries the amount, date or confirmation.",
  links_or_markers: "Replies carried links or reference markers this week: none in chat; name a source in words if it matters.",
  too_long: "Replies ran long this week: two to four lines; the figure first.",
  restated_request: "Replies restated the request this week: start with the answer.",
  generic_advice: "Advice was generic this week: draw it from projects, actions and tracked items, with the concrete next step.",
  wrong_window: "Date windows were misread this week: \"last N days\" is the N days before now; say what happened, not the dates.",
};

/** Once a week: the customer's most frequent flaw becomes one line in preferences.md. */
export async function weeklyStyleNote(t: Tenant): Promise<string | undefined> {
  const r = await one<{ issue: string; n: string }>("select issue, count(*)::text as n from reply_grades where user_id = $1 and issue <> 'none' and created_at > now() - interval '7 days' group by issue order by 2 desc limit 1", [t.id]);
  if (!r || Number(r.n) < 3 || !ISSUE_LINE[r.issue]) return undefined;
  const line = `- ${ISSUE_LINE[r.issue]}`;
  const existing = (await readMemory(t, "preferences.md").catch(() => null)) ?? "";
  if (existing.includes(ISSUE_LINE[r.issue])) return undefined;
  await appendMemory(t, "preferences.md", `${existing.includes("## Style notes") ? "" : "\n## Style notes (from weekly grading; edit or delete)\n"}${line} (${new Date().toISOString().slice(0, 10)})\n`);
  return line;
}

// ------------------------------------------------------------------ 9. contextual quick replies

/** Chips under the chat, from the last reply and the thread's state: one tap is a full request. */
export function quickReplies(lastAgentText: string, status: string, pending: string | null): string[] {
  if (pending === "checkpoint") return ["Approve", "Not now", "Change something"];
  if (pending === "send_email") return ["Send it", "Edit it first", "Don't send"];
  if (pending === "ask_user") return ["Use the defaults", "Let me think"];
  if (status === "running") return ["How's it going?", "Stop that"];
  const t = lastAgentText.trim();
  const out: string[] = [];
  const time = t.match(/\b(?:for|at)\s(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i)?.[1];
  if (/\b(want me to|shall i|should i|do you want me to)\b[^?]*\b(book|order|reorder|line up|schedule|set up|pay|send|call|cancel|renew|buy)\b/i.test(t)) out.push(time ? `Yes, book it for ${time}` : "Yes, do it", "Not yet");
  else if (/\?\s*$/.test(t) && /\b(yes|no|ok|okay|right|correct|want|should)\b/i.test(t)) out.push("Yes", "No");
  if (/\b(keep going|tell me to keep going)\b/i.test(t)) out.push("Keep going");
  if (/\b(pages?\s\d+)/i.test(t) && /document|lease|contract|statement|policy/i.test(t)) out.push("Show me that page");
  if (/\b(refund|dispute|claim)\b/i.test(t)) out.push("What's the next step?");
  if (/\$\s?\d/.test(t) && /\b(due|owe|balance|bill)\b/i.test(t)) out.push("Pay it");
  if (/\b(price|drop|in stock|available|opening)\b/i.test(t)) out.push("Watch it for me");
  if (!out.length) out.push("Thanks", "What's today?");
  else if (!out.includes("Thanks")) out.push("Thanks");
  return [...new Set(out)].slice(0, 4);
}

// ------------------------------------------------------------------ 1. overnight refresh of the numbers they ask for

export interface Reading {
  domain: string;
  label: string;
  value: string;
  read_at: Date;
}

const REFRESH_HOUR = Number(process.env.READINGS_REFRESH_HOUR ?? 4);
const REFRESH_MIN_USES = Number(process.env.READINGS_MIN_USES ?? 2);

/** A recorded path was replayed or recorded: count it, so only the sites a customer keeps coming back to are refreshed. */
export async function notePathUse(t: Tenant, domain: string, name: string): Promise<void> {
  await q("insert into path_uses (user_id, domain, name, uses, last_used_at) values ($1,$2,$3,1,now()) on conflict (user_id, domain, name) do update set uses = path_uses.uses + 1, last_used_at = now()", [t.id, domain, name.slice(0, 120)]).catch(() => {});
}

/** Today's fresh readings for the context block, newest first. */
export async function freshReadings(t: Tenant): Promise<Reading[]> {
  return q<Reading>("select domain, label, value, read_at from readings where user_id = $1 and read_at > now() - interval '20 hours' order by read_at desc limit 12", [t.id]).catch(() => []);
}

export function formatReadings(rs: Reading[], tz: string): string {
  if (!rs.length) return "";
  const when = (d: Date) => {
    const s = localClock(tz, new Date(d));
    return `${String(s.h).padStart(2, "0")}:${String(s.m).padStart(2, "0")}`;
  };
  return `Fresh readings the host took this morning (answer from these; re-read only if the user wants it live):\n${rs.map((r) => `- ${r.domain}: ${r.label} = ${r.value} (read ${when(r.read_at)})`).join("\n")}`;
}

/**
 * At the refresh hour, for each site this customer replays at least REFRESH_MIN_USES times: run the
 * path and read the figures, store them. One browser session per customer per night at most.
 */
export async function refreshReadings(t: Tenant, replay: (domain: string, name: string) => Promise<string>): Promise<number> {
  const clock = localClock(t.timezone);
  if (clock.h !== REFRESH_HOUR) return 0;
  if (await one("select 1 from daily_marks where user_id = $1 and kind = 'readings' and day = $2::date", [t.id, clock.day])) return 0;
  await q("insert into daily_marks (user_id, kind, day) values ($1, 'readings', $2::date) on conflict do nothing", [t.id, clock.day]);
  const sites = await q<{ domain: string; name: string }>("select domain, name from path_uses where user_id = $1 and uses >= $2 and last_used_at > now() - interval '45 days' order by uses desc limit 4", [t.id, REFRESH_MIN_USES]);
  let stored = 0;
  for (const s of sites) {
    const note = await readMemory(t, `sites/${s.domain}.md`).catch(() => null);
    if (!note || !parseReaders(note).length || !parsePaths(note).some((p) => p.name === s.name)) continue;
    const result = await replay(s.domain, s.name).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    const line = result.match(/read off the page: (.+)/)?.[1];
    if (!line) continue;
    for (const pair of line.split("; ")) {
      const [label, ...rest] = pair.split(": ");
      const value = rest.join(": ").trim();
      if (!label || !value) continue;
      await q("insert into readings (user_id, domain, label, value) values ($1,$2,$3,$4)", [t.id, s.domain, label.trim().slice(0, 80), value.slice(0, 80)]);
      stored++;
    }
  }
  return stored;
}
