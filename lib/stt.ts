/**
 * Voice notes -> text. Three routes, tried in order, so a voice note works on a deploy that has
 * nothing but an LLM key:
 *
 *   1. A Whisper-compatible endpoint (STT_BASE_URL, STT_API_KEY): OpenAI, Groq, DeepInfra, a
 *      self-hosted whisper. Eats every format the phones produce; the best route when it is there.
 *   2. The main LLM provider's own /audio/transcriptions, when that provider has one (OpenAI, Groq,
 *      DeepInfra, Fireworks). No extra key, no extra config.
 *   3. The audio-capable chat model itself (Gemini, GPT-4o-audio, Qwen Omni), sent the note inline
 *      and asked to write down what it hears. Works with the key the service already needs, but
 *      only for the formats those models accept (m4a/aac, mp3, wav, ogg, flac, aiff) — not webm.
 *
 * Which one a deploy has decides what the chat page offers, so the mic never sits there doing
 * nothing: `sttRoute()` is what /api/me reports and what the upload route explains when it cannot.
 */
import { complete, geminiDirect, modelList } from "./llm.js";
import { poolFor } from "./router.js";

/** Whisper endpoints reject anything much past this; say so plainly rather than sending it. */
const MAX_BYTES = Number(process.env.STT_MAX_BYTES) || 25 * 1024 * 1024;

/** Extensions the phones actually produce: iPhone memos (.m4a), WhatsApp (.opus/.ogg), Android (.amr/.3gp), the app (.webm). */
const AUDIO_EXT = /\.(m4a|m4b|mp3|mpga|mpeg|wav|weba|webm|ogg|oga|opus|amr|aac|flac|3gp|3gpp|caf|aiff?)$/i;

/** Providers that serve an OpenAI-shaped /audio/transcriptions alongside chat. */
const WHISPER_HOSTS = /api\.openai\.com|api\.groq\.com|api\.deepinfra\.com|api\.fireworks\.ai|api\.together\.xyz|api\.lemonfox\.ai/i;

/** Model families that take audio inline in a chat message. */
const AUDIO_MODELS = (process.env.AUDIO_MODELS ?? "gemini,gpt-4o-audio,gpt-audio,gpt-5,qwen-omni,qwen3-omni,phi-4-multimodal").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** What an audio-capable chat model will accept inline. A browser's webm/opus is not on the list. */
const INLINE_FORMATS: Record<string, string> = { m4a: "m4a", m4b: "m4a", aac: "aac", mp3: "mp3", mpga: "mp3", mpeg: "mp3", wav: "wav", ogg: "ogg", oga: "ogg", opus: "ogg", flac: "flac", aif: "aiff", aiff: "aiff" };

/**
 * Is this attachment someone talking? The mime type is the first word, but mail servers and phones
 * send voice notes as application/octet-stream often enough that the filename gets a vote too.
 * video/webm and video/mp4 are here because that is what a browser recording and an iPhone memo
 * arrive as.
 */
export function isAudio(mimeType: string, filename = ""): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  if (mime === "video/webm" || mime === "video/mp4" || mime === "video/3gpp") return true;
  return AUDIO_EXT.test(filename);
}

function formatOf(filename: string, mimeType: string): string {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext) return ext === "weba" ? "webm" : ext;
  const sub = (mimeType.split("/")[1] ?? "").split(";")[0].toLowerCase();
  return sub === "mpeg" ? "mp3" : sub === "x-m4a" ? "m4a" : sub === "mp4" ? "m4a" : sub;
}

/** The model that gets sent the audio on route 3: STT_CHAT_MODEL, else the first audio-capable id in the pools. */
function audioModel(): string | undefined {
  if (process.env.STT_CHAT_MODEL) return process.env.STT_CHAT_MODEL;
  const ids = [...poolFor("task"), ...poolFor("chat")].flatMap((m) => modelList(m));
  const hit = ids.find((id) => AUDIO_MODELS.some((f) => id.toLowerCase().includes(f)));
  if (hit) return hit;
  return geminiDirect() ? "gemini-3.8-flash" : undefined;
}

export interface SttRoute {
  /** How a note would be transcribed here, or "none" when nothing can. */
  how: "endpoint" | "provider" | "model" | "none";
  /** One line for the operator and for the error the page shows. */
  detail: string;
  /** Formats this route accepts; empty means everything. A browser recording must be one of these. */
  formats?: string[];
}

/** Which route this deploy has. Cheap: environment only, no network. */
export function sttRoute(): SttRoute {
  if (process.env.STT_BASE_URL && process.env.STT_API_KEY) return { how: "endpoint", detail: `${process.env.STT_BASE_URL} (${process.env.STT_MODEL ?? "whisper-1"})` };
  const base = process.env.LLM_BASE_URL ?? "";
  if (WHISPER_HOSTS.test(base) && process.env.LLM_API_KEY) return { how: "provider", detail: `${base} /audio/transcriptions` };
  const model = audioModel();
  if (model) return { how: "model", detail: `${model}, audio inline`, formats: [...new Set(Object.keys(INLINE_FORMATS))] };
  return { how: "none", detail: "no transcription route: set STT_BASE_URL and STT_API_KEY, or use an audio-capable model" };
}

/** True when a voice note can be transcribed at all on this deploy. */
export function sttConfigured(): boolean {
  return sttRoute().how !== "none";
}

/** Formats the page should record in, best first: what the chosen route accepts. */
export function sttFormats(): string[] {
  const r = sttRoute();
  return r.formats ?? [];
}

async function viaEndpoint(base: string, key: string, model: string, audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", model);
  form.append("response_format", "json");
  // Optional: pin the language when the owner speaks one (better on names and numbers than autodetect).
  if (process.env.STT_LANGUAGE) form.append("language", process.env.STT_LANGUAGE);
  const res = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

async function viaModel(model: string, audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const format = INLINE_FORMATS[formatOf(filename, mimeType)];
  if (!format) {
    throw new Error(
      `this deploy transcribes with ${model}, which does not take ${formatOf(filename, mimeType) || mimeType} audio (it takes ${[...new Set(Object.values(INLINE_FORMATS))].join(", ")}). Record in one of those, or set STT_BASE_URL and STT_API_KEY for a Whisper endpoint.`,
    );
  }
  const out = await complete({
    model,
    temperature: 0,
    maxTokens: 2000,
    reasoning: "none",
    messages: [
      { role: "system", content: "You transcribe voice notes. Write down exactly what is said, verbatim, with normal punctuation. No summary, no commentary, no speaker labels, no quotation marks around it. If the audio is silent or has no speech, reply with nothing at all." },
      { role: "user", content: [{ type: "text", text: "Transcribe this voice note." }, { type: "input_audio", input_audio: { data: audio.toString("base64"), format } }] },
    ],
  });
  const said = out.message?.content;
  return (typeof said === "string" ? said : Array.isArray(said) ? said.map((c) => ("text" in c ? c.text : "")).join(" ") : "").trim();
}

export async function transcribe(audio: Buffer, filename: string, mimeType: string): Promise<string> {
  if (audio.length > MAX_BYTES) throw new Error(`that note is too long to transcribe (${Math.round(audio.length / 1e6)} MB, ${Math.round(MAX_BYTES / 1e6)} MB max)`);
  const route = sttRoute();
  if (route.how === "endpoint") return viaEndpoint(process.env.STT_BASE_URL!, process.env.STT_API_KEY!, process.env.STT_MODEL ?? "whisper-1", audio, filename, mimeType);
  if (route.how === "provider") return viaEndpoint(process.env.LLM_BASE_URL!, process.env.LLM_API_KEY!, process.env.STT_MODEL ?? "whisper-1", audio, filename, mimeType);
  if (route.how === "model") return viaModel(audioModel()!, audio, filename, mimeType);
  throw new Error("voice notes are not configured here (STT_BASE_URL and STT_API_KEY, or an audio-capable model)");
}

/**
 * Transcribe without throwing: for the paths that fold a voice note in among other attachments
 * (forwarded mail, a mixed upload), where one unreadable note must not lose the rest of the batch.
 * Returns what was said, or why it could not be heard.
 */
export async function transcribeQuietly(audio: Buffer, filename: string, mimeType: string): Promise<{ text: string; error?: string }> {
  try {
    const text = await transcribe(audio, filename, mimeType);
    return text ? { text } : { text: "", error: "nothing audible in it" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[stt] ${filename}: ${error}`);
    return { text: "", error };
  }
}
