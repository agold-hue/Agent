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
const SEEN_RATE = Number(process.env.REACTION_SEEN_RATE ?? 0.2);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  return (h >>> 0) % 100;
}

/**
 * A message that is only a pleasantry closing the exchange: "thanks", "perfect", "got it", a lone
 * 🙏. Pete reacts with an emoji and says nothing back, the way a person taps a heart on "thanks"
 * instead of typing "you're welcome". Anything longer, or carrying a request, is not a closer.
 */
const CLOSER = /^(thank(s| you| u)?( so much| very much| a lot| a ton| again| a bunch)*|thx|tysm|tyvm|ty|ta|cheers|much appreciated|(i )?(really )?appreciate (it|you|that|this)|appreciated|perfect|great|awesome|amazing|wonderful|fantastic|excellent|brilliant|lovely|nice|cool|sweet|neat|(you'?re )?(the )?best|you rock|great (job|work)|(good|nice) (job|work|stuff)|well done|got it|gotcha|understood|noted|makes sense|sounds good|will do|ok(ay)? (thanks|cool|great|perfect)|no worries|np)[\s.!,\u2764\ud83d\ude4f\ud83d\udc4d\ud83d\ude4c\ud83d\ude0a\ud83c\udf89\ud83d\udc4f\ud83d\udcaf\ud83d\udd25\ud83d\ude0d\ud83e\udd70]*$/iu;
export function isPleasantryCloser(text: string): boolean {
  const t = text.replace(/^\[[^\]]*\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").trim();
  if (!t || t.length > 40) return false;
  if (/^[\s\ud83d\udc4d\ud83d\ude4f\u2764\ufe0f\ud83d\ude4c\ud83d\ude0a\ud83c\udf89\ud83d\udc4f\ud83d\udcaf\ud83d\udd25\ud83d\ude0d\ud83e\udd70\ud83d\udc4c]+$/u.test(t)) return true;
  return CLOSER.test(t);
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
  if (NO.test(t)) return undefined; // "cancel", "stop", "no": the reply is the acknowledgement, a thumbs up reads wrong
  if (QUESTION.test(t)) return undefined; // the answer is the reaction
  // A real request (a verb, some length) is answered by doing it; the typing dots are the "seen".
  if (t.split(/\s+/).length > 9) return undefined;
  // A short ordinary line: "seen", some of the time, never two in a row.
  if (recent[recent.length - 1] === "👍") return undefined;
  return hash(t) < SEEN_RATE * 100 ? "👍" : undefined;
}
