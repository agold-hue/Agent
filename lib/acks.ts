/**
 * The instant "on it" line for a task that will take a while (a price to look up, a booking, a
 * refund, research). It posts as a chat bubble the moment the request lands, before the agent has
 * done the work, so the user is never left staring at a silent typing dot. Two or three words, no
 * cheer, no nickname: the answer is what the user is waiting for, not the acknowledgement. The
 * wording is varied and never repeats a line already used recently in this chat.
 */
const ACKS = ["On it.", "Checking.", "Looking now.", "One minute.", "Pulling it up.", "Give me a minute.", "Working on it.", "Checking that now.", "Looking into it.", "On it, one minute."];

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
