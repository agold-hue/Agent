import { env } from "./env.js";

export interface CheckpointInput {
  action_type: string;
  summary: string;
  amount_usd?: number;
  merchant?: string;
  details: string;
  options_considered?: string[];
  recommendation?: string;
}

/** Hard floor. The agent's standing instructions can be stricter, never looser. */
export function autoApprove(input: CheckpointInput): { ok: boolean; reason: string } {
  const type = String(input.action_type ?? "other").toLowerCase();
  if (env.policy.autoApproveTypes().includes(type)) return { ok: true, reason: `action type '${type}' is on the auto-approve list` };
  const amount = Number(input.amount_usd ?? 0);
  const ceiling = env.policy.autoApproveMaxUsd();
  const moneyTypes = ["purchase", "payment"];
  if (moneyTypes.includes(type) && ceiling > 0 && amount > 0 && amount <= ceiling) {
    return { ok: true, reason: `$${amount.toFixed(2)} is within the $${ceiling.toFixed(2)} no-approval ceiling` };
  }
  return { ok: false, reason: "requires the user's approval" };
}

export function isApprovalReply(text: string): boolean {
  const first = text.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  return /^(yes|y|yes please|approve|approved|ok|okay|go|go ahead|do it|confirm|confirmed|proceed|👍)\b/.test(first);
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
