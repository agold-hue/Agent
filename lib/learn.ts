import { complete } from "./llm.js";
import { appendMemory, readMemory } from "./memory.js";
import { modelFor } from "./router.js";
import { chargeCompletion, isUserMessage, messageText, taskStart, type SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * Learning from corrections. When the user's message corrects what the agent just did or said
 * ("no, the other account", "never before 9", "I said the Brooklyn store"), the host asks the fast
 * model for the one durable rule in it and files it under "## Learned" in preferences.md. The next
 * task reads it with the rest of the customer's facts, so a correction is made once.
 */
export const CORRECTION = /^(no|nope|wrong|not that|that'?s (not|wrong)|i said|i meant|i told you|actually|never|always|from now on|stop|don'?t|do not|please don'?t|not the|use the|it'?s the|you (got|have) (it|that) wrong|incorrect)\b/i;

export function isCorrection(text: string): boolean {
  const t = text.replace(/^\[[^\]]+\]\n/, "").trim();
  return CORRECTION.test(t) && t.split(/\s+/).length <= 60;
}

/** The exchange the correction refers to: the previous request and the agent's last reply to it. */
function priorExchange(messages: SessionRow["messages"]): { request?: string; reply?: string } {
  const start = taskStart(messages);
  let reply: string | undefined;
  let request: string | undefined;
  for (let i = start - 1; i > 0; i--) {
    const m = messages[i];
    if (!reply && m.role === "assistant" && !m.ephemeral && !m.superseded && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) reply = m.content.trim();
    if (isUserMessage(m)) {
      request = messageText(m).replace(/^\[[^\]]+\]\n/, "");
      break;
    }
  }
  return { request, reply };
}

/** After a task that began with a correction ended: extract the rule and file it. Returns the line written, if any. */
export async function learnFromCorrection(t: Tenant, row: SessionRow): Promise<string | undefined> {
  const messages = row.messages;
  const correction = messageText(messages[taskStart(messages)]).replace(/^\[[^\]]+\]\n/, "");
  if (!isCorrection(correction)) return undefined;
  const { request, reply } = priorExchange(messages);
  const c = await complete({
    model: modelFor("chat", t),
    temperature: 0,
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content:
          "A personal assistant was corrected by the person it works for. Write the ONE durable preference or rule the correction implies, as a single line starting with '- ', in plain words, general enough to apply next time (e.g. '- The Con Ed account is the Brooklyn apartment, not the office.' or '- Never schedule deliveries before 9am.'). If the correction is about this one occasion only, or is not a correction, reply exactly: NONE",
      },
      { role: "user", content: `Earlier request: ${request ?? "(unknown)"}\nAssistant's reply: ${(reply ?? "(unknown)").slice(0, 600)}\nUser's correction: ${correction.slice(0, 600)}` },
    ],
  });
  await chargeCompletion(t, row, c, "learn");
  const line = typeof c.message.content === "string" ? c.message.content.trim().split("\n")[0].trim() : "";
  if (!line || /^NONE\b/i.test(line) || !line.startsWith("- ")) return undefined;
  const existing = (await readMemory(t, "preferences.md").catch(() => null)) ?? "";
  if (existing.includes(line)) return line;
  const header = existing.includes("## Learned") ? "" : "\n## Learned (from your corrections; edit or delete any line)\n";
  await appendMemory(t, "preferences.md", `${header}${line} (${new Date().toISOString().slice(0, 10)})\n`);
  return line;
}
