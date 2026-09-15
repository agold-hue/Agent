/**
 * The instant acknowledgement: an emoji on the user's message the moment it lands, before the agent
 * has done anything. Picked by intent with plain patterns, no model call, so it is immediate and free.
 */
const RULES: Array<[RegExp, string]> = [
  [/\b(remind|reminder|timer|alarm|in \d+ ?(min|minutes|hours?|h|m)\b|at \d{1,2}(:\d{2})? ?(am|pm))/i, "⏰"],
  [/\b(refund|return (it|this|the)|money back|chargeback|dispute)\b/i, "💸"],
  [/^\s*(code[:\s]*)?\d{4,8}\s*$/i, "🔐"],
  [/\b(log ?in(to)?|login|sign ?in(to)?|password|account|acct)\b/i, "🔐"],
  [/\b(buy|order|purchase|reorder|cart|checkout|amazon|cheapest|price)\b/i, "🛒"],
  [/\b(pay|bill|payment|invoice|utility|con ?ed(ison)?|national grid|pseg|peco)\b/i, "💵"],
  [/\b(book|appointment|reserve|reservation|schedule|calendar|meeting|table for)\b/i, "📅"],
  [/\b(email|e-mail|write to|send (a )?(message|note)|draft|reply to)\b/i, "✉️"],
  [/\b(flight|hotel|trip|travel|airbnb|uber|train)\b/i, "✈️"],
  [/\b(package|delivery|tracking|shipped|where'?s my)\b/i, "📦"],
  [/\b(call|phone|dial)\b/i, "📞"],
  [/\b(find|search|look up|lookup|research|compare|check|who owns|owner of)\b/i, "🔍"],
  [/\b(remember|note that|fyi|just so you know|i have an?|i(?:'?m| am) (in|at|going))\b/i, "📝"],
  [/\b(thanks|thank you|great|perfect|you rock|awesome)\b/i, "🙌"],
  [/\b(why (didn'?t|did not)|you (forgot|didn'?t|never)|still waiting|not working|mistake|wrong)\b/i, "🙏"],
  [/^(yes|yep|ok|okay|do it|go ahead|approved|sure|y|done|added|saved|updated|finished|fixed|it'?s (in|there|done))\b/i, "✅"],
  [/\b(logins?|credentials?|vault|added (it|them|my))\b/i, "🔐"],
  [/^(no|nope|don'?t|stop|cancel|wait)\b/i, "✋"],
  [/\?\s*$/, "💬"],
];

/**
 * Interchangeable emojis per intent, so the same face does not repeat down a short run of bubbles.
 * The first entry is the primary from RULES; the rest are stand-ins picked when it was used recently.
 */
const ALTERNATES: Record<string, string[]> = {
  "⏰": ["⏰", "⏳", "🕒", "⏲️"],
  "💸": ["💸", "💰", "🧾", "↩️"],
  "🔐": ["🔐", "🔑", "🗝️", "🔒"],
  "🛒": ["🛒", "🛍️", "🧺", "🏷️"],
  "💵": ["💵", "💳", "🧾", "🏦"],
  "📅": ["📅", "🗓️", "📆", "⏱️"],
  "✉️": ["✉️", "📧", "📨", "📝"],
  "✈️": ["✈️", "🛫", "🧳", "🚕"],
  "📦": ["📦", "🚚", "📬", "🏷️"],
  "📞": ["📞", "☎️", "📲", "🗣️"],
  "🔍": ["🔍", "🔎", "🕵️", "🧐"],
  "📝": ["📝", "🗒️", "📌", "🖊️"],
  "🙌": ["🙌", "🎉", "👏", "😄"],
  "🙏": ["🙏", "🫶", "😅", "🛠️"],
  "✋": ["✋", "🛑", "🚫", "⏸️"],
  "💬": ["💬", "🗨️", "❓", "🤔"],
};

/** These may repeat as often as they like; they are the plain "got it" / "done" acks. */
const REPEATABLE = new Set(["👍", "✅"]);

/**
 * Pick the acknowledgement emoji for a message. `recent` is the emojis used on the last several
 * messages; the same non-repeatable emoji is not used twice within that window, so a run of shopping
 * or lookup messages gets a little variety instead of ten identical faces. 👍 and ✅ are exempt.
 */
export function reactionFor(text: string, recent: string[] = []): string {
  const t = text.trim();
  let primary = "👍";
  for (const [re, emoji] of RULES)
    if (re.test(t)) {
      primary = emoji;
      break;
    }
  if (REPEATABLE.has(primary)) return primary;
  const used = new Set(recent);
  if (!used.has(primary)) return primary;
  for (const alt of ALTERNATES[primary] ?? []) if (!used.has(alt)) return alt;
  return "👍"; // every variant was used recently; fall back to the one emoji that is allowed to repeat
}
