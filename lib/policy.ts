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
  const lines = [
    `I need your approval before I do this:`,
    ``,
    `  ${input.summary}`,
    ``,
    `Type: ${input.action_type}`,
  ];
  if (input.merchant) lines.push(`Where: ${input.merchant}`);
  if (input.amount_usd != null) lines.push(`Amount: $${Number(input.amount_usd).toFixed(2)}`);
  lines.push(``, `Details:`, input.details);
  if (input.recommendation) lines.push(``, `My recommendation: ${input.recommendation}`);
  if (input.options_considered?.length) lines.push(``, `Other options I considered:`, ...input.options_considered.map((o) => `  - ${o}`));
  lines.push(``, `Reply "yes" to approve. Anything else and I will stop and treat your reply as instructions.`);
  if (liveViewUrl) lines.push(``, `Watch or take over the browser: ${liveViewUrl}`);
  return lines.join("\n");
}

export function formatEmailApproval(draft: { to: string; cc?: string; subject: string; body: string; attachments?: string[]; purpose?: string }): string {
  const lines = [`I'd like to send this email. Reply "yes" to send it as written, or tell me what to change.`, ``];
  if (draft.purpose) lines.push(`Why: ${draft.purpose}`, ``);
  lines.push(`To: ${draft.to}`);
  if (draft.cc) lines.push(`Cc: ${draft.cc}`);
  lines.push(`Subject: ${draft.subject}`);
  if (draft.attachments?.length) lines.push(`Attachments: ${draft.attachments.join(", ")}`);
  lines.push(``, `---`, draft.body, `---`);
  return lines.join("\n");
}

export function formatQuestionsEmail(questions: Array<{ question: string; default: string }>, deadlineHours: number): string {
  const lines = [`Quick questions before I continue. If I do not hear back within ${deadlineHours} hours I will go with the defaults.`, ``];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.question}`, `   Default: ${q.default}`, ``);
  });
  lines.push(`Reply with your answers in one email (numbered is easiest).`);
  return lines.join("\n");
}
