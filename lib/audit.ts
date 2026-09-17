import { complete } from "./llm.js";
import { modelFor } from "./router.js";
import { chargeCompletion, taskUserText, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";
import type { CheckpointInput } from "./policy.js";

/**
 * A second reading before money moves. Before a payment or purchase checkpoint reaches the user, a
 * cheap model compares what the checkpoint claims (amount, payee, card) with the page about to be
 * confirmed and with the request and the user's facts. A mismatch is sent back to the working model
 * as a HOLD with the specific discrepancy, so the user is never asked to spot a wrong amount, a
 * neighbour's account or the wrong card themselves.
 */
export const HOLD_PREFIX = "HOLD:";
/** Past this many holds in one task the audit steps aside, so a disagreement never loops forever. */
const MAX_HOLDS = Number(process.env.MONEY_AUDIT_MAX_HOLDS ?? 2);

export function holdsSoFar(row: SessionRow): number {
  let n = 0;
  for (const m of row.messages) if (m.role === "tool" && typeof m.content === "string" && m.content.startsWith(HOLD_PREFIX)) n++;
  return n;
}

export async function auditMoneyMove(t: Tenant, row: SessionRow, cp: CheckpointInput, pageText: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  if ((process.env.MONEY_AUDIT ?? "on") === "off" || holdsSoFar(row) >= MAX_HOLDS) return { ok: true };
  const facts = (row.contextBlock ?? "").slice(0, 6000);
  const request = taskUserText(row.messages).slice(0, 1500);
  const claim = JSON.stringify({ action: cp.action_type, summary: cp.summary, amount_usd: cp.amount_usd, merchant: cp.merchant, details: String(cp.details ?? "").slice(0, 800) });
  const c = await complete({
    model: modelFor("chat", t),
    reasoning: "none",
    maxTokens: 200,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You audit a payment or purchase an assistant is about to make for a person. You get the person's request, what is known about them (their address, cards, accounts), what the assistant claims it is about to do, and the text of the page it is about to confirm. Answer with JSON only: {\"ok\": true} when the amount, the payee or merchant, the account or service address, and the card on the page agree with the claim and the request; otherwise {\"ok\": false, \"problem\": \"<one line naming the exact discrepancy and the figures>\"}. Rules: a total on the page that differs from the claimed amount by more than a dollar is a problem (tax and delivery are fine when the request implied a purchase); a service address or account number on the page that is not the person's is a problem; a card other than the one the request or the facts name is a problem; a page that shows no amount at all is a problem. Absence of a detail in the facts is not a problem. Never invent a discrepancy.",
      },
      { role: "user", content: `Request:\n${request}\n\nKnown about the person:\n${facts}\n\nClaim:\n${claim}\n\nPage:\n${pageText.slice(0, 6000)}` },
    ],
  });
  await chargeCompletion(t, row, c, "audit").catch(() => {});
  const text = typeof c.message.content === "string" ? c.message.content : "";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { ok?: boolean; problem?: string };
    if (parsed.ok === false && parsed.problem) return { ok: false, problem: String(parsed.problem).slice(0, 300) };
  } catch {
    /* an unreadable verdict never blocks a payment */
  }
  return { ok: true };
}
