/**
 * The instant acknowledgement: an emoji on the user's message the moment it lands, before the agent
 * has done anything. Picked by intent with plain patterns, no model call, so it is immediate and free.
 */
const RULES: Array<[RegExp, string]> = [
  [/\b(remind|reminder|timer|alarm|in \d+ ?(min|minutes|hours?|h|m)\b|at \d{1,2}(:\d{2})? ?(am|pm))/i, "⏰"],
  [/\b(refund|return (it|this|the)|money back|chargeback|dispute)\b/i, "💸"],
  [/\b(log ?in(to)?|login|sign ?in(to)?|password|account|acct)\b/i, "🔐"],
  [/\b(buy|order|purchase|reorder|cart|checkout|amazon|cheapest|price)\b/i, "🛒"],
  [/\b(pay|bill|payment|invoice|utility|con ?ed(ison)?|national grid|pseg|peco)\b/i, "💵"],
  [/\b(book|appointment|reserve|reservation|schedule|calendar|meeting|table for)\b/i, "📅"],
  [/\b(email|e-mail|write to|send (a )?(message|note)|draft|reply to)\b/i, "✉️"],
  [/\b(flight|hotel|trip|travel|airbnb|uber|train)\b/i, "✈️"],
  [/\b(package|delivery|tracking|shipped|where'?s my)\b/i, "📦"],
  [/\b(call|phone|dial)\b/i, "📞"],
  [/\b(find|search|look up|lookup|research|compare|check|who owns|owner of)\b/i, "🔍"],
  [/\b(remember|note that|fyi|just so you know|i have an?|i'?m (in|at|going))\b/i, "📝"],
  [/\b(thanks|thank you|great|perfect|you rock|awesome)\b/i, "🙌"],
  [/\b(why (didn'?t|did not)|you (forgot|didn'?t|never)|still waiting|not working|mistake|wrong)\b/i, "🙏"],
  [/^(yes|yep|ok|okay|do it|go ahead|approved|sure|y)\b/i, "✅"],
  [/^(no|nope|don'?t|stop|cancel|wait)\b/i, "✋"],
  [/\?\s*$/, "💬"],
];

export function reactionFor(text: string): string {
  const t = text.trim();
  for (const [re, emoji] of RULES) if (re.test(t)) return emoji;
  return "👀";
}
