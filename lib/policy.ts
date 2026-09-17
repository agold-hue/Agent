import type { Tenant } from "./tenant.js";

export interface CheckpointInput {
  action_type: string;
  summary: string;
  amount_usd?: number;
  merchant?: string;
  details: string;
  options_considered?: string[];
  recommendation?: string;
}

/** Hard floor per tenant. The agent's standing instructions can be stricter, never looser. */
export function autoApprove(t: Tenant, input: CheckpointInput): { ok: boolean; reason: string } {
  const type = String(input.action_type ?? "other").toLowerCase();
  const types = (t.settings.auto_approve_types ?? []).map((s) => s.toLowerCase());
  if (types.includes(type)) return { ok: true, reason: `action type '${type}' is on your auto-approve list` };
  const amount = Number(input.amount_usd ?? 0);
  // Learned rules: the same kind of action at the same merchant the user has approved before and agreed to stop being asked about.
  const merchant = String(input.merchant ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  for (const r of t.settings.auto_approve_rules ?? []) {
    if (r.action_type.toLowerCase() !== type) continue;
    if (r.merchant && !(merchant.includes(r.merchant.toLowerCase()) || r.merchant.toLowerCase().includes(merchant))) continue;
    if (r.max_usd != null && (amount <= 0 || amount > r.max_usd)) continue;
    return { ok: true, reason: `your rule: ${type}${r.merchant ? ` at ${r.merchant}` : ""}${r.max_usd != null ? ` under $${r.max_usd}` : ""} needs no approval` };
  }
  const ceiling = Number(t.settings.auto_approve_max_usd ?? 0);
  if (["purchase", "payment"].includes(type) && ceiling > 0 && amount > 0 && amount <= ceiling) {
    return { ok: true, reason: `$${amount.toFixed(2)} is within your $${ceiling.toFixed(2)} no-approval ceiling` };
  }
  return { ok: false, reason: "requires the user's approval" };
}

/**
 * A verification code in a short message the user sent ("905168", "code is 905168", "it's 12 34 56").
 * Only short messages count: a long sentence with a number in it is not a code.
 */
export function codeIn(text: string): string | undefined {
  const t = text.trim().replace(/^\[[^\]]+\]\n/, "").replace(/^Re: (?:(?:my|your) message )?"[^\n]*"\s*\n/, "").trim();
  if (t.length > 80) return undefined;
  // "905168", "code is 905168", "it's 12 34 56", "8442 is my email code", "the text code: 4471"
  const all = [...t.matchAll(/\d[\d\s-]*\d|\d/g)].map((m) => m[0].replace(/\D/g, ""));
  const runs = all.filter((d) => d.length >= 4 && d.length <= 8);
  if (runs.length !== 1) return undefined;
  const bare = /^\s*[\d\s-]+\s*[.!]?$/.test(t);
  const saysCode = /\b(code|otp|pin|passcode|verification|verify)\b/i.test(t);
  // "it's 905168" counts only when no phone or order number is in the same line.
  const saysIs = /\b(is|it'?s)\s*:?\s*\d/i.test(t) && !all.some((d) => d.length > 8);
  return bare || saysCode || saysIs ? runs[0] : undefined;
}

/** The host's hint to the model when a code arrives, so it is entered instead of read as chat. */
export function codeHint(code: string): string {
  return `(That looks like a verification code: ${code}. If a site is waiting for one, enter it now with login(domain, code) or browser_type into the code field, then continue. Never repeat the code back to the user.)`;
}

export function isApprovalReply(text: string): boolean {
  const first = text.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  return /^(yes|y|yes please|approve|approved|ok|okay|go|go ahead|do it|confirm|confirmed|proceed|send it|👍)\b/.test(first);
}

export function formatCheckpointEmail(input: CheckpointInput, liveViewUrl?: string): string {
  const lines = [`Need your ok: ${input.summary}`];
  const meta = [input.merchant, input.amount_usd != null ? `$${Number(input.amount_usd).toFixed(2)}` : ""].filter(Boolean).join(", ");
  if (meta) lines.push(meta);
  if (input.details?.trim()) lines.push(input.details.trim());
  if (input.recommendation) lines.push(`I'd ${input.recommendation.replace(/^(I would|I'd|I recommend to|I recommend)\s*/i, "")}`);
  if (input.options_considered?.length) lines.push(`Other options: ${input.options_considered.join("; ")}`);
  lines.push(`Reply "yes" to go ahead, or tell me what to change.`);
  if (liveViewUrl) lines.push(`Watch/take over: ${liveViewUrl}`);
  return lines.join("\n");
}

export function formatEmailApproval(draft: { to: string; cc?: string; subject: string; body: string; attachments?: string[]; purpose?: string }): string {
  const lines = [draft.purpose ? `Want to send this to ${draft.to}: ${draft.purpose}` : `Want to send this to ${draft.to}.`];
  if (draft.cc) lines.push(`Cc ${draft.cc}`);
  if (draft.attachments?.length) lines.push(`Attaching ${draft.attachments.join(", ")}`);
  lines.push(``, `Subject: ${draft.subject}`, draft.body.trim(), ``, `"yes" sends it, or tell me what to change.`);
  return lines.join("\n");
}

export function formatQuestionsEmail(questions: Array<{ question: string; default: string }>, deadlineHours: number): string {
  const lines: string[] = [];
  if (questions.length === 1) {
    lines.push(questions[0].question, `If I don't hear back in ${deadlineHours}h I'll go with: ${questions[0].default}`);
  } else {
    lines.push(`Quick ones before I continue:`);
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q.question} (default: ${q.default})`));
    lines.push(`No answer in ${deadlineHours}h and I'll use the defaults.`);
  }
  return lines.join("\n");
}
