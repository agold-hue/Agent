/**
 * The instant "on it" line for a task that will take a while (a price to look up, a booking, a
 * refund, research). It posts as a chat bubble the moment the request lands, before the agent has
 * done the work, so the user is never left staring at a silent typing dot. The wording is varied and
 * never repeats a line already used recently in this chat.
 */
const ACKS = [
  "On it, Boss. Give me a minute.",
  "Hey Boss, I'll check it out for you, one sec.",
  "Sure thing, digging into it now.",
  "Got it, looking into that right now.",
  "On the case, back in a moment.",
  "Let me pull that up for you, hang tight.",
  "Right away, checking now.",
  "You got it, give me a moment to look.",
  "On it now, Boss, won't be long.",
  "Sure, let me go find out.",
  "Leave it with me, checking now.",
  "Okay, running that down for you.",
  "On it, give me a beat to dig in.",
  "Let me look into that for you now.",
  "Consider it handled, one moment.",
];

/**
 * Pick an acknowledgement, avoiding any line already present in `recent` (the last few things the
 * agent said). Falls back to the least-recently-implied line rather than repeating the last one.
 */
export function researchAck(recent: string[] = []): string {
  const used = new Set(recent.map((s) => s.trim()));
  const fresh = ACKS.filter((a) => !used.has(a));
  const pool = fresh.length ? fresh : ACKS.filter((a) => a !== recent[recent.length - 1]);
  return pool[Math.floor(Math.random() * pool.length)] ?? ACKS[0];
}
