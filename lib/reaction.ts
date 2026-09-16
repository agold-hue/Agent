/**
 * The instant reaction on the user's message, the way a person taps a message they just read: not
 * on everything, never a little icon for the topic, and mostly the same two or three faces a friend
 * would use. A thank-you gets a heart, a yes gets a thumbs up, a joke gets a laugh, something heavy
 * gets a heart, and an ordinary request gets a thumbs up some of the time so it reads as "seen", not
 * as a machine stamping every line. Questions get no reaction: the answer is the reaction.
 */
const THANKS = /\b(thanks|thank you|thx|ty|appreciate|you rock|you're the best|awesome|amazing|perfect|great job|well done|nice work|love (it|this|that))\b/i;
const YES = /^\s*(yes|yep|yeah|ok|okay|k|sure|do it|go ahead|go for it|approved|approve|confirm(ed)?|send it|book it|pay it|y|done|all done|👍|✅)\b/i;
const NO = /^\s*(no|nope|don'?t|stop|cancel|wait|hold on|not now|never mind|nevermind)\b/i;
const FUNNY = /\b(lol|lmao|haha+|hehe|rofl|😂|🤣|😅)\b|😂|🤣/i;
const HEAVY = /\b(tired|exhausted|sick|not feeling|stressed|overwhelmed|rough day|long day|hard day|sad|upset|worried|scared|anxious|funeral|hospital|passed away|broke up|fired|laid off)\b/i;
const CELEBRATE = /\b(got the job|we won|it worked|closed|approved!|accepted|passed|engaged|married|baby|birthday today|promotion|refund landed|money'?s in)\b/i;
const COMPLAINT = /\b(why (didn'?t|did not|haven'?t)|you (forgot|never|didn'?t|still haven'?t)|still waiting|not working|wrong|mistake|useless|again\?)\b/i;
const CODE = /^\s*(code[:\s]*)?\d{4,8}\s*$/i;
const QUESTION = /\?\s*$/;

/** How often an ordinary request gets a "seen" thumbs up: deterministic per message so a reload shows the same thing. */
const SEEN_RATE = Number(process.env.REACTION_SEEN_RATE ?? 0.35);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  return (h >>> 0) % 100;
}

/**
 * The reaction for a message, or nothing. `recent` is the reactions on the last few user messages;
 * two thumbs in a row are fine, three in a row are not, so a run of requests is not a wall of 👍.
 */
export function reactionFor(text: string, recent: string[] = []): string | undefined {
  const t = text.trim();
  if (!t || CODE.test(t)) return undefined;
  if (COMPLAINT.test(t)) return undefined; // a complaint gets a fix, not a face
  if (THANKS.test(t)) return recent[recent.length - 1] === "❤️" ? "🙌" : "❤️";
  if (CELEBRATE.test(t)) return "🎉";
  if (FUNNY.test(t)) return "😂";
  if (HEAVY.test(t)) return "❤️";
  if (YES.test(t)) return "👍";
  if (NO.test(t)) return "👍"; // "got it, stopping"
  if (QUESTION.test(t)) return undefined; // the answer is the reaction
  // An ordinary request: "seen", some of the time, never three in a row.
  const lastTwo = recent.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((r) => r === "👍")) return undefined;
  return hash(t) < SEEN_RATE * 100 ? "👍" : undefined;
}
